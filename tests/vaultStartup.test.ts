import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Startup and the host CLI (vault plan §13 row 2, D212, T199), each in its own process: no key →
 * the module is off (503 everywhere, hidden from everyone but admins, who get the reason); a key
 * equal to TOTP_ENCRYPTION_KEY or a malformed key → the app refuses to start; a key that does not
 * open the stored vaults → the module is off with a log line and the app keeps running;
 * `vault-admin.ts verify-key` and `rotate-kek` do what they say, printing counts only.
 */

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const keyA = Buffer.alloc(32, 21).toString("base64");
const keyB = Buffer.alloc(32, 22).toString("base64");
const keyC = Buffer.alloc(32, 23).toString("base64");
const totpKey = Buffer.alloc(32, 7).toString("base64");

function run(args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync(["bun", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TOTP_ENCRYPTION_KEY: totpKey, ...env }, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const line = stdout.split("\n").find((item) => item.startsWith("PROBE "));
  return { code: result.exitCode, stdout, stderr, probe: line ? JSON.parse(line.slice(6)) : null };
}
async function runAsync(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(["bun", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TOTP_ENCRYPTION_KEY: totpKey, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}
const probe = (mode: string, env: Record<string, string>) => run([join("tests", "support", "vaultStartupProbe.ts"), mode], env);
const admin = (command: string, env: Record<string, string>) => run([join("server", "vault-admin.ts"), command], env);

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "mynotes-vault-probe-"));
  dirs.push(dir);
  return dir;
}

describe("vault startup (T199)", () => {
  test("without a key the module is off: 503, hidden from members, and admins learn why", () => {
    const result = probe("check", { DATA_DIR: dataDir() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Vault: VAULT_ENCRYPTION_KEY is not set, so the vault module is off");
    expect(result.probe).toMatchObject({
      status: { enabled: false, reason: "unset" }, health: 200,
      adminFeatures: { vault: true }, memberFeatures: { vault: false },
      adminStatus: { enabled: false, reason: "unset" }, memberStatus: { enabled: false, reason: null },
      list: { status: 503, code: "VAULT_DISABLED" }
    });
  }, 30_000);

  test("a vault key equal to the TOTP key, a malformed key, or both variables refuse to start", () => {
    const equal = probe("check", { DATA_DIR: dataDir(), VAULT_ENCRYPTION_KEY: totpKey });
    expect(equal.code).not.toBe(0);
    expect(equal.stderr).toContain("VAULT_ENCRYPTION_KEY must differ from TOTP_ENCRYPTION_KEY");
    expect(equal.stderr).not.toContain(totpKey);
    const short = probe("check", { DATA_DIR: dataDir(), VAULT_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") });
    expect(short.code).not.toBe(0);
    expect(short.stderr).toContain("VAULT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    const file = join(dataDir(), "vault.key");
    writeFileSync(file, `${keyA}\n`, { mode: 0o600 });
    const both = probe("check", { DATA_DIR: dataDir(), VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_FILE: file });
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain("not both");
  }, 30_000);

  test("a wrong key turns the module off (not the app); verify-key and rotate-kek; VAULT_ENCRYPTION_KEY_FILE", async () => {
    const dir = dataDir();
    const seeded = probe("seed", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA });
    expect(seeded.code).toBe(0);
    expect(seeded.probe.status).toBe(201);
    const ids = { PROBE_VAULT_ID: seeded.probe.vaultId as string };

    const wrong = probe("check", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyB, ...ids });
    expect(wrong.code).toBe(0);
    expect(wrong.stdout).toContain("Vault: VAULT_ENCRYPTION_KEY does not open 1 of 1 vault keys, so the vault module is off");
    expect(wrong.probe).toMatchObject({ status: { enabled: false, reason: "key_mismatch" }, health: 200, adminStatus: { reason: "key_mismatch" }, vault: { status: 503 } });
    expect(wrong.stdout + wrong.stderr).not.toContain(keyB);

    expect(admin("verify-key", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyB })).toMatchObject({ code: 1 });
    const verified = admin("verify-key", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA });
    expect(verified.code).toBe(0);
    expect(verified.stdout).toContain("The key opens all 1 vault data keys (1 vault)");
    expect(admin("verify-key", { DATA_DIR: dir })).toMatchObject({ code: 2 });
    expect(admin("nonsense", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA })).toMatchObject({ code: 2 });

    expect(admin("rotate-kek", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA })).toMatchObject({ code: 2 });
    expect(admin("rotate-kek", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_NEW: keyA })).toMatchObject({ code: 2 });
    expect(admin("rotate-kek", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_NEW: totpKey }).stderr).toContain("must differ from TOTP_ENCRYPTION_KEY");
    // H1: an inline new key is refused unless the operator says it was saved; a file is the normal way.
    const inline = admin("rotate-kek", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_NEW: keyC });
    expect(inline.code).toBe(2);
    expect(inline.stderr).toContain("VAULT_ENCRYPTION_KEY_NEW_FILE");
    expect(inline.stdout + inline.stderr).not.toContain(keyC);
    expect(admin("verify-key", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA })).toMatchObject({ code: 0 });
    expect(run([join("server", "vault-admin.ts"), "verify-key", "--key-saved"], { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA })).toMatchObject({ code: 2 });
    const newKeyFile = join(dataDir(), "vault.key.new");
    writeFileSync(newKeyFile, `${keyC}\n`, { mode: 0o600 });
    const fingerprintC = createHash("sha256").update(Buffer.from(keyC, "base64")).digest("hex").slice(0, 8);

    // L3: refused while a server heartbeat in DATA_DIR stays fresh (the CLI waits 20 seconds first).
    const heartbeat = join(dir, "server.heartbeat");
    const keepBeating = setInterval(() => writeFileSync(heartbeat, "test heartbeat\n"), 1000);
    writeFileSync(heartbeat, "test heartbeat\n");
    try {
      const busy = await runAsync([join("server", "vault-admin.ts"), "rotate-kek"], { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_NEW_FILE: newKeyFile });
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain("still using this DATA_DIR");
    } finally {
      clearInterval(keepBeating);
      rmSync(heartbeat, { force: true });
    }
    expect(admin("verify-key", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA })).toMatchObject({ code: 0 });

    const rotated = admin("rotate-kek", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_NEW_FILE: newKeyFile });
    expect(rotated.code).toBe(0);
    expect(rotated.stdout).toContain("Re-wrapped 1 vault data keys");
    expect(rotated.stdout).toContain(`New key fingerprint:     ${fingerprintC}`);
    expect(rotated.stdout).toContain("Next steps:");
    expect(rotated.stdout + rotated.stderr).not.toContain(keyC);
    expect(admin("verify-key", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA })).toMatchObject({ code: 1 });
    const verifiedC = admin("verify-key", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY_FILE: newKeyFile });
    expect(verifiedC).toMatchObject({ code: 0 });
    expect(verifiedC.stdout).toContain(`Key fingerprint: ${fingerprintC}`);
    // Inline with --key-saved works too (rotating back and forth).
    const back = run([join("server", "vault-admin.ts"), "rotate-kek", "--key-saved"], { DATA_DIR: dir, VAULT_ENCRYPTION_KEY_FILE: newKeyFile, VAULT_ENCRYPTION_KEY_NEW: keyA });
    expect(back.code).toBe(0);
    expect(back.stdout + back.stderr).not.toContain(keyA);
    const forth = run([join("server", "vault-admin.ts"), "rotate-kek", "--key-saved"], { DATA_DIR: dir, VAULT_ENCRYPTION_KEY: keyA, VAULT_ENCRYPTION_KEY_NEW: keyC });
    expect(forth.code).toBe(0);

    // A key file inside DATA_DIR would be archived with every backup (T180): refused.
    const inside = join(dir, "vault.key");
    writeFileSync(inside, `${keyC}\n`, { mode: 0o600 });
    const refused = probe("check", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY_FILE: inside, ...ids });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("VAULT_ENCRYPTION_KEY_FILE must be outside DATA_DIR");
    // The new key, from a file elsewhere, opens the vault and its value.
    const file = join(dataDir(), "vault.key");
    writeFileSync(file, `${keyC}\n`, { mode: 0o600 });
    const after = probe("check", { DATA_DIR: dir, VAULT_ENCRYPTION_KEY_FILE: file, ...ids });
    expect(after.stdout).toContain("the key comes from VAULT_ENCRYPTION_KEY_FILE");
    expect(after.probe).toMatchObject({ status: { enabled: true, reason: null }, vault: { status: 200 }, memberFeatures: { vault: true } });
  }, 120_000);
});
