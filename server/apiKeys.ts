import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit, db, now } from "./db";
import { recordAccessEvent, type AccessVia } from "./access/events";
import {
  dedupeGrants, GENERAL_KEY_MODULES, grantKey, grantsToScopes, isNarrowing, permissionsForModule, SCOPE_GRANTS, scopeFor, scopeReach, SELECTOR_KINDS,
  type Grant, type GrantModule, type KeyKind, type KeyPermission, type KeySurfaces, type ResourceKind
} from "./keyGrants";
import { hasScope, type McpScope } from "./mcpScopes";
import { MCP_LIMITS } from "./mcpRateLimit";
import { recoveryCode, totpCode } from "./validation";
import { activeModules, blockedKeySql, policyBlock, POLICY_BLOCK_MESSAGES, readPolicies, surfaceBlocks, type PolicyBlock, type Policies } from "./team/policies";
import { can, mcpScopesForRole, type Role } from "./team/roles";
import { editableBoardPredicate, readableBoardPredicate } from "./tasks/access";
import { editableCollectionPredicate, readableCollectionPredicate } from "./collections/access";
import { readableDocumentPredicate } from "./documentAccess";
import { whiteboardDisplayName } from "../shared/whiteboardScene";
import { editableCalendarPredicate, readableCalendarPredicate } from "./calendar/access";

/**
 * Nook keys (docs/plan/research/2026-09-28-access-management-api-keys.md §C.4, D261–D283): one
 * key model in `mcp_api_keys` with grants in `api_key_grants`. Every call recomputes what a key may
 * do (T81, T201, T202, T209):
 *
 *   effective = grants ∩ the owner's current role scopes ∩ org policy (modules per role)
 *
 * and the key is refused outright (KEY_POLICY) when policy blocks it (expiry rules, surfaces per
 * role), or inactive once revoked, expired, or past its rotation grace. The owner's live access to
 * each item is still checked by the module service the tool runs (sessions and keys use the same
 * readable predicates). Keys never manage access (D265): nothing here is reachable from a key.
 */

export const TOKEN_PREFIX: Record<KeyKind, string> = { general: "mynotes_", vault: "nkv_" };
export const MAX_GRANTS = 50;
export const MAX_RESOURCE_IDS = 100;
export const GRACE_HOURS = [0, 1, 24, 168] as const;
export const KEY_NAME_MAX = 80;
export const KEY_DESCRIPTION_MAX = 200;
export const REVOKE_REASON_MAX = 200;
/** Keys revoked this recently still show in the owner's list, so an admin revoke is visible (D268). */
const RECENTLY_REVOKED_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export const hashKeyToken = (token: string) => createHash("sha256").update(token).digest("hex");

// ------------------------------------------------------------------------------ schemas

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const grantInput = z.object({
  module: z.enum(GENERAL_KEY_MODULES as [GrantModule, ...GrantModule[]]),
  permission: z.enum(["read", "comment", "write", "draft", "publish", "create"]),
  /** Omitted or null: every resource in the module. */
  resourceIds: z.array(uuid).min(1).max(MAX_RESOURCE_IDS).nullish()
}).strict();
export type GrantInput = z.infer<typeof grantInput>;

const reauthFields = {
  password: z.string().min(1).max(256),
  totpCode: totpCode.optional(),
  recoveryCode: recoveryCode.optional()
};

export const createKeySchema = z.object({
  name: z.string().trim().min(1).max(KEY_NAME_MAX),
  description: z.string().trim().max(KEY_DESCRIPTION_MAX).nullish(),
  surfaces: z.enum(["mcp", "rest", "both"]).default("mcp"),
  /** Days until the key expires; the policy default when omitted (D276). */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  grants: z.array(grantInput).min(1).max(MAX_GRANTS),
  limits: z.object({ callsPerMinute: z.number().int().min(1).optional(), writesPerMinute: z.number().int().min(1).optional() }).strict().optional(),
  ...reauthFields
}).strict().refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");

/** PATCH: narrowing only (D278). Every field is optional; the grants, when given, replace the current set. */
export const narrowKeySchema = z.object({
  name: z.string().trim().min(1).max(KEY_NAME_MAX).optional(),
  description: z.string().trim().max(KEY_DESCRIPTION_MAX).nullable().optional(),
  surfaces: z.enum(["mcp", "rest", "both"]).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  grants: z.array(grantInput).min(1).max(MAX_GRANTS).optional(),
  limits: z.object({ callsPerMinute: z.number().int().min(1).nullable().optional(), writesPerMinute: z.number().int().min(1).nullable().optional() }).strict().optional()
}).strict();

export const rotateKeySchema = z.object({
  graceHours: z.union([z.literal(0), z.literal(1), z.literal(24), z.literal(168)]).default(24),
  ...reauthFields
}).strict().refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");

export const adminRevokeSchema = z.object({ reason: z.string().trim().min(1).max(REVOKE_REASON_MAX) }).strict();

// ------------------------------------------------------------------------------ rows

type KeyRow = {
  id: string; user_id: string; name: string; description: string | null; key_prefix: string; kind: KeyKind; surfaces: KeySurfaces;
  scopes: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoke_after: string | null; revoked_at: string | null;
  rotated_from: string | null; revoked_by: string | null; revoke_reason: string | null; limits_json: string | null;
  role: Role; disabled_at: string | null;
};

const keyColumns = `k.id, k.user_id, k.name, k.description, k.key_prefix, k.kind, k.surfaces, k.scopes, k.created_at, k.last_used_at, k.expires_at,
  k.revoke_after, k.revoked_at, k.rotated_from, k.revoked_by, k.revoke_reason, k.limits_json, u.role, u.disabled_at`;

const keyById = db.query(`SELECT ${keyColumns} FROM mcp_api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ?`);
const grantsByKey = db.query("SELECT module, permission, resource_kind, resource_id FROM api_key_grants WHERE key_id = ? ORDER BY created_at, rowid");

export function loadGrants(keyId: string): Grant[] {
  return (grantsByKey.all(keyId) as Array<{ module: GrantModule; permission: KeyPermission; resource_kind: ResourceKind | null; resource_id: string | null }>)
    .map((row) => ({ module: row.module, permission: row.permission, resourceKind: row.resource_kind, resourceId: row.resource_id }));
}

export type KeyLimits = { callsPerMinute?: number; writesPerMinute?: number };

export function parseLimits(json: string | null): KeyLimits {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const out: KeyLimits = {};
    // Lower only (D282, T216): anything at or above the global limit is ignored.
    if (typeof value.callsPerMinute === "number" && value.callsPerMinute >= 1 && value.callsPerMinute < MCP_LIMITS.call.limit) out.callsPerMinute = Math.floor(value.callsPerMinute);
    if (typeof value.writesPerMinute === "number" && value.writesPerMinute >= 1 && value.writesPerMinute < MCP_LIMITS.write.limit) out.writesPerMinute = Math.floor(value.writesPerMinute);
    return out;
  } catch {
    return {};
  }
}

const isoMs = (value: string | null) => value === null ? null : Date.parse(value);

export type KeyState = "active" | "grace" | "expired" | "blocked" | "paused" | "revoked";

function keyState(row: KeyRow, policies: Policies, time = Date.now()): { state: KeyState; blockedBy: PolicyBlock | null } {
  if (row.revoked_at !== null) return { state: "revoked", blockedBy: null };
  if (row.revoke_after !== null && isoMs(row.revoke_after)! <= time) return { state: "revoked", blockedBy: null };
  if (row.expires_at !== null && isoMs(row.expires_at)! <= time) return { state: "expired", blockedBy: null };
  if (row.disabled_at !== null) return { state: "paused", blockedBy: null };
  // Listed as blocked when policy blocks it on every surface it may use (the preview counts the same).
  const blockedBy = surfaceBlocks({ createdAt: row.created_at, expiresAt: row.expires_at }, row.role, row.surfaces, policies).block;
  if (blockedBy) return { state: "blocked", blockedBy };
  return { state: row.revoke_after !== null ? "grace" : "active", blockedBy: null };
}

// ------------------------------------------------------------------------------ effective rights

export type InactiveReason = "role" | "policy" | "no-access";

/** Why one grant grants nothing right now, or null when it is active (T201: stored, listed, and dead weight). */
function grantInactiveReason(grant: Grant, role: Role, modules: readonly GrantModule[], userId: string): InactiveReason | null {
  const scope = scopeFor(grant.module, grant.permission);
  if (!scope || !mcpScopesForRole(role).includes(scope)) return "role";
  if (!modules.includes(grant.module)) return "policy";
  if (grant.resourceKind && grant.resourceId && !resourceReachable(userId, grant.resourceKind, grant.resourceId, grant.permission)) return "no-access";
  return null;
}

/** What a live key can use now: role-capped, policy-filtered grants and the scopes they amount to. */
function effectiveOf(row: KeyRow, grants: readonly Grant[], policies: Policies) {
  const allowed = mcpScopesForRole(row.role);
  const modules = activeModules(row.role, policies);
  const active: Grant[] = [];
  for (const grant of grants) {
    if (!modules.includes(grant.module)) continue;
    const scope = scopeFor(grant.module, grant.permission);
    if (scope !== null && allowed.includes(scope)) {
      active.push(grant);
      continue;
    }
    // A write the role cannot use still reads (a demoted member's write key keeps its reads, T81).
    const read = scopeFor(grant.module, "read");
    if (grant.permission !== "read" && read !== null && allowed.includes(read)) active.push({ ...grant, permission: "read" });
  }
  const scopes = grantsToScopes(active).filter((scope) => allowed.includes(scope));
  return { grants: active, scopes };
}

export type KeyActor = {
  keyId: string;
  userId: string;
  name: string;
  kind: KeyKind;
  /** Effective scopes (the compatibility view registration and handlers use). */
  scopes: McpScope[];
  /** Effective grants: role-capped and policy-filtered. */
  grants: Grant[];
  limits: KeyLimits;
};

export type KeyDenial = { code: "KEY_INACTIVE" | "KEY_POLICY"; message: string; reason?: PolicyBlock };

const blockLogged = new Set<string>();

/**
 * The key as it stands now for one call on `surface` (D263): refused when revoked, past its
 * grace, expired, its holder blocked, or blocked by policy; otherwise its effective grants.
 */
export function resolveKeyActor(keyId: string, surface: "mcp" | "rest" = "mcp", time = Date.now()): KeyActor | KeyDenial {
  const row = keyById.get(keyId) as KeyRow | null;
  if (!row || row.revoked_at !== null || row.disabled_at !== null) return { code: "KEY_INACTIVE", message: "This API key is no longer active" };
  if (row.revoke_after !== null && isoMs(row.revoke_after)! <= time) return { code: "KEY_INACTIVE", message: "This API key was rotated and its grace period has ended" };
  if (row.expires_at !== null && isoMs(row.expires_at)! <= time) return { code: "KEY_INACTIVE", message: "This API key has expired" };
  const surfaceAllowed = row.surfaces === "both" || row.surfaces === surface;
  if (!surfaceAllowed) return { code: "KEY_POLICY", message: surface === "mcp" ? "This API key is not allowed to use MCP" : "This API key is not allowed to use the REST API" };
  const policies = readPolicies();
  const blocked = policyBlock({ createdAt: row.created_at, expiresAt: row.expires_at }, row.role, surface, policies);
  if (blocked) {
    notePolicyBlock(row, blocked, time);
    return { code: "KEY_POLICY", message: POLICY_BLOCK_MESSAGES[blocked], reason: blocked };
  }
  const effective = effectiveOf(row, loadGrants(row.id), policies);
  return { keyId: row.id, userId: row.user_id, name: row.name, kind: row.kind, scopes: effective.scopes, grants: effective.grants, limits: parseLimits(row.limits_json) };
}

export const isKeyDenial = (value: KeyActor | KeyDenial): value is KeyDenial => "code" in value;

/** One `key.policy_blocked` event per key per day (§C.4), so the inventory can show it without a log flood. */
function notePolicyBlock(row: KeyRow, reason: PolicyBlock, time: number) {
  const day = new Date(time).toISOString().slice(0, 10);
  const marker = `${row.id}:${day}`;
  countKeyUsage(row.id, "denied");
  if (blockLogged.has(marker)) return;
  if (blockLogged.size > 5000) blockLogged.clear();
  blockLogged.add(marker);
  const already = db.query("SELECT 1 FROM access_events WHERE key_id = ? AND action = 'key.policy_blocked' AND created_at >= ? LIMIT 1").get(row.id, `${day}T00:00:00.000Z`);
  if (!already) recordAccessEvent({ actorId: null, via: row.surfaces === "rest" ? "rest" : "mcp", action: "key.policy_blocked", targetUserId: row.user_id, keyId: row.id, meta: { reason } });
}

// ------------------------------------------------------------------------------ resources

/** A resource a tool touches (D281), resolved to the container kind grants name in Wave 31. */
export type ToolResourceArg = "board" | "card" | "column" | "sprint" | "collection" | "row" | "calendar" | "event" | "whiteboard";

const containerLookups: Record<ToolResourceArg, { kind: ResourceKind; sql: string | null }> = {
  board: { kind: "board", sql: null },
  card: { kind: "board", sql: "SELECT board_id AS id FROM cards WHERE id = ?" },
  column: { kind: "board", sql: "SELECT board_id AS id FROM board_columns WHERE id = ?" },
  sprint: { kind: "board", sql: "SELECT board_id AS id FROM board_sprints WHERE id = ?" },
  collection: { kind: "collection", sql: null },
  row: { kind: "collection", sql: "SELECT collection_id AS id FROM collection_rows WHERE id = ?" },
  calendar: { kind: "calendar", sql: null },
  event: { kind: "calendar", sql: "SELECT calendar_id AS id FROM events WHERE id = ?" },
  // A whiteboard is its own container (Wave 23); only ids of real boards resolve.
  whiteboard: { kind: "whiteboard", sql: "SELECT document_id AS id FROM whiteboards WHERE document_id = ?" }
};

export const containerKindOf = (arg: ToolResourceArg) => containerLookups[arg].kind;

/** The container of a tool argument (a card's board, a row's collection, an event's calendar), or null. */
export function resolveContainer(arg: ToolResourceArg, id: string): { kind: ResourceKind; id: string } | null {
  const lookup = containerLookups[arg];
  if (!lookup.sql) return { kind: lookup.kind, id: id.toLowerCase() };
  const row = db.query(lookup.sql).get(id.toLowerCase()) as { id: string } | null;
  return row ? { kind: lookup.kind, id: row.id } : null;
}

/** Whether `userId` can reach a selectable resource now, at a level that fits `permission`. */
export function resourceReachable(userId: string, kind: ResourceKind, id: string, permission: KeyPermission) {
  const write = permission !== "read";
  switch (kind) {
    // Board members edit cards at `edit` and up (D38, D272); `comment` and `view` members read.
    case "board": return Boolean(db.query(`SELECT 1 FROM boards b WHERE b.id = $id AND ${write ? editableBoardPredicate : readableBoardPredicate}`).get({ id, userId }));
    case "collection": return Boolean(db.query(`SELECT 1 FROM collections c WHERE c.id = $id AND ${write ? editableCollectionPredicate : readableCollectionPredicate}`).get({ id, userId }));
    case "calendar": return Boolean(db.query(`SELECT 1 FROM calendars k WHERE k.id = $id AND ${write ? editableCalendarPredicate : readableCalendarPredicate}`).get({ id, userId }));
    // Whiteboards: readers read, only the owner writes (D195).
    case "whiteboard": return Boolean(db.query(`SELECT 1 FROM documents d JOIN whiteboards w ON w.document_id = d.id WHERE d.id = $id AND d.purpose = 'file'
      AND ${write ? "d.owner_id = $userId AND d.deleted_at IS NULL" : readableDocumentPredicate}`).get({ id, userId }));
    default: return false;
  }
}

function resourceName(userId: string, kind: ResourceKind, id: string): string | null {
  switch (kind) {
    case "board": return (db.query(`SELECT b.name FROM boards b WHERE b.id = $id AND ${readableBoardPredicate}`).get({ id, userId }) as { name: string } | null)?.name ?? null;
    case "collection": return (db.query(`SELECT c.name FROM collections c WHERE c.id = $id AND ${readableCollectionPredicate}`).get({ id, userId }) as { name: string } | null)?.name ?? null;
    case "calendar": return (db.query(`SELECT k.name FROM calendars k WHERE k.id = $id AND ${readableCalendarPredicate}`).get({ id, userId }) as { name: string } | null)?.name ?? null;
    case "whiteboard": {
      const name = (db.query(`SELECT d.name FROM documents d JOIN whiteboards w ON w.document_id = d.id WHERE d.id = $id AND d.purpose = 'file' AND ${readableDocumentPredicate}`).get({ id, userId }) as { name: string } | null)?.name;
      return name ? whiteboardDisplayName(name) : null;
    }
    default: return null;
  }
}

/**
 * How a key reaches the scopes a tool needs (D281): "all" when some grant covers the whole module,
 * a selector (kind and ids) when only resource grants do, or null when it cannot use the tool.
 * `anyOf` needs one scope; `allOf` needs each (alsoRequires, D172).
 */
export function toolReach(grants: readonly Grant[], held: readonly McpScope[], anyOf: readonly McpScope[], allOf: readonly McpScope[] = []) {
  const selectors: Array<{ kind: ResourceKind; ids: ReadonlySet<string> }> = [];
  const reachFor = (scope: McpScope) => hasScope(held, scope) ? scopeReach(grants, scope) : null;
  const any = anyOf.map(reachFor).filter((reach) => reach !== null);
  if (!any.length) return null;
  if (!any.includes("all")) selectors.push(...any.filter((reach) => reach !== "all"));
  for (const scope of allOf) {
    const reach = reachFor(scope);
    if (reach === null) return null;
    if (reach !== "all") selectors.push(reach);
  }
  return { all: selectors.length === 0, selectors };
}

// ------------------------------------------------------------------------------ creating keys

export class KeyError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "KeyError";
  }
}

/** Grants from the request, validated against the vocabulary, the holder's role, policy, and access (§C.4). */
export function validateGrants(userId: string, role: Role, inputs: readonly GrantInput[], policies: Policies): Grant[] {
  const allowed = mcpScopesForRole(role);
  const modules = activeModules(role, policies);
  const grants: Grant[] = [];
  let resourceCount = 0;
  for (const input of inputs) {
    if (!permissionsForModule(input.module).includes(input.permission)) throw new KeyError(400, "INVALID_GRANT", `Keys cannot hold ${input.permission} on ${input.module}`);
    const scope = scopeFor(input.module, input.permission)!;
    if (!allowed.includes(scope)) throw new KeyError(403, "SCOPE_NOT_ALLOWED", "Your team role cannot create a key with these permissions");
    if (!modules.includes(input.module)) throw new KeyError(403, "KEY_POLICY", "Team policy does not allow keys for this module for your team role", { module: input.module });
    if (!input.resourceIds) {
      grants.push({ module: input.module, permission: input.permission, resourceKind: null, resourceId: null });
      continue;
    }
    const kind = SELECTOR_KINDS[input.module];
    if (!kind) throw new KeyError(400, "INVALID_GRANT", `Keys for ${input.module} cover every item for now`);
    resourceCount += input.resourceIds.length;
    if (resourceCount > MAX_RESOURCE_IDS) throw new KeyError(400, "INVALID_GRANT", `A key can name at most ${MAX_RESOURCE_IDS} items`);
    for (const id of new Set(input.resourceIds)) {
      // Missing and unreadable look the same (T205).
      if (!resourceReachable(userId, kind, id, input.permission)) throw new KeyError(404, "RESOURCE_NOT_FOUND", "One of the chosen items was not found");
      grants.push({ module: input.module, permission: input.permission, resourceKind: kind, resourceId: id });
    }
  }
  const unique = dedupeGrants(grants);
  if (unique.length > MAX_GRANTS) throw new KeyError(400, "INVALID_GRANT", `A key can hold at most ${MAX_GRANTS} grants`);
  // A module is either "all" or selected items, never both (the builder offers one or the other).
  for (const module of new Set(unique.map((grant) => grant.module))) {
    const rows = unique.filter((grant) => grant.module === module);
    for (const permission of new Set(rows.map((grant) => grant.permission))) {
      const same = rows.filter((grant) => grant.permission === permission);
      if (same.some((grant) => grant.resourceKind === null) && same.some((grant) => grant.resourceKind !== null)) {
        throw new KeyError(400, "INVALID_GRANT", "A permission covers either every item or chosen items, not both");
      }
    }
  }
  return unique;
}

export function liveKeyCount(userId: string, time = Date.now()) {
  return (db.query(`SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?) AND (revoke_after IS NULL OR revoke_after > ?)`).get(userId, new Date(time).toISOString(), new Date(time).toISOString()) as { count: number }).count;
}

/** Policy and count checks shared by `/api/keys` and the `/api/mcp/keys` alias, before any code is consumed. */
export function checkCreatePolicy(userId: string, role: Role, input: { surfaces: KeySurfaces; expiresInDays?: number }, policies: Policies) {
  if (!can(role, "mcp.key.create")) throw new KeyError(403, "ROLE_READ_ONLY", "Your team role cannot create API keys");
  if ((input.surfaces === "mcp" || input.surfaces === "both") && !policies.mcpRoles.includes(role as "admin")) throw new KeyError(403, "KEY_POLICY", "Team policy does not allow your team role to use MCP keys");
  if ((input.surfaces === "rest" || input.surfaces === "both") && !policies.restRoles.includes(role as "admin")) throw new KeyError(403, "KEY_POLICY", "Team policy does not allow your team role to use REST keys");
  const days = input.expiresInDays ?? policies.keyDefaultDays;
  if (days > policies.keyMaxDays) throw new KeyError(403, "KEY_POLICY", `Team policy allows keys for at most ${policies.keyMaxDays} days`, { maxDays: policies.keyMaxDays });
  return Math.min(days, policies.keyMaxDays);
}

export function checkKeyCount(userId: string, policies: Policies) {
  if (liveKeyCount(userId) >= policies.keysPerUser) throw new KeyError(409, "KEY_LIMIT", "Revoke an existing API key before creating another", { limit: policies.keysPerUser });
}

type InsertInput = {
  userId: string; name: string; description: string | null; kind: KeyKind; surfaces: KeySurfaces; grants: readonly Grant[];
  expiresAt: string | null; limits: KeyLimits; rotatedFrom?: string | null; createdBy?: string | null; createdAt?: string;
};

/** Inserts the key, its grants, and the `scopes` mirror (rollback for one release, D262). Call inside a transaction. */
function insertKey(input: InsertInput) {
  const token = `${TOKEN_PREFIX[input.kind]}${randomBytes(32).toString("base64url")}`;
  const id = crypto.randomUUID();
  const createdAt = input.createdAt ?? now();
  const scopes = grantsToScopes(input.grants);
  const limits = Object.keys(input.limits).length ? JSON.stringify(input.limits) : null;
  db.query(`INSERT INTO mcp_api_keys (id, user_id, name, description, key_prefix, token_hash, scopes, created_at, kind, surfaces, expires_at, rotated_from, limits_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.userId, input.name, input.description, token.slice(0, 16), hashKeyToken(token), JSON.stringify(scopes), createdAt, input.kind, input.surfaces,
      input.expiresAt, input.rotatedFrom ?? null, limits, input.createdBy ?? null);
  const insertGrant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const grant of input.grants) insertGrant.run(crypto.randomUUID(), id, grant.module, grant.permission, grant.resourceKind, grant.resourceId, createdAt);
  return { id, token, prefix: token.slice(0, 16), scopes, createdAt };
}

const grantSummary = (grants: readonly Grant[]) => grants.map((grant) => `${grant.module}:${grant.permission}${grant.resourceId ? `@${grant.resourceKind}` : ""}`);

/**
 * Creates a general key. Validation, policy, and re-authentication are the caller's (the route
 * checks them in that order, so no code is consumed on a refusal).
 */
export function createApiKey(userId: string, input: { name: string; description?: string | null; surfaces: KeySurfaces; grants: readonly Grant[]; expiresInDays: number | null; limits?: KeyLimits }, options: { via?: AccessVia } = {}) {
  if (input.grants.length === 0) throw new KeyError(400, "INVALID_GRANT", "A key needs at least one permission");
  const createdAt = now();
  const expiresAt = input.expiresInDays === null ? null : new Date(Date.parse(createdAt) + input.expiresInDays * DAY_MS).toISOString();
  return db.transaction(() => {
    const created = insertKey({ userId, name: input.name, description: input.description ?? null, kind: "general", surfaces: input.surfaces, grants: input.grants, expiresAt, limits: input.limits ?? {}, createdAt });
    // The audit shape predates grants (Wave 8): keyId, name, and the scopes the grants amount to.
    audit(userId, null, "mcp.key_created", { keyId: created.id, name: input.name, scopes: created.scopes });
    recordAccessEvent({ actorId: userId, via: options.via ?? "web", action: "key.created", targetUserId: userId, keyId: created.id,
      meta: { grants: grantSummary(input.grants), surfaces: input.surfaces, expiresInDays: input.expiresInDays } }, createdAt);
    return { id: created.id, token: created.token, prefix: created.prefix, scopes: created.scopes, createdAt, expiresAt, name: input.name };
  })();
}

// ------------------------------------------------------------------------------ narrowing, rotating, revoking

function ownKey(userId: string, keyId: string) {
  const row = keyById.get(keyId) as KeyRow | null;
  return row && row.user_id === userId ? row : null;
}

const liveOwnKey = (userId: string, keyId: string) => {
  const row = ownKey(userId, keyId);
  if (!row || keyState(row, readPolicies()).state === "revoked") throw new KeyError(404, "NOT_FOUND", "API key not found");
  return row;
};

/** PATCH /api/keys/:id (D278): rename, describe, and narrow; anything that widens is refused. */
export function narrowApiKey(userId: string, keyId: string, patch: z.infer<typeof narrowKeySchema>) {
  const row = liveOwnKey(userId, keyId);
  const changed: string[] = [];
  const current = loadGrants(row.id);
  let nextGrants: Grant[] | null = null;
  if (patch.grants) {
    // Narrowing validates like creation (vocabulary and access), except that it never needs the
    // role or policy to allow the grant again: removing power is always allowed.
    const candidate: Grant[] = [];
    for (const input of patch.grants) {
      if (!permissionsForModule(input.module).includes(input.permission)) throw new KeyError(400, "INVALID_GRANT", `Keys cannot hold ${input.permission} on ${input.module}`);
      if (!input.resourceIds) candidate.push({ module: input.module, permission: input.permission, resourceKind: null, resourceId: null });
      else {
        const kind = SELECTOR_KINDS[input.module];
        if (!kind) throw new KeyError(400, "INVALID_GRANT", `Keys for ${input.module} cover every item for now`);
        for (const id of new Set(input.resourceIds)) candidate.push({ module: input.module, permission: input.permission, resourceKind: kind, resourceId: id });
      }
    }
    const unique = dedupeGrants(candidate);
    if (!isNarrowing(current, unique)) throw new KeyError(400, "WIDENING_NOT_ALLOWED", "Editing a key can only remove access. Create a new key to add access.");
    // Narrowing an "all" grant to chosen items: each item must be one the holder can reach (T205).
    for (const grant of unique) {
      if (grant.resourceId && !current.some((held) => grantKey(held) === grantKey(grant)) && !resourceReachable(userId, grant.resourceKind!, grant.resourceId, grant.permission)) {
        throw new KeyError(404, "RESOURCE_NOT_FOUND", "One of the chosen items was not found");
      }
    }
    if (unique.length > MAX_GRANTS) throw new KeyError(400, "INVALID_GRANT", `A key can hold at most ${MAX_GRANTS} grants`);
    const same = unique.length === current.length && unique.every((grant) => current.some((held) => grantKey(held) === grantKey(grant)));
    if (!same) {
      nextGrants = unique;
      changed.push("grants");
    }
  }
  let surfaces = row.surfaces;
  if (patch.surfaces && patch.surfaces !== row.surfaces) {
    if (row.surfaces !== "both") throw new KeyError(400, "WIDENING_NOT_ALLOWED", "Editing a key can only remove where it is used. Create a new key for another surface.");
    surfaces = patch.surfaces;
    changed.push("surfaces");
  }
  let expiresAt = row.expires_at;
  if (patch.expiresInDays !== undefined) {
    const next = new Date(Date.now() + patch.expiresInDays * DAY_MS).toISOString();
    if (row.expires_at !== null && Date.parse(next) > Date.parse(row.expires_at)) throw new KeyError(400, "WIDENING_NOT_ALLOWED", "Editing a key can only bring its expiry closer. Rotate it for a new lifetime.");
    expiresAt = next;
    changed.push("expiry");
  }
  const currentLimits = parseLimits(row.limits_json);
  let limits = currentLimits;
  if (patch.limits) {
    const next: KeyLimits = { ...currentLimits };
    for (const field of ["callsPerMinute", "writesPerMinute"] as const) {
      const value = patch.limits[field];
      if (value === undefined) continue;
      const ceiling = field === "callsPerMinute" ? MCP_LIMITS.call.limit : MCP_LIMITS.write.limit;
      const held = currentLimits[field];
      // Clearing a lower limit, or raising one, widens the key.
      if (value === null ? held !== undefined : held !== undefined && value > held) throw new KeyError(400, "WIDENING_NOT_ALLOWED", "Editing a key can only lower its limits");
      // At or above the global limit there is nothing to lower.
      if (value === null || value >= ceiling) continue;
      next[field] = value;
    }
    if (JSON.stringify(next) !== JSON.stringify(currentLimits)) {
      limits = next;
      changed.push("limits");
    }
  }
  const name = patch.name ?? row.name;
  if (patch.name !== undefined && patch.name !== row.name) changed.push("name");
  const description = patch.description === undefined ? row.description : (patch.description?.trim() || null);
  if (patch.description !== undefined && description !== row.description) changed.push("description");
  if (!changed.length) return { changed };
  db.transaction(() => {
    const timestamp = now();
    const scopes = nextGrants ? grantsToScopes(nextGrants) : null;
    db.query(`UPDATE mcp_api_keys SET name = ?, description = ?, surfaces = ?, expires_at = ?, limits_json = ?, scopes = COALESCE(?, scopes) WHERE id = ? AND user_id = ?`)
      .run(name, description, surfaces, expiresAt, Object.keys(limits).length ? JSON.stringify(limits) : null, scopes ? JSON.stringify(scopes) : null, row.id, userId);
    if (nextGrants) {
      db.query("DELETE FROM api_key_grants WHERE key_id = ?").run(row.id);
      const insertGrant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const grant of nextGrants) insertGrant.run(crypto.randomUUID(), row.id, grant.module, grant.permission, grant.resourceKind, grant.resourceId, timestamp);
    }
    recordAccessEvent({ actorId: userId, via: "web", action: "key.narrowed", targetUserId: userId, keyId: row.id,
      meta: { fields: changed, ...(nextGrants ? { grantsBefore: current.length, grantsAfter: nextGrants.length } : {}) } }, timestamp);
    audit(userId, null, "key.narrowed", { keyId: row.id, fields: changed });
  })();
  return { changed };
}

/** Withdraws the pending proposals a key made (review M1), when it stops working. */
function supersedeProposals(keyId: string, ownerId: string, timestamp: string) {
  return db.query(`UPDATE proposals SET status = 'superseded', result_code = 'KEY_REVOKED', resolved_at = ?, base_draft_markdown = NULL
    WHERE key_id = ? AND owner_id = ? AND status = 'pending'`).run(timestamp, keyId, ownerId).changes;
}

/**
 * The checks a rotation runs, the same as creating a key (review L1), before the password and again
 * inside rotateApiKey: the holder's role may create keys (a guest may not, even for a key made
 * before a demotion), policy allows the key's surfaces and every module it holds, the role allows
 * every permission, and the count has room for the new key. The old key still counts while its
 * grace runs, so a rotation with grace needs a free slot; a 0-hour rotation revokes the old key in
 * the same transaction and needs none. An expired key may be rotated (with the password): that is
 * how its holder renews it without re-entering its grants.
 */
export function checkRotation(userId: string, keyId: string, graceHours: typeof GRACE_HOURS[number]) {
  const row = liveOwnKey(userId, keyId);
  if (row.revoke_after !== null) throw new KeyError(409, "KEY_ROTATING", "This key was already rotated. Revoke it now or wait for its grace period to end.");
  const policies = readPolicies();
  checkCreatePolicy(userId, row.role, { surfaces: row.surfaces }, policies);
  const allowed = mcpScopesForRole(row.role);
  const modules = activeModules(row.role, policies);
  for (const grant of loadGrants(row.id)) {
    const scope = scopeFor(grant.module, grant.permission);
    if (!scope || !allowed.includes(scope)) throw new KeyError(403, "SCOPE_NOT_ALLOWED", "Your team role cannot hold this key's permissions. Create a new key instead.");
    if (!modules.includes(grant.module)) throw new KeyError(403, "KEY_POLICY", "Team policy does not allow keys for this module for your team role", { module: grant.module });
  }
  if (graceHours > 0) checkKeyCount(userId, policies);
  return { row, policies };
}

/**
 * POST /api/keys/:id/rotate (D277), after re-authentication: a new token with the same name,
 * grants, surfaces, and limits, linked by `rotated_from`. The old key works for `graceHours`, then
 * stops. Routines bound to the old key move to the new one in the same transaction.
 */
export function rotateApiKey(userId: string, keyId: string, graceHours: typeof GRACE_HOURS[number]) {
  const { row, policies } = checkRotation(userId, keyId, graceHours);
  const lifetimeDays = row.expires_at === null ? policies.keyDefaultDays
    : Math.max(1, Math.round((Date.parse(row.expires_at) - Date.parse(row.created_at)) / DAY_MS));
  const days = Math.min(lifetimeDays, policies.keyMaxDays);
  const grants = loadGrants(row.id);
  if (!grants.length) throw new KeyError(409, "NO_GRANTS", "This key has no permissions left. Create a new key instead.");
  const createdAt = now();
  const expiresAt = new Date(Date.parse(createdAt) + days * DAY_MS).toISOString();
  const revokeAfter = new Date(Date.parse(createdAt) + graceHours * 3_600_000).toISOString();
  return db.transaction(() => {
    const created = insertKey({ userId, name: row.name, description: row.description, kind: row.kind, surfaces: row.surfaces, grants, expiresAt, limits: parseLimits(row.limits_json), rotatedFrom: row.id, createdAt });
    if (graceHours === 0) {
      db.query("UPDATE mcp_api_keys SET revoked_at = ?, revoke_after = ? WHERE id = ?").run(createdAt, createdAt, row.id);
      supersedeProposals(row.id, userId, createdAt);
    } else {
      db.query("UPDATE mcp_api_keys SET revoke_after = ? WHERE id = ?").run(revokeAfter, row.id);
    }
    const routines = db.query("UPDATE routines SET key_id = ? WHERE key_id = ? AND owner_id = ?").run(created.id, row.id, userId).changes;
    recordAccessEvent({ actorId: userId, via: "web", action: "key.rotated", targetUserId: userId, keyId: row.id, meta: { newKeyId: created.id, graceHours, routinesMoved: routines } }, createdAt);
    recordAccessEvent({ actorId: userId, via: "web", action: "key.created", targetUserId: userId, keyId: created.id, meta: { rotatedFrom: row.id, grants: grantSummary(grants), expiresInDays: days } }, createdAt);
    audit(userId, null, "mcp.key_created", { keyId: created.id, name: row.name, scopes: created.scopes, rotatedFrom: row.id });
    audit(userId, null, "key.rotated", { keyId: row.id, newKeyId: created.id, graceHours });
    return { id: created.id, token: created.token, prefix: created.prefix, scopes: created.scopes, createdAt, expiresAt, name: row.name, oldKey: { id: row.id, revokeAfter: graceHours === 0 ? createdAt : revokeAfter } };
  })();
}

/** Revokes one of the caller's keys now (also ends a rotation grace early). Pending proposals go with it. */
export function revokeOwnKey(userId: string, keyId: string) {
  return db.transaction(() => {
    const timestamp = now();
    // The owner is recorded as the actor, so a revoke during a rotation grace reads "self", not "rotation".
    const result = db.query("UPDATE mcp_api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(timestamp, userId, keyId, userId);
    if (!result.changes) return false;
    const superseded = supersedeProposals(keyId, userId, timestamp);
    audit(userId, null, "mcp.key_revoked", { keyId, ...(superseded ? { proposalsSuperseded: superseded } : {}) });
    recordAccessEvent({ actorId: userId, via: "web", action: "key.revoked", targetUserId: userId, keyId, meta: { by: "self" } }, timestamp);
    return true;
  })();
}

/** POST /api/team/keys/:id/revoke: an admin revokes anyone's key, with a reason only admins and the owner see. */
export function adminRevokeKey(actorId: string, keyId: string, reason: string) {
  return db.transaction(() => {
    const row = keyById.get(keyId) as KeyRow | null;
    if (!row || row.revoked_at !== null) return null;
    const timestamp = now();
    const cleanReason = reason.trim().slice(0, REVOKE_REASON_MAX);
    db.query("UPDATE mcp_api_keys SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL").run(timestamp, actorId, cleanReason, row.id);
    const superseded = supersedeProposals(row.id, row.user_id, timestamp);
    // Ids only; the reason's length, never its text (T83).
    recordAccessEvent({ actorId, via: "web", action: "key.revoked", targetUserId: row.user_id, keyId: row.id, meta: { by: "admin", reasonLength: cleanReason.length } }, timestamp);
    audit(actorId, null, "team.key_revoked", { keyId: row.id, targetId: row.user_id, ...(superseded ? { proposalsSuperseded: superseded } : {}) });
    return { keyId: row.id, ownerId: row.user_id, revokedAt: timestamp };
  })();
}

/** Sweeper: rotation graces that ended become revocations (their proposals are withdrawn). */
export function sweepKeyGraces(nowMs = Date.now()) {
  const timestamp = new Date(nowMs).toISOString();
  const due = db.query("SELECT id, user_id, revoke_after FROM mcp_api_keys WHERE revoked_at IS NULL AND revoke_after IS NOT NULL AND revoke_after <= ?")
    .all(timestamp) as Array<{ id: string; user_id: string; revoke_after: string }>;
  for (const key of due) {
    db.transaction(() => {
      if (!db.query("UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(key.revoke_after, key.id).changes) return;
      supersedeProposals(key.id, key.user_id, timestamp);
      recordAccessEvent({ actorId: null, via: "sweeper", action: "key.grace_ended", targetUserId: key.user_id, keyId: key.id }, timestamp);
    })();
  }
  flushKeyUsage();
  const trimmed = db.query("DELETE FROM api_key_usage WHERE day < ?").run(new Date(nowMs - 90 * DAY_MS).toISOString().slice(0, 10)).changes;
  return { gracesEnded: due.length, usageTrimmed: trimmed };
}

// ------------------------------------------------------------------------------ usage (D283)

type Usage = { calls: number; writes: number; denied: number };
const pendingUsage = new Map<string, Usage>();
let usageTimer: ReturnType<typeof setInterval> | null = null;

/** Counts one call in memory; flushed every minute and before any read (lossy by up to a minute on a crash). */
export function countKeyUsage(keyId: string, kind: "call" | "write" | "denied") {
  const day = new Date().toISOString().slice(0, 10);
  const marker = `${keyId}|${day}`;
  const usage = pendingUsage.get(marker) ?? { calls: 0, writes: 0, denied: 0 };
  if (kind === "call") usage.calls += 1;
  else if (kind === "write") usage.writes += 1;
  else usage.denied += 1;
  pendingUsage.set(marker, usage);
}

export function flushKeyUsage() {
  if (!pendingUsage.size) return;
  const entries = [...pendingUsage.entries()];
  pendingUsage.clear();
  const upsert = db.query(`INSERT INTO api_key_usage (key_id, day, calls, writes, denied) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key_id, day) DO UPDATE SET calls = calls + excluded.calls, writes = writes + excluded.writes, denied = denied + excluded.denied`);
  db.transaction(() => {
    for (const [marker, usage] of entries) {
      const [keyId, day] = marker.split("|") as [string, string];
      if (!db.query("SELECT 1 FROM mcp_api_keys WHERE id = ?").get(keyId)) continue;
      upsert.run(keyId, day, usage.calls, usage.writes, usage.denied);
    }
  })();
}

export function startKeyUsageFlusher() {
  if (usageTimer) return;
  usageTimer = setInterval(() => {
    try {
      flushKeyUsage();
    } catch (error) {
      console.error("Key usage flush failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, 60_000);
  usageTimer.unref();
}

/** Admitted calls per day (reads + writes) for the last 14 days, oldest first, for each key.
 *  The table keeps the split in its `calls` (reads) and `writes` columns. */
function usage14d(keyIds: readonly string[]) {
  flushKeyUsage();
  const days = Array.from({ length: 14 }, (_, index) => new Date(Date.now() - (13 - index) * DAY_MS).toISOString().slice(0, 10));
  const result = new Map<string, number[]>();
  if (!keyIds.length) return result;
  const rows = db.query(`SELECT key_id, day, calls + writes AS calls FROM api_key_usage WHERE day >= ? AND key_id IN (${keyIds.map(() => "?").join(",")})`)
    .all(days[0]!, ...keyIds) as Array<{ key_id: string; day: string; calls: number }>;
  for (const id of keyIds) result.set(id, days.map(() => 0));
  for (const row of rows) {
    const index = days.indexOf(row.day);
    if (index >= 0) result.get(row.key_id)![index] = row.calls;
  }
  return result;
}

// ------------------------------------------------------------------------------ listing

export type GrantView = {
  module: GrantModule; permission: KeyPermission;
  resource: { kind: ResourceKind; id: string; name: string | null } | null;
  active: boolean; inactiveReason: InactiveReason | null;
};

export type ApiKeyView = {
  id: string; name: string; description: string | null; prefix: string; kind: KeyKind; surfaces: KeySurfaces;
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokeAfter: string | null; revokedAt: string | null;
  rotatedFrom: string | null; state: KeyState; blockedBy: PolicyBlock | null; blockedMessage: string | null;
  revokedBy: "self" | "admin" | "rotation" | null; revokeReason: string | null;
  grants: GrantView[]; scopes: McpScope[]; effectiveScopes: McpScope[]; limits: KeyLimits; usage14d: number[];
};

/**
 * Who stopped a key (review L4): an admin (`revoked_by` is someone else), the owner (`revoked_by` is
 * them; also an owner revoke from before it was recorded, which lands before the grace end), or the
 * rotation (the grace ran out, or a 0-hour rotation revoked it at the grace end itself).
 */
function revokedByOf(row: KeyRow, state: KeyState): ApiKeyView["revokedBy"] {
  if (row.revoked_at === null && state !== "revoked") return null;
  if (row.revoked_by) return row.revoked_by === row.user_id ? "self" : "admin";
  if (row.revoke_after === null) return "self";
  return row.revoked_at === null || Date.parse(row.revoked_at) >= Date.parse(row.revoke_after) ? "rotation" : "self";
}

function present(row: KeyRow, grants: readonly Grant[], policies: Policies, usage: number[], viewerIsOwner: boolean): ApiKeyView {
  const { state, blockedBy } = keyState(row, policies);
  const modules = activeModules(row.role, policies);
  const effective = effectiveOf(row, grants, policies);
  const revokedBy = revokedByOf(row, state);
  return {
    id: row.id, name: row.name, description: row.description, prefix: row.key_prefix, kind: row.kind, surfaces: row.surfaces,
    createdAt: row.created_at, lastUsedAt: row.last_used_at, expiresAt: row.expires_at, revokeAfter: row.revoke_after, revokedAt: row.revoked_at,
    rotatedFrom: row.rotated_from, state, blockedBy, blockedMessage: blockedBy ? POLICY_BLOCK_MESSAGES[blockedBy] : null,
    revokedBy, revokeReason: viewerIsOwner || revokedBy === "admin" ? row.revoke_reason : null,
    grants: grants.map((grant) => {
      const reason = grantInactiveReason(grant, row.role, modules, row.user_id);
      // Names only for items the key's owner can still read (T204); the owner is the viewer here.
      const name = grant.resourceKind && grant.resourceId && viewerIsOwner ? resourceName(row.user_id, grant.resourceKind, grant.resourceId) : null;
      return { module: grant.module, permission: grant.permission, resource: grant.resourceKind && grant.resourceId ? { kind: grant.resourceKind, id: grant.resourceId, name } : null, active: reason === null, inactiveReason: reason };
    }),
    scopes: grantsToScopes(grants), effectiveScopes: effective.scopes, limits: parseLimits(row.limits_json), usage14d: usage
  };
}

/** The caller's keys: live ones (including expired, in grace, or blocked) plus those revoked in the last 7 days. */
export function listApiKeys(userId: string) {
  const since = new Date(Date.now() - RECENTLY_REVOKED_MS).toISOString();
  const rows = db.query(`SELECT ${keyColumns} FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.user_id = ? AND (k.revoked_at IS NULL OR k.revoked_at >= ?) ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC LIMIT 100`).all(userId, since) as KeyRow[];
  const policies = readPolicies();
  const usage = usage14d(rows.map((row) => row.id));
  const keys = rows.map((row) => present(row, loadGrants(row.id), policies, usage.get(row.id) ?? [], true));
  return { keys, policy: { keyMaxDays: policies.keyMaxDays, keyDefaultDays: policies.keyDefaultDays, keyRequireExpiry: policies.keyRequireExpiry, keysPerUser: policies.keysPerUser, modules: activeModules(userRole(userId) ?? "guest", policies), mcpAllowed: policies.mcpRoles.includes((userRole(userId) ?? "guest") as "admin"), restAllowed: policies.restRoles.includes((userRole(userId) ?? "guest") as "admin") }, liveCount: liveKeyCount(userId) };
}

const userRole = (userId: string) => (db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: Role } | null)?.role ?? null;

/** One of the caller's keys (any state), or null. */
export function ownApiKey(userId: string, keyId: string) {
  const row = ownKey(userId, keyId);
  if (!row) return null;
  return present(row, loadGrants(row.id), readPolicies(), usage14d([row.id]).get(row.id) ?? [], true);
}

// ------------------------------------------------------------------------------ admin inventory (T215, T218)

export type InventoryFilter = { owner?: string; module?: GrantModule; state?: "active" | "expiring" | "no_expiry" | "blocked" | "grace" | "unused" | "expired"; cursor?: string };

export type InventoryKey = ApiKeyView & { owner: { id: string; displayName: string; role: Role; blocked: boolean } };

export const INVENTORY_PAGE = 200;

/**
 * Every unrevoked key across the team, metadata only: prefix, name, owner, grant summary (module
 * and permission; resource names never, T204), expiry, last use, and state. Never a hash or token.
 */
export function listInventory(filter: InventoryFilter, time = Date.now()) {
  const params: Array<string | number> = [];
  const policies = readPolicies();
  let where = "k.revoked_at IS NULL";
  // The state filter runs in SQL, before the page cut, so pages are full and nextCursor is honest
  // (review L3). Each condition mirrors keyState: grace ended, then expired, paused, blocked.
  if (filter.state) {
    const at = new Date(time).toISOString();
    const graceEnded = "(k.revoke_after IS NOT NULL AND k.revoke_after <= ?)";
    const expired = "(k.expires_at IS NOT NULL AND k.expires_at <= ?)";
    const blocked = blockedKeySql(policies);
    const usable = `NOT ${graceEnded} AND NOT ${expired} AND u.disabled_at IS NULL`;
    switch (filter.state) {
      case "active":
      case "grace":
        where += ` AND ${usable} AND NOT ${blocked.sql} AND k.revoke_after IS ${filter.state === "active" ? "NULL" : "NOT NULL"}`;
        params.push(at, at, ...blocked.params);
        break;
      case "blocked":
        where += ` AND ${usable} AND ${blocked.sql}`;
        params.push(at, at, ...blocked.params);
        break;
      case "expired":
        where += ` AND NOT ${graceEnded} AND ${expired}`;
        params.push(at, at);
        break;
      case "expiring":
        where += " AND k.expires_at IS NOT NULL AND k.expires_at > ? AND k.expires_at < ?";
        params.push(at, new Date(time + 14 * DAY_MS).toISOString());
        break;
      case "no_expiry":
        where += " AND k.expires_at IS NULL";
        break;
      case "unused":
        where += " AND (k.last_used_at IS NULL OR k.last_used_at < ?)";
        params.push(new Date(time - 90 * DAY_MS).toISOString());
        break;
    }
  }
  if (filter.owner) {
    where += " AND k.user_id = ?";
    params.push(filter.owner);
  }
  if (filter.module) {
    where += " AND EXISTS (SELECT 1 FROM api_key_grants g WHERE g.key_id = k.id AND g.module = ?)";
    params.push(filter.module);
  }
  if (filter.cursor) {
    const [createdAt, id] = filter.cursor.split("|");
    if (createdAt && id) {
      where += " AND (k.created_at < ? OR (k.created_at = ? AND k.id < ?))";
      params.push(createdAt, createdAt, id);
    }
  }
  const rows = db.query(`SELECT ${keyColumns}, u.display_name AS owner_name FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
    WHERE ${where} ORDER BY k.created_at DESC, k.id DESC LIMIT ${INVENTORY_PAGE + 1}`).all(...params) as Array<KeyRow & { owner_name: string }>;
  const page = rows.slice(0, INVENTORY_PAGE);
  const usage = usage14d(page.map((row) => row.id));
  const keys: InventoryKey[] = page.map((row) => ({
    ...present(row, loadGrants(row.id), policies, usage.get(row.id) ?? [], false),
    owner: { id: row.user_id, displayName: row.owner_name, role: row.role, blocked: row.disabled_at !== null }
  })).map((key) => ({ ...key, grants: key.grants.map((grant) => ({ ...grant, resource: grant.resource ? { kind: grant.resource.kind, id: grant.resource.id, name: null } : null })) }));
  const last = page.at(-1);
  const summary = db.query(`SELECT COUNT(*) AS live, SUM(CASE WHEN k.expires_at IS NULL THEN 1 ELSE 0 END) AS no_expiry
    FROM mcp_api_keys k WHERE k.revoked_at IS NULL`).get() as { live: number; no_expiry: number | null };
  return {
    keys,
    nextCursor: rows.length > INVENTORY_PAGE && last ? `${last.created_at}|${last.id}` : null,
    summary: { live: summary.live, noExpiry: summary.no_expiry ?? 0 }
  };
}

/**
 * Test hook: replaces a key's grants with "all" grants for exactly `scopes` (the stored-scopes
 * shape older tests set directly), keeping the `scopes` mirror in step.
 */
export function setKeyScopesForTests(keyId: string, scopes: readonly McpScope[]) {
  const at = now();
  db.transaction(() => {
    db.query("DELETE FROM api_key_grants WHERE key_id = ?").run(keyId);
    const insertGrant = db.query("INSERT OR IGNORE INTO api_key_grants (id, key_id, module, permission, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const scope of scopes) {
      const grant = grantsForScopesExact(scope);
      insertGrant.run(crypto.randomUUID(), keyId, grant.module, grant.permission, at);
    }
    db.query("UPDATE mcp_api_keys SET scopes = ? WHERE id = ?").run(JSON.stringify(scopes), keyId);
  })();
}

const grantsForScopesExact = (scope: McpScope) => SCOPE_GRANTS[scope];
