import { z } from "zod";
import { audit, db, now } from "../db";
import { recordAccessEvent } from "../access/events";
import { GENERAL_KEY_MODULES, type GrantModule, type KeySurfaces } from "../keyGrants";
import type { Role } from "./roles";

/**
 * Org policies (docs/plan/research/2026-09-28-access-management-api-keys.md D285, D276, T209).
 * One `team_settings` row per setting; a missing row is the default. Policies are read on every
 * key call (no cache across calls), so tightening one takes effect on the next call. A key that
 * breaks a policy is blocked with KEY_POLICY, never revoked, so loosening the policy again brings
 * it back.
 *
 * Wave 31 enforces the key settings. `groups_member_create` and `share_with_guests` are stored and
 * validated now; Wave 32 enforces them.
 */

export const KEY_MAX_DAYS_LIMIT = 365;
export const KEYS_PER_USER_LIMIT = 50;
/** Roles whose keys the module policy can shape (guests hold no keys, O6). */
export const KEY_ROLES = ["admin", "member", "viewer"] as const;
export type KeyRole = typeof KEY_ROLES[number];

export type Policies = {
  keyMaxDays: number;
  keyDefaultDays: number;
  keyRequireExpiry: boolean;
  keysPerUser: number;
  keyModulesByRole: Record<KeyRole, GrantModule[]>;
  mcpRoles: KeyRole[];
  restRoles: KeyRole[];
  groupsMemberCreate: boolean;
  shareWithGuests: boolean;
};

export const DEFAULT_POLICIES: Policies = {
  keyMaxDays: 365,
  keyDefaultDays: 90,
  // Off for the first release (O-A6), so pre-025 keys without an expiry keep working.
  keyRequireExpiry: false,
  keysPerUser: 10,
  keyModulesByRole: { admin: [...GENERAL_KEY_MODULES], member: [...GENERAL_KEY_MODULES], viewer: [...GENERAL_KEY_MODULES] },
  mcpRoles: ["admin", "member", "viewer"],
  restRoles: ["admin", "member"],
  groupsMemberCreate: false,
  shareWithGuests: true
};

const COLUMNS: Record<keyof Policies, string> = {
  keyMaxDays: "key_max_days",
  keyDefaultDays: "key_default_days",
  keyRequireExpiry: "key_require_expiry",
  keysPerUser: "keys_per_user",
  keyModulesByRole: "key_modules_by_role",
  mcpRoles: "mcp_roles",
  restRoles: "rest_roles",
  groupsMemberCreate: "groups_member_create",
  shareWithGuests: "share_with_guests"
};

const moduleList = z.array(z.enum(GENERAL_KEY_MODULES as [GrantModule, ...GrantModule[]])).max(GENERAL_KEY_MODULES.length)
  .transform((modules) => GENERAL_KEY_MODULES.filter((module) => modules.includes(module)));
const roleList = z.array(z.enum(KEY_ROLES)).max(KEY_ROLES.length).transform((roles) => KEY_ROLES.filter((role) => roles.includes(role)));

const policyFields = {
  keyMaxDays: z.number().int().min(1).max(KEY_MAX_DAYS_LIMIT),
  keyDefaultDays: z.number().int().min(1).max(KEY_MAX_DAYS_LIMIT),
  keyRequireExpiry: z.boolean(),
  keysPerUser: z.number().int().min(1).max(KEYS_PER_USER_LIMIT),
  keyModulesByRole: z.object({ admin: moduleList, member: moduleList, viewer: moduleList }).strict(),
  mcpRoles: roleList,
  restRoles: roleList,
  groupsMemberCreate: z.boolean(),
  shareWithGuests: z.boolean()
} satisfies Record<keyof Policies, z.ZodType>;

export const policiesSchema = z.object(policyFields).strict()
  .refine((value) => value.keyDefaultDays <= value.keyMaxDays, { message: "The default lifetime cannot be longer than the maximum", path: ["keyDefaultDays"] });

/** `PUT /api/team/policies`: the whole set plus the revision it was based on (CAS). */
export const putPoliciesSchema = z.object({ policies: policiesSchema, revision: z.number().int().min(0) }).strict();
export const previewPoliciesSchema = z.object({ policies: policiesSchema }).strict();

const readRows = db.query("SELECT key, value_json, revision, updated_at, updated_by FROM team_settings");

/** The current policies; a stored value that no longer validates falls back to its default (fail safe to the documented default). */
export function readPolicies(): Policies {
  const rows = readRows.all() as Array<{ key: string; value_json: string }>;
  const stored = new Map(rows.map((row) => [row.key, row.value_json]));
  const merged: Record<string, unknown> = { ...DEFAULT_POLICIES };
  for (const [field, column] of Object.entries(COLUMNS)) {
    const json = stored.get(column);
    if (json === undefined) continue;
    try {
      merged[field] = JSON.parse(json);
    } catch {
      // keep the default
    }
  }
  const parsed = policiesSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // One bad row must not disable every policy: keep each field that validates on its own.
  const safe = { ...DEFAULT_POLICIES } as Record<string, unknown>;
  for (const [field, schema] of Object.entries(policyFields)) {
    const value = (schema as z.ZodType).safeParse(merged[field]);
    if (value.success) safe[field] = value.data;
  }
  const result = safe as Policies;
  return { ...result, keyDefaultDays: Math.min(result.keyDefaultDays, result.keyMaxDays) };
}

/** The policies revision: the sum of the rows' revisions, 0 before any change. Every change raises it. */
export function policiesRevision() {
  return (db.query("SELECT COALESCE(SUM(revision), 0) AS revision FROM team_settings").get() as { revision: number }).revision;
}

export function policiesState() {
  const updated = db.query("SELECT s.updated_at, s.updated_by, u.display_name FROM team_settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.updated_at DESC LIMIT 1")
    .get() as { updated_at: string; updated_by: string | null; display_name: string | null } | null;
  return {
    policies: readPolicies(),
    defaults: DEFAULT_POLICIES,
    revision: policiesRevision(),
    updatedAt: updated?.updated_at ?? null,
    updatedBy: updated?.updated_by && updated.display_name !== null ? { id: updated.updated_by, displayName: updated.display_name } : null
  };
}

export class PolicyError extends Error {
  constructor(readonly status: 409, readonly code: "POLICIES_CHANGED", message: string) {
    super(message);
  }
}

/** Saves every changed setting in one transaction with a compare-and-swap on the revision. */
export function writePolicies(actorId: string, next: Policies, expectedRevision: number) {
  return db.transaction(() => {
    if (policiesRevision() !== expectedRevision) throw new PolicyError(409, "POLICIES_CHANGED", "The policies were changed by someone else. Review them and try again.");
    const current = readPolicies();
    const changed: string[] = [];
    const timestamp = now();
    for (const [field, column] of Object.entries(COLUMNS) as Array<[keyof Policies, string]>) {
      if (JSON.stringify(current[field]) === JSON.stringify(next[field])) continue;
      changed.push(column);
      db.query(`INSERT INTO team_settings (key, value_json, revision, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = team_settings.revision + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(column, JSON.stringify(next[field]), actorId, timestamp);
    }
    if (changed.length) {
      recordAccessEvent({ actorId, via: "web", action: "policy.changed", meta: { settings: changed } }, timestamp);
      audit(actorId, null, "team.policies_changed", { settings: changed });
    }
    return { changed };
  })();
}

/** Test hook: back to the defaults (team_settings is not append-only). */
export function resetPoliciesForTests() {
  db.exec("DELETE FROM team_settings");
}

// ------------------------------------------------------------------ call-time checks

const DAY_MS = 86_400_000;
/** Clock slack for "lifetime within the maximum", so a key made at exactly the maximum stays compliant. */
const LIFETIME_SLACK_MS = 5 * 60_000;

export type PolicyBlock = "expiry_required" | "lifetime" | "surface_role";

export const POLICY_BLOCK_MESSAGES: Record<PolicyBlock, string> = {
  expiry_required: "Team policy requires every API key to have an expiry date. Rotate this key or create a new one.",
  lifetime: "This API key lasts longer than team policy allows. Rotate it or create a new one with a shorter expiry.",
  surface_role: "Team policy does not allow your team role to use API keys here."
};

/**
 * Why `key` is blocked by `policies` for a holder with `role` on `surface`, or null when it complies.
 * Module rules do not block the whole key: they make grants in disallowed modules inactive
 * (`activeModules`).
 */
export function policyBlock(key: { createdAt: string; expiresAt: string | null }, role: Role, surface: "mcp" | "rest", policies: Policies = readPolicies()): PolicyBlock | null {
  // A guest's key is not blocked but holds nothing: the role cap already empties its scopes (O6).
  const roles: readonly Role[] = surface === "mcp" ? policies.mcpRoles : policies.restRoles;
  if (role !== "guest" && !roles.includes(role)) return "surface_role";
  if (key.expiresAt === null) return policies.keyRequireExpiry ? "expiry_required" : null;
  const lifetime = Date.parse(key.expiresAt) - Date.parse(key.createdAt);
  if (lifetime > policies.keyMaxDays * DAY_MS + LIFETIME_SLACK_MS) return "lifetime";
  return null;
}

/** The modules a key held by `role` may use under the policy (grants elsewhere are inactive). */
export function activeModules(role: Role, policies: Policies = readPolicies()): readonly GrantModule[] {
  return role === "guest" ? [] : policies.keyModulesByRole[role];
}

/** Why a key is blocked on every surface it may use (null when one still works), and whether one of two is blocked. */
export function surfaceBlocks(key: { createdAt: string; expiresAt: string | null }, role: Role, surfaces: KeySurfaces, policies: Policies) {
  const each = (surfaces === "both" ? ["mcp", "rest"] as const : [surfaces]).map((surface) => policyBlock(key, role, surface, policies));
  return { block: each.every((block) => block !== null) ? each[0]! : null, partly: each.some((block) => block !== null) };
}

/**
 * The impact of proposed policies (the preview line above Save): how many live keys would be
 * blocked, and how many would lose something without being blocked (a module, or one of the two
 * surfaces of a `both` key). Live means usable now: not revoked, not expired, and not past a
 * rotation grace (review L2). Each key is checked on its own surfaces: `mcpRoles` for MCP keys,
 * `restRoles` for REST keys, and both for `both` keys (blocked only when both are).
 */
export function policyImpact(proposed: Policies, time = Date.now()) {
  const at = new Date(time).toISOString();
  const keys = db.query(`SELECT k.id, k.created_at, k.expires_at, k.surfaces, u.role FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.revoked_at IS NULL AND u.disabled_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?) AND (k.revoke_after IS NULL OR k.revoke_after > ?)`)
    .all(at, at) as Array<{ id: string; created_at: string; expires_at: string | null; surfaces: KeySurfaces; role: Role }>;
  const grants = db.query("SELECT key_id, module FROM api_key_grants").all() as Array<{ key_id: string; module: GrantModule }>;
  const modulesByKey = new Map<string, Set<GrantModule>>();
  for (const grant of grants) {
    const set = modulesByKey.get(grant.key_id) ?? new Set<GrantModule>();
    set.add(grant.module);
    modulesByKey.set(grant.key_id, set);
  }
  const current = readPolicies();
  let blocked = 0;
  let newlyBlocked = 0;
  let narrowed = 0;
  for (const key of keys) {
    const input = { createdAt: key.created_at, expiresAt: key.expires_at };
    const next = surfaceBlocks(input, key.role, key.surfaces, proposed);
    if (next.block) {
      blocked += 1;
      if (!surfaceBlocks(input, key.role, key.surfaces, current).block) newlyBlocked += 1;
      continue;
    }
    const allowed = activeModules(key.role, proposed);
    if (next.partly || [...(modulesByKey.get(key.id) ?? [])].some((module) => !allowed.includes(module))) narrowed += 1;
  }
  return { liveKeys: keys.length, blocked, newlyBlocked, narrowed };
}
