import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { publicTownhallSettingMigration } = await import("../server/migrations/160_public_townhall_setting");
const { resetPublicLimits } = await import("../server/public/limits");

/**
 * D1382: "Public townhall links" is a workspace setting of its own (team_settings `public_townhall`,
 * migration 160). Before, the audience link fell under "Public forms and polls". The migration seeds it
 * from `public_forms`, so an upgrade keeps each workspace's behaviour.
 */

type Json = Record<string, any>;
let admin: Session;
let host: Session;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const payload = body === undefined && method !== "GET" ? {} : body;
  const response = await request(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, session);
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};
const settings = async () => (await api(admin, "GET", "/workspace/settings")).body as { settings: Json; revision: number };
const put = async (change: Json) => api(admin, "PUT", "/workspace/settings", { settings: change, revision: (await settings()).revision });

beforeAll(async () => {
  admin = await createUser("Townhall policy admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  host = await createUser("Townhall policy host");
});
afterAll(async () => { await put({ publicTownhall: true, publicForms: true }); });

describe("migration 160", () => {
  const legacy = () => {
    const memory = new Database(":memory:");
    memory.exec(`CREATE TABLE team_settings (
      key TEXT PRIMARY KEY CHECK (key IN ('key_max_days','public_forms','public_booking_pages','default_currency')),
      value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_by TEXT,
      updated_at TEXT NOT NULL
    )`);
    return memory;
  };

  test("a workspace that turned public forms off keeps its audience links off; re-running changes nothing", () => {
    const memory = legacy();
    memory.query("INSERT INTO team_settings (key, value_json, revision, updated_at) VALUES ('public_forms', 'false', 3, '2026-01-01T00:00:00.000Z')").run();
    memory.transaction(() => publicTownhallSettingMigration.up(memory))();
    expect(memory.query("SELECT value_json FROM team_settings WHERE key = 'public_townhall'").get()).toEqual({ value_json: "false" });
    memory.transaction(() => publicTownhallSettingMigration.up(memory))();
    expect(memory.query("SELECT COUNT(*) AS count FROM team_settings").get()).toEqual({ count: 2 });
    expect(() => memory.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES ('nope', 'true', 'x')").run()).toThrow(/CHECK/);
  });

  test("with no stored public_forms row, nothing is stored: both read the default (on)", () => {
    const memory = legacy();
    memory.transaction(() => publicTownhallSettingMigration.up(memory))();
    expect(memory.query("SELECT COUNT(*) AS count FROM team_settings").get()).toEqual({ count: 0 });
    memory.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES ('public_townhall', 'true', 'x')").run();
  });
});

describe("the Public townhall links setting", () => {
  test("is read by everyone, on by default, and changed by admins only", async () => {
    const state = await settings();
    expect(state.settings.publicTownhall).toBe(true);
    expect((state as Json).defaults.publicTownhall).toBe(true);
    expect((await api(host, "PUT", "/workspace/settings", { settings: { publicTownhall: false }, revision: state.revision })).status).toBe(403);
  });

  test("off closes townhall audience links but not forms; public forms off no longer closes them", async () => {
    resetPublicLimits();
    const session = (await api(host, "POST", "/townhall/sessions", { title: "Policy all hands" })).body.session as Json;
    const link = await api(host, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: true });
    const token = (link.body.publicUrl as string).split("/").pop();
    const open = async () => (await fetch(`${origin}/api/public/townhall/${token}`, { headers: { Origin: origin } })).status;
    expect(await open()).toBe(200);

    // Public forms off: the townhall link still opens (before D1382 it 404'd).
    expect((await put({ publicForms: false })).status).toBe(200);
    expect(await open()).toBe(200);
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.publicAllowed).toBe(true);
    expect((await put({ publicForms: true })).status).toBe(200);

    // Public townhall links off: the link 404s at once and a new one is refused with the new words.
    expect((await put({ publicTownhall: false })).status).toBe(200);
    expect(await open()).toBe(404);
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.publicAllowed).toBe(false);
    const refused = await api(host, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: true });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "POLICY_OFF", error: "Public townhall links are turned off for this workspace" });
    const form = (await api(host, "POST", "/forms", { kind: "form", title: "Still public" })).body.form as Json;
    expect(form.publicAllowed).toBe(true);

    // On again: the same link comes back.
    expect((await put({ publicTownhall: true })).status).toBe(200);
    expect(await open()).toBe(200);
  });
});
