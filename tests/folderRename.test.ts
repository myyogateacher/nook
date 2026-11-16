import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db } from "./support/harness";
import { api, auditRows, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";

const { ensureDefaultFolder } = await import("../server/db");
const { ensureSystemFolder } = await import("../server/attachments/service");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

/**
 * Renaming Notes and Files folders (D1300, D1301): PATCH /api/folders/:id with a name, and the MCP
 * rename_folder tool, through the one updateFolder service. Owner-only (a share, even at edit, never
 * renames), create's validation (trim, 1-120, "Default" taken), Default and Attachments keep their
 * names, someone else's folder is the usual 404, and a real rename is audited folder.rename.
 */

beforeEach(() => resetMcpLimits());

const folderName = (id: string) => (db.query("SELECT name FROM folders WHERE id = ?").get(id) as { name: string } | null)?.name;

describe("PATCH /api/folders/:id renames", () => {
  test("the owner renames with create's validation; the answer carries the folder; a real rename is audited once", async () => {
    const owner = await createUser("Rename owner");
    const folder = (await api(owner, "POST", "/folders", { name: "Plans" })).body.folder as { id: string };
    const renamed = await api(owner, "PATCH", `/folders/${folder.id}`, { name: "  Roadmap  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ ok: true, folder: { id: folder.id, name: "Roadmap", parent_id: null } });
    expect(folderName(folder.id)).toBe("Roadmap");
    // The folder list (Notes and Files read the same rows) shows the new name.
    const listed = (await api(owner, "GET", "/folders")).body.folders as Array<{ id: string; name: string }>;
    expect(listed.find((row) => row.id === folder.id)?.name).toBe("Roadmap");
    expect((await api(owner, "GET", "/folders?include=system")).body.folders.find((row: { id: string }) => row.id === folder.id)?.name).toBe("Roadmap");
    expect(auditRows(owner.userId, "folder.rename")).toEqual([{ noteId: null, folderId: folder.id }]);
    // The same name again changes nothing worth auditing.
    expect((await api(owner, "PATCH", `/folders/${folder.id}`, { name: "Roadmap" })).status).toBe(200);
    expect(auditRows(owner.userId, "folder.rename")).toHaveLength(1);

    // Validation is create's: blank after trimming, too long, unknown fields, and "Default" in any case.
    for (const name of ["", "   ", "x".repeat(121)]) expect((await api(owner, "PATCH", `/folders/${folder.id}`, { name })).status).toBe(400);
    expect((await api(owner, "PATCH", `/folders/${folder.id}`, { name: "Ok", color: "red" })).status).toBe(400);
    expect((await api(owner, "PATCH", `/folders/${folder.id}`, { name: "x".repeat(120) })).status).toBe(200);
    const taken = await api(owner, "PATCH", `/folders/${folder.id}`, { name: " default " });
    expect(taken).toMatchObject({ status: 409, body: { code: "NAME_TAKEN" } });
    // Sibling names may repeat, as on create.
    const twin = (await api(owner, "POST", "/folders", { name: "Twin" })).body.folder as { id: string };
    expect((await api(owner, "PATCH", `/folders/${folder.id}`, { name: "Twin" })).status).toBe(200);
    expect([folderName(folder.id), folderName(twin.id)]).toEqual(["Twin", "Twin"]);
  });

  test("Default and Attachments keep their names; a missing or someone else's folder is 404", async () => {
    const owner = await createUser("Rename system");
    const other = await createUser("Rename stranger");
    const defaultId = ensureDefaultFolder(owner.userId);
    expect(await api(owner, "PATCH", `/folders/${defaultId}`, { name: "Inbox" })).toMatchObject({ status: 409, body: { code: "DEFAULT_FOLDER" } });
    expect(folderName(defaultId)).toBe("Default");
    const attachments = ensureSystemFolder(owner.userId);
    expect(await api(owner, "PATCH", `/folders/${attachments}`, { name: "Mine" })).toMatchObject({ status: 400, body: { code: "SYSTEM_FOLDER" } });
    expect(folderName(attachments)).toBe("Attachments");
    expect((await api(owner, "PATCH", `/folders/${crypto.randomUUID()}`, { name: "Ghost" })).status).toBe(404);
    const theirs = (await api(other, "POST", "/folders", { name: "Theirs" })).body.folder as { id: string };
    expect(await api(owner, "PATCH", `/folders/${theirs.id}`, { name: "Mine now" })).toMatchObject({ status: 404, body: { error: "Folder not found" } });
    expect(folderName(theirs.id)).toBe("Theirs");
    expect(auditRows(owner.userId, "folder.rename")).toEqual([]);
  });

  test("a shared folder is renamed by its owner only: view and edit recipients, and everyone, get 404; viewers are read-only", async () => {
    const owner = await createUser("Rename sharer");
    const reader = await createUser("Rename reader");
    const editor = await createUser("Rename editor");
    const folder = (await api(owner, "POST", "/folders", { name: "Team docs" })).body.folder as { id: string };
    expect((await api(owner, "PUT", `/folders/${folder.id}/sharing`, { visibility: "selected", userIds: [reader.userId, editor.userId] })).status).toBe(200);
    db.query("UPDATE folder_shares SET level = 'edit' WHERE folder_id = ? AND user_id = ?").run(folder.id, editor.userId);
    // Both recipients see it in their folder list ...
    for (const person of [reader, editor]) expect(((await api(person, "GET", "/folders")).body.folders as Array<{ id: string }>).some((row) => row.id === folder.id)).toBe(true);
    // ... and neither renames it.
    for (const person of [reader, editor]) expect((await api(person, "PATCH", `/folders/${folder.id}`, { name: "Hijacked" })).status).toBe(404);
    expect(folderName(folder.id)).toBe("Team docs");
    // The owner's rename keeps its sharing and shows for the recipients.
    expect((await api(owner, "PATCH", `/folders/${folder.id}`, { name: "Team handbook" })).status).toBe(200);
    expect((db.query("SELECT visibility FROM folders WHERE id = ?").get(folder.id) as { visibility: string }).visibility).toBe("selected");
    expect(((await api(reader, "GET", "/folders")).body.folders as Array<{ id: string; name: string }>).find((row) => row.id === folder.id)?.name).toBe("Team handbook");
    // A viewer Team role cannot rename even their own folder (the role write gate).
    const mine = (await api(reader, "POST", "/folders", { name: "Reader's" })).body.folder as { id: string };
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(reader.userId);
    expect(await api(reader, "PATCH", `/folders/${mine.id}`, { name: "Still mine" })).toMatchObject({ status: 403, body: { code: "ROLE_READ_ONLY" } });
    expect(folderName(mine.id)).toBe("Reader's");
  });

  test("moving still works through the same route, audited folder.move", async () => {
    const owner = await createUser("Rename mover");
    const parent = (await api(owner, "POST", "/folders", { name: "Parent" })).body.folder as { id: string };
    const child = (await api(owner, "POST", "/folders", { name: "Child" })).body.folder as { id: string };
    expect((await api(owner, "PATCH", `/folders/${child.id}`, { parentId: parent.id })).body.folder).toMatchObject({ parent_id: parent.id, name: "Child" });
    expect((await api(owner, "PATCH", `/folders/${child.id}`, { parentId: child.id })).status).toBe(400);
    expect((await api(owner, "PATCH", `/folders/${child.id}`, { parentId: null, name: "Top" })).body.folder).toMatchObject({ parent_id: null, name: "Top" });
    expect(auditRows(owner.userId, "folder.move").map((row) => row.parentId)).toEqual([parent.id, null]);
    expect(auditRows(owner.userId, "folder.rename")).toHaveLength(1);
  });
});

describe("rename_folder over MCP (D1301)", () => {
  test("notes:write-draft or files:write rename owned folders with the route's rules, audited via mcp", async () => {
    const owner = await createUser("Rename key owner");
    const other = await createUser("Rename key other");
    const notesKey = makeKey(owner, ["notes:write-draft"]);
    const filesKey = makeKey(owner, ["files:write"]);
    expect(await toolNames(notesKey)).toContain("rename_folder");
    expect(await toolNames(filesKey)).toContain("rename_folder");
    expect(await toolNames(makeKey(owner, ["notes:read", "files:read"]))).not.toContain("rename_folder");
    const folder = (await ok(notesKey, "create_folder", { name: "Agent folder" })).folder as { id: string };
    expect((await ok(filesKey, "rename_folder", { folderId: folder.id, name: "  Agent notes  " })).folder).toMatchObject({ id: folder.id, name: "Agent notes" });
    expect(folderName(folder.id)).toBe("Agent notes");
    expect(auditRows(owner.userId, "folder.rename")).toEqual([{ noteId: null, folderId: folder.id, via: "mcp", keyId: filesKey.id }]);
    expect(await errorCode(notesKey, "rename_folder", { folderId: folder.id, name: "DEFAULT" })).toBe("NAME_TAKEN");
    expect(await errorCode(notesKey, "rename_folder", { folderId: folder.id, name: "   " })).toBe("INVALID");
    expect(await errorCode(notesKey, "rename_folder", { folderId: ensureDefaultFolder(owner.userId), name: "Inbox" })).toBe("INVALID");
    expect(await errorCode(notesKey, "rename_folder", { folderId: ensureSystemFolder(owner.userId), name: "Mine" })).toBe("INVALID");
    const theirs = (await api(other, "POST", "/folders", { name: "Not yours" })).body.folder as { id: string };
    expect((await api(other, "PUT", `/folders/${theirs.id}/sharing`, { visibility: "selected", userIds: [owner.userId] })).status).toBe(200);
    expect(await errorCode(notesKey, "rename_folder", { folderId: theirs.id, name: "Taken over" })).toBe("NOT_FOUND");
    expect(folderName(theirs.id)).toBe("Not yours");
  });
});
