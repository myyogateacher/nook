import { api } from "../api";
import type { CellStatus, EnvLevel, SecretType } from "../../shared/vault";

/** docs/plan/API_CONTRACTS.md § Vault (Wave 25): the session API under /api/vault. */

export type VaultEnvironment = { id: string; slug: string; name: string; position: number; protected: boolean; level: EnvLevel };
export type VaultSummary = {
  id: string; name: string; description: string; role: "owner" | "member"; revision: number;
  createdAt: string; updatedAt: string; secretCount: number; environments: VaultEnvironment[];
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
export const updateEnvironment = (vaultId: string, envId: string, body: { name: string }) => api<{ environment: VaultEnvironment }>(`${v(vaultId)}/environments/${encodeURIComponent(envId)}`, { method: "PATCH", body: json(body) });
export const reorderEnvironments = (vaultId: string, ids: string[], expectedRevision: number) => api<{ vault: VaultSummary }>(`${v(vaultId)}/environments/order`, { method: "PUT", body: json({ ids, expectedRevision }) });
export const deleteEnvironment = (vaultId: string, envId: string) => api<{ ok: true }>(`${v(vaultId)}/environments/${encodeURIComponent(envId)}`, { method: "DELETE", body: "{}" });

export const listSecrets = (vaultId: string, options: { q?: string; cursor?: string | null } = {}) => {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
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
