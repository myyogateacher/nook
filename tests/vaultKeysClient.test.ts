import { describe, expect, test } from "bun:test";
import {
  ALL_ENVS, envChoices, grantableVaults, namesProtected, permissionChoicesFor, vaultFlagChips, vaultGrantChips, vaultGrantCountChips, vaultGrantsToRows,
  vaultKeyEventLine, vaultRowsNarrow, vaultRowsToGrants, type VaultChoice, type VaultGrantRow
} from "../src/keys/vaultKeyGrants";
import { activityActor, activityLine } from "../src/vault/VaultActivityPage";
import { keyLevelsLine, keysWithAccessLine } from "../src/vault/VaultKeysSection";
import { vaultCurlExample, vaultExpiryChoices } from "../src/keys/KeysSettings";

/**
 * Wave 27 (Vault C), client side: the vault key grant builder's rules (what it offers, protected
 * environments, narrowing), the key row's chips (names for owners, counts for admins), Activity's
 * key actors, and "Keys with access".
 */

const payments: VaultChoice = {
  id: "v1", name: "Payments", environments: [
    { id: "e-dev", slug: "dev", name: "Development", protected: false, level: "write" },
    { id: "e-stg", slug: "staging", name: "Staging", protected: false, level: "read" },
    { id: "e-prod", slug: "prod", name: "Production", protected: true, level: "read" }
  ]
};
const locked: VaultChoice = { id: "v2", name: "Locked", environments: [{ id: "x", slug: "dev", name: "Dev", protected: false, level: "none" }] };
const row = (patch: Partial<VaultGrantRow>): VaultGrantRow => ({ key: "k", vaultId: "v1", envId: ALL_ENVS, permission: "read", ...patch });

describe("vault key grant builder", () => {
  test("offers only vaults the creator reads; protected environments need the flag; write only where the creator writes", () => {
    expect(grantableVaults([payments, locked]).map((vault) => vault.id)).toEqual(["v1"]);
    const without = envChoices(payments, false);
    expect(without.map((option) => [option.value, option.disabled])).toEqual([[ALL_ENVS, false], ["e-dev", false], ["e-stg", false], ["e-prod", true]]);
    expect(envChoices(payments, true).find((option) => option.value === "e-prod")!.disabled).toBe(false);
    expect(permissionChoicesFor(payments, "e-dev", "member").find((option) => option.value === "write")!.disabled).toBe(false);
    expect(permissionChoicesFor(payments, "e-stg", "member").find((option) => option.value === "write")!.disabled).toBe(true);
    expect(permissionChoicesFor(payments, "e-dev", "viewer").find((option) => option.value === "write")!.disabled).toBe(true);
    expect(permissionChoicesFor(payments, ALL_ENVS, "member").find((option) => option.value === "write")!.disabled).toBe(false);
    expect(namesProtected([row({ envId: "e-prod" })], [payments])).toBe(true);
    expect(namesProtected([row({})], [payments])).toBe(false);
  });

  test("rows become grants (every environment is envId null); duplicates and empty lists are refused", () => {
    expect(vaultRowsToGrants([row({}), row({ envId: "e-dev", permission: "write" })]).grants).toEqual([
      { module: "vault", permission: "read", vaultId: "v1", envId: null },
      { module: "vault", permission: "write", vaultId: "v1", envId: "e-dev" }
    ]);
    expect(vaultRowsToGrants([]).error).toContain("Add at least one vault");
    expect(vaultRowsToGrants([row({}), row({ key: "k2" })]).error).toContain("twice");
  });

  test("narrowing follows the server's rule (D278)", () => {
    const ceiling = [row({ permission: "write" })];
    expect(vaultRowsNarrow(ceiling, [row({ permission: "read" })], false)).toBe(true);
    expect(vaultRowsNarrow(ceiling, [row({ envId: "e-dev" })], false)).toBe(true);
    expect(vaultRowsNarrow(ceiling, [row({ envId: "e-dev" })], true)).toBe(false);
    expect(vaultRowsNarrow([row({ envId: "e-dev" })], [row({})], false)).toBe(false);
    expect(vaultRowsNarrow([row({})], [row({ vaultId: "v2" })], false)).toBe(false);
    const views = [{ module: "vault" as const, permission: "write", resource: { kind: "vault" as const, id: "v1", name: "Payments" }, env: { id: "e-dev", name: "Development", protected: false }, active: true, inactiveReason: null }];
    expect(vaultGrantsToRows(views).map(({ vaultId, envId, permission }) => ({ vaultId, envId, permission }))).toEqual([{ vaultId: "v1", envId: "e-dev", permission: "write" }]);
  });
});

describe("vault key rows, Activity, and Keys with access", () => {
  const grants = [
    { module: "vault" as const, permission: "write", resource: { kind: "vault" as const, id: "v1", name: "Payments" }, env: { id: "e-dev", name: "Development", protected: false }, active: true, inactiveReason: null },
    { module: "vault" as const, permission: "read", resource: { kind: "vault" as const, id: "v2", name: null }, env: null, active: false, inactiveReason: "no-access" }
  ];
  test("owners see names; Team → Keys sees counts only (D73)", () => {
    expect(vaultGrantChips(grants).map((chip) => chip.label)).toEqual(["Vault · Payments · Development: read and write", "Vault · A vault · every environment: read (no current access)"]);
    // Review L4: Team → Keys gets no ids either; the server's counts make the chip.
    const counted = vaultGrantCountChips(grants.map((grant) => ({ ...grant, resource: grant.resource && { ...grant.resource, id: null, name: null }, env: grant.env && { ...grant.env, id: null, name: null } })), { vaults: 2, writeVaults: 1 });
    expect(counted.map((chip) => chip.label)).toEqual(["Vault · 2 vaults · write in 1"]);
    expect(JSON.stringify(counted)).not.toContain("Payments");
    expect(vaultFlagChips({ allowMcpValueReads: false, protectedAccess: true })).toEqual(["No values over MCP", "Protected environments"]);
    expect(vaultFlagChips(null)).toEqual([]);
  });

  test("Activity names the key as key:<name> and whose it is; the key's own history never names a secret", () => {
    const base = { id: "1", createdAt: new Date().toISOString(), count: 1, secret: { name: "DB_URL", state: "live" as const }, environment: { id: "e", name: "Staging" } };
    expect(activityActor({ actor: { id: "u", displayName: "Ada", isYou: false }, via: "api", key: { name: "CI", prefix: "nkv_x" } })).toBe("key:CI (Ada's key)");
    expect(activityLine({ ...base, event: "value.read", via: "api", actor: { id: "u", displayName: "Ada", isYou: false }, key: { name: "CI", prefix: "nkv_x" } })).toBe("key:CI (Ada's key) revealed DB_URL in Staging");
    expect(activityLine({ ...base, event: "value.read", via: "session", actor: { id: "u", displayName: "Ada", isYou: false } })).toBe("Ada revealed DB_URL in Staging");
    expect(activityLine({ ...base, secret: null, environment: null, event: "apikey.create", via: "session", actor: { id: "u", displayName: "Ada", isYou: true }, key: { name: "CI", prefix: null } })).toBe("You gave the API key “CI” access to this vault");
    expect(vaultKeyEventLine({ event: "value.write", via: "mcp", vault: { name: "Payments" }, environment: { name: "Development" } })).toBe("Wrote a value over MCP · Payments · Development");
  });

  test("Keys with access: owners see each key; others the count and their own", () => {
    expect(keysWithAccessLine({ count: 2, scope: "vault", keys: [] })).toContain("2 API keys reach this vault now");
    expect(keysWithAccessLine({ count: 0, scope: "vault", keys: [] })).toBe("No API key reaches this vault.");
    expect(keysWithAccessLine({ count: 3, scope: "own", keys: [] })).toContain("none of yours");
    expect(keyLevelsLine({ "e-dev": "write", "e-stg": "read" }, payments.environments)).toBe("Development: read and write · Staging: read");
    expect(keyLevelsLine({}, payments.environments)).toBe("No environment right now");
  });

  test("the help's example never holds a real key, and vault keys always expire", () => {
    expect(vaultCurlExample("https://nook.example")).toContain("<YOUR_VAULT_KEY>");
    expect(vaultCurlExample("https://nook.example")).not.toMatch(/nkv_[A-Za-z0-9]/);
    const choices = vaultExpiryChoices({ keyMaxDays: 400, keyDefaultDays: 90, keyRequireExpiry: false });
    expect(choices.some((option) => option.value === "none")).toBe(false);
    expect(Math.max(...choices.map((option) => Number(option.value)))).toBe(365);
  });
});
