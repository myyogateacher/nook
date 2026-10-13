/**
 * An admin removes someone else's profile picture (T353): DELETE /api/team/:userId/avatar. Admins
 * only (guests 404, everyone else 403), not for integrations or the admin's own account, 404 for
 * unknown ids; the removed marker is stored, the file goes through the object store, one audit row
 * with ids only, and a bell notice to the member, who can upload again. Google sign-ins keep the
 * letters afterwards (only the member's own "Use my Google picture" brings it back).
 * Runs on S3 too: `MYNOTES_TEST_STORAGE=s3 bun test tests/avatarAdminRemove.test.ts`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, storedObjectExists, type Session } from "./support/harness";
import { base64, makePng } from "./support/images";
import { retireUsersAfterFile } from "./support/retireUsers";
const avatars = await import("../server/avatars");
const { resetTeamRateLimits } = await import("../server/team/routes");

retireUsersAfterFile();
beforeEach(() => resetTeamRateLimits());

const upload = (session: Session, bytes: Uint8Array) => request("/me/avatar", { method: "PUT", body: JSON.stringify({ source: "upload", image: base64(bytes) }) }, session);
const removeAs = (session: Session, userId: string) => request(`/team/${userId}/avatar`, { method: "DELETE", body: "{}" }, session);
const avatarIdOf = (userId: string) => (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null }).avatar_id;
const read = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, any> });

async function makeAdmin(label: string) {
  const admin = await createUser(label);
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  return admin;
}

describe("DELETE /api/team/:userId/avatar", () => {
  test("removes the picture: marker stored, file deleted, audit with ids only, bell notice, and the member can upload again", async () => {
    const admin = await makeAdmin("AR admin");
    const member = await createUser("AR member");
    const onlooker = await createUser("AR onlooker");
    expect((await upload(member, makePng(24, 24))).status).toBe(200);
    const fileId = avatarIdOf(member.userId)!;
    const oldUrl = `/api/users/${member.userId}/avatar?v=${fileId}`;
    expect((await fetch(`${origin}${oldUrl}`, { headers: { Cookie: onlooker.cookie } })).status).toBe(200);

    const removed = await read(await removeAs(admin, member.userId));
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);
    expect(removed.body.member.avatarUrl).toBeNull();
    expect(avatarIdOf(member.userId)).toBe(avatars.AVATAR_REMOVED);
    expect(await storedObjectExists(fileId, "avatars")).toBe(false);
    expect((await fetch(`${origin}${oldUrl}`, { headers: { Cookie: onlooker.cookie } })).status).toBe(404);

    const audits = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'account.avatar_removed_by_admin' AND json_extract(metadata_json, '$.targetId') = ?").all(member.userId) as Array<{ actor_id: string; metadata_json: string }>;
    expect(audits.length).toBe(1);
    expect(audits[0]!.actor_id).toBe(admin.userId);
    expect(JSON.parse(audits[0]!.metadata_json)).toEqual({ targetId: member.userId, previousSource: "upload", via: "web" });

    const bell = await read(await request("/notifications", {}, member));
    const notice = (bell.body.notifications ?? bell.body.items ?? []).find((item: { title: string }) => item.title.includes("removed your profile picture"));
    expect(notice).toBeDefined();
    expect(notice.title).toBe("AR admin removed your profile picture. You can add a new one in Settings → Security.");
    expect(notice.href).toBe("/settings/security");

    // A second remove finds nothing to remove; the member uploads again and it shows.
    expect((await read(await removeAs(admin, member.userId))).body.code).toBe("NO_AVATAR");
    const again = await upload(member, makePng(16, 16));
    expect(again.status).toBe(200);
    expect(avatars.avatarSourceOf(avatarIdOf(member.userId))).toBe("upload");
  });

  test("a Google copy is removed too, and Google sign-in rules keep the letters (the marker)", async () => {
    const admin = await makeAdmin("AR google admin");
    const member = await createUser("AR google member");
    // Stand-in for a Google copy: a version-4 id (the store has no file, which the delete tolerates).
    db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(crypto.randomUUID(), member.userId);
    expect((await removeAs(admin, member.userId)).status).toBe(200);
    expect(avatarIdOf(member.userId)).toBe(avatars.AVATAR_REMOVED);
    expect(avatars.avatarChosenByPerson(avatarIdOf(member.userId))).toBe(true);
    // A Google sign-in's download stops before fetching anything.
    expect(await avatars.storeAvatarFromUrl(member.userId, "https://lh3.googleusercontent.com/a/example")).toBe(false);
    expect(avatarIdOf(member.userId)).toBe(avatars.AVATAR_REMOVED);
  });

  test("refused for the admin's own account, integrations, people without a picture, and unknown or malformed ids", async () => {
    const admin = await makeAdmin("AR self admin");
    expect((await upload(admin, makePng(12, 12))).status).toBe(200);
    const self = await read(await removeAs(admin, admin.userId));
    expect({ status: self.status, code: self.body.code }).toEqual({ status: 409, code: "SELF_ACTION" });
    expect(avatars.avatarSourceOf(avatarIdOf(admin.userId))).toBe("upload");

    const created = await read(await request("/team/integrations", { method: "POST", body: JSON.stringify({ name: "AR bot", role: "member" }) }, admin));
    expect(created.status).toBe(201);
    const bot = await read(await removeAs(admin, created.body.integration.id));
    expect({ status: bot.status, code: bot.body.code }).toEqual({ status: 400, code: "INTEGRATION" });

    const plain = await createUser("AR plain");
    const none = await read(await removeAs(admin, plain.userId));
    expect({ status: none.status, code: none.body.code }).toEqual({ status: 409, code: "NO_AVATAR" });
    expect(avatarIdOf(plain.userId)).toBeNull();

    expect((await removeAs(admin, crypto.randomUUID())).status).toBe(404);
    expect((await removeAs(admin, "not-a-uuid")).status).toBe(404);
  });

  test("admins only: members get 403 ADMIN_ONLY, viewers the write gate, guests 404; nothing changes", async () => {
    const target = await createUser("AR target");
    expect((await upload(target, makePng(12, 12))).status).toBe(200);
    const before = avatarIdOf(target.userId);
    const member = await createUser("AR plain member");
    const memberTry = await read(await removeAs(member, target.userId));
    expect({ status: memberTry.status, code: memberTry.body.code }).toEqual({ status: 403, code: "ADMIN_ONLY" });
    const viewer = await createUser("AR viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect((await removeAs(viewer, target.userId)).status).toBe(403);
    const guest = await createUser("AR guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await removeAs(guest, target.userId)).status).toBe(404);
    expect(avatarIdOf(target.userId)).toBe(before);
  });

  test("counts toward the 30-a-minute Team write limit", async () => {
    const admin = await makeAdmin("AR busy admin");
    const target = await createUser("AR busy target");
    for (let index = 0; index < 30; index += 1) await removeAs(admin, target.userId);
    const limited = await read(await removeAs(admin, target.userId));
    expect({ status: limited.status, code: limited.body.code }).toEqual({ status: 429, code: "RATE_LIMITED" });
  });
});
