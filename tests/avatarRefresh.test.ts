/**
 * A changed picture on screens already open (T353): with no push channel to everyone, an avatar that
 * fails to load looks up the person's current URL once (/api/me/avatar for oneself, /api/team/:id for
 * others), and every avatar holding the stale URL switches. Guests cannot read Team, so they keep the
 * letters and learn nothing new.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { base64, makePng } from "./support/images";
import { retireUsersAfterFile } from "./support/retireUsers";
import { currentAvatarUrl, refreshAvatar, resetAvatarRefresh, type AvatarLookup } from "../src/ui/avatarRefresh";
import { selfAvatarNow, setSelfAvatar } from "../src/ui/selfAvatar";

retireUsersAfterFile();
beforeAll(async () => {
  const admin = await createUser("AF file admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
});

const user = "11111111-1111-4111-8111-111111111111";
const urlOf = (userId: string, version: string) => `/api/users/${userId}/avatar?v=${version}`;
const OLD = urlOf(user, "22222222-2222-4222-8222-222222222222");
const NEW = urlOf(user, "33333333-3333-4333-8333-333333333333");

function lookup(answer: string | null | Error) {
  const calls: string[] = [];
  const respond = async () => { if (answer instanceof Error) throw answer; return answer; };
  const value: AvatarLookup = { self: async () => { calls.push("self"); return respond(); }, member: async (id) => { calls.push(id); return respond(); } };
  return { calls, value };
}

describe("refreshAvatar (client)", () => {
  beforeEach(() => { resetAvatarRefresh(); setSelfAvatar(null); });

  test("a stale URL is looked up once for that person and every holder of it gets the new one", async () => {
    const { calls, value } = lookup(NEW);
    expect(currentAvatarUrl(OLD)).toBe(OLD);
    expect(await refreshAvatar(OLD, value)).toBe(NEW);
    expect(calls).toEqual([user]);
    expect(currentAvatarUrl(OLD)).toBe(NEW);
    // Once per stale URL: a second failure does not ask again.
    expect(await refreshAvatar(OLD, value)).toBeUndefined();
    expect(calls).toEqual([user]);
  });

  test("a removed picture becomes the letters; a lookup failure or an unchanged URL changes nothing", async () => {
    expect(await refreshAvatar(OLD, lookup(null).value)).toBeNull();
    expect(currentAvatarUrl(OLD)).toBeNull();
    resetAvatarRefresh();
    expect(await refreshAvatar(OLD, lookup(new Error("404")).value)).toBeUndefined();
    expect(currentAvatarUrl(OLD)).toBe(OLD);
    resetAvatarRefresh();
    expect(await refreshAvatar(OLD, lookup(OLD).value)).toBeUndefined();
    expect(currentAvatarUrl(OLD)).toBe(OLD);
  });

  test("only Nook avatar URLs are looked up, and only Nook avatar URLs are accepted back", async () => {
    const { calls, value } = lookup(NEW);
    expect(await refreshAvatar("https://example.test/a.png", value)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await refreshAvatar(OLD, lookup("javascript:alert(1)").value)).toBeNull();
  });

  test("one's own stale picture asks /me/avatar and updates the shell's picture", async () => {
    setSelfAvatar(OLD);
    const { calls, value } = lookup(NEW);
    expect(await refreshAvatar(OLD, value)).toBe(NEW);
    expect(calls).toEqual(["self"]);
    expect(selfAvatarNow()).toBe(NEW);
  });

  test("a picture changed twice follows the chain", async () => {
    const third = urlOf(user, "44444444-4444-4444-8444-444444444444");
    await refreshAvatar(OLD, lookup(NEW).value);
    await refreshAvatar(NEW, lookup(third).value);
    expect(currentAvatarUrl(OLD)).toBe(third);
  });
});

describe("the lookup endpoints (server)", () => {
  test("members and viewers read a person's current URL from /api/team/:id; guests get 404", async () => {
    const person = await createUser("AF person");
    const member = await createUser("AF member");
    const viewer = await createUser("AF viewer");
    const guest = await createUser("AF guest");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    const put = (bytes: Uint8Array) => request("/me/avatar", { method: "PUT", body: JSON.stringify({ source: "upload", image: base64(bytes) }) }, person);
    const first = (await (await put(makePng(12, 12))).json() as { avatarUrl: string }).avatarUrl;
    const second = (await (await put(makePng(14, 14))).json() as { avatarUrl: string }).avatarUrl;
    expect(second).not.toBe(first);
    expect((await request(first.replace(/^\/api/, ""), {}, member)).status).toBe(404);
    for (const reader of [member, viewer]) {
      const response = await request(`/team/${person.userId}`, {}, reader);
      expect(response.status).toBe(200);
      expect((await response.json() as { member: { avatarUrl: string } }).member.avatarUrl).toBe(second);
    }
    expect((await request(`/team/${person.userId}`, {}, guest)).status).toBe(404);
    expect(((await (await request("/me/avatar", {}, person)).json()) as { avatarUrl: string }).avatarUrl).toBe(second);
  });
});
