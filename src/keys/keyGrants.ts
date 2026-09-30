import { MCP_PERMISSIONS, offeredMcpPermissions, type McpScope } from "../mcpPermissions";

/**
 * Nook key grants as Settings → API keys shows them (access plan §C.2, §E). Mirrors
 * server/keyGrants.ts (tests/keysClient.test.tsx keeps them in step). Pure, so the grant
 * builder's rules and summaries are unit-tested.
 */

export type GrantModule = "notes" | "files" | "tasks" | "today" | "calendar" | "collections" | "team" | "inbox" | "bin" | "whiteboards";
export type KeyPermission = "read" | "comment" | "write" | "draft" | "publish" | "create";
export type ResourceKind = "folder" | "note" | "document" | "board" | "task_view" | "collection" | "calendar" | "routine" | "whiteboard";
export type KeySurfaces = "mcp" | "rest" | "both";

export const GRANT_MODULES: readonly GrantModule[] = ["notes", "files", "tasks", "today", "calendar", "collections", "team", "inbox", "bin", "whiteboards"];

export const MODULE_LABELS: Record<GrantModule, string> = {
  notes: "Notes", files: "Files", tasks: "Tasks", today: "Today", calendar: "Calendar", collections: "Collections", team: "Team", inbox: "Inbox", bin: "Bin", whiteboards: "Whiteboards"
};

/** Every `{module, permission}` pair a key can hold, and the MCP scope it is. */
export const GRANT_SCOPES: Record<GrantModule, Partial<Record<KeyPermission, McpScope>>> = {
  notes: { read: "notes:read", draft: "notes:write-draft", publish: "notes:publish" },
  files: { read: "files:read", write: "files:write" },
  tasks: { read: "tasks:read", write: "tasks:write" },
  today: { read: "today:read" },
  calendar: { read: "calendar:read", write: "calendar:write" },
  collections: { read: "collections:read", write: "collections:write" },
  team: { read: "team:read" },
  inbox: { read: "inbox:read", write: "inbox:write" },
  bin: { write: "bin:write" },
  whiteboards: { read: "whiteboards:read", write: "whiteboards:write" }
};

export const scopeFor = (module: GrantModule, permission: KeyPermission) => GRANT_SCOPES[module][permission] ?? null;

export const permissionsFor = (module: GrantModule) => Object.keys(GRANT_SCOPES[module]) as KeyPermission[];

/**
 * Modules whose grants may name chosen items (Wave 34: every module with selectable items), the
 * kinds each offers (mirrors server/keyGrants.ts SELECTOR_KINDS), and what the items are called.
 * A folder covers the notes or files directly inside it (never its subfolders); a saved view is
 * read only.
 */
export const SELECTOR_KINDS: Partial<Record<GrantModule, { kinds: readonly ResourceKind[]; one: string; many: string }>> = {
  notes: { kinds: ["folder", "note"], one: "folder or note", many: "folders and notes" },
  files: { kinds: ["folder", "document"], one: "folder or file", many: "folders and files" },
  tasks: { kinds: ["board", "task_view"], one: "board or view", many: "boards and views" },
  collections: { kinds: ["collection"], one: "collection", many: "collections" },
  calendar: { kinds: ["calendar"], one: "calendar", many: "calendars" },
  inbox: { kinds: ["routine"], one: "routine", many: "routines" },
  whiteboards: { kinds: ["whiteboard"], one: "whiteboard", many: "whiteboards" }
};

export const KIND_LABELS: Record<ResourceKind, string> = {
  folder: "Folder", note: "Note", document: "File", board: "Board", task_view: "View", collection: "Collection", calendar: "Calendar", routine: "Routine", whiteboard: "Whiteboard"
};

/** Kinds a key can only read through (a saved view is a query, never a write target). */
export const READ_ONLY_KINDS: readonly ResourceKind[] = ["task_view"];

/** A chosen item in the builder is one string, `kind:id`, so one picker can hold several kinds. */
export const resourceToken = (kind: ResourceKind, id: string) => `${kind}:${id}`;
export function parseResourceToken(token: string): { kind: ResourceKind; id: string } | null {
  const at = token.indexOf(":");
  if (at < 1) return null;
  return { kind: token.slice(0, at) as ResourceKind, id: token.slice(at + 1) };
}

export function permissionLabel(module: GrantModule, permission: KeyPermission) {
  const scope = scopeFor(module, permission);
  return MCP_PERMISSIONS.find((item) => item.scope === scope)?.label ?? permission;
}

export function permissionHelp(module: GrantModule, permission: KeyPermission) {
  const scope = scopeFor(module, permission);
  const item = MCP_PERMISSIONS.find((entry) => entry.scope === scope);
  return item ? [item.help, item.warning].filter(Boolean).join(" ") : "";
}

export type PolicySummary = {
  keyMaxDays: number; keyDefaultDays: number; keyRequireExpiry: boolean; keysPerUser: number; modules: readonly GrantModule[]; mcpAllowed: boolean; restAllowed: boolean;
  /** Wave 34 (O-A7): whether this server can check client addresses (TRUSTED_PROXY_HOPS ≥ 1). */
  ipAllowlistAvailable?: boolean;
};

export type PermissionChoice = { value: KeyPermission; label: string; description: string; disabled: boolean; reason: string | null };

/**
 * The permission options for one module, for the holder's team role and the team policy. A
 * disabled option says why (§E: "Admins only", "Your team role reads only", "Turned off by team policy").
 */
export function permissionChoices(module: GrantModule, role: string | undefined, policy: Pick<PolicySummary, "modules"> | null): PermissionChoice[] {
  const offered = new Set(offeredMcpPermissions(role).map((item) => item.scope));
  const moduleOff = policy !== null && !policy.modules.includes(module);
  return permissionsFor(module).map((permission) => {
    const scope = scopeFor(module, permission)!;
    const reason = moduleOff ? "Turned off by team policy"
      : offered.has(scope) ? null
      : scope === "team:read" ? "Admins only"
      : role === "viewer" ? "Your team role reads only"
      : "Not available for your team role";
    return { value: permission, label: permissionLabel(module, permission), description: reason ?? permissionHelp(module, permission), disabled: reason !== null, reason };
  });
}

/** Modules the builder offers: any with at least one allowed permission. Others show why they are off. */
export function moduleChoices(role: string | undefined, policy: Pick<PolicySummary, "modules"> | null) {
  return GRANT_MODULES.map((module) => {
    const choices = permissionChoices(module, role, policy);
    const first = choices.find((choice) => !choice.disabled) ?? null;
    return { value: module, label: MODULE_LABELS[module], disabled: first === null, description: first ? undefined : choices[0]?.reason ?? undefined, firstPermission: first?.value ?? null };
  });
}

/** One row of the grant builder. `resourceIds` (tokens from resourceToken) is used when `applies` is "chosen". */
export type GrantRow = { key: string; module: GrantModule; permission: KeyPermission; applies: "all" | "chosen"; resourceIds: string[] };

/** Where each module and permission is already used, by row number (1-based), leaving out `rowKey`. */
function usedElsewhere(rows: readonly GrantRow[], rowKey: string | null) {
  const used = new Map<string, number>();
  rows.forEach((row, index) => { if (row.key !== rowKey && !used.has(`${row.module}:${row.permission}`)) used.set(`${row.module}:${row.permission}`, index + 1); });
  return used;
}

/**
 * The permission options for one row (Friction 4): one another row already holds is disabled and
 * says which row, so a module and permission is never listed twice.
 */
export function rowPermissionChoices(module: GrantModule, role: string | undefined, policy: Pick<PolicySummary, "modules"> | null, rows: readonly GrantRow[], rowKey: string | null): PermissionChoice[] {
  const used = usedElsewhere(rows, rowKey);
  return permissionChoices(module, role, policy).map((choice) => {
    const row = used.get(`${module}:${choice.value}`);
    return !choice.disabled && row ? { ...choice, disabled: true, reason: `Already in permission ${row}`, description: `Already in permission ${row}` } : choice;
  });
}

/**
 * The Module options for one row (Friction 4): a module whose every open permission other rows
 * already hold is disabled and says which row; `firstPermission` is the first one still free. A
 * module with a free permission stays open (read all boards in one row, write chosen boards in another).
 */
export function rowModuleChoices(role: string | undefined, policy: Pick<PolicySummary, "modules"> | null, rows: readonly GrantRow[], rowKey: string | null) {
  const used = usedElsewhere(rows, rowKey);
  return moduleChoices(role, policy).map((module) => {
    if (module.disabled) return module;
    const free = rowPermissionChoices(module.value, role, policy, rows, rowKey).find((choice) => !choice.disabled) ?? null;
    if (free) return { ...module, firstPermission: free.value };
    const row = Math.min(...[...used].filter(([id]) => id.startsWith(`${module.value}:`)).map(([, index]) => index));
    return { ...module, disabled: true, description: `Already in permission ${row}`, firstPermission: null };
  });
}

export type GrantPayload = { module: GrantModule; permission: KeyPermission; resources?: Array<{ kind: ResourceKind; id: string }> };

/** The request body's grants, or an error to show next to Create. */
export function rowsToGrants(rows: readonly GrantRow[]): { grants: GrantPayload[]; error: string | null } {
  if (!rows.length) return { grants: [], error: "Add at least one permission." };
  const seen = new Set<string>();
  const grants: GrantPayload[] = [];
  for (const row of rows) {
    const id = `${row.module}:${row.permission}`;
    if (seen.has(id)) return { grants: [], error: `${MODULE_LABELS[row.module]}: ${permissionLabel(row.module, row.permission)} is listed twice.` };
    seen.add(id);
    if (row.applies === "chosen") {
      const selector = SELECTOR_KINDS[row.module];
      if (!selector) return { grants: [], error: `${MODULE_LABELS[row.module]} covers every item.` };
      if (!row.resourceIds.length) return { grants: [], error: `Choose at least one ${selector.one} for ${MODULE_LABELS[row.module]}, or pick All ${selector.many}.` };
      const resources = row.resourceIds.map(parseResourceToken).filter((item): item is { kind: ResourceKind; id: string } => item !== null);
      if (row.permission !== "read" && resources.some((item) => READ_ONLY_KINDS.includes(item.kind))) return { grants: [], error: `${MODULE_LABELS[row.module]}: saved views can only be read. Remove them or choose Read.` };
      grants.push({ module: row.module, permission: row.permission, resources });
    } else {
      grants.push({ module: row.module, permission: row.permission });
    }
  }
  return { grants, error: null };
}

export type KeyGrantView = {
  module: GrantModule; permission: KeyPermission;
  resource: { kind: ResourceKind; id: string; name: string | null } | null;
  active: boolean; inactiveReason: "role" | "policy" | "no-access" | null;
};

const INACTIVE_TEXT = { role: "your team role cannot use it", policy: "turned off by team policy", "no-access": "no current access" } as const;

/**
 * The chips of a key row: one per module and permission, naming the chosen items (or "all"),
 * with inactive grants marked and why (T201).
 */
export function grantChips(grants: readonly KeyGrantView[]) {
  const groups = new Map<string, KeyGrantView[]>();
  for (const grant of grants) {
    const id = `${grant.module}:${grant.permission}:${grant.resource ? "chosen" : "all"}`;
    groups.set(id, [...(groups.get(id) ?? []), grant]);
  }
  return [...groups.entries()].map(([id, items]) => {
    const first = items[0]!;
    const selector = SELECTOR_KINDS[first.module];
    const base = `${MODULE_LABELS[first.module]}: ${permissionLabel(first.module, first.permission).toLowerCase()}`;
    let scope = "";
    if (first.resource) {
      const names = items.map((item) => item.resource?.name).filter((name): name is string => Boolean(name));
      const kinds = new Set(items.map((item) => item.resource!.kind));
      // One kind: "3 boards"; mixed kinds: "2 items".
      const noun = kinds.size === 1 ? KIND_NOUNS[first.resource.kind] : ["item", "items"] as const;
      scope = items.length === 1 && names.length === 1 ? ` · ${names[0]}` : ` · ${items.length} ${items.length === 1 ? noun[0] : noun[1]}`;
    }
    const inactive = items.every((item) => !item.active);
    const reason = inactive ? items.find((item) => item.inactiveReason)?.inactiveReason ?? null : null;
    return { id, label: `${base}${scope}${reason ? ` (${INACTIVE_TEXT[reason]})` : ""}`, active: !inactive };
  });
}

const KIND_NOUNS: Record<ResourceKind, readonly [string, string]> = {
  folder: ["folder", "folders"], note: ["note", "notes"], document: ["file", "files"], board: ["board", "boards"], task_view: ["view", "views"],
  collection: ["collection", "collections"], calendar: ["calendar", "calendars"], routine: ["routine", "routines"], whiteboard: ["whiteboard", "whiteboards"]
};

/** One sentence under the builder: what the key can do, and what no key ever does (D265). */
export function grantSummary(rows: readonly GrantRow[]) {
  if (!rows.length) return "This key can do nothing yet. Add a permission.";
  const parts = rows.map((row) => {
    const selector = SELECTOR_KINDS[row.module];
    // Creating a whiteboard makes a new, private board: it is not "on" any existing ones (QA Q7).
    const createOnly = row.module === "whiteboards" && row.permission === "write";
    const kinds = new Set(row.resourceIds.map((token) => parseResourceToken(token)?.kind));
    const only = kinds.size === 1 ? [...kinds][0] : undefined;
    const noun = only ? KIND_NOUNS[only] : ["item", "items"] as const;
    const where = createOnly ? "" : row.applies === "chosen" && selector ? ` on ${row.resourceIds.length} ${row.resourceIds.length === 1 ? noun[0] : noun[1]}` : selector ? ` on all ${selector.many}` : "";
    return `${MODULE_LABELS[row.module]}: ${permissionLabel(row.module, row.permission).toLowerCase()}${where}`;
  });
  return `${parts.join("; ")}. Never shares, never manages access or keys, and never deletes forever.`;
}

export const SURFACE_LABELS: Record<KeySurfaces, string> = { mcp: "MCP", rest: "REST", both: "MCP and REST" };

/** The line under a key: when it was last used on each surface it may use (Wave 34). */
export function lastUsedLine(key: { surfaces: KeySurfaces; lastUsedAt: string | null; lastUsed?: { mcp: string | null; rest: string | null } }, relative: (iso: string) => string) {
  if (!key.lastUsed || key.surfaces !== "both") return key.lastUsedAt ? `Used ${relative(key.lastUsedAt)}` : "Never used";
  const part = (label: string, at: string | null) => `${label} ${at ? relative(at) : "never"}`;
  return `${part("MCP", key.lastUsed.mcp)} · ${part("REST", key.lastUsed.rest)}`;
}

/** The allowlist textarea's lines, trimmed, blanks dropped (the server validates and canonicalises). */
export const allowlistLines = (text: string) => text.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean);

export const GRACE_OPTIONS = [
  { value: "0", label: "Stop the old key now" },
  { value: "1", label: "Keep the old key 1 hour" },
  { value: "24", label: "Keep the old key 24 hours" },
  { value: "168", label: "Keep the old key 7 days" }
] as const;

const EXPIRY_CHOICES = [7, 30, 90, 180, 365];

/** Expiry options up to the policy maximum, always including the policy default and maximum. */
export function expiryOptions(policy: Pick<PolicySummary, "keyMaxDays" | "keyDefaultDays">) {
  const days = [...new Set([...EXPIRY_CHOICES, policy.keyDefaultDays, policy.keyMaxDays])].filter((value) => value >= 1 && value <= policy.keyMaxDays).sort((a, b) => a - b);
  return days.map((value) => ({ value: String(value), label: value === 365 ? "1 year" : value === 1 ? "1 day" : `${value} days`, description: value === policy.keyDefaultDays ? "Team default" : undefined }));
}

/** The Expires value for "No expiry" (C2). */
export const NO_EXPIRY = "none";

/**
 * The day choices plus "No expiry" (C2), for creating and rotating a key. With `key_require_expiry`
 * on, "No expiry" stays listed but disabled, with the reason; `key_max_days` still caps the days.
 */
export function expiryChoices(policy: Pick<PolicySummary, "keyMaxDays" | "keyDefaultDays" | "keyRequireExpiry">) {
  return [
    ...expiryOptions(policy).map((option) => ({ ...option, disabled: false })),
    { value: NO_EXPIRY, label: "No expiry", description: policy.keyRequireExpiry ? "Team policy requires an expiry" : "Works until you revoke it", disabled: policy.keyRequireExpiry }
  ];
}

/** The request's `expiresInDays` for an Expires value: null for "No expiry". */
export const expiryDays = (value: string): number | null => value === NO_EXPIRY ? null : Number(value);

/**
 * The Expires choice a rotation starts on: the key's own lifetime (capped by policy), "No expiry"
 * for a key without one when policy allows it, else the team default.
 */
export function rotationExpiryDefault(key: { createdAt: string; expiresAt: string | null }, policy: Pick<PolicySummary, "keyMaxDays" | "keyDefaultDays" | "keyRequireExpiry">) {
  if (key.expiresAt === null) return policy.keyRequireExpiry ? String(policy.keyDefaultDays) : NO_EXPIRY;
  const lifetime = Math.max(1, Math.round((Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / DAY));
  const capped = Math.min(lifetime, policy.keyMaxDays);
  const offered = expiryOptions(policy).map((option) => Number(option.value));
  // The closest offered choice at or under the lifetime, so the Select always shows a real option.
  return String([...offered].reverse().find((days) => days <= capped) ?? offered[0] ?? policy.keyDefaultDays);
}

export type KeyState = "active" | "grace" | "expired" | "blocked" | "paused" | "revoked";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The state line of a key row, with a tone for the chip. */
export function keyStateLabel(key: { state: KeyState; expiresAt: string | null; revokeAfter: string | null; revokedBy?: "self" | "admin" | "rotation" | null; blockedMessage?: string | null }, now = Date.now()) {
  switch (key.state) {
    case "revoked": return { label: key.revokedBy === "admin" ? "Revoked by an admin" : key.revokedBy === "rotation" ? "Replaced by rotation" : "Revoked", tone: "danger" as const };
    case "expired": return { label: "Expired", tone: "danger" as const };
    case "paused": return { label: "Paused while your account is blocked", tone: "warn" as const };
    case "blocked": return { label: "Blocked by team policy", tone: "danger" as const };
    case "grace": {
      const left = key.revokeAfter ? Date.parse(key.revokeAfter) - now : 0;
      return { label: left > DAY ? `Old key: stops in ${Math.ceil(left / DAY)} days` : `Old key: stops in ${Math.max(1, Math.ceil(left / HOUR))} h`, tone: "warn" as const };
    }
    default: {
      if (!key.expiresAt) return { label: "No expiry", tone: "warn" as const };
      const left = Date.parse(key.expiresAt) - now;
      const days = Math.ceil(left / DAY);
      return { label: days <= 1 ? "Expires today" : `Expires in ${days} days`, tone: days <= 14 ? "warn" as const : "ok" as const };
    }
  }
}

/** Accessible text for the 14-day usage bars. */
export function usageLabel(usage: readonly number[]) {
  const total = usage.reduce((sum, value) => sum + value, 0);
  return total === 0 ? "No calls in the last 14 days" : `${total} ${total === 1 ? "call" : "calls"} in the last 14 days`;
}
