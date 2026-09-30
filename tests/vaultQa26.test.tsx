import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createUser, db, request } from "./support/harness";
import { call, newVault, resetVaultLimits, share } from "./support/vault";
import { chargeVault } from "../server/vault/limits";
import { draftAfterLoad, guardUnload, notOffered } from "../src/vault/VaultAccessPage";
import { activityLine } from "../src/vault/VaultActivityPage";
import { protectedHint } from "../src/vault/VaultDialogs";
import { hiddenItemPhrase } from "../src/access/memberAccessApi";
import { afterDialogsReleased } from "../src/historyDialogs";
import { DEFAULT_ENVIRONMENTS } from "../shared/vault";
import type { ActivityEvent, VaultAccessSheet } from "../src/vault/vaultApi";

/** QA findings on Wave 26 (Vault B), fixed on wave26-fixes. */

const root = join(import.meta.dir, "..", "src");
beforeEach(() => resetVaultLimits());

describe("QA D4: bulk import and export fit the rate limits", () => {
  test("a 350-entry preview and import succeed on a fresh budget, and 350 values export", async () => {
    const owner = await createUser("QA26 bulk owner");
    const vault = await newVault(owner);
    const path = `/vaults/${vault.id}/environments/${vault.envs.dev}`;
    const entries = Array.from({ length: 350 }, (_, index) => ({ name: `BULK_${index}`, value: `v${index}` }));
    const preview = await call(owner, "POST", `${path}/import`, { entries, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.create).toBe(350);
    const imported = await call(owner, "POST", `${path}/import`, { entries });
    expect(imported.status).toBe(200);
    expect(imported.body.counts.create).toBe(350);
    // Overwriting them all compares 350 values: still one read.
    const again = await call(owner, "POST", `${path}/import`, { entries: entries.map((entry) => ({ ...entry, value: `${entry.value}!` })), mode: "overwrite", dryRun: true });
    expect(again.body.counts.update).toBe(350);
    const exported = await request(`/vault${path}/export?format=csv`, {}, owner);
    expect(exported.status).toBe(200);
    expect((await exported.text()).split("\r\n").filter(Boolean)).toHaveLength(351);
  });

  test("a refused export does not use up one of the hourly exports", async () => {
    const owner = await createUser("QA26 export budget");
    const vault = await newVault(owner);
    chargeVault("read", owner.userId, 300);
    const refused = await request(`/vault/vaults/${vault.id}/environments/${vault.envs.dev}/export?format=dotenv`, {}, owner);
    expect(refused.status).toBe(429);
    expect(db.query("SELECT 1 FROM vault_rate_limits WHERE bucket = ?").get(`export:${owner.userId}`)).toBeNull();
    resetVaultLimits();
    for (let index = 0; index < 10; index += 1) expect((await request(`/vault/vaults/${vault.id}/environments/${vault.envs.dev}/export?format=dotenv`, {}, owner)).status).toBe(200);
    expect((await request(`/vault/vaults/${vault.id}/environments/${vault.envs.dev}/export?format=dotenv`, {}, owner)).status).toBe(429);
  });
});

describe("QA L1: access lines in Activity name whom they were about", () => {
  test("added, given a level, made an owner, removed: names and levels only", async () => {
    const owner = await createUser("QA26 activity owner");
    const ada = await createUser("QA26 Ada");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: ada, levels: { dev: "write" } }]);
    await share(owner, vault, [{ session: ada, role: "owner" }]);
    await share(owner, vault, []);
    const page = await call(owner, "GET", `/vaults/${vault.id}/events?event=access`);
    expect(page.status).toBe(200);
    const lines = (page.body.events as ActivityEvent[]).map(activityLine).sort();
    // Events of one save share a timestamp, so compare as a set.
    expect(lines).toEqual([
      "You added QA26 Ada",
      "You gave QA26 Ada write access to Development",
      "You made QA26 Ada an owner",
      "You removed QA26 Ada"
    ].sort());
    // The new columns are append-only too.
    expect(() => db.query("UPDATE vault_events SET target_id = 'someone' WHERE vault_id = ? AND target_id IS NOT NULL").run(vault.id)).toThrow("APPEND_ONLY");
  });

  test("older events without a target keep their wording, and a lowered level reads as taken away", () => {
    const base: ActivityEvent = { id: "e", createdAt: "2026-09-30T00:00:00.000Z", event: "member.remove", via: "session", count: 2, actor: { id: "a", displayName: "Alice", isYou: false }, secret: null, environment: null };
    expect(activityLine(base)).toBe("Alice removed people (2)");
    expect(activityLine({ ...base, event: "access.level", count: null, target: { displayName: "Bob", isYou: false }, level: "none", environment: { id: "x", name: "Production" } }))
      .toBe("Alice took away Bob's access to Production");
    expect(activityLine({ ...base, event: "access.level", count: null, target: { displayName: "Bob", isYou: true }, level: "read", environment: { id: null, name: null } }))
      .toBe("Alice gave you read access to an environment you cannot see");
  });
});

describe("QA D1: the Access page keeps unsaved edits", () => {
  const sheet = { etag: "\"e\"", people: [{ id: "p1", role: "member", levels: { e1: "read" } }], groups: [] } as unknown as VaultAccessSheet;
  const reloaded = { ...sheet, etag: "\"f\"" } as VaultAccessSheet;

  test("a reload while the draft is dirty keeps the draft; a clean draft takes the new sheet", () => {
    const dirty = { people: [{ ...sheet.people[0]!, levels: { e1: "write" } }], groups: [] } as never;
    expect(draftAfterLoad({ sheet, draft: dirty }, reloaded)).toBe(dirty);
    const clean = draftAfterLoad(null, sheet);
    expect(draftAfterLoad({ sheet, draft: clean }, reloaded)).not.toBe(clean);
  });

  test("reloading or closing the tab with unsaved changes asks first", async () => {
    let prevented = false;
    const event: { preventDefault: () => void; returnValue?: unknown } = { preventDefault: () => { prevented = true; } };
    expect(guardUnload(event, false)).toBe(false);
    expect(prevented).toBe(false);
    expect(guardUnload(event, true)).toBe(true);
    expect(prevented).toBe(true);
    const source = await Bun.file(join(root, "vault", "VaultAccessPage.tsx")).text();
    expect(source).toContain("window.addEventListener(\"beforeunload\"");
    // The load no longer depends on the parent's onMissing (a new function on every render).
    expect(source).toContain("}, [vaultId]);");
    expect(source).not.toContain("[onMissing, vaultId]");
  });
});

describe("QA L3–L8", () => {
  test("L3: the members' Access error has no Try again; L7: guests and integrations say why they are not offered", async () => {
    const source = await Bun.file(join(root, "vault", "VaultAccessPage.tsx")).text();
    expect(source).toContain("{error !== NOT_A_MANAGER && <button");
    expect(notOffered({ id: "g", displayName: "Gus", role: "guest", kind: "person" })).toMatchObject({ disabled: true, description: "Guests never get vault access" });
    expect(notOffered({ id: "b", displayName: "Bot", role: "member", kind: "service" }).disabled).toBe(true);
  });

  test("L4: the New vault sheet says which environments are protected", () => {
    expect(protectedHint(DEFAULT_ENVIRONMENTS)).toBe("Production (prod) is protected: opening it asks for your password again. You can change this in the vault's settings.");
    expect(protectedHint([{ name: "Dev", slug: "dev", protected: false }])).toBeNull();
  });

  test("L5: a hidden vault reads 'a vault', not 'a a vault'", () => {
    expect(hiddenItemPhrase("A vault")).toBe("a vault");
    expect(hiddenItemPhrase("Board owned by Carol")).toBe("a board owned by Carol");
  });

  test("L6: leaving or deleting from the settings sheet navigates once its history layer is gone", async () => {
    let ran = 0;
    afterDialogsReleased(() => { ran += 1; }, (step) => step());
    expect(ran).toBe(1);
    const app = await Bun.file(join(root, "vault", "VaultApp.tsx")).text();
    expect(app).toContain("afterDialogsReleased(onLeft)");
    expect(app).toContain("afterDialogsReleased(onDeleted)");
  });

  test("L8: an import with nothing to write says so", async () => {
    const source = await Bun.file(join(root, "vault", "VaultTransfer.tsx")).text();
    expect(source).toContain("writes === 0 ? \"Nothing to import\"");
  });
});
