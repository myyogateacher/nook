import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

/**
 * T181 / D213 guard: the vault's plaintext has one way out. Only server/vault/crypto.ts (besides
 * totp.ts and access/handles.ts, which hold their own keys) may use the cipher functions; only the vault service,
 * its startup check, and the host CLI import vault crypto; and only access.ts mints grants. Vault
 * data never enters global search, Today, or other modules (D223).
 */

const root = join(import.meta.dir, "..", "server");
async function sources() {
  const files: Array<{ path: string; source: string }> = [];
  for await (const path of new Glob("**/*.ts").scan({ cwd: root })) files.push({ path, source: await Bun.file(join(root, path)).text() });
  return files;
}

// totp.ts (second factors) and access/handles.ts (opaque item handles) have their own keys and never see vault data.
const OTHER_CIPHER_USERS = new Set(["totp.ts", "access/handles.ts"]);

test("only vault/crypto.ts touches the cipher functions (besides modules with their own keys)", async () => {
  const offenders = (await sources()).filter(({ path, source }) => /createDecipheriv|createCipheriv/.test(source) && path !== "vault/crypto.ts" && !OTHER_CIPHER_USERS.has(path)).map(({ path }) => path);
  expect(offenders).toEqual([]);
});

test("only the vault service, its status check, and the host CLI import vault crypto", async () => {
  const importers = (await sources()).filter(({ source }) => /from\s+"(\.\/|\.\.\/)*(vault\/)?crypto"/.test(source) && /vault/.test(source)).map(({ path }) => path)
    .filter((path) => path.startsWith("vault/") || path === "vault-admin.ts");
  expect(importers.sort()).toEqual(["vault-admin.ts", "vault/service.ts", "vault/status.ts"]);
  const outside = (await sources()).filter(({ path, source }) => !path.startsWith("vault/") && path !== "vault-admin.ts" && /vault\/crypto/.test(source)).map(({ path }) => path);
  expect(outside).toEqual([]);
});

test("grants are minted only in access.ts, and the low-level envelope functions are used only by crypto.ts", async () => {
  for (const { path, source } of await sources()) {
    if (path !== "vault/access.ts") expect({ path, mints: /\bmint\(/.test(source) && /VaultGrant/.test(source) }).toEqual({ path, mints: false });
    if (path !== "vault/crypto.ts") expect({ path, low: /\b(openEnvelope|sealEnvelope|unwrapDek|wrapDek)\b/.test(source) }).toEqual({ path, low: false });
  }
});

test("vault tables stay inside the vault module (D223): no search, Today, or MCP code reads them", async () => {
  const allowed = new Set(["vault/access.ts", "vault/bin.ts", "vault/crypto.ts", "vault/limits.ts", "vault/service.ts", "vault/status.ts", "vault/routes.ts", "vault-admin.ts", "migrations/031_vault.ts"]);
  const readers = (await sources()).filter(({ path, source }) => !allowed.has(path) && /\bvault_(secrets|values|value_versions|keys|environments|events)\b/.test(source)).map(({ path }) => path);
  expect(readers).toEqual([]);
});
