import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute } from "../src/router";
import { vaultBackAction, vaultRoute } from "../src/vaultRoute";
import { alphabetFor, DEFAULT_GENERATOR, generate, randomBelow, strengthLabel } from "../src/vault/generator";
import { PASSPHRASE_WORDS } from "../src/vault/wordlist";
import { cellKey, copySecret } from "../src/vault/reveal";
import { binFolderLabel, binKindLabel, filterBinItems, restoreResultMessage } from "../src/bin/binFormat";
import { settingsModulesFor, unavailableModules } from "../src/modules";
import { formatLoginValue, isTag, parseLoginValue, SLUG_PATTERN } from "../shared/vault";
import type { BinItem } from "../src/types";
import { ApiError } from "../src/api";
import { changedValues, conflictMessage, listNames } from "../src/vault/VaultDialogs";

/** The client side of Wave 25 (Vault A): routes, the generator (§6.7), the clipboard, the Bin, and module availability. */

const V = "0f8fad5b-d9cb-469f-a165-70867728950e";
const E = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const S = "e4eaaaf2-d142-41a4-8c2f-d8c1d4c8c1b7";

describe("vault routes", () => {
  test("parse and format the list, a vault, an environment, and a secret", () => {
    expect(parseRoute("/vault")).toEqual({ app: "vault", vaultId: null, envId: null, secretId: null, page: null });
    expect(parseRoute(`/vault/${V}`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: null, page: null });
    expect(parseRoute(`/vault/${V}/env/${E}`)).toEqual({ app: "vault", vaultId: V, envId: E, secretId: null, page: null });
    expect(parseRoute(`/vault/${V}/secrets/${S}`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: S, page: null });
    expect(parseRoute(`/vault/${V.toUpperCase()}/secrets/${S.toUpperCase()}`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: S, page: null });
    for (const path of ["/vault", `/vault/${V}`, `/vault/${V}/env/${E}`, `/vault/${V}/secrets/${S}`]) expect(formatRoute(parseRoute(path))).toBe(path);
  });

  test("malformed paths fall back to the vault or the list", () => {
    expect(parseRoute("/vault/not-an-id")).toEqual({ app: "vault", vaultId: null, envId: null, secretId: null, page: null });
    expect(parseRoute(`/vault/${V}/secrets/nope`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: null, page: null });
    expect(parseRoute(`/vault/${V}/env/${E}/extra`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: null, page: null });
    // A secret wins over an environment; ids never appear without a vault.
    expect(formatRoute({ app: "vault", vaultId: V, envId: E, secretId: S, page: null })).toBe(`/vault/${V}/secrets/${S}`);
    // Wave 26: a vault's Access and Activity pages.
    expect(parseRoute(`/vault/${V}/access`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: null, page: "access" });
    expect(parseRoute(`/vault/${V}/activity`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: null, page: "activity" });
    expect(parseRoute(`/vault/${V}/activity/x`)).toEqual({ app: "vault", vaultId: V, envId: null, secretId: null, page: null });
    for (const path of [`/vault/${V}/access`, `/vault/${V}/activity`]) expect(formatRoute(parseRoute(path))).toBe(path);
    expect(vaultBackAction(vaultRoute(V, { page: "access" }), 0)).toEqual({ kind: "replace", route: vaultRoute(V) });
    expect(vaultRoute(null, { envId: E })).toEqual({ app: "vault", vaultId: null, envId: null, secretId: null, page: null });
  });

  test("in-app Back steps through history, or replaces a deep link with its parent, or goes Home", () => {
    expect(vaultBackAction(vaultRoute(), 3)).toEqual({ kind: "home" });
    expect(vaultBackAction(vaultRoute(V, { secretId: S, page: null }), 2)).toEqual({ kind: "history" });
    expect(vaultBackAction(vaultRoute(V, { secretId: S, page: null }), 0)).toEqual({ kind: "replace", route: vaultRoute(V) });
    expect(vaultBackAction(vaultRoute(V, { envId: E }), 0)).toEqual({ kind: "replace", route: vaultRoute() });
  });
});

describe("the generator (§6.7)", () => {
  test("rejection sampling draws again from the biased top of the range", () => {
    const draws = [0xffffffff, 7];
    let index = 0;
    const source = (array: Uint32Array) => { array[0] = draws[index++]!; return array; };
    // 2^32 is not a multiple of 3: its top value is refused, and 7 % 3 = 1.
    expect(randomBelow(3, source)).toBe(1);
    expect(index).toBe(2);
    expect(() => randomBelow(0)).toThrow();
  });

  test("characters, tokens, and passphrases have the requested shape and entropy", () => {
    const chars = generate(DEFAULT_GENERATOR);
    expect(chars.value).toHaveLength(32);
    expect([...chars.value].every((char) => alphabetFor(DEFAULT_GENERATOR.sets).includes(char))).toBe(true);
    expect(Math.round(chars.bits)).toBe(Math.round(32 * Math.log2(74)));
    const digits = generate({ ...DEFAULT_GENERATOR, length: 8, sets: { lower: false, upper: false, digits: true, symbols: false } });
    expect(digits.value).toMatch(/^\d{8}$/);
    // Every set off falls back to letters and digits; lengths clamp to 8–128.
    expect(generate({ ...DEFAULT_GENERATOR, length: 500, sets: { lower: false, upper: false, digits: false, symbols: false } }).value).toMatch(/^[A-Za-z0-9]{128}$/);
    expect(generate({ ...DEFAULT_GENERATOR, kind: "hex", bytes: 16 })).toMatchObject({ bits: 128 });
    expect(generate({ ...DEFAULT_GENERATOR, kind: "hex", bytes: 16 }).value).toMatch(/^[0-9a-f]{32}$/);
    expect(generate({ ...DEFAULT_GENERATOR, kind: "base64url", bytes: 32 }).value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const phrase = generate({ ...DEFAULT_GENERATOR, kind: "passphrase", words: 5, separator: "-" });
    expect(phrase.value.split("-").every((word) => PASSPHRASE_WORDS.includes(word))).toBe(true);
    expect(phrase.bits).toBe(55);
    expect(strengthLabel(55)).toBe("55 bits · weak");
    expect(strengthLabel(128)).toBe("128 bits · very strong");
    // QA Q5: the default passphrase is six words, 66 bits, never labelled weak.
    const defaultPhrase = generate({ ...DEFAULT_GENERATOR, kind: "passphrase" });
    expect(defaultPhrase.value.split("-")).toHaveLength(6);
    expect(strengthLabel(defaultPhrase.bits)).toBe("66 bits · fair");
  });

  test("100,000 draws over 16 symbols are roughly uniform", () => {
    const counts = new Array(16).fill(0);
    for (let index = 0; index < 100_000; index += 1) counts[randomBelow(16)] += 1;
    for (const count of counts) expect(Math.abs(count - 6250)).toBeLessThan(500);
  });

  test("the word list is 2,048 unique, sorted, lowercase words (11 bits each)", () => {
    expect(PASSPHRASE_WORDS).toHaveLength(2048);
    expect(new Set(PASSPHRASE_WORDS).size).toBe(2048);
    expect([...PASSPHRASE_WORDS].sort()).toEqual([...PASSPHRASE_WORDS]);
    expect(PASSPHRASE_WORDS.every((word) => /^[a-z]{3,7}$/.test(word))).toBe(true);
  });
});

describe("value conflicts (QA Q1, Q2)", () => {
  test("a VALUE_CHANGED names each environment that moved, with its version", () => {
    const names: Record<string, string> = { d: "Development", s: "Staging", p: "Production" };
    const envName = (id: string) => names[id] ?? "Another environment";
    const batch = new ApiError("changed", 409, { code: "VALUE_CHANGED", envId: "d", currentVersion: 7, changed: [{ envId: "d", currentVersion: 7 }, { envId: "p", currentVersion: 3 }] });
    expect(changedValues(batch, "s")).toEqual([{ envId: "d", currentVersion: 7 }, { envId: "p", currentVersion: 3 }]);
    expect(conflictMessage(changedValues(batch, "s"), envName)).toBe("Development (now version 7) and Production (now version 3) changed since you opened this.");
    // An answer without `changed` is about the environment it names, else the one being edited.
    expect(changedValues(new ApiError("changed", 409, { code: "VALUE_CHANGED", currentVersion: 4 }), "s")).toEqual([{ envId: "s", currentVersion: 4 }]);
    expect(conflictMessage([{ envId: "s", currentVersion: 4 }], envName)).toBe("Staging (now version 4) changed since you opened this.");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("clipboard (T187)", () => {
  test("copying writes the value, then clears it after the delay when the page has focus and it still holds the value", async () => {
    const writes: string[] = [];
    const focus = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { hasFocus: () => true };
    try {
      await copySecret("s3cret", { writeText: async (text: string) => { writes.push(text); }, readText: async () => writes[writes.length - 1] ?? "" }, 5);
      expect(writes).toEqual(["s3cret"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(writes).toEqual(["s3cret", ""]);
      // A browser that refuses to read the clipboard (or cannot): it is left alone.
      const refused: string[] = [];
      await copySecret("s3cret", { writeText: async (text: string) => { refused.push(text); }, readText: async () => { throw new Error("NotAllowedError"); } }, 5);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(refused).toEqual(["s3cret"]);
      const unreadable: string[] = [];
      await copySecret("s3cret", { writeText: async (text: string) => { unreadable.push(text); } }, 5);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unreadable).toEqual(["s3cret"]);
    } finally {
      (globalThis as { document?: unknown }).document = focus;
    }
    expect(cellKey(S, E)).toBe(`${S}:${E}`);
  });
});

describe("shared checks and the Bin", () => {
  test("slugs, tags, and login values", () => {
    for (const slug of ["dev", "prod-eu", "a", "x1"]) expect(SLUG_PATTERN.test(slug)).toBe(true);
    for (const slug of ["", "-dev", "Prod", "p rod", "a".repeat(33)]) expect(SLUG_PATTERN.test(slug)).toBe(false);
    expect(isTag("db")).toBe(true);
    expect(isTag("two words")).toBe(false);
    expect(isTag("a,b")).toBe(false);
    const login = { username: "root", password: "p", url: "https://x.test" };
    expect(parseLoginValue(formatLoginValue(login))).toEqual(login);
    expect(parseLoginValue('{"username":"a"}')).toEqual({ username: "a", password: "", url: "" });
    expect(parseLoginValue('{"other":1}')).toBeNull();
    expect(parseLoginValue("not json")).toBeNull();
  });

  test("vault items in the Bin: labels, the Vault filter, restore messages", () => {
    const item = (type: BinItem["type"], folder: string | null = "Payments"): BinItem => ({ type, id: crypto.randomUUID(), title: "X", folder_id: null, folder_name: folder, size_bytes: null, deleted_at: "2026-09-30T00:00:00.000Z", purge_after: "2026-10-30T00:00:00.000Z", purging: false });
    const items = [item("vault", "Vault"), item("vault_environment"), item("vault_secret"), item("note", "Default")];
    expect(filterBinItems(items, "vault").map((entry) => entry.type)).toEqual(["vault", "vault_environment", "vault_secret"]);
    expect(binKindLabel(items[2]!)).toBe("Secret");
    expect(binFolderLabel(items[1]!)).toBe("Payments");
    expect(binFolderLabel(items[0]!)).toBe("Vault");
    expect(restoreResultMessage(items[2]!, { ok: true, folderName: "Payments" } as never)).toBe("Restored to Payments");
    expect(restoreResultMessage(items[0]!, { ok: true } as never)).toBe("Restored the vault");
  });

  test("module availability: the server's features hide the Vault and its switch", () => {
    expect(unavailableModules(undefined)).toEqual([]);
    expect(unavailableModules({ vault: true })).toEqual([]);
    expect(unavailableModules({ vault: false })).toEqual(["vault"]);
    expect(settingsModulesFor("member", ["vault"]).map((module) => module.id)).not.toContain("vault");
    expect(settingsModulesFor("member").map((module) => module.id)).toContain("vault");
    expect(settingsModulesFor("guest").map((module) => module.id)).not.toContain("vault");
  });
});
