/**
 * Run as a separate `bun` process by tests/vaultStartup.test.ts: the shared harness configures one
 * vault key per test run, so an instance without one, with a wrong one, or with one equal to the
 * TOTP key needs its own process. It calls the app's fetch handler directly (no socket) and prints
 * one line, `PROBE {json}`. The data directory and keys come from the environment the test sets.
 *
 *   mode=seed   register an admin and a member, create a vault with one secret; print the ids
 *   mode=check  report the vault status, what /api/auth/me and /api/vault/* answer, and health
 */
const mode = process.argv[2];
const origin = "http://localhost:22029";
Object.assign(process.env, {
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22029",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  TOTP_POLICY: "optional",
  ALLOW_REGISTRATION: "true",
  SIGNUP_ROLE: "member",
  MAX_UPLOAD_BYTES: "4194304",
  MIN_FREE_DISK_BYTES: "0"
});

const app = (await import("../../server/index")).default;
const { vaultStatus } = await import("../../server/vault/status");

async function send(path: string, init: RequestInit & { cookie?: string; csrf?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.csrf) headers.set("X-CSRF-Token", init.csrf);
  const response = await app.fetch(new Request(`${origin}/api${path}`, { ...init, headers }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function signIn(email: string, name: string) {
  let response = await send("/auth/register", { method: "POST", body: JSON.stringify({ email, displayName: name, password: "correct horse battery staple" }) });
  if (response.status !== 201) response = await send("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "correct horse battery staple" }) });
  return { cookie: response.cookie!, csrf: response.body.csrfToken as string };
}

const admin = await signIn("vault-probe-admin@example.test", "Probe admin");
const member = await signIn("vault-probe-member@example.test", "Probe member");

if (mode === "seed") {
  const vault = await send("/vault/vaults", { method: "POST", body: JSON.stringify({ name: "Probe" }), ...admin });
  const dev = vault.body.vault.environments[0].id;
  const secret = await send(`/vault/vaults/${vault.body.vault.id}/secrets`, { method: "POST", body: JSON.stringify({ name: "PROBE", values: { [dev]: { value: "probe-value" } } }), ...admin });
  console.log(`PROBE ${JSON.stringify({ vaultId: vault.body.vault.id, secretId: secret.body.secret.id, envId: dev, status: vault.status })}`);
} else {
  const vaultId = process.env.PROBE_VAULT_ID ?? crypto.randomUUID();
  const report = {
    status: vaultStatus(),
    health: (await send("/health")).status,
    adminFeatures: (await send("/auth/me", admin)).body.features,
    memberFeatures: (await send("/auth/me", member)).body.features,
    adminStatus: (await send("/vault/status", admin)).body,
    memberStatus: (await send("/vault/status", member)).body,
    list: await send("/vault/vaults", admin).then((response) => ({ status: response.status, code: response.body.code })),
    vault: await send(`/vault/vaults/${vaultId}`, admin).then((response) => ({ status: response.status, code: response.body.code }))
  };
  console.log(`PROBE ${JSON.stringify(report)}`);
}
process.exit(0);
