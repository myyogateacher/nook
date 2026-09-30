import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits, setRole, share, unlock } from "./support/vault";

/**
 * Protected environments and the 15-minute re-authentication window (D226, V-O2, T186; Wave 26):
 * server-enforced for reveal, edit, clear, restore, delete, import, export, and unprotecting; not
 * for metadata. The window belongs to one session and ends after 15 minutes.
 */

beforeEach(() => resetVaultLimits());

describe("the protected-environment window", () => {
  test("every value path on prod needs the window; metadata does not; the window opens with the password and ends after 15 minutes", async () => {
    const owner = await createUser("Protected owner");
    const reader = await createUser("Protected reader");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "PROD_DB", { dev: "dev-db", prod: "prod-db" });
    await share(owner, vault, [{ session: reader, levels: { dev: "read", prod: "write" } }]);
    const prod = vault.envs.prod!;
    const value = `/vaults/${vault.id}/secrets/${secret.id}/values/${prod}`;

    const status = await call(reader, "GET", "/reauth");
    expect(status.body).toEqual({ reauthUntil: null, method: "password", twoFactor: false });
    const locked = [
      await call(reader, "GET", value),
      await call(reader, "PUT", value, { value: "x", expectedVersion: 1 }),
      await call(reader, "DELETE", `${value}?expectedVersion=1`),
      await call(reader, "GET", `${value}/versions/1`),
      await call(reader, "POST", `${value}/versions/1/restore`, { expectedVersion: 1 }),
      await call(reader, "POST", `/vaults/${vault.id}/reveal`, { cells: [{ secretId: secret.id, envId: vault.envs.dev }, { secretId: secret.id, envId: prod }] }),
      await call(reader, "GET", `/vaults/${vault.id}/environments/${prod}/export?format=dotenv`),
      await call(reader, "POST", `/vaults/${vault.id}/environments/${prod}/import`, { entries: [{ name: "NEW", value: "v" }], dryRun: true })
    ];
    for (const response of locked) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "REAUTH_REQUIRED", envIds: [prod] });
      expect(response.text).not.toContain("prod-db");
    }
    // Metadata and unprotected environments need nothing.
    expect((await call(reader, "GET", `${value}/versions`)).status).toBe(200);
    expect((await call(reader, "GET", `/vaults/${vault.id}/secrets`)).status).toBe(200);
    expect((await call(reader, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).body.value.value).toBe("dev-db");

    // A wrong password is refused (and counted); the right one opens the window for this session.
    const wrong = await call(reader, "POST", "/reauth", { password: "not the password" });
    expect(wrong).toMatchObject({ status: 403, body: { code: "REAUTH_FAILED" } });
    const until = await unlock(reader);
    expect(Date.parse(until) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(until) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect((await call(reader, "GET", value)).body.value.value).toBe("prod-db");
    expect((await call(reader, "GET", `/vaults/${vault.id}`)).body.vault.reauthUntil).toBe(until);
    // The window is per session: another session of the same account starts closed.
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const at = new Date().toISOString();
    db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), reader.userId, new Bun.CryptoHasher("sha256").update(token).digest("hex"), reader.csrf, at, at, new Date(Date.now() + 86_400_000).toISOString());
    const second = { ...reader, cookie: `mynotes_session=${token}`, setCookie: `mynotes_session=${token}` };
    expect((await call(second, "GET", "/reauth")).body.reauthUntil).toBeNull();
    expect((await call(second, "GET", value)).body.code).toBe("REAUTH_REQUIRED");

    // After 15 minutes it is closed again.
    db.query("UPDATE sessions SET vault_reauth_at = ? WHERE user_id = ?").run(new Date(Date.now() - 16 * 60_000).toISOString(), reader.userId);
    expect((await call(reader, "GET", value)).body.code).toBe("REAUTH_REQUIRED");
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type = 'vault.reauth'").get(reader.userId)).toEqual({ count: 1 });
  });

  test("owners too; unprotecting needs the window, protecting does not; deleting a secret with a prod value needs it", async () => {
    const owner = await createUser("Protect toggler");
    const vault = await newVault(owner, undefined, { unlock: false });
    const secret = await newSecret(owner, vault, "TOGGLE", { dev: "d" });
    const prod = vault.envs.prod!;
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/environments/${prod}`, { protected: false })).body.code).toBe("REAUTH_REQUIRED");
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/environments/${prod}`, { name: "Live" })).status).toBe(200);
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/environments/${vault.envs.dev}`, { protected: true })).status).toBe(200);
    // Dev is protected now: its value needs the window, and so does deleting the secret that holds it.
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).body.code).toBe("REAUTH_REQUIRED");
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}`)).body.code).toBe("REAUTH_REQUIRED");
    await unlock(owner);
    expect((await call(owner, "PATCH", `/vaults/${vault.id}/environments/${prod}`, { protected: false })).status).toBe(200);
    expect((await call(owner, "DELETE", `/vaults/${vault.id}/secrets/${secret.id}`)).status).toBe(200);
    const events = (db.query("SELECT event FROM vault_events WHERE vault_id = ? AND event LIKE 'env.%protect'").all(vault.id) as Array<{ event: string }>).map((row) => row.event);
    expect(events.sort()).toEqual(["env.protect", "env.unprotect"]);
  });

  test("viewers may re-authenticate (a read gate) and read prod; re-authentication attempts are rate-limited", async () => {
    const owner = await createUser("Viewer gate owner");
    const viewer = await createUser("Viewer gate");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "VIEWED", { prod: "viewed-prod" });
    await share(owner, vault, [{ session: viewer, levels: { prod: "read" } }]);
    setRole(viewer, "viewer");
    try {
      await unlock(viewer);
      expect((await call(viewer, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.prod}`)).body.value.value).toBe("viewed-prod");
      // Failures count (per session); the success above did not.
      for (let attempt = 0; attempt < 9; attempt += 1) expect((await call(viewer, "POST", "/reauth", { password: "wrong" })).status).toBe(403);
      expect((await call(viewer, "POST", "/reauth", { password: viewer.password })).status).toBe(200);
      expect((await call(viewer, "POST", "/reauth", { password: "wrong" })).status).toBe(403);
      const limited = await call(viewer, "POST", "/reauth", { password: viewer.password });
      expect(limited.status).toBe(429);
    } finally {
      setRole(viewer, "member");
    }
  });

  test("an account with two-factor needs a fresh code as well as the password", async () => {
    const user = await createUser("Protected TOTP");
    db.query("UPDATE users SET totp_enabled_at = ?, totp_secret = 'v1:not:a:secret' WHERE id = ?").run(new Date().toISOString(), user.userId);
    try {
      expect((await call(user, "GET", "/reauth")).body.twoFactor).toBe(true);
      // The password alone is not enough; a code that does not verify is refused too.
      expect((await call(user, "POST", "/reauth", { password: user.password })).body.code).toBe("REAUTH_FAILED");
      expect((await call(user, "POST", "/reauth", { password: user.password, totpCode: "000000" })).body.code).toBe("REAUTH_FAILED");
    } finally {
      db.query("UPDATE users SET totp_enabled_at = NULL, totp_secret = NULL WHERE id = ?").run(user.userId);
    }
    expect((await request("/vault/reauth", { method: "POST", body: JSON.stringify({ password: user.password, extra: 1 }) }, user)).status).toBe(400);
  });
});
