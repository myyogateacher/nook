import { describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { api, attachmentsFolderOf, defaultFolderOf, upload, uploadAttachment } from "./support/attachments";

/**
 * T342, D392: the Attachments system folder is never shared (by name, group, or audience), renamed,
 * moved, or deleted; nothing is created, uploaded, or moved into it; files may leave it. Every
 * folder and document mutation route answers 400 SYSTEM_FOLDER, and the 046 triggers hold the same
 * rules for any path that skipped its check.
 */

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const attachment = await uploadAttachment(owner);
  return { owner, member, attachment, folderId: attachmentsFolderOf(owner.userId)! };
}

const refused = (response: { status: number; body: Record<string, any> | null }) => expect({ status: response.status, code: response.body?.code }).toEqual({ status: 400, code: "SYSTEM_FOLDER" });

describe("system folder refusals over the routes", () => {
  test("share, access, rename, move, delete, subfolders, notes, uploads, moves in, and whiteboards are refused", async () => {
    const { owner, member, attachment, folderId } = await setup("Routes");
    refused(await api(owner, "PUT", `/folders/${folderId}/sharing`, { visibility: "selected", userIds: [member.userId] }));
    refused(await api(owner, "PUT", `/folders/${folderId}/sharing`, { visibility: "all_users", userIds: [] }));
    // Setting it private (what it is) is harmless.
    expect((await api(owner, "PUT", `/folders/${folderId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);

    const access = await request(`/folders/${folderId}/access`, {}, owner);
    expect(access.status).toBe(200);
    const etag = access.headers.get("etag")!;
    const put = await request(`/folders/${folderId}/access`, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ audience: "selected", people: [{ id: member.userId, level: "view" }], groups: [] }) }, owner);
    expect({ status: put.status, code: ((await put.json()) as { code: string }).code }).toEqual({ status: 400, code: "SYSTEM_FOLDER" });
    const everyone = await request(`/folders/${folderId}/access`, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ audience: "all_users" }) }, owner);
    expect(everyone.status).toBe(400);

    refused(await api(owner, "PATCH", `/folders/${folderId}`, { name: "Renamed" }));
    const parent = (await api(owner, "POST", "/folders", { name: "Parent", parentId: null })).body.folder.id as string;
    refused(await api(owner, "PATCH", `/folders/${folderId}`, { parentId: parent }));
    refused(await api(owner, "DELETE", `/folders/${folderId}`));
    refused(await api(owner, "POST", "/folders", { name: "Inside", parentId: folderId }));
    refused(await api(owner, "PATCH", `/folders/${parent}`, { parentId: folderId }));
    refused(await api(owner, "POST", "/notes", { folderId }));
    const note = (await api(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    refused(await api(owner, "PATCH", `/notes/${note}`, { folderId }));
    const direct = await upload(owner, "direct.txt", "d", { folderId });
    expect({ status: direct.status, code: direct.body.code }).toEqual({ status: 400, code: "SYSTEM_FOLDER" });
    const ordinary = (await upload(owner, "ordinary.txt", "o")).id;
    refused(await api(owner, "PATCH", `/files/${ordinary}`, { folderId }));
    expect((await api(owner, "POST", "/whiteboards", { name: "Board", folderId })).body.code).toBe("SYSTEM_FOLDER");

    // Files may leave it (the owner keeps them as ordinary files), and rename inside it is fine.
    expect((await api(owner, "PATCH", `/files/${attachment}`, { name: "renamed.txt" })).status).toBe(200);
    expect((await api(owner, "PATCH", `/files/${attachment}`, { folderId: defaultFolderOf(owner.userId) })).status).toBe(200);

    // Nothing changed.
    expect(db.query("SELECT name, parent_id, visibility, system_kind FROM folders WHERE id = ?").get(folderId)).toEqual({ name: "Attachments", parent_id: null, visibility: "private", system_kind: "attachments" });
    expect(db.query("SELECT COUNT(*) AS count FROM folder_shares WHERE folder_id = ?").get(folderId)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM folders WHERE parent_id = ?").get(folderId)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM notes WHERE folder_id = ?").get(folderId)).toEqual({ count: 0 });
    // The member never sees it.
    expect(((await api(member, "GET", "/folders?include=system")).body.folders as Array<{ id: string }>).some((folder) => folder.id === folderId)).toBe(false);
    // Someone else's folder id is the usual 404.
    expect((await api(member, "PUT", `/folders/${folderId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(404);
    expect((await api(member, "DELETE", `/folders/${folderId}`)).status).toBe(404);
  });

  test("the 046 triggers refuse the same changes made straight in the database", async () => {
    const { owner, member, folderId } = await setup("Triggers");
    const at = new Date().toISOString();
    const attempts: Array<() => unknown> = [
      () => db.query("INSERT INTO folder_shares (folder_id, user_id, created_at) VALUES (?, ?, ?)").run(folderId, member.userId, at),
      () => db.query("UPDATE folders SET visibility = 'all_users' WHERE id = ?").run(folderId),
      () => db.query("UPDATE folders SET name = 'Other' WHERE id = ?").run(folderId),
      () => db.query("UPDATE folders SET system_kind = NULL WHERE id = ?").run(folderId),
      () => db.query("UPDATE folders SET system_kind = 'attachments' WHERE id = ?").run(defaultFolderOf(owner.userId)),
      () => db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Child', ?, ?)").run(crypto.randomUUID(), owner.userId, folderId, at, at),
      () => db.query("INSERT INTO notes (id, owner_id, folder_id, title, created_at, updated_at) VALUES (?, ?, ?, 'N', ?, ?)").run(crypto.randomUUID(), owner.userId, folderId, at, at),
      () => db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES (?, ?, NULL, 'Again', ?, ?, 'attachments')").run(crypto.randomUUID(), owner.userId, at, at)
    ];
    for (const attempt of attempts) expect(attempt).toThrow();
    // A bad shape is refused by the CHECK.
    expect(() => db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at, system_kind) VALUES (?, ?, NULL, 'Bad', ?, ?, 'Has Caps')").run(crypto.randomUUID(), member.userId, at, at)).toThrow();
    // Ordinary folders keep working.
    expect(() => db.query("UPDATE folders SET updated_at = ? WHERE id = ?").run(at, folderId)).not.toThrow();
  });
});
