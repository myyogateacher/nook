import { createContext, useContext } from "react";
import { api } from "../api";
import { KIND_LABELS, resourceToken, type GrantModule, type GrantPayload, type KeyGrantView, type KeyState, type KeySurfaces, type PolicySummary, type ResourceKind } from "./keyGrants";
import type { McpScope } from "../mcpPermissions";

/** `/api/keys` (access plan §C.7). */

export type ApiKey = {
  id: string; name: string; description: string | null; prefix: string; kind: "general" | "vault"; surfaces: KeySurfaces;
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokeAfter: string | null; revokedAt: string | null;
  rotatedFrom: string | null; state: KeyState; blockedBy: string | null; blockedMessage: string | null;
  revokedBy: "self" | "admin" | "rotation" | null; revokeReason: string | null;
  grants: KeyGrantView[]; scopes: McpScope[]; effectiveScopes: McpScope[];
  limits: { callsPerMinute?: number; writesPerMinute?: number }; usage14d: number[]; binnedToday?: number;
  /** Wave 34: last use and 14-day calls per surface; the address limit (its list only for the owner). */
  lastUsed?: { mcp: string | null; rest: string | null }; usageBySurface14d?: { mcp: number; rest: number; daily?: { mcp: number[]; rest: number[] } };
  lastDenied?: { at: string; reason: string; surface: "mcp" | "rest" | null } | null; blockedSurfaces?: Array<"mcp" | "rest">;
  ipRestricted?: boolean; ipAllowlist?: string[];
  /** Pending Inbox suggestions from this key (GET /api/keys only). */
  pendingProposals?: number;
};

export type KeyList = { keys: ApiKey[]; policy: PolicySummary; liveCount: number };
/** The password is left out when this session confirmed the account with Google (Wave 35, D297). */
export type Reauth = { password?: string; totpCode?: string };

export const listKeys = () => api<KeyList>("/keys");

/** One of the caller's key events (GET /api/keys/:id): ids, counts, and short words only. */
export type KeyEvent = { id: string; action: string; via: string; createdAt: string; meta: Record<string, unknown> | null };
export const keyEvents = (id: string) => api<{ events: KeyEvent[] }>(`/keys/${id}`).then((result) => result.events);

export const createKey = (body: { name: string; description?: string | null; surfaces: KeySurfaces; expiresInDays: number | null; grants: GrantPayload[]; ipAllowlist?: string[] } & Reauth) =>
  api<{ key: ApiKey & { token: string } }>("/keys", { method: "POST", body: JSON.stringify(body) });

export type NarrowBody = { name?: string; description?: string | null; surfaces?: KeySurfaces; expiresInDays?: number | null; grants?: GrantPayload[]; limits?: { callsPerMinute?: number | null; writesPerMinute?: number | null }; ipAllowlist?: string[] };

export const narrowKey = (id: string, body: NarrowBody) =>
  api<{ changed: string[]; key: ApiKey }>(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const rotateKey = (id: string, body: { graceHours: 0 | 1 | 24 | 168; expiresInDays?: number | null; grants?: GrantPayload[]; surfaces?: KeySurfaces; ipAllowlist?: string[] | null } & Reauth) =>
  api<{ key: ApiKey & { token: string }; oldKey: ApiKey }>(`/keys/${id}/rotate`, { method: "POST", body: JSON.stringify(body) });

export const revokeKey = (id: string) => api<{ ok: true }>(`/keys/${id}`, { method: "DELETE", body: "{}" });

/**
 * The items a chosen-items grant can name, from each module's own list (only what the user can
 * open). `value` is a `kind:id` token (resourceToken), so one picker can offer several kinds.
 * `writable`: whether a writing grant may name it (the server checks again, D263).
 * `readOnly`: a saved view, which a key can only read.
 */
export type ResourceOption = { value: string; label: string; description?: string; writable: boolean; readOnly?: boolean };

type Owned = { owner_name: string; is_owner: 0 | 1 };
const ownerNote = (item: Owned) => item.is_owner ? undefined : `Owned by ${item.owner_name}`;
const withKind = (kind: ResourceKind, description: string | undefined) => description ? `${KIND_LABELS[kind]} · ${description}` : KIND_LABELS[kind];

export async function loadResources(module: GrantModule): Promise<ResourceOption[]> {
  if (module === "tasks") {
    const [{ boards }, views] = await Promise.all([
      api<{ boards: Array<{ id: string; name: string } & Owned> }>("/tasks/boards"),
      api<{ mine: Array<{ id: string; name: string; owner_name: string }>; shared: Array<{ id: string; name: string; owner_name: string }>; everyone: Array<{ id: string; name: string; owner_name: string }> }>("/tasks/views")
    ]);
    return [
      ...boards.map((board) => ({ value: resourceToken("board", board.id), label: board.name, description: withKind("board", ownerNote(board)), writable: true })),
      // Review S2: only your own views; someone else's view would follow their later edits.
      ...views.mine.map((view) => ({ value: resourceToken("task_view", view.id), label: view.name, description: withKind("task_view", "read only"), writable: false, readOnly: true }))
    ];
  }
  if (module === "notes") {
    const [{ folders }, { notes }] = await Promise.all([
      api<{ folders: Array<{ id: string; name: string } & Owned> }>("/folders"),
      api<{ notes: Array<{ id: string; title: string | null } & Owned> }>("/notes")
    ]);
    // Note writes through a key are the owner's (MCP note tools stay owner-only).
    return [
      ...folders.map((folder) => ({ value: resourceToken("folder", folder.id), label: folder.name, description: withKind("folder", ownerNote(folder) ?? "notes directly in it"), writable: folder.is_owner === 1 })),
      ...notes.map((note) => ({ value: resourceToken("note", note.id), label: note.title || "Untitled", description: withKind("note", ownerNote(note)), writable: note.is_owner === 1 }))
    ];
  }
  if (module === "files") {
    const [{ folders }, { documents }] = await Promise.all([
      api<{ folders: Array<{ id: string; name: string } & Owned> }>("/folders"),
      api<{ documents: Array<{ id: string; name: string } & Owned> }>("/files")
    ]);
    return [
      ...folders.map((folder) => ({ value: resourceToken("folder", folder.id), label: folder.name, description: withKind("folder", ownerNote(folder) ?? "files directly in it"), writable: folder.is_owner === 1 })),
      ...documents.map((document) => ({ value: resourceToken("document", document.id), label: document.name, description: withKind("document", ownerNote(document)), writable: document.is_owner === 1 }))
    ];
  }
  if (module === "inbox") {
    const { routines } = await api<{ routines: Array<{ id: string; name: string }> }>("/inbox/routines");
    return routines.map((routine) => ({ value: resourceToken("routine", routine.id), label: routine.name, writable: true }));
  }
  if (module === "collections") {
    const { collections } = await api<{ collections: Array<{ id: string; name: string; role: string } & Owned> }>("/collections");
    return collections.map((item) => ({ value: resourceToken("collection", item.id), label: item.name, description: ownerNote(item), writable: item.role !== "viewer" }));
  }
  if (module === "whiteboards") {
    const { whiteboards } = await api<{ whiteboards: Array<{ id: string; name: string } & Owned> }>("/whiteboards");
    return whiteboards.map((item) => ({ value: resourceToken("whiteboard", item.id), label: item.name.replace(/\.excalidraw$/i, ""), description: ownerNote(item), writable: item.is_owner === 1 }));
  }
  if (module === "calendar") {
    const { calendars } = await api<{ calendars: Array<{ id: string; name: string; role: string } & Owned> }>("/calendars");
    return calendars.map((item) => ({ value: resourceToken("calendar", item.id), label: item.name, description: ownerNote(item), writable: item.role !== "viewer" }));
  }
  return [];
}

// ---------------------------------------------------------------- whose keys (Wave 36)

/**
 * The key calls one key screen makes: the caller's own keys (Settings → API keys), or an
 * integration's keys managed by an admin (Team → Integrations, D287). The screens and dialogs are
 * the same; only the endpoints, the item picker's source, and the Google re-authentication return
 * address differ.
 */
export type KeysApi = {
  list: () => Promise<KeyList>;
  events: (id: string) => Promise<KeyEvent[]>;
  create: typeof createKey;
  narrow: typeof narrowKey;
  rotate: typeof rotateKey;
  revoke: typeof revokeKey;
  loadResources: (module: GrantModule) => Promise<ResourceOption[]>;
  /** Where a Google re-authentication started from this screen comes back to. */
  returnTo: string;
  /** Whose items an all-items grant covers, as the grant builder says it: "you" by default, "the integration" for one (Q-L5). */
  opener?: string;
};

export const ownKeysApi: KeysApi = { list: listKeys, events: keyEvents, create: createKey, narrow: narrowKey, rotate: rotateKey, revoke: revokeKey, loadResources, returnTo: "/settings/keys" };

/** An integration's keys, under /api/team/integrations/:id (admins; creation and rotation re-authenticate the admin). */
export function integrationKeysApi(integrationId: string): KeysApi {
  const base = `/team/integrations/${encodeURIComponent(integrationId)}`;
  return {
    list: () => api<{ keys: KeyList }>(base).then((result) => result.keys),
    events: (id) => api<{ events: KeyEvent[] }>(`${base}/keys/${id}`).then((result) => result.events),
    create: (body) => api<{ key: ApiKey & { token: string } }>(`${base}/keys`, { method: "POST", body: JSON.stringify(body) }),
    narrow: (id, body) => api<{ changed: string[]; key: ApiKey }>(`${base}/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    rotate: (id, body) => api<{ key: ApiKey & { token: string }; oldKey: ApiKey }>(`${base}/keys/${id}/rotate`, { method: "POST", body: JSON.stringify(body) }),
    revoke: (id) => api<{ ok: true }>(`${base}/keys/${id}`, { method: "DELETE", body: "{}" }),
    // Only what is shared with the integration, never the admin's own items (T212).
    loadResources: (module) => api<{ resources: ResourceOption[] }>(`${base}/resources?module=${encodeURIComponent(module)}`).then((result) => result.resources),
    returnTo: `/settings/team/integrations/${integrationId}`,
    opener: "the integration"
  };
}

export const KeysApiContext = createContext<KeysApi>(ownKeysApi);
export const useKeysApi = () => useContext(KeysApiContext);

// ---------------------------------------------------------------- Team (admins)

export type InventoryKey = ApiKey & { owner: { id: string; displayName: string; role: string; blocked: boolean; /** Wave 36: "service" for an integration. */ kind?: "person" | "service" } };
export type Inventory = { keys: InventoryKey[]; nextCursor: string | null; summary: { live: number; noExpiry: number; matching?: number } };
export type InventoryState = "active" | "expiring" | "no_expiry" | "blocked" | "grace" | "unused" | "expired";

export function listInventory(filter: { owner?: string; module?: GrantModule; state?: InventoryState; cursor?: string; surface?: "mcp" | "rest"; ipRestricted?: "true" | "false" }) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) if (value) params.set(name, value);
  const query = params.toString();
  return api<Inventory>(`/team/keys${query ? `?${query}` : ""}`);
}

export const adminRevokeKey = (id: string, reason: string) => api<{ ok: true }>(`/team/keys/${id}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });

export type Policies = {
  keyMaxDays: number; keyDefaultDays: number; keyRequireExpiry: boolean; keysPerUser: number;
  keyModulesByRole: Record<"admin" | "member" | "viewer", GrantModule[]>;
  mcpRoles: Array<"admin" | "member" | "viewer">; restRoles: Array<"admin" | "member" | "viewer">;
  groupsMemberCreate: boolean; shareWithGuests: boolean;
};
export type PolicyImpact = { liveKeys: number; blocked: number; newlyBlocked: number; narrowed: number; lostSurface?: number; lostModule?: number };
export type PolicyState = { policies: Policies; defaults: Policies; revision: number; updatedAt: string | null; updatedBy: { id: string; displayName: string } | null; impact: PolicyImpact };

export const getPolicies = () => api<PolicyState>("/team/policies");
export const previewPolicies = (policies: Policies) => api<{ impact: PolicyImpact }>("/team/policies/preview", { method: "POST", body: JSON.stringify({ policies }) });
export const savePolicies = (policies: Policies, revision: number) => api<PolicyState & { changed: string[] }>("/team/policies", { method: "PUT", body: JSON.stringify({ policies, revision }) });
