import { expect } from "bun:test";
import { db, request, type Session } from "./harness";

/** Vault test helpers (Wave 25): JSON calls, a vault with the default environments, and a secret. */

export async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/vault${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

export type TestVault = { id: string; revision: number; envs: Record<string, string> };

export async function newVault(session: Session, name = `Vault ${crypto.randomUUID().slice(0, 8)}`): Promise<TestVault> {
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

export function setRole(session: Session, role: "admin" | "member" | "viewer" | "guest") {
  db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
}

export function resetVaultLimits() {
  db.exec("DELETE FROM vault_rate_limits");
}
