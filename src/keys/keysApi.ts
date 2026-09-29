import { api } from "../api";
import type { GrantModule, GrantPayload, KeyGrantView, KeyState, KeySurfaces, PolicySummary } from "./keyGrants";
import type { McpScope } from "../mcpPermissions";

/** `/api/keys` (access plan §C.7). */

export type ApiKey = {
  id: string; name: string; description: string | null; prefix: string; kind: "general" | "vault"; surfaces: KeySurfaces;
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokeAfter: string | null; revokedAt: string | null;
  rotatedFrom: string | null; state: KeyState; blockedBy: string | null; blockedMessage: string | null;
  revokedBy: "self" | "admin" | "rotation" | null; revokeReason: string | null;
  grants: KeyGrantView[]; scopes: McpScope[]; effectiveScopes: McpScope[];
  limits: { callsPerMinute?: number; writesPerMinute?: number }; usage14d: number[]; binnedToday?: number;
  /** Pending Inbox suggestions from this key (GET /api/keys only). */
  pendingProposals?: number;
};

export type KeyList = { keys: ApiKey[]; policy: PolicySummary; liveCount: number };
/** The password is left out when this session confirmed the account with Google (Wave 35, D297). */
export type Reauth = { password?: string; totpCode?: string };

export const listKeys = () => api<KeyList>("/keys");

export const createKey = (body: { name: string; description?: string | null; surfaces: KeySurfaces; expiresInDays: number | null; grants: GrantPayload[] } & Reauth) =>
  api<{ key: ApiKey & { token: string } }>("/keys", { method: "POST", body: JSON.stringify(body) });

export type NarrowBody = { name?: string; description?: string | null; surfaces?: KeySurfaces; expiresInDays?: number | null; grants?: GrantPayload[]; limits?: { callsPerMinute?: number | null; writesPerMinute?: number | null } };

export const narrowKey = (id: string, body: NarrowBody) =>
  api<{ changed: string[]; key: ApiKey }>(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const rotateKey = (id: string, body: { graceHours: 0 | 1 | 24 | 168; expiresInDays?: number | null } & Reauth) =>
  api<{ key: ApiKey & { token: string }; oldKey: ApiKey }>(`/keys/${id}/rotate`, { method: "POST", body: JSON.stringify(body) });

export const revokeKey = (id: string) => api<{ ok: true }>(`/keys/${id}`, { method: "DELETE", body: "{}" });

/** The items a chosen-items grant can name, from each module's own list (only what the user can open). */
export type ResourceOption = { value: string; label: string; description?: string; writable: boolean };

export async function loadResources(module: GrantModule): Promise<ResourceOption[]> {
  if (module === "tasks") {
    const { boards } = await api<{ boards: Array<{ id: string; name: string; owner_name: string; is_owner: 0 | 1 }> }>("/tasks/boards");
    return boards.map((board) => ({ value: board.id, label: board.name, description: board.is_owner ? undefined : `Owned by ${board.owner_name}`, writable: true }));
  }
  if (module === "collections") {
    const { collections } = await api<{ collections: Array<{ id: string; name: string; owner_name: string; is_owner: 0 | 1; role: string }> }>("/collections");
    return collections.map((item) => ({ value: item.id, label: item.name, description: item.is_owner ? undefined : `Owned by ${item.owner_name}`, writable: item.role !== "viewer" }));
  }
  if (module === "calendar") {
    const { calendars } = await api<{ calendars: Array<{ id: string; name: string; owner_name: string; is_owner: 0 | 1; role: string }> }>("/calendars");
    return calendars.map((item) => ({ value: item.id, label: item.name, description: item.is_owner ? undefined : `Owned by ${item.owner_name}`, writable: item.role !== "viewer" }));
  }
  return [];
}

// ---------------------------------------------------------------- Team (admins)

export type InventoryKey = ApiKey & { owner: { id: string; displayName: string; role: string; blocked: boolean } };
export type Inventory = { keys: InventoryKey[]; nextCursor: string | null; summary: { live: number; noExpiry: number } };
export type InventoryState = "active" | "expiring" | "no_expiry" | "blocked" | "grace" | "unused" | "expired";

export function listInventory(filter: { owner?: string; module?: GrantModule; state?: InventoryState; cursor?: string }) {
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
export type PolicyImpact = { liveKeys: number; blocked: number; newlyBlocked: number; narrowed: number };
export type PolicyState = { policies: Policies; defaults: Policies; revision: number; updatedAt: string | null; updatedBy: { id: string; displayName: string } | null; impact: PolicyImpact };

export const getPolicies = () => api<PolicyState>("/team/policies");
export const previewPolicies = (policies: Policies) => api<{ impact: PolicyImpact }>("/team/policies/preview", { method: "POST", body: JSON.stringify({ policies }) });
export const savePolicies = (policies: Policies, revision: number) => api<PolicyState & { changed: string[] }>("/team/policies", { method: "PUT", body: JSON.stringify({ policies, revision }) });
