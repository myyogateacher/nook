import { db } from "../db";
import { requireVault, VaultError, visibleEnvironments, type VaultActor } from "./access";

/**
 * A vault's Activity (vault plan §7 Activity, §10; Wave 26): who did what, when, and how many,
 * from `vault_events`. Never a value or a comment: events hold ids and counts only (T188), and this
 * view adds display names for people, secrets, and environments the caller can see.
 *
 * - Owners see every event of the vault; other members see only their own (§7).
 * - A secret's name is shown when the secret still exists (binned secrets show "a secret in the
 *   Bin" to members; owners see the name, as in the Bin itself). An environment the caller cannot
 *   read shows as "an environment you cannot see".
 * - Filters: person (`actor`), event family (`event`: reads, writes, access, keys, transfer,
 *   structure), and environment (`env`). Pages of 100, newest first, with an opaque cursor.
 */

export const EVENT_FAMILIES: Record<string, readonly string[]> = {
  reads: ["value.read", "version.read", "comment.read"],
  writes: ["value.write", "value.clear", "value.restore", "secret.create", "secret.update", "secret.delete", "secret.restore", "secret.purge"],
  access: ["member.add", "member.remove", "member.leave", "member.owner", "member.demote", "access.change", "access.level"],
  keys: ["key.rotate", "key.rotate.auto", "key.rotate.skipped", "key.retire", "reauth"],
  transfer: ["export", "import", "import.preview"],
  structure: ["vault.create", "vault.update", "vault.delete", "vault.restore", "env.create", "env.update", "env.protect", "env.unprotect", "env.reorder", "env.delete", "env.restore", "env.purge", "integrity.fail"]
};
export type EventFamily = keyof typeof EVENT_FAMILIES;
export const ACTIVITY_PAGE = 100;

type Row = {
  id: string; created_at: string; event: string; via: string; count: number | null; actor_id: string | null; actor_name: string | null;
  secret_id: string | null; secret_name: string | null; secret_deleted: string | null; env_id: string | null; env_name: string | null;
  target_id: string | null; target_name: string | null; level: string | null;
};

const encode = (row: { created_at: string; id: string }) => Buffer.from(JSON.stringify([row.created_at, row.id])).toString("base64url");
function decode(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string" && parsed[0].length <= 40 && parsed[1].length <= 40) return { at: parsed[0], id: parsed[1] };
  } catch {
    // fall through
  }
  throw new VaultError(400, "INVALID_CURSOR", "cursor is not valid");
}

export function listVaultActivity(actor: VaultActor, vaultId: string, filters: { actorId?: string; family?: EventFamily; envId?: string; cursor?: string }) {
  const access = requireVault(actor, vaultId);
  const owner = access.role === "owner";
  const cursor = decode(filters.cursor);
  const readableEnvs = new Set(visibleEnvironments(access).filter((env) => owner || (access.levels.get(env.id) ?? "none") !== "none").map((env) => env.id));
  const events = filters.family ? EVENT_FAMILIES[filters.family] ?? [] : null;
  // Members see their own events only (§7): the actor filter is forced to themselves.
  const actorId = owner ? filters.actorId : actor.userId;
  const rows = db.query(`SELECT e.id, e.created_at, e.event, e.via, e.count, e.actor_id, u.display_name AS actor_name,
      e.secret_id, s.name AS secret_name, s.deleted_at AS secret_deleted, e.env_id, n.name AS env_name,
      e.target_id, t.display_name AS target_name, e.level
    FROM vault_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN users t ON t.id = e.target_id
      LEFT JOIN vault_secrets s ON s.id = e.secret_id AND s.vault_id = e.vault_id
      LEFT JOIN vault_environments n ON n.id = e.env_id AND n.vault_id = e.vault_id
    WHERE e.vault_id = $vaultId
      ${actorId ? "AND e.actor_id = $actorId" : ""}
      ${events ? "AND e.event IN (SELECT value FROM json_each($events))" : ""}
      ${filters.envId ? "AND e.env_id = $envId" : ""}
      ${cursor ? "AND (e.created_at < $at OR (e.created_at = $at AND e.id < $cursorId))" : ""}
    ORDER BY e.created_at DESC, e.id DESC LIMIT $limit`).all({
    vaultId, limit: ACTIVITY_PAGE + 1,
    ...(actorId ? { actorId } : {}), ...(events ? { events: JSON.stringify(events) } : {}), ...(filters.envId ? { envId: filters.envId } : {}),
    ...(cursor ? { at: cursor.at, cursorId: cursor.id } : {})
  }) as Row[];
  const page = rows.slice(0, ACTIVITY_PAGE);
  const people = owner
    ? db.query(`SELECT DISTINCT u.id, u.display_name FROM vault_events e JOIN users u ON u.id = e.actor_id WHERE e.vault_id = ? ORDER BY u.display_name COLLATE NOCASE`).all(vaultId) as Array<{ id: string; display_name: string }>
    : [];
  return {
    scope: owner ? "vault" as const : "own" as const,
    events: page.map((row) => {
      const envVisible = row.env_id !== null && readableEnvs.has(row.env_id);
      const secret = row.secret_id === null ? null
        : row.secret_name === null ? { name: null, state: "gone" as const }
          : row.secret_deleted !== null && !owner ? { name: null, state: "binned" as const }
            : { name: row.secret_name, state: row.secret_deleted !== null ? "binned" as const : "live" as const };
      return {
        id: row.id, createdAt: row.created_at, event: row.event, via: row.via, count: row.count,
        actor: row.actor_id ? { id: row.actor_id, displayName: row.actor_name ?? "Former member", isYou: row.actor_id === actor.userId } : null,
        secret,
        environment: row.env_id === null ? null : envVisible ? { id: row.env_id, name: row.env_name } : { id: null, name: null },
        // Whom an access event was about (names only, QA L1), and the level it gave.
        target: row.target_id === null ? null : { displayName: row.target_name ?? "a former member", isYou: row.target_id === actor.userId },
        level: row.level
      };
    }),
    people: people.map((row) => ({ id: row.id, displayName: row.display_name })),
    environments: visibleEnvironments(access).filter((env) => readableEnvs.has(env.id)).map((env) => ({ id: env.id, name: env.name })),
    families: Object.keys(EVENT_FAMILIES),
    nextCursor: rows.length > ACTIVITY_PAGE ? encode(page[page.length - 1]!) : null
  };
}
