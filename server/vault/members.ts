import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { avatarUrlFor } from "../avatars";
import { recordAccessEvent } from "../access/events";
import { notifyAccess } from "../access/notices";
import { mailVaultShared } from "../mail/triggers";
import { readPolicies } from "../team/policies";
import {
  atLeast, envLevel, GROUP_TO_VAULT, maxLevel, minLevel, requireVault, roleCap, VAULT_TO_GROUP, vaultAccess, VaultError,
  type VaultAccess, type VaultActor, type VaultLevel, type VaultRole
} from "./access";
import { chargeVault } from "./limits";
import { beginRotation } from "./rotation";
import { recordVaultEvent } from "./service";
import { ENV_LEVELS, VAULT_BOUNDS } from "../../shared/vault";

/**
 * Vault members and per-environment access (vault plan §6.1, §6.6, §10 Access; D214–D216, V-O3,
 * T185, T197, T198): `GET/PUT /api/vault/vaults/:id/access`, leaving a vault, and the member
 * access page's view of one person's vaults (reductions only, D268).
 *
 * The shape follows the shared Access sheet (§C.5 of the access plan): people and groups, each with
 * a level, and an ETag that `PUT` must send back in `If-Match` (409 `ACCESS_CHANGED` with the
 * latest otherwise). Here each person and group has a level per environment, and each person a
 * vault role (owner or member).
 *
 * - Owners change everything: people, roles (a vault keeps at least one owner, `LAST_OWNER`),
 *   levels, and groups. Environment admins change only `none`/`read`/`write` of existing members
 *   on the environments they administer, never an owner or another admin there (D215, T185); they
 *   cannot add or remove people, change roles, or touch groups. Anyone else gets 403 `VAULT_LEVEL`.
 * - Team roles cap every level (viewers read at most and are never owners, `ROLE_CAP`); guests are
 *   never vault members (`GUEST_NOT_ALLOWED`, V-O3); integrations are never vault members
 *   (`INTEGRATION_NOT_ALLOWED`; Wave 26 decision, 037 refuses it in the database too). A group that
 *   includes guests may be granted only while `share_with_guests` is on (`GUEST_SHARE_DISABLED`),
 *   and its guests still reach nothing.
 * - Losing access (removed, or a readable environment lowered to none) starts a data-key rotation
 *   (§3.3) and records `member.remove`; the answer carries `rotated` so the sheet can say "rotate
 *   the real credentials upstream" (§6.6).
 * - People newly given access hear through the bell and email ("shared with you"): the vault's
 *   name only, never a secret name or value (D93, D223).
 */

export const MAX_VAULT_PEOPLE = VAULT_BOUNDS.members;
export const MAX_VAULT_GROUPS = 20;

type PersonRow = { id: string; display_name: string; role: string; kind: string; disabled_at: string | null; avatar_id: string | null };
type MemberRow = { user_id: string; role: VaultRole; revision: number; added_at: string };

export type SheetEnvironment = { id: string; slug: string; name: string; protected: boolean; manageable: boolean };
export type SheetPerson = {
  id: string; displayName: string; teamRole: string; kind: string; blocked: boolean; avatarUrl: string | null; isYou: boolean;
  role: VaultRole; levels: Record<string, VaultLevel>;
  /** The Team role's ceiling (§6.1): admin (none), read (viewers), none (guests, blocked). */
  cap: VaultLevel;
  /** Groups on this sheet the person is in (the highest level wins). */
  groupIds: string[];
};
export type SheetGroup = { id: string; name: string; memberCount: number; guestCount: number; levels: Record<string, VaultLevel> };
export type VaultAccessSheet = ReturnType<typeof readVaultAccess>;

const environmentsOf = (access: VaultAccess) => access.environments;

function members(vaultId: string): MemberRow[] {
  return db.query("SELECT user_id, role, revision, added_at FROM vault_members WHERE vault_id = ? ORDER BY added_at, user_id").all(vaultId) as MemberRow[];
}

function envAccessRows(vaultId: string) {
  return db.query("SELECT user_id, env_id, level FROM vault_env_access WHERE vault_id = ? ORDER BY user_id, env_id").all(vaultId) as Array<{ user_id: string; env_id: string; level: VaultLevel }>;
}

function groupRows(vaultId: string) {
  return db.query(`SELECT gg.group_id, gg.env_id, gg.level, g.name,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id AND u.role = 'guest') AS guest_count
    FROM group_grants gg JOIN user_groups g ON g.id = gg.group_id
    WHERE gg.resource_kind = 'vault' AND gg.resource_id = ? AND gg.env_id IS NOT NULL ORDER BY g.name COLLATE NOCASE, g.id, gg.env_id`).all(vaultId) as Array<{ group_id: string; env_id: string; level: string; name: string; member_count: number; guest_count: number }>;
}

/** The ETag: a hash of every member row, access row, and group grant of the vault (§C.5 pattern). */
function etagOf(vaultId: string) {
  const canonical = JSON.stringify({
    members: members(vaultId).map((row) => `${row.user_id}:${row.role}`),
    levels: envAccessRows(vaultId).map((row) => `${row.user_id}:${row.env_id}:${row.level}`),
    groups: groupRows(vaultId).map((row) => `${row.group_id}:${row.env_id}:${row.level}`)
  });
  return `"${createHash("sha256").update(`${vaultId}:${canonical}`).digest("hex").slice(0, 24)}"`;
}

/** Who may open the sheet: owners (every environment) and environment admins (theirs). */
function manageableEnvs(access: VaultAccess): Set<string> {
  if (access.role === "owner" && roleCap(access.actor.userId) === "admin") return new Set(environmentsOf(access).map((env) => env.id));
  return new Set(environmentsOf(access).filter((env) => envLevel(access, env.id) === "admin").map((env) => env.id));
}

function authorize(actor: VaultActor, vaultId: string) {
  const access = requireVault(actor, vaultId);
  const manageable = manageableEnvs(access);
  if (manageable.size === 0) throw new VaultError(403, "VAULT_LEVEL", "Only the vault's owners and environment admins manage who has access");
  return { access, manageable, owner: access.role === "owner" && roleCap(actor.userId) === "admin" };
}

export function readVaultAccess(actor: VaultActor, vaultId: string) {
  const { access, manageable, owner } = authorize(actor, vaultId);
  // An environment admin sees only the environments they can read (§6.2): the rest, their names and
  // who holds them, stay hidden, and a save leaves them exactly as they are.
  const envs = owner ? environmentsOf(access) : environmentsOf(access).filter((env) => atLeast(envLevel(access, env.id), "read"));
  const memberList = members(vaultId);
  const levels = envAccessRows(vaultId);
  const ids = memberList.map((row) => row.user_id);
  const people = ids.length ? db.query(`SELECT id, display_name, role, kind, disabled_at, avatar_id FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as PersonRow[] : [];
  const byId = new Map(people.map((row) => [row.id, row]));
  const groupGrantRows = groupRows(vaultId);
  const groups = new Map<string, SheetGroup>();
  for (const row of groupGrantRows) {
    const group = groups.get(row.group_id) ?? { id: row.group_id, name: row.name, memberCount: row.member_count, guestCount: row.guest_count, levels: Object.fromEntries(envs.map((env) => [env.id, "none" as VaultLevel])) };
    if (envs.some((env) => env.id === row.env_id)) group.levels[row.env_id] = maxLevel(group.levels[row.env_id] ?? "none", GROUP_TO_VAULT[row.level] ?? "none");
    groups.set(row.group_id, group);
  }
  const memberOf = new Map<string, string[]>();
  if (ids.length && groups.size) {
    const rows = db.query(`SELECT user_id, group_id FROM group_members WHERE group_id IN (${[...groups.keys()].map(() => "?").join(",")}) AND user_id IN (${ids.map(() => "?").join(",")})`)
      .all(...groups.keys(), ...ids) as Array<{ user_id: string; group_id: string }>;
    for (const row of rows) memberOf.set(row.user_id, [...(memberOf.get(row.user_id) ?? []), row.group_id]);
  }
  const sheetPeople: SheetPerson[] = memberList.flatMap((member) => {
    const person = byId.get(member.user_id);
    if (!person) return [];
    const own = Object.fromEntries(envs.map((env) => [env.id, member.role === "owner" ? "admin" as VaultLevel : "none" as VaultLevel]));
    if (member.role !== "owner") for (const row of levels) if (row.user_id === member.user_id && row.env_id in own) own[row.env_id] = row.level;
    return [{
      id: person.id, displayName: person.display_name, teamRole: person.role, kind: person.kind, blocked: person.disabled_at !== null,
      avatarUrl: avatarUrlFor(person.id, person.avatar_id), isYou: person.id === actor.userId, role: member.role, levels: own,
      cap: roleCap(person.id), groupIds: memberOf.get(person.id) ?? []
    }];
  });
  return {
    etag: etagOf(vaultId),
    vault: { id: access.vault.id, name: access.vault.name },
    yourRole: access.role,
    youId: actor.userId,
    canManagePeople: owner,
    environments: envs.map((env): SheetEnvironment => ({ id: env.id, slug: env.slug, name: env.name, protected: env.protected === 1, manageable: manageable.has(env.id) })),
    people: sheetPeople,
    groups: [...groups.values()],
    levels: ENV_LEVELS,
    shareWithGuests: readPolicies().shareWithGuests,
    maxPeople: MAX_VAULT_PEOPLE,
    maxGroups: MAX_VAULT_GROUPS
  };
}

export type PutPerson = { id: string; role: VaultRole; levels: Record<string, VaultLevel> };
export type PutGroup = { id: string; levels: Record<string, VaultLevel> };
export type VaultAccessPut = { people: PutPerson[]; groups: PutGroup[] };

const invalid = (message: string, code = "INVALID", details: Record<string, unknown> = {}) => new VaultError(400, code, message, details);

/** Readable environments per person before and after, to know who lost access (rotation, notices). */
function readableEnvs(vaultId: string, userId: string, envIds: readonly string[]): Set<string> {
  const actor: VaultActor = { kind: "session", userId };
  const access = vaultAccess(actor, vaultId);
  if (!access) return new Set();
  return new Set(envIds.filter((envId) => atLeast(envLevel(access, envId), "read")));
}

/** Everyone who reaches the vault now: its members and the members of its granted groups. */
function reachers(vaultId: string): string[] {
  return (db.query(`SELECT user_id FROM vault_members WHERE vault_id = $vaultId
    UNION SELECT gm.user_id FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id WHERE gg.resource_kind = 'vault' AND gg.resource_id = $vaultId`)
    .all({ vaultId }) as Array<{ user_id: string }>).map((row) => row.user_id);
}

/**
 * `PUT …/access` with `If-Match`: replaces the members, their roles and levels, and the group grants
 * in one transaction (owners), or the none/read/write levels of existing members on the caller's
 * environments (environment admins). Returns the sheet, whether a rotation started, and who lost access.
 */
export function writeVaultAccess(actor: VaultActor, vaultId: string, body: VaultAccessPut, ifMatch: string | undefined) {
  if (!ifMatch) throw new VaultError(428, "ETAG_REQUIRED", "Send If-Match with the ETag from GET …/access");
  chargeVault("write", actor.userId);
  const outcome = db.transaction(() => {
    const current = readVaultAccess(actor, vaultId);
    if (ifMatch !== current.etag && ifMatch !== current.etag.slice(1, -1)) {
      throw new VaultError(409, "ACCESS_CHANGED", "Someone else changed who has access. Review the latest and save again.", { access: current });
    }
    const envIds = current.environments.map((env) => env.id);
    const people = dedupe(body.people.map((entry) => ({ ...entry, id: entry.id.toLowerCase() })));
    const groups = dedupe(body.groups.map((entry) => ({ ...entry, id: entry.id.toLowerCase() })));
    for (const entry of [...people, ...groups]) {
      for (const [envId, level] of Object.entries(entry.levels)) {
        if (!envIds.includes(envId.toLowerCase())) throw invalid("An environment is not part of this vault");
        if (!(ENV_LEVELS as readonly string[]).includes(level)) throw invalid("That level is not offered");
      }
    }
    const normalize = (levels: Record<string, VaultLevel>) => Object.fromEntries(envIds.map((envId) => [envId, levels[envId] ?? Object.entries(levels).find(([key]) => key.toLowerCase() === envId)?.[1] ?? "none"])) as Record<string, VaultLevel>;
    const nextPeople = people.map((entry) => ({ ...entry, levels: entry.role === "owner" ? Object.fromEntries(envIds.map((envId) => [envId, "admin" as VaultLevel])) : normalize(entry.levels) }));
    const nextGroups = groups.map((entry) => ({ ...entry, levels: normalize(entry.levels) }));
    if (current.canManagePeople) validateOwnerChange(current, nextPeople, nextGroups);
    else validateEnvAdminChange(current, nextPeople, nextGroups);

    const before = new Map(reachers(vaultId).map((userId) => [userId, readableEnvs(vaultId, userId, envIds)]));
    const beforeMembers = new Map(members(vaultId).map((row) => [row.user_id, row]));
    const timestamp = now();

    // Members: add and promote first, then demote, then remove, whatever order the sheet sent (an
    // owner handing the vault over lists themselves first): 031's LAST_OWNER triggers only see a
    // vault without an owner if the save really leaves none.
    const lastOwner = <T>(operation: () => T): T => {
      try {
        return operation();
      } catch (error) {
        if (error instanceof Error && error.message.includes("LAST_OWNER")) throw new VaultError(409, "LAST_OWNER", "A vault keeps at least one owner");
        throw error;
      }
    };
    const setRole = (person: NextPerson) => {
      db.query("UPDATE vault_members SET role = ?, revision = revision + 1 WHERE vault_id = ? AND user_id = ?").run(person.role, vaultId, person.id);
      recordVaultEvent(vaultId, actor.userId, person.role === "owner" ? "member.owner" : "member.demote", { targetId: person.id });
    };
    for (const person of nextPeople) {
      const had = beforeMembers.get(person.id);
      if (!had) db.query("INSERT INTO vault_members (vault_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)").run(vaultId, person.id, person.role, actor.userId, timestamp);
      else if (had.role !== person.role && person.role === "owner") setRole(person);
    }
    for (const person of nextPeople) {
      const had = beforeMembers.get(person.id);
      if (had && had.role !== person.role && person.role !== "owner") lastOwner(() => setRole(person));
    }
    const removed = [...beforeMembers.keys()].filter((userId) => !nextPeople.some((person) => person.id === userId));
    for (const userId of removed) lastOwner(() => db.query("DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?").run(vaultId, userId));
    // Levels: members' rows only (owners hold admin everywhere; no rows).
    // Live environments only: a binned environment's rows come back with it when it is restored.
    const liveIds = JSON.stringify(envIds);
    db.query("DELETE FROM vault_env_access WHERE vault_id = ? AND env_id IN (SELECT value FROM json_each(?))").run(vaultId, liveIds);
    const insertLevel = db.query("INSERT INTO vault_env_access (vault_id, user_id, env_id, level) VALUES (?, ?, ?, ?)");
    for (const person of nextPeople) {
      if (person.role === "owner") continue;
      for (const envId of envIds) if (person.levels[envId] !== "none") insertLevel.run(vaultId, person.id, envId, person.levels[envId]);
    }
    // Group grants: one row per environment above none.
    db.query("DELETE FROM group_grants WHERE resource_kind = 'vault' AND resource_id = ? AND env_id IN (SELECT value FROM json_each(?))").run(vaultId, liveIds);
    const insertGroup = db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, env_id, granted_by, created_at) VALUES ('vault', ?, ?, ?, ?, ?, ?)");
    for (const group of nextGroups) {
      for (const envId of envIds) {
        const level = group.levels[envId]!;
        if (level !== "none") insertGroup.run(vaultId, group.id, VAULT_TO_GROUP[level], envId, actor.userId, timestamp);
      }
    }
    moveBillingOwner(vaultId);
    db.query("UPDATE vaults SET updated_at = ? WHERE id = ?").run(timestamp, vaultId);

    // Who gained and who lost access, for notices, events, and the rotation.
    const after = new Map(reachers(vaultId).map((userId) => [userId, readableEnvs(vaultId, userId, envIds)]));
    const everyone = new Set([...before.keys(), ...after.keys(), ...removed]);
    const gained: string[] = [];
    const lost: string[] = [];
    for (const userId of everyone) {
      const had = before.get(userId) ?? new Set<string>();
      const has = after.get(userId) ?? new Set<string>();
      if (had.size === 0 && has.size > 0) gained.push(userId);
      if ([...had].some((envId) => !has.has(envId))) lost.push(userId);
    }
    // Activity names whom each change was about (QA L1): one event per person added or removed, and
    // one per person and environment whose own level changed (members; owners hold admin everywhere).
    const addedPeople = nextPeople.filter((person) => !beforeMembers.has(person.id));
    for (const person of addedPeople) recordVaultEvent(vaultId, actor.userId, "member.add", { targetId: person.id });
    for (const userId of removed) recordVaultEvent(vaultId, actor.userId, "member.remove", { targetId: userId });
    for (const person of nextPeople) {
      if (person.role === "owner") continue;
      const had = current.people.find((item) => item.id === person.id);
      for (const envId of envIds) {
        const from = had && had.role !== "owner" ? had.levels[envId] ?? "none" : "none";
        const to = person.levels[envId] ?? "none";
        if (from !== to && (had?.role !== "owner" || to !== "none")) recordVaultEvent(vaultId, actor.userId, "access.level", { targetId: person.id, envId, level: to });
      }
    }
    const groupsChanged = nextGroups.length !== current.groups.length
      || nextGroups.some((group) => { const was = current.groups.find((item) => item.id === group.id); return !was || envIds.some((envId) => (was.levels[envId] ?? "none") !== group.levels[envId]); });
    if (groupsChanged) recordVaultEvent(vaultId, actor.userId, "access.change", { count: nextGroups.length });
    const added = addedPeople.length;
    for (const userId of gained) notifyAccess({ userId, kind: "vault_shared", actorId: actor.userId, resource: { kind: "vault", id: vaultId } }, timestamp);
    // Email only for people added by name (as other modules: groups hear through the bell, §C.11).
    mailVaultShared(actor.userId, vaultId, gained.filter((userId) => nextPeople.some((person) => person.id === userId)));
    for (const userId of lost.filter((id) => (after.get(id)?.size ?? 0) === 0)) notifyAccess({ userId, kind: "vault_removed", actorId: actor.userId, resource: { kind: "vault", id: vaultId } }, timestamp);
    const counts = { people: nextPeople.length, groups: nextGroups.length, added: gained.length, lost: lost.length, removed: removed.length };
    audit(actor.userId, null, "vault.access_changed", { vaultId, ...counts, ...(current.canManagePeople ? {} : { asEnvAdmin: true }) });
    recordAccessEvent({ actorId: actor.userId, via: "web", action: "item.access_changed", resource: { kind: "vault", id: vaultId }, meta: { kind: "vault", peopleCount: nextPeople.length, groupCount: nextGroups.length } }, timestamp);
    // §3.3, §6.6: anyone who could read an environment and no longer can starts a new data key.
    const rotated = lost.length > 0 ? beginRotation(vaultId, actor.userId, "member_removed") : null;
    return { rotated: rotated !== null, generation: rotated, lostAccess: lost.length };
  })();
  // The sheet as the caller sees it now, read after the save rather than inside it: an owner who
  // handed the vault over (or stepped down to no access) no longer manages it, and re-authorizing
  // inside the transaction would roll their handover back. `access` is then null, and `stillReads`
  // says whether the page should go to the vault or to the list.
  let access: VaultAccessSheet | null = null;
  try {
    access = readVaultAccess(actor, vaultId);
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
  }
  return { access, managesAccess: access !== null, stillReads: access !== null || vaultAccess(actor, vaultId) !== null, ...outcome };
}

/**
 * The creator's bytes stay with whoever owns the vault: when its billing owner (`vaults.owner_id`)
 * is no longer an owner of it, the longest-standing owner becomes the billing owner (the byte quota
 * and the 100-vault bound). Called after every change that can demote or remove an owner.
 */
function moveBillingOwner(vaultId: string) {
  const billing = db.query("SELECT owner_id FROM vaults WHERE id = ?").get(vaultId) as { owner_id: string } | null;
  if (!billing) return;
  if (db.query("SELECT 1 FROM vault_members WHERE vault_id = ? AND user_id = ? AND role = 'owner'").get(vaultId, billing.owner_id)) return;
  const next = db.query("SELECT user_id FROM vault_members WHERE vault_id = ? AND role = 'owner' ORDER BY added_at, user_id LIMIT 1").get(vaultId) as { user_id: string } | null;
  if (next) db.query("UPDATE vaults SET owner_id = ? WHERE id = ?").run(next.user_id, vaultId);
}

function dedupe<T extends { id: string }>(entries: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

type NextPerson = { id: string; role: VaultRole; levels: Record<string, VaultLevel> };
type NextGroup = { id: string; levels: Record<string, VaultLevel> };

/** Owners: the rules on every person and group (§6.1, V-O3, T198). */
function validateOwnerChange(current: VaultAccessSheet, people: NextPerson[], groups: NextGroup[]) {
  if (people.length > MAX_VAULT_PEOPLE) throw invalid(`A vault has at most ${MAX_VAULT_PEOPLE} people`, "LIMIT_REACHED");
  if (groups.length > MAX_VAULT_GROUPS) throw invalid(`A vault is shared with at most ${MAX_VAULT_GROUPS} groups`, "LIMIT_REACHED");
  if (!people.some((person) => person.role === "owner")) throw new VaultError(409, "LAST_OWNER", "A vault keeps at least one owner");
  if (people.length) {
    const rows = db.query(`SELECT id, display_name, role, kind, disabled_at, avatar_id FROM users WHERE id IN (${people.map(() => "?").join(",")})`).all(...people.map((person) => person.id)) as PersonRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const person of people) {
      const row = byId.get(person.id);
      const existing = current.people.find((item) => item.id === person.id);
      if (!row || (row.disabled_at !== null && !existing)) throw invalid("One or more people were not found", "NOT_FOUND_PERSON");
      if (row.kind !== "person") throw invalid("Integrations cannot be vault members. Give an integration vault access with a vault key when those arrive.", "INTEGRATION_NOT_ALLOWED", { people: [person.id] });
      const raised = !existing || existing.role !== person.role || Object.entries(person.levels).some(([envId, level]) => LEVEL_ORDER(level) > LEVEL_ORDER(existing.levels[envId] ?? "none"));
      if (row.role === "guest" && raised) throw invalid("Guests cannot be vault members", "GUEST_NOT_ALLOWED", { people: [person.id] });
      if (row.role === "viewer" && raised) {
        if (person.role === "owner") throw invalid("A viewer can only read: they cannot own a vault", "ROLE_CAP", { people: [person.id] });
        if (Object.values(person.levels).some((level) => LEVEL_ORDER(level) > LEVEL_ORDER("read"))) throw invalid("A viewer can only read", "ROLE_CAP", { people: [person.id] });
      }
      // A new owner must be able to manage the vault: never a blocked account (review L2), nor any
      // account whose Team role does not reach admin on a vault. An existing owner who was blocked
      // stays listed, so the sheet can still be saved while someone else takes over.
      if (person.role === "owner" && existing?.role !== "owner") {
        if (row.disabled_at !== null) throw invalid("A blocked account cannot own a vault", "PERSON_BLOCKED", { people: [person.id] });
        if (roleCap(person.id) !== "admin") throw invalid("This person's Team role cannot own a vault", "ROLE_CAP", { people: [person.id] });
      }
    }
  }
  if (groups.length) {
    const found = db.query(`SELECT id FROM user_groups WHERE id IN (${groups.map(() => "?").join(",")})`).all(...groups.map((group) => group.id)) as Array<{ id: string }>;
    if (found.length !== groups.length) throw invalid("One or more groups were not found");
    if (!readPolicies().shareWithGuests) {
      const raisedGroups = groups.filter((group) => {
        const existing = current.groups.find((item) => item.id === group.id);
        return !existing || Object.entries(group.levels).some(([envId, level]) => LEVEL_ORDER(level) > LEVEL_ORDER(existing.levels[envId] ?? "none"));
      }).map((group) => group.id);
      if (raisedGroups.length) {
        const withGuests = (db.query(`SELECT DISTINCT gm.group_id AS id FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE u.role = 'guest' AND gm.group_id IN (${raisedGroups.map(() => "?").join(",")})`)
          .all(...raisedGroups) as Array<{ id: string }>).map((row) => row.id);
        if (withGuests.length) throw new VaultError(400, "GUEST_SHARE_DISABLED", "Sharing with guests is turned off for this Nook", { guests: { people: [], groups: withGuests } });
      }
    }
  }
}

const LEVEL_ORDER = (level: VaultLevel) => ({ none: 0, read: 1, write: 2, admin: 3 })[level];

/**
 * Environment admins (D215, T185): the same people with the same roles and the same groups; only
 * none/read/write of members on environments they administer may change, and never a level that is
 * (or would become) admin.
 */
function validateEnvAdminChange(current: VaultAccessSheet, people: NextPerson[], groups: NextGroup[]) {
  const refuse = (message: string) => new VaultError(403, "VAULT_LEVEL", message);
  const manageable = new Set(current.environments.filter((env) => env.manageable).map((env) => env.id));
  const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  if (!sameIds(people.map((person) => person.id), current.people.map((person) => person.id))) throw refuse("Only owners add or remove people");
  if (!sameIds(groups.map((group) => group.id), current.groups.map((group) => group.id))) throw refuse("Only owners change groups");
  for (const group of groups) {
    const existing = current.groups.find((item) => item.id === group.id)!;
    if (Object.keys(group.levels).some((envId) => group.levels[envId] !== existing.levels[envId])) throw refuse("Only owners change groups");
  }
  for (const person of people) {
    const existing = current.people.find((item) => item.id === person.id)!;
    if (existing.role !== person.role) throw refuse("Only owners change vault roles");
    if (existing.role === "owner") continue;
    for (const [envId, level] of Object.entries(person.levels)) {
      const before = existing.levels[envId] ?? "none";
      if (level === before) continue;
      if (!manageable.has(envId)) throw refuse("You can change access only on environments you administer");
      if (before === "admin" || level === "admin") throw refuse("Only owners grant or change admin");
      if (person.id === current.youId) throw refuse("You cannot change your own access");
      if (existing.cap === "read" && level === "write") throw invalid("A viewer can only read", "ROLE_CAP", { people: [person.id] });
      if (existing.cap === "none" && level !== "none") throw invalid("This person cannot be given vault access", "GUEST_NOT_ALLOWED", { people: [person.id] });
    }
  }
}

/**
 * Leaving a vault (`POST …/leave`): removes the caller's own member row. The last owner cannot
 * leave (409 `LAST_OWNER`); someone who reaches it only through a group asks an admin (409
 * `VIA_GROUP`). Leaving is losing access, so it starts a rotation like a removal.
 */
export function leaveVault(actor: VaultActor, vaultId: string) {
  const access = requireVault(actor, vaultId);
  if (!access.direct) throw new VaultError(409, "VIA_GROUP", "You reach this vault through a group. Ask an admin to change the group.");
  return db.transaction(() => {
    try {
      db.query("DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?").run(vaultId, actor.userId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("LAST_OWNER")) throw new VaultError(409, "LAST_OWNER", "You are the last owner. Make someone else an owner first, or delete the vault.");
      throw error;
    }
    moveBillingOwner(vaultId);
    recordVaultEvent(vaultId, actor.userId, "member.leave");
    audit(actor.userId, null, "vault.left", { vaultId });
    const stillReads = vaultAccess(actor, vaultId) !== null;
    const generation = beginRotation(vaultId, actor.userId, "member_removed");
    return { ok: true, stillReads, generation };
  })();
}

// ---------------------------------------------------------------------------------------------
// The member access page (Team → member → Access; Settings → My access): reductions only (D268).

export type MemberVaultRow = {
  vaultId: string;
  /** The vault's name when the viewer can open the vault themselves (D269), else "Vault owned by …". */
  title: string;
  titleHidden: boolean;
  owner: { displayName: string };
  role: VaultRole;
  via: "direct" | "group";
  /** Per environment the person can read: name (hidden like the title) and level, after the role cap. */
  environments: Array<{ name: string; level: VaultLevel }>;
  active: boolean;
};

/** The vaults `userId` reaches through their own member row (groups show on the page's group list). */
export function memberVaults(viewerId: string, userId: string): MemberVaultRow[] {
  const rows = db.query(`SELECT v.id, v.name, m.role, u.display_name AS owner_name FROM vault_members m JOIN vaults v ON v.id = m.vault_id JOIN users u ON u.id = v.owner_id
    WHERE m.user_id = ? AND v.deleted_at IS NULL AND v.purge_started_at IS NULL ORDER BY u.display_name COLLATE NOCASE, v.id LIMIT 200`).all(userId) as Array<{ id: string; name: string; role: VaultRole; owner_name: string }>;
  const cap = roleCap(userId);
  return rows.map((row) => {
    const visible = vaultAccess({ kind: "session", userId: viewerId }, row.id) !== null;
    const envs = db.query("SELECT id, name FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL ORDER BY position, created_at, id").all(row.id) as Array<{ id: string; name: string }>;
    const own = new Map((db.query("SELECT env_id, level FROM vault_env_access WHERE vault_id = ? AND user_id = ?").all(row.id, userId) as Array<{ env_id: string; level: VaultLevel }>).map((item) => [item.env_id, item.level]));
    const environments = envs.map((env, index) => ({ name: visible ? env.name : `Environment ${index + 1}`, level: minLevel(row.role === "owner" ? "admin" : own.get(env.id) ?? "none", cap) }))
      .filter((env) => env.level !== "none" || row.role === "owner");
    return {
      vaultId: row.id, title: visible ? row.name : `Vault owned by ${row.owner_name}`, titleHidden: !visible, owner: { displayName: row.owner_name }, role: row.role, via: "direct" as const,
      environments, active: cap !== "none" && (row.role === "owner" || environments.some((env) => env.level !== "none"))
    };
  });
}

/** Vault memberships that Reset access removes (member rows; owned vaults stay), counted as direct shares. */
export const vaultMemberCount = (userId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM vault_members m JOIN vaults v ON v.id = m.vault_id WHERE m.user_id = ? AND m.role = 'member'").get(userId) as { count: number }).count;

/**
 * Reset access (Team, D268): removes the person's member rows (never an owner row) and returns the
 * vaults' billing owners with counts for their notices. Runs inside the reset's transaction; the
 * caller wraps the whole reset in `snapshotVaultReach` / `rotateOnLostReach`, which rotates each
 * vault the person could read (their member rows and their groups alike) once.
 */
export function resetVaultMemberships(adminId: string, userId: string): Map<string, number> {
  const rows = db.query("SELECT m.vault_id, v.owner_id, v.deleted_at FROM vault_members m JOIN vaults v ON v.id = m.vault_id WHERE m.user_id = ? AND m.role = 'member'").all(userId) as Array<{ vault_id: string; owner_id: string; deleted_at: string | null }>;
  const perOwner = new Map<string, number>();
  for (const row of rows) {
    db.query("DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?").run(row.vault_id, userId);
    recordVaultEvent(row.vault_id, adminId, "member.remove", { targetId: userId });
    perOwner.set(row.owner_id, (perOwner.get(row.owner_id) ?? 0) + 1);
  }
  return perOwner;
}

/**
 * An admin removes one person's membership of a vault (D268, reduction only). The last owner stays
 * (409 `LAST_OWNER`: an admin cannot orphan a vault; V-O5 keeps orphan recovery on the host). Starts
 * a rotation, tells the person, and records it.
 */
export function adminRemoveVaultMember(adminId: string, userId: string, vaultId: string) {
  return db.transaction(() => {
    const row = db.query("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?").get(vaultId, userId) as { role: VaultRole } | null;
    if (!row) throw new VaultError(404, "NOT_FOUND", "This access is already gone. The page now shows the latest.");
    try {
      db.query("DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?").run(vaultId, userId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("LAST_OWNER")) throw new VaultError(409, "LAST_OWNER", "This person is the vault's only owner. Their access stays until another owner is added.");
      throw error;
    }
    moveBillingOwner(vaultId);
    const timestamp = now();
    recordVaultEvent(vaultId, adminId, "member.remove", { targetId: userId });
    recordAccessEvent({ actorId: adminId, via: "web", action: "access.share_removed", targetUserId: userId, resource: { kind: "vault", id: vaultId }, meta: { role: row.role } }, timestamp);
    audit(adminId, null, "team.access_removed", { targetId: userId, kind: "vault" });
    notifyAccess({ userId, kind: "vault_removed", actorId: adminId, resource: { kind: "vault", id: vaultId } }, timestamp);
    const generation = beginRotation(vaultId, adminId, "member_removed");
    return { removed: "vault" as const, generation };
  })();
}

/**
 * An admin lowers a member's levels (D268): every environment above `level` comes down to it; only
 * `read` is offered (lowering to none is Remove). Owners are left alone: removing is the only
 * reduction on an owner, and never the last one.
 */
export function adminLowerVaultMember(adminId: string, userId: string, vaultId: string, level: "read") {
  return db.transaction(() => {
    const row = db.query("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?").get(vaultId, userId) as { role: VaultRole } | null;
    if (!row) throw new VaultError(404, "NOT_FOUND", "This access is already gone. The page now shows the latest.");
    if (row.role === "owner") throw new VaultError(400, "NOT_LOWERABLE", "An owner's access can only be removed, not lowered");
    const changed = db.query("UPDATE vault_env_access SET level = ? WHERE vault_id = ? AND user_id = ? AND level IN ('write', 'admin')").run(level, vaultId, userId).changes;
    if (!changed) throw new VaultError(400, "NOT_A_REDUCTION", "Admins can only lower access, never raise it");
    const timestamp = now();
    recordVaultEvent(vaultId, adminId, "access.change", { count: changed });
    recordAccessEvent({ actorId: adminId, via: "web", action: "access.share_lowered", targetUserId: userId, resource: { kind: "vault", id: vaultId }, meta: { to: level, environments: changed } }, timestamp);
    audit(adminId, null, "team.access_lowered", { targetId: userId, kind: "vault", to: level, environments: changed });
    return { lowered: true as const, environments: changed };
  })();
}

// ---------------------------------------------------------------------------------------------
// Losing read outside the Access sheet (review M3; §6.6, Wave 26 decision 5): Team → Groups (a
// member removed, a group deleted), Team → member access (removed from a group, Reset access), and
// the account itself (blocked, or made a guest). Every such change takes a snapshot of what the
// people involved could read first, and after the change rotates each vault where anyone lost an
// environment, exactly as the Access sheet does, and tells the vault's owners to rotate the real
// credentials upstream (the bell; the sheet says it to the owner who saved).

/** Per vault, per person: the live environments each of `userIds` can read now. */
export type VaultReach = Map<string, Map<string, Set<string>>>;

const liveEnvIds = (vaultId: string) => (db.query("SELECT id FROM vault_environments WHERE vault_id = ? AND deleted_at IS NULL AND purge_started_at IS NULL").all(vaultId) as Array<{ id: string }>).map((row) => row.id);

export function snapshotVaultReach(userIds: readonly string[]): VaultReach {
  const reach: VaultReach = new Map();
  for (const userId of new Set(userIds)) {
    const vaultIds = (db.query(`SELECT vault_id AS id FROM vault_members WHERE user_id = $userId
      UNION SELECT gg.resource_id AS id FROM group_grants gg JOIN group_members gm ON gm.group_id = gg.group_id WHERE gg.resource_kind = 'vault' AND gm.user_id = $userId`)
      .all({ userId }) as Array<{ id: string }>).map((row) => row.id);
    for (const vaultId of vaultIds) {
      const envs = readableEnvs(vaultId, userId, liveEnvIds(vaultId));
      if (!envs.size) continue;
      const people = reach.get(vaultId) ?? new Map<string, Set<string>>();
      people.set(userId, envs);
      reach.set(vaultId, people);
    }
  }
  return reach;
}

/**
 * Compares `before` with what the same people read now and, per vault where anyone lost an
 * environment, starts a rotation (`key.rotate.auto`) and puts a bell notice with each owner. Call in
 * the same transaction as the change. Returns the vaults rotated.
 */
export function rotateOnLostReach(actorId: string | null, before: VaultReach): string[] {
  const rotated: string[] = [];
  const timestamp = now();
  for (const [vaultId, people] of before) {
    const envIds = liveEnvIds(vaultId);
    let lost = 0;
    for (const [userId, had] of people) {
      const has = readableEnvs(vaultId, userId, envIds);
      if ([...had].some((envId) => !has.has(envId))) lost += 1;
    }
    if (!lost) continue;
    beginRotation(vaultId, actorId, "member_removed");
    rotated.push(vaultId);
    const owners = (db.query("SELECT user_id FROM vault_members WHERE vault_id = ? AND role = 'owner'").all(vaultId) as Array<{ user_id: string }>).map((row) => row.user_id);
    for (const ownerId of owners) {
      if (people.has(ownerId)) continue;
      notifyAccess({ userId: ownerId, kind: "vault_key_rotated", actorId, resource: { kind: "vault", id: vaultId }, count: lost }, timestamp);
    }
  }
  return rotated;
}
