import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { activityLine } from "../src/vault/VaultActivityPage";
import { levelOptions } from "../src/vault/VaultAccessPage";
import { countLabel } from "../src/vault/VaultTransfer";
import { safeNotificationPath } from "../src/notifications/notificationsApi";
import { dotenvValue, formatFromFileName, parseDotenv, serializeCsv, serializeDotenv, serializeJson, parseImport } from "../shared/vaultTransfer";
import type { ActivityEvent } from "../src/vault/vaultApi";

/**
 * The client side of Wave 26 (Vault B): the access grid's level choices (caps, admin for owners
 * only), Activity lines (never a value), import counts, the bell link to a shared vault, the
 * formats' round trips, and the picker rule (app Select and Combobox only in src/vault).
 */

const V = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("the access grid's level choices", () => {
  test("viewers stop at read, guests at none, and only owners give admin", () => {
    const disabled = (options: ReturnType<typeof levelOptions>) => options.filter((option) => option.disabled).map((option) => option.value);
    expect(disabled(levelOptions({ cap: "admin", ownerOnly: false, current: "none" }))).toEqual([]);
    expect(disabled(levelOptions({ cap: "read", ownerOnly: false, current: "read" }))).toEqual(["write", "admin"]);
    expect(disabled(levelOptions({ cap: "none", ownerOnly: false, current: "none" }))).toEqual(["read", "write", "admin"]);
    expect(disabled(levelOptions({ cap: "admin", ownerOnly: true, current: "write" }))).toEqual(["admin"]);
    // The current level always stays choosable, so a row can be saved unchanged.
    expect(disabled(levelOptions({ cap: "read", ownerOnly: true, current: "write" }))).toEqual(["admin"]);
    expect(levelOptions({ cap: "read", ownerOnly: false, current: "read" }).find((option) => option.value === "write")!.description).toBe("Viewers can only read");
  });
});

describe("Activity lines", () => {
  const event = (overrides: Partial<ActivityEvent>): ActivityEvent => ({
    id: "e", createdAt: "2026-09-30T00:00:00.000Z", event: "value.read", via: "session", count: 1,
    actor: { id: "a", displayName: "Alice", isYou: false }, secret: { name: "DATABASE_URL", state: "live" }, environment: { id: "p", name: "Production" }, ...overrides
  });
  test("say who did what, where, and how many; never a value", () => {
    expect(activityLine(event({}))).toBe("Alice revealed DATABASE_URL in Production");
    expect(activityLine(event({ secret: null, environment: null, count: 12 }))).toBe("Alice revealed 12 values");
    expect(activityLine(event({ event: "export", secret: null, count: 3, actor: { id: "b", displayName: "Bob", isYou: true } }))).toBe("You exported 3 values from Production");
    expect(activityLine(event({ event: "import", secret: null, count: 1 }))).toBe("Alice imported into Production (1 entry)");
    expect(activityLine(event({ event: "value.write", environment: { id: null, name: null } }))).toBe("Alice set DATABASE_URL in an environment you cannot see");
    expect(activityLine(event({ event: "secret.delete", secret: { name: null, state: "binned" }, environment: null }))).toBe("Alice deleted a secret now in the Bin");
    expect(activityLine(event({ event: "key.retire", actor: null, via: "sweeper", secret: null, environment: null, count: 1 }))).toBe("Nook retired old data keys");
    expect(activityLine(event({ event: "member.remove", secret: null, environment: null, count: 2 }))).toBe("Alice removed people (2)");
    expect(activityLine(event({ event: "env.protect", secret: null }))).toBe("Alice protected Production");
  });
});

describe("import counts, the bell link, and file formats", () => {
  test("counts read as words", () => {
    expect(countLabel("create", 1)).toBe("1 new secret");
    expect(countLabel("create", 2)).toBe("2 new secrets");
    expect(countLabel("skip", 3)).toBe("3 skipped");
  });

  test("a shared-vault notice opens that vault; anything else stays on the list (T68)", () => {
    expect(safeNotificationPath(`/vault/${V}`)).toBe(`/vault/${V}`);
    expect(safeNotificationPath(`/vault/${V.toUpperCase()}`)).toBe(`/vault/${V}`);
    expect(safeNotificationPath(`/vault/${V}/secrets/${V}`)).toBe("/notifications");
    expect(safeNotificationPath("/vault/not-an-id")).toBe("/notifications");
    expect(safeNotificationPath("https://example.test/vault")).toBe("/notifications");
  });

  test("formats by file name; every serializer round-trips through its parser", () => {
    expect(formatFromFileName(".env")).toBe("dotenv");
    expect(formatFromFileName("production.env")).toBe("dotenv");
    expect(formatFromFileName(".env.local")).toBe("dotenv");
    expect(formatFromFileName("secrets.JSON")).toBe("json");
    expect(formatFromFileName("export.csv")).toBe("csv");
    expect(formatFromFileName("photo.png")).toBeNull();
    expect(dotenvValue("a\"b\\c\nd")).toBe("\"a\\\"b\\\\c\\nd\"");
    const entries = [
      { name: "A", value: "plain", comment: "first", type: "value" },
      { name: "B_2", value: "with \"quotes\", commas, # and\nlines\r\n", comment: null, type: "note" },
      { name: "C", value: "", comment: "multi\nline comment", type: "value" }
    ];
    const pairs = (format: "dotenv" | "json" | "csv", text: string) => Object.fromEntries(parseImport(format, text).entries.map((entry) => [entry.name, entry.value]));
    const expected = Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
    const env = serializeDotenv(entries, { comments: true, header: "Test" });
    expect(env.skipped).toEqual([]);
    expect(env.text).toContain("# multi line comment\nC=\"\"");
    expect(pairs("dotenv", env.text)).toEqual(expected);
    expect(pairs("json", serializeJson(entries, { comments: true, vault: "V", environment: "dev" }))).toEqual(expected);
    expect(pairs("csv", serializeCsv(entries, { comments: true }))).toEqual(expected);
    expect(serializeDotenv([{ name: "has space", value: "x", comment: null, type: "value" }], { comments: false }).skipped).toEqual(["has space"]);
    expect(parseDotenv("A=1\nA=2\n").problems).toEqual([{ line: 1, name: "A", reason: "Replaced by line 2" }]);
  });
});

test("src/vault uses the app's Select and Combobox, never a native select (D91)", async () => {
  const root = join(import.meta.dir, "..", "src", "vault");
  for await (const path of new Glob("**/*.tsx").scan({ cwd: root })) {
    const source = await Bun.file(join(root, path)).text();
    expect({ path, native: /<select[\s>]/.test(source) }).toEqual({ path, native: false });
    expect({ path, confirm: /\bwindow\.confirm\(|\bconfirm\(/.test(source.replace(/useConfirm|confirmElement|confirmLabel|onConfirm|ConfirmRequest|confirmOpen|confirmed/g, "")) }).toEqual({ path, confirm: false });
  }
});
