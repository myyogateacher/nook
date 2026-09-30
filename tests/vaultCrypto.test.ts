import { beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { createUser, db } from "./support/harness";
import { call, newSecret, newVault, resetVaultLimits } from "./support/vault";

const crypto_ = await import("../server/vault/crypto");
const { AAD, openEnvelope, sealEnvelope, unwrapDek, wrapDek, rotateKek, verifyKeys, openValue, sealValue } = crypto_;
const { requireEnvGrant, requireVault } = await import("../server/vault/access");
const { config } = await import("../server/config");
const { setVaultKeyForTests } = await import("../server/vault/status");

/**
 * The vault's crypto (vault plan §3.3, §13 row 1; T181, T189, T190): known-answer AES-256-GCM,
 * envelope round trips at the size bounds, nonce uniqueness, AAD binding per id, tamper detection,
 * DEK wrapping, KEK rotation, and the grant check in front of every open and seal.
 */

beforeEach(() => resetVaultLimits());

const hex = (value: string) => Buffer.from(value, "hex");
const b64url = (value: Buffer) => value.toString("base64url");

describe("AES-256-GCM envelopes", () => {
  test("NIST GCM test case 16 (256-bit key, 96-bit IV, AAD) through the envelope format", () => {
    const key = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
    const nonce = hex("cafebabefacedbaddecaf888");
    const plaintext = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
    const aadBytes = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    const expectedCt = hex("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662");
    const expectedTag = hex("76fc6ece0f4e1768cddf8853bb2d551b");
    // Envelope AADs are UTF-8 text and this vector's AAD is binary, so the envelope is checked for the
    // ciphertext (GCM's counter stream does not depend on the AAD) and the full vector, tag included,
    // for the primitive underneath.
    const aadUtf8 = "nook:kat";
    const envelope = sealEnvelope(key, plaintext, aadUtf8, nonce);
    const [format, n, , ct] = envelope.split(":");
    expect(format).toBe("v1");
    expect(n).toBe(b64url(nonce));
    // Without AAD differences the ciphertext (CTR keystream) is identical to the vector's.
    expect(Buffer.from(ct!, "base64url").equals(expectedCt)).toBe(true);
    expect(openEnvelope(key, envelope, aadUtf8).equals(plaintext)).toBe(true);
    // The full vector, AAD included, with node:crypto directly: the primitive the envelope uses.
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aadBytes);
    const full = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    expect(full.equals(expectedCt)).toBe(true);
    expect(cipher.getAuthTag().equals(expectedTag)).toBe(true);
  });

  test("round trips at every size bound, including empty and 64 KiB", () => {
    const key = Buffer.alloc(32, 3);
    for (const size of [0, 1, 15, 16, 17, 2048, 65_536]) {
      const plaintext = Buffer.alloc(size, 0x61);
      expect(openEnvelope(key, sealEnvelope(key, plaintext, "aad"), "aad").equals(plaintext)).toBe(true);
    }
  });

  test("100,000 envelopes never reuse a nonce", () => {
    const key = Buffer.alloc(32, 4);
    const seen = new Set<string>();
    for (let index = 0; index < 100_000; index += 1) seen.add(sealEnvelope(key, Buffer.alloc(1), "n").split(":")[1]!);
    expect(seen.size).toBe(100_000);
  }, 30_000);

  test("a flipped byte in the nonce, tag, or ciphertext, a wrong key, a wrong AAD, or a malformed envelope fails closed", () => {
    const key = Buffer.alloc(32, 5);
    const envelope = sealEnvelope(key, Buffer.from("secret value"), "aad");
    const parts = envelope.split(":");
    for (const index of [1, 2, 3]) {
      const bytes = Buffer.from(parts[index]!, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      const tampered = parts.map((part, at) => at === index ? b64url(bytes) : part).join(":");
      expect(() => openEnvelope(key, tampered, "aad")).toThrow("integrity");
    }
    expect(() => openEnvelope(Buffer.alloc(32, 6), envelope, "aad")).toThrow("integrity");
    expect(() => openEnvelope(key, envelope, "aad2")).toThrow("integrity");
    for (const bad of ["", "v2:" + parts.slice(1).join(":"), parts.slice(0, 3).join(":"), `${envelope}:x`, envelope.replace("v1:", "v1:!")]) {
      expect(() => openEnvelope(key, bad, "aad")).toThrow("integrity");
    }
  });

  test("DEK wrapping binds the vault and generation", () => {
    const kek = Buffer.alloc(32, 8);
    const dek = Buffer.alloc(32, 1);
    const wrapped = wrapDek(kek, "vault-a", 1, dek);
    expect(unwrapDek(kek, "vault-a", 1, wrapped).equals(dek)).toBe(true);
    expect(() => unwrapDek(kek, "vault-b", 1, wrapped)).toThrow("integrity");
    expect(() => unwrapDek(kek, "vault-a", 2, wrapped)).toThrow("integrity");
    expect(() => unwrapDek(Buffer.alloc(32, 9), "vault-a", 1, wrapped)).toThrow("integrity");
    expect(AAD.value("v", "s", "e", 3)).toBe("nook:vault-value:v1:v:s:e:3");
  });
});

describe("values under their ids (T189)", () => {
  test("a ciphertext moved to another secret, environment, version, or vault fails with VAULT_INTEGRITY, audited", async () => {
    const owner = await createUser("Swap owner");
    const vault = await newVault(owner);
    const a = await newSecret(owner, vault, "A", { dev: "alpha-dev", prod: "alpha-prod" });
    const b = await newSecret(owner, vault, "B", { dev: "beta-dev" });
    const row = (secretId: string, envId: string) => db.query("SELECT value_ct, generation, version FROM vault_values WHERE secret_id = ? AND env_id = ?").get(secretId, envId) as { value_ct: string; generation: number; version: number };

    // Prod's ciphertext under dev (same secret): the environment id is in the AAD.
    db.query("UPDATE vault_values SET value_ct = ? WHERE secret_id = ? AND env_id = ?").run(row(a.id, vault.envs.prod!).value_ct, a.id, vault.envs.dev!);
    const swapped = await call(owner, "GET", `/vaults/${vault.id}/secrets/${a.id}/values/${vault.envs.dev}`);
    expect(swapped).toMatchObject({ status: 500, body: { code: "VAULT_INTEGRITY" } });
    expect(swapped.text).not.toContain("alpha");
    // Another secret's ciphertext (same environment): B has no prod value, so it gets A's.
    db.query("INSERT INTO vault_values (secret_id, env_id, value_ct, generation, version, updated_at) VALUES (?, ?, ?, 1, 1, ?)").run(b.id, vault.envs.prod!, row(a.id, vault.envs.prod!).value_ct, new Date().toISOString());
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${b.id}/values/${vault.envs.prod}`)).body.code).toBe("VAULT_INTEGRITY");
    // An older version replayed under a newer version number.
    const bRow = row(b.id, vault.envs.dev!);
    db.query("UPDATE vault_values SET version = 2 WHERE secret_id = ? AND env_id = ?").run(b.id, vault.envs.dev!);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${b.id}/values/${vault.envs.dev}`)).body.code).toBe("VAULT_INTEGRITY");
    db.query("UPDATE vault_values SET version = ? WHERE secret_id = ? AND env_id = ?").run(bRow.version, b.id, vault.envs.dev!);
    expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${b.id}/values/${vault.envs.dev}`)).body.value.value).toBe("beta-dev");
    // A ciphertext copied into another vault fails there too.
    const other = await newVault(owner);
    const c = await newSecret(owner, other, "C", { dev: "gamma" });
    db.query("UPDATE vault_values SET value_ct = ? WHERE secret_id = ? AND env_id = ?").run(bRow.value_ct, c.id, other.envs.dev!);
    expect((await call(owner, "GET", `/vaults/${other.id}/secrets/${c.id}/values/${other.envs.dev}`)).body.code).toBe("VAULT_INTEGRITY");
    const failures = db.query("SELECT COUNT(*) AS count FROM vault_events WHERE event = 'integrity.fail' AND vault_id IN (?, ?)").get(vault.id, other.id) as { count: number };
    expect(failures.count).toBe(4);
  });

  test("the cross-vault trigger refuses a value row naming another vault's environment", async () => {
    const owner = await createUser("Trigger owner");
    const one = await newVault(owner);
    const two = await newVault(owner);
    const secret = await newSecret(owner, one, "S");
    expect(() => db.query("INSERT INTO vault_values (secret_id, env_id, value_ct, generation, version, updated_at) VALUES (?, ?, 'v1:a:b:c', 1, 1, ?)").run(secret.id, two.envs.dev!, new Date().toISOString())).toThrow("VAULT_MISMATCH");
  });
});

describe("grants (D213, T181)", () => {
  test("open and seal refuse anything but a grant minted by access.ts for that environment and level", async () => {
    const owner = await createUser("Grant owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "G", { dev: "gee" });
    const stored = db.query("SELECT value_ct, comment_ct, generation, version FROM vault_values WHERE secret_id = ?").get(secret.id) as { value_ct: string; comment_ct: string | null; generation: number; version: number };
    const row = { secretId: secret.id, envId: vault.envs.dev!, version: stored.version, generation: stored.generation, valueCt: stored.value_ct, commentCt: stored.comment_ct };
    const forged = Object.freeze({ vaultId: vault.id, envId: vault.envs.dev!, level: "admin" as const, actorId: owner.userId, via: "session" as const });
    expect(() => openValue(forged, row)).toThrow("Vault grant refused");
    const access = requireVault({ kind: "session", userId: owner.userId }, vault.id);
    const grant = requireEnvGrant(access, vault.envs.dev!, "read");
    expect(openValue(grant, row).value).toBe("gee");
    // A grant for another environment, or a copy of a real one, is refused.
    expect(() => openValue(requireEnvGrant(access, vault.envs.staging!, "read"), row)).toThrow("Vault grant refused");
    // Prod is protected: without a session window no grant is minted at all (D226).
    expect(() => requireEnvGrant(access, vault.envs.prod!, "read")).toThrow("protected");
    expect(() => openValue({ ...grant }, row)).toThrow("Vault grant refused");
    // Sealing needs write.
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    try {
      const readOnly = requireEnvGrant(requireVault({ kind: "session", userId: owner.userId }, vault.id), vault.envs.dev!, "read");
      expect(() => sealValue(readOnly, { secretId: secret.id, envId: vault.envs.dev!, version: 2 }, "x", null)).toThrow("Vault grant refused");
    } finally {
      db.query("UPDATE users SET role = 'member' WHERE id = ?").run(owner.userId);
    }
  });
});

describe("keys (T199, §3.3 rotation)", () => {
  test("KEK rotation re-wraps every DEK and keeps every value readable; the old key opens nothing after", async () => {
    const owner = await createUser("Rotation owner");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "ROT", { dev: "before-rotation" });
    const oldKey = config.vault.key!;
    const newKey = Buffer.alloc(32, 11);
    const before = verifyKeys(oldKey);
    expect(before.failed).toBe(0);
    try {
      expect(rotateKek(oldKey, newKey).keys).toBe(before.keys);
      expect(verifyKeys(newKey)).toEqual({ ...before, failed: 0 });
      expect(verifyKeys(oldKey).failed).toBe(before.keys);
      setVaultKeyForTests(newKey);
      expect((await call(owner, "GET", `/vaults/${vault.id}/secrets/${secret.id}/values/${vault.envs.dev}`)).body.value.value).toBe("before-rotation");
      // The running server with the wrong key: the module is off, not broken.
      expect(setVaultKeyForTests(oldKey)).toEqual({ enabled: false, reason: "key_mismatch" });
      expect((await call(owner, "GET", "/vaults")).body.code).toBe("VAULT_DISABLED");
    } finally {
      rotateKek(newKey, oldKey);
      expect(setVaultKeyForTests(oldKey)).toEqual({ enabled: true, reason: null });
    }
  });
});
