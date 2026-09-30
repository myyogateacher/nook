import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { accessBody, call, newSecret, newVault, putAccess, resetVaultLimits, setRole, share, unlock } from "./support/vault";

/**
 * Wave 26 (Vault B): members and per-environment access (D214–D216, T181, T185, T198), the Access
 * sheet's payloads (ETag, If-Match), Team caps, guests, integrations, owners, groups with `env_id`,
 * leaving, and what non-members never learn (search, Today, Bin, notifications, activity).
 */

beforeEach(() => resetVaultLimits());

const base = (vaultId: string) => `/vaults/${vaultId}`;

function group(name: string, members: Session[]) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, at, at);
  for (const member of members) db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, member.userId, at);
  return id;
}

function integration(label: string) {
  const id = crypto.randomUUID();
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES (?, ?, ?, '!', ?, 'member', 'service')")
    .run(id, `${id}@integration.invalid`, label, new Date().toISOString());
  return id;
}

describe("per-environment levels for members (T181, T185)", () => {
  test("dev write, staging read, prod none: each route answers by level, prod stays invisible", async () => {
    const owner = await createUser("Share owner");
    const member = await createUser("Share member");
    const vault = await newVault(owner);
    const secret = await newSecret(owner, vault, "DATABASE_URL", { dev: "dev-v", staging: "staging-v", prod: "prod-v" });
    const devOnly = await newSecret(owner, vault, "DEV_ONLY", { dev: "only-dev" });
    await share(owner, vault, [{ session: member, levels: { dev: "write", staging: "read" } }]);

    const listed = (await call(member, "GET", "/vaults")).body.vaults.find((item: any) => item.id === vault.id);
    expect(listed).toMatchObject({ role: "member", via: "direct" });
    expect(listed.environments.map((env: any) => [env.slug, env.level])).toEqual([["dev", "write"], ["staging", "read"]]);
    const secrets = (await call(member, "GET", `${base(vault.id)}/secrets`)).body.secrets;
    expect(Object.keys(secrets.find((item: any) => item.id === secret.id).values).sort()).toEqual([vault.envs.dev, vault.envs.staging].sort());
    expect(JSON.stringify(secrets)).not.toContain(vault.envs.prod);

    const value = (slug: string) => `${base(vault.id)}/secrets/${secret.id}/values/${vault.envs[slug]}`;
    expect((await call(member, "GET", value("dev"))).body.value.value).toBe("dev-v");
    expect((await call(member, "GET", value("staging"))).body.value.value).toBe("staging-v");
    expect((await call(member, "GET", value("prod"))).status).toBe(404);
    expect((await call(member, "PUT", value("dev"), { value: "dev-2", expectedVersion: 1 })).status).toBe(200);
    expect((await call(member, "PUT", value("staging"), { value: "x", expectedVersion: 1 })).body.code).toBe("VAULT_LEVEL");
    expect((await call(member, "PUT", value("prod"), { value: "x", expectedVersion: 1 })).status).toBe(404);
    // D216: renaming or deleting needs write where the secret has values (prod and staging here).
    expect((await call(member, "DELETE", `${base(vault.id)}/secrets/${secret.id}`)).body.code).toBe("VAULT_LEVEL");
    expect((await call(member, "PATCH", `${base(vault.id)}/secrets/${secret.id}`, { name: "RENAMED", expectedRevision: 1 })).body.code).toBe("VAULT_LEVEL");
    expect((await call(member, "PATCH", `${base(vault.id)}/secrets/${devOnly.id}`, { tags: ["mine"], expectedRevision: 1 })).status).toBe(200);
    expect((await call(member, "POST", `${base(vault.id)}/secrets`, { name: "NEW_BY_MEMBER", values: { [vault.envs.dev!]: { value: "n" } } })).status).toBe(201);
    // Owner-only: the vault, environments, order, protection, access, rotation (D215).
    for (const [method, path, body] of [
      ["PATCH", base(vault.id), { name: "X", expectedRevision: 1 }],
      ["DELETE", base(vault.id), {}],
      ["POST", `${base(vault.id)}/environments`, { slug: "qa", name: "QA" }],
      ["PUT", `${base(vault.id)}/environments/order`, { ids: [vault.envs.dev, vault.envs.staging, vault.envs.prod], expectedRevision: 1 }],
      ["PATCH", `${base(vault.id)}/environments/${vault.envs.dev}`, { name: "Renamed" }],
      ["POST", `${base(vault.id)}/rotate`, {}]
    ] as const) {
      expect({ path: `${method} ${path}`, code: (await call(member, method, path, body)).body.code }).toEqual({ path: `${method} ${path}`, code: "VAULT_LEVEL" });
    }
    expect((await call(member, "GET", `${base(vault.id)}/access`)).body.code).toBe("VAULT_LEVEL");
    expect((await putAccess(member, vault.id, accessBody(vault, owner, []), "\"x\"")).body.code).toBe("VAULT_LEVEL");
  });

  test("an environment admin renames their environment and grants read or write there only; never admin, people, or groups", async () => {
    const owner = await createUser("EnvAdmin owner");
    const admin = await createUser("EnvAdmin");
    const other = await createUser("EnvAdmin other");
    const vault = await newVault(owner);
    await share(owner, vault, [{ session: admin, levels: { dev: "admin", staging: "read" } }, { session: other, levels: { staging: "read" } }]);
    expect((await call(admin, "PATCH", `${base(vault.id)}/environments/${vault.envs.dev}`, { name: "Dev box" })).body.environment.name).toBe("Dev box");
    expect((await call(admin, "PATCH", `${base(vault.id)}/environments/${vault.envs.dev}`, { protected: true })).body.code).toBe("VAULT_LEVEL");
    const sheet = await call(admin, "GET", `${base(vault.id)}/access`);
    expect(sheet.status).toBe(200);
    expect(sheet.body.canManagePeople).toBe(false);
    expect(sheet.body.environments.map((env: any) => [env.slug, env.manageable])).toEqual([["dev", true], ["staging", false], ["prod", false]]);
    const as = (people: Parameters<typeof accessBody>[2]) => putAccess(admin, vault.id, accessBody(vault, owner, people));
    // Granting write on dev to an existing member works…
    expect((await as([{ session: admin, levels: { dev: "admin", staging: "read" } }, { session: other, levels: { dev: "write", staging: "read" } }])).status).toBe(200);
    // …but not admin, not on staging, not new people, not their own row.
    expect((await as([{ session: admin, levels: { dev: "admin", staging: "read" } }, { session: other, levels: { dev: "admin", staging: "read" } }])).body.code).toBe("VAULT_LEVEL");
    expect((await as([{ session: admin, levels: { dev: "admin", staging: "read" } }, { session: other, levels: { dev: "write", staging: "write" } }])).body.code).toBe("VAULT_LEVEL");
    const stranger = await createUser("EnvAdmin stranger");
    expect((await as([{ session: admin, levels: { dev: "admin", staging: "read" } }, { session: other, levels: { dev: "write", staging: "read" } }, { session: stranger, levels: { dev: "read" } }])).body.code).toBe("VAULT_LEVEL");
    expect((await as([{ session: admin, levels: { dev: "write", staging: "read" } }, { session: other, levels: { dev: "write", staging: "read" } }])).body.code).toBe("VAULT_LEVEL");
    expect((await as([{ session: admin, role: "owner" }, { session: other, levels: { dev: "write", staging: "read" } }])).body.code).toBe("VAULT_LEVEL");
    expect((await call(other, "GET", `${base(vault.id)}`)).body.vault.environments.map((env: any) => [env.slug, env.level])).toEqual([["dev", "write"], ["staging", "read"]]);
  });
});

describe("Team caps, guests, integrations, admins (T198, V-O3, D73)", () => {
  test("viewers read at most and never own; guests and integrations are refused; a non-member admin gets 404 everywhere", async () => {
    const owner = await createUser("Caps owner");
    const viewer = await createUser("Caps viewer");
    const guest = await createUser("Caps guest");
    const admin = await createUser("Caps admin");
    setRole(viewer, "viewer");
    setRole(guest, "guest");
    setRole(admin, "admin");
    try {
      const vault = await newVault(owner);
      const secret = await newSecret(owner, vault, "CAPPED", { dev: "capped-dev" });
      expect((await putAccess(owner, vault.id, accessBody(vault, owner, [{ session: viewer, levels: { dev: "write" } }]))).body.code).toBe("ROLE_CAP");
      expect((await putAccess(owner, vault.id, accessBody(vault, owner, [{ session: viewer, role: "owner" }]))).body.code).toBe("ROLE_CAP");
      expect((await putAccess(owner, vault.id, accessBody(vault, owner, [{ session: guest, levels: { dev: "read" } }]))).body.code).toBe("GUEST_NOT_ALLOWED");
      const bot = integration("Caps CI");
      const refused = await putAccess(owner, vault.id, accessBody(vault, owner, [{ id: bot, levels: { dev: "read" } }]));
      expect(refused.body).toMatchObject({ code: "INTEGRATION_NOT_ALLOWED" });
      expect(refused.body.error).toContain("Integrations cannot be vault members");
      expect(() => db.query("INSERT INTO vault_members (vault_id, user_id, role, added_at) VALUES (?, ?, 'member', ?)").run(vault.id, bot, new Date().toISOString())).toThrow("PERSON_ONLY");

      await share(owner, vault, [{ session: viewer, levels: { dev: "read" } }]);
      expect((await call(viewer, "GET", `${base(vault.id)}/secrets/${secret.id}/values/${vault.envs.dev}`)).body.value.value).toBe("capped-dev");
      expect((await call(viewer, "PUT", `${base(vault.id)}/secrets/${secret.id}/values/${vault.envs.dev}`, { value: "x", expectedVersion: 1 })).body.code).toBe("ROLE_READ_ONLY");
      // A member with write who becomes a viewer is capped at once (the predicate is live).
      const writer = await createUser("Caps writer");
      await share(owner, vault, [{ session: viewer, levels: { dev: "read" } }, { session: writer, levels: { dev: "write" } }]);
      setRole(writer, "viewer");
      expect((await call(writer, "GET", base(vault.id))).body.vault.environments.map((env: any) => env.level)).toEqual(["read"]);
      // …and as a guest they reach nothing.
      setRole(writer, "guest");
      expect((await call(writer, "GET", base(vault.id))).status).toBe(404);
      setRole(writer, "member");

      // Admins who are not members: the same 404 as a vault that does not exist (D73).
      for (const path of [base(vault.id), `${base(vault.id)}/secrets`, `${base(vault.id)}/access`, `${base(vault.id)}/events`, `${base(vault.id)}/environments/${vault.envs.dev}/export?format=dotenv`]) {
        expect({ path, status: (await call(admin, "GET", path)).status }).toEqual({ path, status: 404 });
      }
      expect((await call(admin, "POST", `${base(vault.id)}/leave`, {})).status).toBe(404);
      expect((await call(admin, "GET", "/vaults")).body.vaults.map((item: any) => item.id)).not.toContain(vault.id);
    } finally {
      for (const session of [viewer, guest]) setRole(session, "member");
    }
  });

  test("a group with guests is refused while sharing with guests is off; its guests never reach the vault", async () => {
    const owner = await createUser("Guest group owner");
    const guest = await createUser("Guest group guest");
    const member = await createUser("Guest group member");
    setRole(guest, "guest");
    const groupId = group(`Guests ${crypto.randomUUID().slice(0, 6)}`, [guest, member]);
    const vault = await newVault(owner);
    db.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES ('share_with_guests', 'false', ?) ON CONFLICT(key) DO UPDATE SET value_json = 'false'").run(new Date().toISOString());
    try {
      const refused = await putAccess(owner, vault.id, accessBody(vault, owner, [], [{ id: groupId, levels: { dev: "read" } }]));
      expect(refused.body).toMatchObject({ code: "GUEST_SHARE_DISABLED", guests: { groups: [groupId] } });
    } finally {
      db.query("DELETE FROM team_settings WHERE key = 'share_with_guests'").run();
    }
    await share(owner, vault, [], [{ id: groupId, levels: { dev: "read" } }]);
    expect((await call(member, "GET", base(vault.id))).status).toBe(200);
    expect((await call(guest, "GET", base(vault.id))).status).toBe(404);
    setRole(guest, "member");
  });
});

describe("the Access sheet payloads (§C.5 shape, per environment)", () => {
  test("GET gives people, groups, levels per environment and an ETag; PUT needs If-Match and refuses a stale one with the latest", async () => {
    const owner = await createUser("Sheet owner");
    const member = await createUser("Sheet member");
    const vault = await newVault(owner);
    const sheet = await call(owner, "GET", `${base(vault.id)}/access`);
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("etag")).toBe(sheet.body.etag);
    expect(sheet.body).toMatchObject({ vault: { id: vault.id }, yourRole: "owner", canManagePeople: true, levels: ["none", "read", "write", "admin"], maxPeople: 50, groups: [] });
    expect(sheet.body.people).toEqual([expect.objectContaining({ id: owner.userId, role: "owner", isYou: true, cap: "admin" })]);
    expect(sheet.body.environments.map((env: any) => [env.slug, env.protected])).toEqual([["dev", false], ["staging", false], ["prod", true]]);
    const body = accessBody(vault, owner, [{ session: member, levels: { dev: "read" } }]);
    const noMatch = await request(`/vault/vaults/${vault.id}/access`, { method: "PUT", body: JSON.stringify(body) }, owner);
    expect(noMatch.status).toBe(428);
    const saved = await putAccess(owner, vault.id, body, sheet.body.etag);
    expect(saved.status).toBe(200);
    expect(saved.body.access.people.find((person: any) => person.id === member.userId).levels[vault.envs.dev!]).toBe("read");
    expect(saved.body.rotated).toBe(false);
    const stale = await putAccess(owner, vault.id, accessBody(vault, owner, []), sheet.body.etag);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("ACCESS_CHANGED");
    expect(stale.body.access.etag).toBe(saved.body.access.etag);
    // Unknown environments and levels are refused.
    expect((await putAccess(owner, vault.id, { people: [{ id: owner.userId, role: "owner", levels: {} }, { id: member.userId, role: "member", levels: { [crypto.randomUUID()]: "read" } }], groups: [] })).status).toBe(400);
    expect((await putAccess(owner, vault.id, { people: [{ id: owner.userId, role: "owner", levels: {} }, { id: member.userId, role: "member", levels: { [vault.envs.dev!]: "god" } }], groups: [] })).status).toBe(400);
  });
});

describe("owners (D214)", () => {
  test("the last owner stays; ownership moves to another owner, and the creator's bytes follow", async () => {
    const owner = await createUser("Owner A");
    const next = await createUser("Owner B");
    const vault = await newVault(owner);
    await newSecret(owner, vault, "OWNED", { dev: "owned" });
    expect((await putAccess(owner, vault.id, { people: [{ id: owner.userId, role: "member", levels: {} }], groups: [] })).body.code).toBe("LAST_OWNER");
    expect((await call(owner, "POST", `${base(vault.id)}/leave`, {})).body.code).toBe("LAST_OWNER");
    await share(owner, vault, [{ session: next, role: "owner" }]);
    // The new owner demotes the creator and so becomes the billing owner.
    const demoted = await putAccess(next, vault.id, { people: [{ id: next.userId, role: "owner", levels: {} }, { id: owner.userId, role: "member", levels: { [vault.envs.dev!]: "read" } }], groups: [] });
    expect(demoted.status).toBe(200);
    expect(db.query("SELECT owner_id FROM vaults WHERE id = ?").get(vault.id)).toEqual({ owner_id: next.userId });
    expect((await call(owner, "GET", base(vault.id))).body.vault).toMatchObject({ role: "member", ownerName: "Owner B" });
    // A member can leave; a later GET is 404.
    const left = await call(owner, "POST", `${base(vault.id)}/leave`, {});
    expect(left.status).toBe(200);
    expect(left.body.stillReads).toBe(false);
    expect((await call(owner, "GET", base(vault.id))).status).toBe(404);
  });
});

describe("groups with env_id", () => {
  test("a group grant per environment reaches its members as a member; leaving is refused for them; the rows name each environment", async () => {
    const owner = await createUser("Group owner");
    const reader = await createUser("Group reader");
    const groupId = group(`Readers ${crypto.randomUUID().slice(0, 6)}`, [reader]);
    const vault = await newVault(owner);
    await newSecret(owner, vault, "GROUPED", { dev: "g-dev", staging: "g-staging" });
    await share(owner, vault, [], [{ id: groupId, levels: { dev: "write", staging: "read" } }]);
    const rows = db.query("SELECT env_id, level FROM group_grants WHERE resource_kind = 'vault' AND resource_id = ? ORDER BY level").all(vault.id);
    expect(rows).toEqual([{ env_id: vault.envs.dev, level: "edit" }, { env_id: vault.envs.staging, level: "view" }]);
    const summary = (await call(reader, "GET", "/vaults")).body.vaults.find((item: any) => item.id === vault.id);
    expect(summary).toMatchObject({ role: "member", via: "group" });
    expect(summary.environments.map((env: any) => [env.slug, env.level])).toEqual([["dev", "write"], ["staging", "read"]]);
    expect((await call(reader, "POST", `${base(vault.id)}/leave`, {})).body.code).toBe("VIA_GROUP");
    // A direct row and a group: the higher wins.
    await share(owner, vault, [{ session: reader, levels: { staging: "write" } }], [{ id: groupId, levels: { dev: "write", staging: "read" } }]);
    expect((await call(reader, "GET", base(vault.id))).body.vault.environments.map((env: any) => env.level)).toEqual(["write", "write"]);
    // Removing the group and the row: nothing is left, and a rotation starts.
    const removed = await putAccess(owner, vault.id, accessBody(vault, owner, []));
    expect(removed.body).toMatchObject({ rotated: true, lostAccess: 1 });
    expect((await call(reader, "GET", base(vault.id))).status).toBe(404);
  });
});

describe("nothing leaks to non-members (D223, T193)", () => {
  test("search, Today, the Bin, notifications, activity, and email carry no vault or secret names to people outside it", async () => {
    const mail = await import("../server/mail");
    const { runMailDispatch } = await import("../server/mail/dispatcher");
    const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
    mail.setMailTransportForTests(async (message) => { sent.push(message as never); return { id: `m${sent.length}` }; });
    try {
      const owner = await createUser("Leak owner");
      const member = await createUser("Leak member");
      const outsider = await createUser("Leak outsider");
      db.query("UPDATE users SET email_verified_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), member.userId, outsider.userId);
      const vault = await newVault(owner, "Leaky Payments");
      const secret = await newSecret(owner, vault, "STRIPE_SECRET_LEAK", { dev: "sk_leak_value" });
      await share(owner, vault, [{ session: member, levels: { dev: "write" } }]);
      await unlock(member);
      expect((await call(member, "DELETE", `${base(vault.id)}/secrets/${secret.id}`)).status).toBe(200);

      // The bell: the member hears the vault's name, never a secret's.
      const bell = await (await request("/notifications", {}, member)).json() as { items: Array<{ title: string; href: string }> };
      const line = bell.items.find((item) => item.title.includes("Leaky Payments"));
      expect(line).toMatchObject({ href: `/vault/${vault.id}` });
      expect(JSON.stringify(bell)).not.toContain("STRIPE_SECRET_LEAK");
      // Email: the vault's name only.
      await runMailDispatch({ nowMs: Date.now() + 11 * 60_000 });
      const shared = sent.filter((message) => message.to === member.email);
      expect(shared.length).toBe(1);
      expect(shared[0]!.subject).toContain("Leaky Payments");
      expect(`${shared[0]!.text}${shared[0]!.html}`).not.toContain("STRIPE_SECRET_LEAK");
      expect(`${shared[0]!.text}${shared[0]!.html}`).not.toContain("sk_leak_value");

      for (const session of [outsider]) {
        const text = JSON.stringify([
          await (await request("/search?q=STRIPE", {}, session)).text(),
          await (await request("/search?q=Leaky", {}, session)).text(),
          await (await request("/bin", {}, session)).text(),
          await (await request("/notifications", {}, session)).text(),
          await (await request("/today", {}, session)).text(),
          (await call(session, "GET", `${base(vault.id)}/events`)).text
        ]);
        expect(text).not.toContain("STRIPE_SECRET_LEAK");
        expect(text).not.toContain("Leaky Payments");
      }
      // In the Bin: the owner and the deleter see the row; a member who did not delete it does not.
      const bystander = await createUser("Leak bystander");
      await share(owner, vault, [{ session: member, levels: { dev: "write" } }, { session: bystander, levels: { dev: "write" } }]);
      const binOf = async (session: Session) => JSON.stringify(await (await request("/bin", {}, session)).json());
      expect(await binOf(owner)).toContain("STRIPE_SECRET_LEAK");
      expect(await binOf(member)).toContain("STRIPE_SECRET_LEAK");
      expect(await binOf(bystander)).not.toContain("STRIPE_SECRET_LEAK");
      // Activity: owners see everything, members their own events only, with names but no values.
      const ownerView = await call(owner, "GET", `${base(vault.id)}/events`);
      expect(ownerView.body.scope).toBe("vault");
      expect(ownerView.body.events.some((event: any) => event.actor?.id === member.userId && event.event === "secret.delete")).toBe(true);
      const memberView = await call(member, "GET", `${base(vault.id)}/events`);
      expect(memberView.body.scope).toBe("own");
      expect(memberView.body.events.every((event: any) => event.actor?.id === member.userId)).toBe(true);
      expect(ownerView.text).not.toContain("sk_leak_value");
      // Removal: the bell line keeps no name once the member cannot read the vault.
      await putAccess(owner, vault.id, accessBody(vault, owner, [{ session: bystander, levels: { dev: "write" } }]));
      const after = JSON.stringify(await (await request("/notifications", {}, member)).json());
      expect(after).not.toContain("Leaky Payments");
      expect(after).toContain("removed your access to a vault");
    } finally {
      mail.setMailTransportForTests(null);
    }
  });
});

describe("the Team member access page (D268, D269)", () => {
  test("an admin sees a person's vaults with names hidden, removes one (rotating its key), lowers another, and Reset removes the rest", async () => {
    const admin = await createUser("Page admin");
    setRole(admin, "admin");
    const owner = await createUser("Page owner");
    const target = await createUser("Page target");
    const one = await newVault(owner, "Hidden One");
    const two = await newVault(owner, "Hidden Two");
    const three = await newVault(owner, "Hidden Three");
    await share(owner, one, [{ session: target, levels: { dev: "write" } }]);
    await share(owner, two, [{ session: target, levels: { dev: "write", staging: "admin" } }]);
    await share(owner, three, [{ session: target, levels: { dev: "read" } }]);
    const summary = await request(`/team/members/${target.userId}/access`, {}, admin);
    const body = await summary.json() as any;
    expect(body.vaults).toHaveLength(3);
    for (const name of ["Hidden One", "Hidden Two", "Hidden Three", "Development", one.id, two.id, three.id]) expect(JSON.stringify(body.vaults)).not.toContain(name);
    expect(body.vaults.every((row: any) => row.titleHidden && row.title === "Vault owned by Page owner" && typeof row.handle === "string")).toBe(true);
    expect(body.resetCounts.directShares).toBe(3);
    // Remove one with write somewhere; lower another (to read only); a raise is never offered.
    const rows = body.vaults as Array<{ handle: string; environments: Array<{ level: string }> }>;
    const writable = rows.filter((row) => row.environments.some((env) => env.level !== "read"));
    const [first, second] = writable;
    expect((await request(`/team/members/${target.userId}/access/${first!.handle}`, { method: "DELETE", body: "{}" }, admin)).status).toBe(200);
    expect((await request(`/team/members/${target.userId}/access/${first!.handle}`, { method: "DELETE", body: "{}" }, admin)).status).toBe(404);
    expect((await request(`/team/members/${target.userId}/access/${second!.handle}`, { method: "PATCH", body: JSON.stringify({ level: "view" }) }, admin)).status).toBe(200);
    // Lowered already: nothing is left to lower, and edit is never offered.
    expect((await request(`/team/members/${target.userId}/access/${second!.handle}`, { method: "PATCH", body: JSON.stringify({ level: "view" }) }, admin)).status).toBe(400);
    expect((await request(`/team/members/${target.userId}/access/${second!.handle}`, { method: "PATCH", body: JSON.stringify({ level: "edit" }) }, admin)).status).toBe(400);
    const events = db.query("SELECT event FROM vault_events WHERE event IN ('member.remove', 'key.rotate.auto') AND actor_id = ?").all(admin.userId) as Array<{ event: string }>;
    expect(events.map((row) => row.event).sort()).toEqual(["key.rotate.auto", "member.remove"]);
    const reset = await request(`/team/members/${target.userId}/access/reset`, { method: "POST", body: "{}" }, admin);
    expect(reset.status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM vault_members WHERE user_id = ?").get(target.userId)).toEqual({ count: 0 });
    // The person's own page (Settings → My access) shows real names and no handles.
    await share(owner, one, [{ session: target, levels: { dev: "read" } }]);
    const mine = await (await request("/me/access", {}, target)).json() as any;
    expect(mine.vaults.map((row: any) => row.title)).toEqual(["Hidden One"]);
    expect(mine.vaults[0].handle).toBeUndefined();
  });
});
