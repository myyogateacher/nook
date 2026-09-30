import { api, ApiError } from "../api";
import type { CellStatus, EnvLevel, SecretType } from "../../shared/vault";

/** docs/plan/API_CONTRACTS.md § Vault (Waves 25–26): the session API under /api/vault. */

export type VaultEnvironment = { id: string; slug: string; name: string; position: number; protected: boolean; level: EnvLevel };
export type VaultSummary = {
  id: string; name: string; description: string; role: "owner" | "member"; revision: number;
  createdAt: string; updatedAt: string; secretCount: number; environments: VaultEnvironment[];
  /** Wave 26: who created it, how you reach it, and until when this session opens protected environments. */
  ownerName?: string | null; via?: "direct" | "group"; reauthUntil?: string | null;
};
export type ValueCell = { status: CellStatus; version: number | null; updatedAt: string | null; updatedBy: string | null };
export type SecretSummary = {
  id: string; name: string; type: SecretType; tags: string[]; hasComment: boolean; revision: number;
  createdAt: string; updatedAt: string; updatedBy: string | null; values: Record<string, ValueCell>;
};
export type SecretDetail = SecretSummary & { comment: string | null };
export type ValueResult = { secretId: string; envId: string; version: number; updatedAt: string; updatedBy: string | null };
export type RevealedValue = ValueResult & { value: string; comment: string | null };
export type VersionInfo = { version: number; cleared: boolean; createdAt: string; createdBy: string | null };
export type VaultStatus = { enabled: boolean; reason: "unset" | "key_mismatch" | null };

const json = (body: unknown) => JSON.stringify(body);
const v = (id: string) => `/vault/vaults/${encodeURIComponent(id)}`;
const s = (vaultId: string, secretId: string) => `${v(vaultId)}/secrets/${encodeURIComponent(secretId)}`;
const value = (vaultId: string, secretId: string, envId: string) => `${s(vaultId, secretId)}/values/${encodeURIComponent(envId)}`;

export const vaultStatus = () => api<VaultStatus>("/vault/status");
export const listVaults = () => api<{ vaults: VaultSummary[] }>("/vault/vaults");
export const createVault = (body: { name: string; description?: string; environments?: Array<{ slug: string; name: string; protected?: boolean }> }) =>
  api<{ vault: VaultSummary }>("/vault/vaults", { method: "POST", body: json(body) });
export const getVault = (id: string) => api<{ vault: VaultSummary }>(v(id));
export const updateVault = (id: string, body: { name?: string; description?: string; expectedRevision: number }) => api<{ vault: VaultSummary }>(v(id), { method: "PATCH", body: json(body) });
export const deleteVault = (id: string) => api<{ ok: true }>(v(id), { method: "DELETE", body: "{}" });

export const createEnvironment = (vaultId: string, body: { slug: string; name: string }) => api<{ environment: VaultEnvironment }>(`${v(vaultId)}/environments`, { method: "POST", body: json(body) });
export const updateEnvironment = (vaultId: string, envId: string, body: { name?: string; protected?: boolean }) => api<{ environment: VaultEnvironment }>(`${v(vaultId)}/environments/${encodeURIComponent(envId)}`, { method: "PATCH", body: json(body) });
export const reorderEnvironments = (vaultId: string, ids: string[], expectedRevision: number) => api<{ vault: VaultSummary }>(`${v(vaultId)}/environments/order`, { method: "PUT", body: json({ ids, expectedRevision }) });
export const deleteEnvironment = (vaultId: string, envId: string) => api<{ ok: true }>(`${v(vaultId)}/environments/${encodeURIComponent(envId)}`, { method: "DELETE", body: "{}" });

export const listSecrets = (vaultId: string, options: { q?: string; tag?: string | null; cursor?: string | null } = {}) => {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.tag) params.set("tag", options.tag);
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.toString();
  return api<{ vault: VaultSummary; secrets: SecretSummary[]; nextCursor: string | null }>(`${v(vaultId)}/secrets${query ? `?${query}` : ""}`);
};
export const createSecret = (vaultId: string, body: { name: string; type: SecretType; comment?: string | null; tags?: string[]; values?: Record<string, { value: string; comment?: string | null }> }) =>
  api<{ vault: VaultSummary; secret: SecretDetail }>(`${v(vaultId)}/secrets`, { method: "POST", body: json(body) });
export const getSecret = (vaultId: string, secretId: string) => api<{ vault: VaultSummary; secret: SecretDetail }>(s(vaultId, secretId));
export const updateSecret = (vaultId: string, secretId: string, body: { name?: string; type?: SecretType; comment?: string | null; tags?: string[]; expectedRevision: number }) =>
  api<{ vault: VaultSummary; secret: SecretDetail }>(s(vaultId, secretId), { method: "PATCH", body: json(body) });
export const deleteSecret = (vaultId: string, secretId: string) => api<{ ok: true }>(s(vaultId, secretId), { method: "DELETE", body: "{}" });

export const readValue = (vaultId: string, secretId: string, envId: string) => api<{ value: RevealedValue }>(value(vaultId, secretId, envId));
export const setValue = (vaultId: string, secretId: string, envId: string, body: { value: string; comment?: string | null; expectedVersion: number }) =>
  api<{ value: ValueResult }>(value(vaultId, secretId, envId), { method: "PUT", body: json(body) });
export const setValues = (vaultId: string, secretId: string, values: Array<{ envId: string; value: string; comment?: string | null; expectedVersion: number }>) =>
  api<{ values: ValueResult[] }>(`${s(vaultId, secretId)}/values`, { method: "PUT", body: json({ values }) });
export const clearValue = (vaultId: string, secretId: string, envId: string, expectedVersion: number) =>
  api<{ ok: true; version: number }>(`${value(vaultId, secretId, envId)}?expectedVersion=${expectedVersion}`, { method: "DELETE", body: "{}" });
export const listVersions = (vaultId: string, secretId: string, envId: string) =>
  api<{ current: { version: number; set: boolean }; versions: VersionInfo[] }>(`${value(vaultId, secretId, envId)}/versions`);
export const readVersion = (vaultId: string, secretId: string, envId: string, version: number) =>
  api<{ version: { version: number; cleared: boolean; value: string | null; comment: string | null; createdAt: string } }>(`${value(vaultId, secretId, envId)}/versions/${version}`);
export const restoreVersion = (vaultId: string, secretId: string, envId: string, version: number, expectedVersion: number) =>
  api<{ value: ValueResult }>(`${value(vaultId, secretId, envId)}/versions/${version}/restore`, { method: "POST", body: json({ expectedVersion }) });

// ---------------------------------------------------------------------------------------------
// Wave 26 (Vault B): sharing, the protected-environment window, import and export, rotation, activity.

export type ReauthStatus = { reauthUntil: string | null; method: "password" | "google" | "none"; twoFactor: boolean };
export const reauthStatus = () => api<ReauthStatus>("/vault/reauth");
export const reauth = (body: { password?: string; totpCode?: string }) => api<{ reauthUntil: string }>("/vault/reauth", { method: "POST", body: json(body) });

export type SheetEnvironment = { id: string; slug: string; name: string; protected: boolean; manageable: boolean };
export type SheetPerson = {
  id: string; displayName: string; teamRole: string; kind: string; blocked: boolean; avatarUrl: string | null; isYou: boolean;
  role: "owner" | "member"; levels: Record<string, EnvLevel>; cap: EnvLevel; groupIds: string[];
};
export type SheetGroup = { id: string; name: string; memberCount: number; guestCount: number; levels: Record<string, EnvLevel> };
export type VaultAccessSheet = {
  etag: string; vault: { id: string; name: string }; yourRole: "owner" | "member"; youId: string; canManagePeople: boolean;
  environments: SheetEnvironment[]; people: SheetPerson[]; groups: SheetGroup[]; levels: EnvLevel[]; shareWithGuests: boolean; maxPeople: number; maxGroups: number;
};
export type AccessPutBody = { people: Array<{ id: string; role: "owner" | "member"; levels: Record<string, EnvLevel> }>; groups: Array<{ id: string; levels: Record<string, EnvLevel> }> };
export const getVaultAccess = (vaultId: string) => api<VaultAccessSheet>(`${v(vaultId)}/access`);
export const putVaultAccess = (vaultId: string, body: AccessPutBody, etag: string) =>
  api<{
    /** Null when the caller no longer manages the vault's access (an owner who handed it over). */
    access: VaultAccessSheet | null; managesAccess: boolean; stillReads: boolean;
    rotated: boolean; generation: number | null; lostAccess: number;
  }>(`${v(vaultId)}/access`, { method: "PUT", body: json(body), headers: { "If-Match": etag } });
export const leaveVault = (vaultId: string) => api<{ ok: true; stillReads: boolean }>(`${v(vaultId)}/leave`, { method: "POST", body: "{}" });

export type RotationStatus = { generation: number; pendingRows: number; activeKeys: number; done: boolean };
export const rotateVault = (vaultId: string) => api<{ rotation: RotationStatus }>(`${v(vaultId)}/rotate`, { method: "POST", body: "{}" });
export const getRotation = (vaultId: string) => api<{ rotation: RotationStatus }>(`${v(vaultId)}/rotation`);
export const getQuota = () => api<{ storedBytes: number; quotaBytes: number }>("/vault/quota");

/** Wave 27: the vault keys (nkv_) that reach a vault now; owners see each, others the count and their own. */
export type VaultKeysWithAccess = {
  count: number; scope: "vault" | "own"; maxGrants: number;
  keys: Array<{ id: string; name: string; prefix: string; owner: { id: string; displayName: string; isYou: boolean }; expiresAt: string | null; lastUsedAt: string | null; levels: Record<string, EnvLevel> }>;
};
export const listVaultKeys = (vaultId: string) => api<VaultKeysWithAccess>(`${v(vaultId)}/keys`);

export type ActivityEvent = {
  id: string; createdAt: string; event: string; via: string; count: number | null;
  actor: { id: string; displayName: string; isYou: boolean } | null;
  secret: { name: string | null; state: "live" | "binned" | "gone" } | null;
  environment: { id: string | null; name: string | null } | null;
  /** Whom an access event was about (names only), and the level it gave. Absent on older events. */
  target?: { displayName: string; isYou: boolean } | null;
  level?: string | null;
  /** Wave 27: the vault key that acted (shown as key:<name>); `actor` is the person who made it. */
  key?: { name: string; prefix: string | null } | null;
};
export type ActivityPage = {
  scope: "vault" | "own"; events: ActivityEvent[]; people: Array<{ id: string; displayName: string }>;
  environments: Array<{ id: string; name: string }>; families: string[]; nextCursor: string | null;
};
export const listActivity = (vaultId: string, filters: { actor?: string | null; event?: string | null; env?: string | null; cursor?: string | null }) => {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.event) params.set("event", filters.event);
  if (filters.env) params.set("env", filters.env);
  if (filters.cursor) params.set("cursor", filters.cursor);
  const query = params.toString();
  return api<ActivityPage>(`${v(vaultId)}/events${query ? `?${query}` : ""}`);
};

export type ImportStatus = "create" | "set" | "update" | "same" | "skip" | "invalid";
export type ImportResult = {
  mode: "skip" | "overwrite"; dryRun: boolean;
  counts: Record<ImportStatus, number>;
  entries: Array<{ name: string; status: ImportStatus; reason: string | null }>;
};
export const importEntries = (vaultId: string, envId: string, body: { entries: Array<{ name: string; value: string; comment?: string | null }>; mode: "skip" | "overwrite"; dryRun: boolean }) =>
  api<ImportResult>(`${v(vaultId)}/environments/${encodeURIComponent(envId)}/import`, { method: "POST", body: json(body) });

/** The export as a file: a plain fetch (the answer is an attachment, not JSON); errors come back as ApiError. */
export async function exportEnvironment(vaultId: string, envId: string, format: "dotenv" | "json" | "csv", comments: boolean) {
  const response = await fetch(`/api${v(vaultId)}/environments/${encodeURIComponent(envId)}/export?format=${format}${comments ? "&comments=1" : ""}`, { credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    throw new ApiError(typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`, response.status, payload);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "vault-export.txt";
  return { blob: await response.blob(), fileName: name, count: Number(response.headers.get("x-vault-export-count") ?? 0), skipped: Number(response.headers.get("x-vault-export-skipped") ?? 0) };
}
