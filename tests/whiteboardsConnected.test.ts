import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";

const { resetWhiteboardLimitsForTests, SNAPSHOT_INTERVAL_MS } = await import("../server/whiteboards/service");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

/**
 * Connected whiteboards (Wave 24, whiteboard plan D198, D207, §8, T164, T165): images as Nook file
 * references checked at save time, snapshots and the History API, duplicate, import of
 * `.excalidraw` with embedded images, the embed card's summary route, and MCP image references.
 */

retireUsersAfterFile();
// Run alone, the file still leaves an active admin behind (retireUsersAfterFile keeps the last one).
beforeAll(async () => {
  const admin = await createUser("WBB file admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
});
beforeEach(() => {
  resetWhiteboardLimitsForTests();
  resetMcpLimits();
});

type Json = Record<string, any>;
async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

// A 2×2 PNG, and a 1×1 GIF.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

async function upload(session: Session, bytes: Uint8Array | string, filename: string, folderId?: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const response = await request(`/files${folderId ? `?folderId=${folderId}` : ""}`, { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return (await response.json() as { document: Json }).document;
}

async function create(owner: Session, name = "Board") {
  const result = await api(owner, "POST", "/whiteboards", { name });
  expect(result.status).toBe(201);
  return result.body.whiteboard as Json;
}

const rect = (id: string, x = 0) => ({ id, type: "rectangle", x, y: 0, width: 40, height: 30, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", version: 1 });
const imageEl = (id: string, fileId: string) => ({ id, type: "image", x: 0, y: 50, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId, status: "pending", scale: [1, 1], version: 1 });
function sceneWith(elements: unknown[], images: Array<{ documentId: string; mimeType?: string }> = []) {
  const files = Object.fromEntries(images.map((image) => [image.documentId, { id: image.documentId, mimeType: image.mimeType ?? "image/png", nookDocumentId: image.documentId }]));
  const withImages = [...elements, ...images.map((image, index) => imageEl(`img${index}`, image.documentId))];
  return { type: "excalidraw", version: 2, source: "test", elements: withImages, appState: {}, files };
}
const save = (owner: Session, id: string, baseRevision: number, scene: unknown) => api(owner, "PUT", `/whiteboards/${id}/scene`, { baseRevision, scene });
const share = (owner: Session, id: string, userIds: string[]) => api(owner, "PUT", `/files/${id}/sharing`, { visibility: "selected", userIds });

describe("images are Nook file references (D198, T164, T165)", () => {
  test("the owner may add only images they can open; images already on the board are carried", async () => {
    const owner = await createUser("WBB image owner");
    const other = await createUser("WBB image other");
    const board = await create(owner, "Photos");
    const mine = await upload(owner, PNG, "mine.png");
    expect(mine).toMatchObject({ mime_type: "image/png", preview_kind: "image" });
    const text = await upload(owner, "hello", "notes.txt");
    const theirs = await upload(other, PNG, "theirs.png");
    const sharedWithMe = await upload(other, GIF, "shared.gif");
    await share(other, sharedWithMe.id, [owner.userId]);

    // Someone else's private image, a text file, a MIME that does not match, or a missing file: refused.
    for (const [ref, label] of [[{ documentId: theirs.id }, "private"], [{ documentId: text.id }, "text"], [{ documentId: mine.id, mimeType: "image/jpeg" }, "mime"], [{ documentId: crypto.randomUUID() }, "missing"]] as const) {
      const refused = await save(owner, board.id, 1, sceneWith([rect("r1")], [ref]));
      expect({ label, status: refused.status, code: refused.body.code }).toEqual({ label, status: 400, code: "IMAGE_NOT_AVAILABLE" });
      expect(refused.body.documentIds).toEqual([ref.documentId]);
    }
    // A dataURL is never stored.
    const dataUrl = sceneWith([rect("r1")], [{ documentId: mine.id }]);
    (dataUrl.files as Json)[mine.id].dataURL = `data:image/png;base64,${PNG.toString("base64")}`;
    expect((await save(owner, board.id, 1, dataUrl)).body.code).toBe("DATA_URL_NOT_ALLOWED");

    // Own images and images shared with the owner are fine.
    const saved = await save(owner, board.id, 1, sceneWith([rect("r1")], [{ documentId: mine.id }, { documentId: sharedWithMe.id, mimeType: "image/gif" }]));
    expect(saved.status).toBe(200);
    const read = await api(owner, "GET", `/whiteboards/${board.id}`);
    expect(Object.values(read.body.scene.files)).toEqual([
      { id: mine.id, mimeType: "image/png", nookDocumentId: mine.id },
      { id: sharedWithMe.id, mimeType: "image/gif", nookDocumentId: sharedWithMe.id }
    ].sort((a, b) => a.id < b.id ? -1 : 1));
    expect(read.body.scene.elements.filter((element: Json) => element.type === "image").every((element: Json) => element.status === "saved")).toBe(true);

    // The shared image is unshared and the owner's own image goes to the Bin: the board still saves
    // with both (they show as placeholders), because they were already on it.
    await api(other, "PUT", `/files/${sharedWithMe.id}/sharing`, { visibility: "private" });
    expect((await api(owner, "DELETE", `/files/${mine.id}`)).status).toBe(200);
    const moved = sceneWith([rect("r1", 99)], [{ documentId: mine.id }, { documentId: sharedWithMe.id, mimeType: "image/gif" }]);
    expect((await save(owner, board.id, 2, moved)).status).toBe(200);
    // A new board may use the owner's own binned image (it is theirs), but not the unshared one.
    const second = await create(owner, "Second");
    expect((await save(owner, second.id, 1, sceneWith([], [{ documentId: mine.id }]))).status).toBe(200);
    expect((await save(owner, second.id, 2, sceneWith([], [{ documentId: sharedWithMe.id, mimeType: "image/gif" }]))).body.code).toBe("IMAGE_NOT_AVAILABLE");
  }, 30_000);

  test("sharing a board never shares its images: a recipient reads the image only if the file is readable to them", async () => {
    const owner = await createUser("WBB share owner");
    const reader = await createUser("WBB share reader");
    const board = await create(owner, "Shared photos");
    const privateImage = await upload(owner, PNG, "private.png");
    const sharedImage = await upload(owner, PNG, "shared.png");
    await share(owner, sharedImage.id, [reader.userId]);
    expect((await save(owner, board.id, 1, sceneWith([], [{ documentId: privateImage.id }, { documentId: sharedImage.id }]))).status).toBe(200);
    await share(owner, board.id, [reader.userId]);
    // The reader gets the references (so the canvas can show placeholders) …
    expect(Object.keys((await api(reader, "GET", `/whiteboards/${board.id}`)).body.scene.files).sort()).toEqual([privateImage.id, sharedImage.id].sort());
    // … and the bytes only of the file they can read, through the content route as themselves.
    expect((await request(`/files/${privateImage.id}/content?disposition=inline`, {}, reader)).status).toBe(404);
    const shared = await request(`/files/${sharedImage.id}/content?disposition=inline`, {}, reader);
    expect(shared.status).toBe(200);
    expect(shared.headers.get("Content-Type")).toBe("image/png");
  }, 30_000);
});

describe("snapshots and History (D207)", () => {
  test("list, preview, and restore are the owner's; a restore is a new revision; the 30-minute rule", async () => {
    const owner = await createUser("WBB history owner");
    const reader = await createUser("WBB history reader");
    const board = await create(owner, "History");
    expect((await save(owner, board.id, 1, sceneWith([rect("a"), rect("b")]))).status).toBe(200);
    // The first save over a non-empty scene keeps it.
    expect((await save(owner, board.id, 2, sceneWith([rect("a"), rect("b"), rect("c")]))).body.snapshotKept).toBe(true);
    // Within 30 minutes of the newest snapshot, nothing more is kept …
    expect((await save(owner, board.id, 3, sceneWith([rect("a"), rect("b"), rect("c"), rect("d")]))).body.snapshotKept).toBeUndefined();
    // … and after them, the next save keeps what it replaces.
    db.query("UPDATE whiteboard_snapshots SET created_at = ? WHERE document_id = ?").run(new Date(Date.now() - SNAPSHOT_INTERVAL_MS - 1000).toISOString(), board.id);
    expect((await save(owner, board.id, 4, sceneWith([rect("a")]))).body.snapshotKept).toBe(true);

    const list = await api(owner, "GET", `/whiteboards/${board.id}/snapshots`);
    expect(list.status).toBe(200);
    expect(list.body.snapshots.map((snapshot: Json) => [snapshot.revision, snapshot.elementCount])).toEqual([[4, 4], [2, 2]]);
    await share(owner, board.id, [reader.userId]);
    expect((await api(reader, "GET", `/whiteboards/${board.id}/snapshots`)).status).toBe(404);
    const oldest = list.body.snapshots[1];
    expect((await api(reader, "GET", `/whiteboards/${board.id}/snapshots/${oldest.id}`)).status).toBe(404);
    const preview = await api(owner, "GET", `/whiteboards/${board.id}/snapshots/${oldest.id}`);
    expect(preview.body.scene.elements.map((element: Json) => element.id)).toEqual(["a", "b"]);
    expect((await api(owner, "GET", `/whiteboards/${board.id}/snapshots/${crypto.randomUUID()}`)).body.code).toBe("NO_SNAPSHOT");

    // Restore goes through the revision check; the replaced scene is kept too.
    expect((await api(owner, "POST", `/whiteboards/${board.id}/snapshots/${oldest.id}/restore`, { baseRevision: 4 })).body.code).toBe("REVISION_CONFLICT");
    expect((await api(reader, "POST", `/whiteboards/${board.id}/snapshots/${oldest.id}/restore`, { baseRevision: 5 })).status).toBe(404);
    const restored = await api(owner, "POST", `/whiteboards/${board.id}/snapshots/${oldest.id}/restore`, { baseRevision: 5 });
    expect(restored.body).toMatchObject({ revision: 6, snapshotKept: true, restoredFrom: { id: oldest.id, revision: 2 } });
    expect((await api(owner, "GET", `/whiteboards/${board.id}`)).body.scene.elements.map((element: Json) => element.id)).toEqual(["a", "b"]);
    expect((await api(owner, "GET", `/whiteboards/${board.id}/snapshots`)).body.snapshots).toHaveLength(3);
  }, 30_000);

  test("restoring a version carries its images even when their files are gone since", async () => {
    const owner = await createUser("WBB restore images");
    const board = await create(owner, "Images history");
    const image = await upload(owner, PNG, "old.png");
    expect((await save(owner, board.id, 1, sceneWith([rect("a")], [{ documentId: image.id }]))).status).toBe(200);
    expect((await save(owner, board.id, 2, sceneWith([]))).body.snapshotKept).toBe(true);
    // The image is deleted for good.
    await api(owner, "DELETE", `/files/${image.id}`);
    await api(owner, "DELETE", `/bin/document/${image.id}`);
    const [snapshot] = (await api(owner, "GET", `/whiteboards/${board.id}/snapshots`)).body.snapshots;
    const restored = await api(owner, "POST", `/whiteboards/${board.id}/snapshots/${snapshot.id}/restore`, { baseRevision: 3 });
    expect(restored.status).toBe(200);
    expect(Object.keys((await api(owner, "GET", `/whiteboards/${board.id}`)).body.scene.files)).toEqual([image.id]);
  }, 30_000);
});

describe("duplicate", () => {
  test("a recipient's copy is theirs, private, numbered, and keeps only images they can open", async () => {
    const owner = await createUser("WBB dup owner");
    const reader = await createUser("WBB dup reader");
    const stranger = await createUser("WBB dup stranger");
    const board = await create(owner, "Plan");
    const hidden = await upload(owner, PNG, "hidden.png");
    const visible = await upload(owner, PNG, "visible.png");
    await share(owner, visible.id, [reader.userId]);
    expect((await save(owner, board.id, 1, sceneWith([rect("r")], [{ documentId: hidden.id }, { documentId: visible.id }]))).status).toBe(200);
    await share(owner, board.id, [reader.userId]);

    expect((await api(stranger, "POST", `/whiteboards/${board.id}/duplicate`, {})).status).toBe(404);
    const copy = await api(reader, "POST", `/whiteboards/${board.id}/duplicate`, {});
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ imagesLeftOut: 1, whiteboard: { name: "Plan (copy).excalidraw", is_owner: 1, visibility: "private", revision: 1, elementCount: 2 } });
    expect(Object.keys((await api(reader, "GET", `/whiteboards/${copy.body.whiteboard.id}`)).body.scene.files)).toEqual([visible.id]);
    expect((await api(reader, "POST", `/whiteboards/${board.id}/duplicate`, {})).body.whiteboard.name).toBe("Plan (copy 2).excalidraw");
    // The owner's copy keeps both images, in the board's folder; a snapshot copy is the owner's only.
    const own = await api(owner, "POST", `/whiteboards/${board.id}/duplicate`, {});
    expect(own.body).toMatchObject({ imagesLeftOut: 0, whiteboard: { name: "Plan (copy).excalidraw", folder_id: board.folder_id, elementCount: 3 } });
    expect((await save(owner, board.id, 2, sceneWith([rect("r"), rect("s")]))).body.snapshotKept).toBe(true);
    const [snapshot] = (await api(owner, "GET", `/whiteboards/${board.id}/snapshots`)).body.snapshots;
    expect((await api(reader, "POST", `/whiteboards/${board.id}/duplicate`, { snapshotId: snapshot.id })).status).toBe(404);
    const fromSnapshot = await api(owner, "POST", `/whiteboards/${board.id}/duplicate`, { snapshotId: snapshot.id });
    expect(fromSnapshot.body.whiteboard).toMatchObject({ name: "Plan (copy 2).excalidraw", elementCount: 3 });
    // A viewer role reads but never writes (the Wave 15 gate).
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(reader.userId);
    expect((await api(reader, "POST", `/whiteboards/${board.id}/duplicate`, {})).status).toBe(403);
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(reader.userId);
  }, 30_000);
});

describe("import .excalidraw", () => {
  const exported = (elements: unknown[], files: Json = {}) => ({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: 20, theme: "dark", collaborators: [] }, files });
  const documentsOf = (userId: string) => (db.query("SELECT id, name, mime_type, folder_id FROM documents WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at").all(userId) as Json[]);

  test("embedded images become Files in the board's folder, referenced by id; the rest goes through the save validator", async () => {
    const owner = await createUser("WBB import owner");
    const file = exported([rect("r1"), imageEl("i1", "abc"), imageEl("i2", "abc"), imageEl("i3", "gone"), { ...imageEl("i4", "deleted"), isDeleted: true }], {
      abc: { id: "abc", mimeType: "image/png", dataURL: `data:image/png;base64,${PNG.toString("base64")}`, created: 1 },
      deleted: { id: "deleted", mimeType: "image/png", dataURL: `data:image/png;base64,${PNG.toString("base64")}`, created: 1 }
    });
    const result = await api(owner, "POST", "/whiteboards/import", { name: "Sketch", file });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ images: 1, imagesLeftOut: 1, whiteboard: { name: "Sketch.excalidraw", revision: 1, elementCount: 3 } });
    const images = documentsOf(owner.userId).filter((document) => document.mime_type === "image/png");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ name: "Sketch image 1.png", folder_id: result.body.whiteboard.folder_id });
    const scene = (await api(owner, "GET", `/whiteboards/${result.body.whiteboard.id}`)).body.scene;
    expect(scene.files).toEqual({ abc: { id: "abc", mimeType: "image/png", nookDocumentId: images[0]!.id } });
    expect(JSON.stringify(scene)).not.toContain("data:");
    expect(scene.elements.map((element: Json) => element.id)).toEqual(["r1", "i1", "i2"]);
  }, 30_000);

  test("a hostile or unsupported file is refused before anything is stored", async () => {
    const owner = await createUser("WBB import refused");
    const before = documentsOf(owner.userId).length;
    const png = `data:image/png;base64,${PNG.toString("base64")}`;
    const cases: Array<[string, unknown, number, string]> = [
      ["not a drawing", { hello: "world" }, 400, "INVALID_SCENE"],
      ["an embed", exported([rect("r"), { ...rect("e"), type: "embeddable", link: "https://example.test" }], {}), 400, "UNSUPPORTED_ELEMENT"],
      ["an SVG image", exported([imageEl("i", "s")], { s: { id: "s", mimeType: "image/svg+xml", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" } }), 400, "IMAGE_TYPE_NOT_SUPPORTED"],
      ["a javascript: link", exported([{ ...rect("r"), link: "javascript:alert(1)" }, imageEl("i", "p")], { p: { id: "p", mimeType: "image/png", dataURL: png } }), 400, "INVALID_LINK"],
      ["too deep", exported([{ ...rect("r"), roundness: { a: { b: { c: { d: { e: { f: 1 } } } } } } }]), 400, "INVALID_SCENE"]
    ];
    for (const [label, file, status, code] of cases) {
      const result = await api(owner, "POST", "/whiteboards/import", { name: label, file });
      expect({ label, status: result.status, code: result.body.code }).toEqual({ label, status, code });
    }
    // Bytes that are not the image they claim to be: stored, sniffed, refused, and removed again.
    const fake = await api(owner, "POST", "/whiteboards/import", { name: "Fake", file: exported([imageEl("i", "f")], { f: { id: "f", mimeType: "image/png", dataURL: `data:image/png;base64,${Buffer.from("not an image at all").toString("base64")}` } }) });
    expect(fake.body.code).toBe("IMAGE_TYPE_NOT_SUPPORTED");
    expect(documentsOf(owner.userId)).toHaveLength(before);
    expect(db.query("SELECT COUNT(*) AS n FROM documents WHERE owner_id = ? AND name = 'Fake image 1.png'").get(owner.userId)).toEqual({ n: 0 });
    // Over the import cap: 413 before parsing.
    const huge = await api(owner, "POST", "/whiteboards/import", `{"name":"Huge","file":"${"a".repeat(33 * 1024 * 1024)}"}`);
    expect(huge.status).toBe(413);
  }, 60_000);
});

describe("the embed card and MCP", () => {
  test("the summary route answers readers only; read_whiteboard names image files by id, never bytes", async () => {
    const owner = await createUser("WBB embed owner");
    const stranger = await createUser("WBB embed stranger");
    const board = await create(owner, "Embedded");
    const image = await upload(owner, PNG, "pic.png");
    expect((await save(owner, board.id, 1, sceneWith([rect("r")], [{ documentId: image.id }]))).status).toBe(200);
    const summary = await api(owner, "GET", `/whiteboards/${board.id}/summary`);
    expect(summary.body.whiteboard).toMatchObject({ id: board.id, name: "Embedded.excalidraw", elementCount: 2 });
    const hidden = await api(stranger, "GET", `/whiteboards/${board.id}/summary`);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain("Embedded");

    const keyId = createApiKey(owner.userId, { name: "Agent", surfaces: "mcp", grants: [{ module: "whiteboards", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 90 }).id;
    const result = await invokeMcpToolForTests("read_whiteboard", { id: board.id, include: "elements" }, keyId);
    const value = JSON.parse(result.content[0]!.text) as Json;
    expect(value.elements.find((element: Json) => element.type === "image")).toMatchObject({ documentId: image.id });
    expect(result.content[0]!.text).not.toContain("base64");
    // The id alone reads nothing: this key has no Files tools.
    const denied = await invokeMcpToolForTests("get_document_metadata", { id: image.id }, keyId);
    expect(denied.isError).toBe(true);
  }, 30_000);
});

describe("QA H1: a note never gives away the name of a board it embeds", () => {
  const embed = (id: string, text: string) => `[${text}](/whiteboards/${id} "whiteboard")`;
  const noteKey = (userId: string) => createApiKey(userId, { name: "Reader", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 90 }).id;

  test("the stored Markdown and every reader's view carry no board name, new notes and older ones alike", async () => {
    const { storage, checksum } = await import("../server/storage");
    const owner = await createUser("WBB H1 owner");
    const reader = await createUser("WBB H1 reader");
    const board = await create(owner, "Secret merger plan");
    const created = await api(owner, "POST", "/notes", {});
    const noteId = created.body.note.id as string;
    // Whatever the client sends (an older client, an agent), the stored draft names no board.
    const sent = `${embed(board.id, "Secret merger plan")}\n\nAfter.\n\n\`\`\`\n${embed(board.id, "kept in code")}\n\`\`\``;
    const saved = await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: sent, revision: created.body.note.draft_revision });
    expect(saved.status).toBe(200);
    expect(saved.body.title).not.toContain("Secret");
    const stored = await storage.readDraft(noteId);
    expect(stored).not.toContain("Secret");
    expect(stored).toContain(embed(board.id, "Whiteboard"));
    expect(stored).toContain("kept in code");
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: saved.body.revision })).status).toBe(200);
    expect(await storage.readVersion(noteId, 1)).not.toContain("Secret");
    expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);

    // An older note, written before this fix: its draft and published version 2 name the board.
    const old = `# Plan\n\n${embed(board.id, "Secret merger plan")}\n`;
    await storage.writeDraft(noteId, old);
    db.query("UPDATE notes SET draft_revision = ?, draft_checksum = ? WHERE id = ?").run(saved.body.revision + 1, checksum(old), noteId);
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: saved.body.revision + 1 })).status).toBe(200);
    expect(await storage.readVersion(noteId, 2)).toBe(old);

    for (const [label, path] of [["note", `/notes/${noteId}`], ["v1", `/notes/${noteId}/versions/1`], ["v2", `/notes/${noteId}/versions/2`]] as const) {
      const response = await api(reader, "GET", path);
      expect({ label, status: response.status }).toEqual({ label, status: 200 });
      expect({ label, leaked: JSON.stringify(response.body).includes("Secret") }).toEqual({ label, leaked: false });
      expect(response.body.markdown ?? response.body.note?.markdown).toContain(embed(board.id, "Whiteboard"));
    }
    const result = await invokeMcpToolForTests("read_note", { noteId }, noteKey(reader.userId));
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).not.toContain("Secret");
    expect(result.content[0]!.text).toContain(`/whiteboards/${board.id}`);
    // The card's summary stays closed to the reader, so the name is nowhere they can reach.
    expect((await api(reader, "GET", `/whiteboards/${board.id}/summary`)).status).toBe(404);
    // Stored versions are never rewritten.
    expect(await storage.readVersion(noteId, 2)).toBe(old);
  }, 30_000);
});

describe("QA L6: a binned board's card", () => {
  test("the summary says binned to the owner only; anyone else gets the plain 404", async () => {
    const owner = await createUser("WBB L6 owner");
    const reader = await createUser("WBB L6 reader");
    const board = await create(owner, "Binned plan");
    await share(owner, board.id, [reader.userId]);
    expect((await api(reader, "GET", `/whiteboards/${board.id}/summary`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/files/${board.id}`)).status).toBe(200);
    const mine = await api(owner, "GET", `/whiteboards/${board.id}/summary`);
    expect(mine.status).toBe(404);
    expect(mine.body).toMatchObject({ code: "BINNED", binned: true });
    expect(JSON.stringify(mine.body)).not.toContain("Binned plan");
    const theirs = await api(reader, "GET", `/whiteboards/${board.id}/summary`);
    expect(theirs.status).toBe(404);
    expect(theirs.body.binned).toBeUndefined();
    expect(theirs.body.code).toBe("NOT_FOUND");
    const missing = await api(owner, "GET", `/whiteboards/${crypto.randomUUID()}/summary`);
    expect(missing.body.code).toBe("NOT_FOUND");
  }, 30_000);
});
