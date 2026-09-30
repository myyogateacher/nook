import { expect } from "bun:test";
import { db, request, type Session } from "./harness";

/**
 * Vault test helpers: JSON calls, a vault with the default environments, and a secret. `newVault`
 * opens the creator's protected-environment window (Wave 26, D226) unless told not to, so tests that
 * are about other rules can use prod as before; tests/vaultProtected.test.ts covers the window.
 */

export async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/vault${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

export type TestVault = { id: string; revision: number; envs: Record<string, string> };

/** Re-authenticates the session for protected environments (the test accounts have no two-factor). */
export async function unlock(session: Session) {
  const response = await call(session, "POST", "/reauth", { password: session.password });
  expect(response.status).toBe(200);
  return response.body.reauthUntil as string;
}

export async function newVault(session: Session, name = `Vault ${crypto.randomUUID().slice(0, 8)}`, options: { unlock?: boolean } = {}): Promise<TestVault> {
  if (options.unlock !== false) await unlock(session);
  const created = await call(session, "POST", "/vaults", { name, description: "test" });
  expect(created.status).toBe(201);
  const vault = created.body.vault;
  return { id: vault.id, revision: vault.revision, envs: Object.fromEntries(vault.environments.map((env: { slug: string; id: string }) => [env.slug, env.id])) };
}

export async function newSecret(session: Session, vault: TestVault, name: string, values: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const payload = Object.fromEntries(Object.entries(values).map(([slug, value]) => [vault.envs[slug]!, { value }]));
  const created = await call(session, "POST", `/vaults/${vault.id}/secrets`, { name, ...(Object.keys(payload).length ? { values: payload } : {}), ...extra });
  expect(created.status).toBe(201);
  return created.body.secret as { id: string; revision: number; values: Record<string, { status: string; version: number }> };
}

/** Levels by environment short name (`{ dev: "write", prod: "read" }`); unnamed environments are none. */
export type SlugLevels = Record<string, "none" | "read" | "write" | "admin">;
export type ShareEntry = { session?: Session; id?: string; role?: "owner" | "member"; levels?: SlugLevels };

/** The access sheet body for `vault`: the owner stays, everyone listed is set as given (Wave 26). */
export function accessBody(vault: TestVault, owner: Session, people: ShareEntry[], groups: Array<{ id: string; levels: SlugLevels }> = []) {
  const toIds = (levels: SlugLevels = {}) => Object.fromEntries(Object.entries(levels).map(([slug, level]) => [vault.envs[slug]!, level]));
  return {
    people: [{ id: owner.userId, role: "owner", levels: {} }, ...people.map((entry) => ({ id: entry.id ?? entry.session!.userId, role: entry.role ?? "member", levels: toIds(entry.levels) }))],
    groups: groups.map((group) => ({ id: group.id, levels: toIds(group.levels) }))
  };
}

/** GET the access sheet, then PUT `body` with its ETag. Returns the PUT response. */
export async function putAccess(session: Session, vaultId: string, body: unknown, etag?: string) {
  const sheet = etag ?? (await call(session, "GET", `/vaults/${vaultId}/access`)).headers.get("etag") ?? "";
  const response = await request(`/vault/vaults/${vaultId}/access`, { method: "PUT", body: JSON.stringify(body), headers: { "If-Match": sheet } }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

/** Shares `vault` (owned by `owner`) with the people given; expects success. */
export async function share(owner: Session, vault: TestVault, people: ShareEntry[], groups: Array<{ id: string; levels: SlugLevels }> = []) {
  const response = await putAccess(owner, vault.id, accessBody(vault, owner, people, groups));
  expect(response.status).toBe(200);
  return response.body;
}

export function setRole(session: Session, role: "admin" | "member" | "viewer" | "guest") {
  db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
}

export function resetVaultLimits() {
  db.exec("DELETE FROM vault_rate_limits");
}
