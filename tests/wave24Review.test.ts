import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";

const { resetWhiteboardLimitsForTests } = await import("../server/whiteboards/service");

/**
 * Wave 24 independent review probes: the embed summary for binned boards, snapshot and duplicate
 * routes for non-owners, import references to other people's files, and the case where an undo
 * brings back a picture whose file was unshared since it left the board.
 */

retireUsersAfterFile();
beforeAll(async () => {
  const admin = await createUser("W24R file admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
});
beforeEach(() => resetWhiteboardLimitsForTests());

type Json = Record<string, any>;
async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, text };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");

async function upload(session: Session, bytes: Uint8Array, filename: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const response = await request("/files", { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return (await response.json() as { document: Json }).document;
}
const create = async (owner: Session, name: string) => {
  const result = await api(owner, "POST", "/whiteboards", { name });
  expect(result.status).toBe(201);
  return result.body.whiteboard as Json;
};
const rect = (id: string) => ({ id, type: "rectangle", x: 0, y: 0, width: 40, height: 30, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", version: 1 });
const imageEl = (id: string, fileId: string) => ({ id, type: "image", x: 0, y: 50, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId, status: "saved", scale: [1, 1], version: 1 });
const sceneWith = (elements: unknown[], imageIds: string[] = []) => ({
  type: "excalidraw", version: 2, source: "test",
  elements: [...elements, ...imageIds.map((documentId, index) => imageEl(`img${index}`, documentId))],
  appState: {},
  files: Object.fromEntries(imageIds.map((documentId) => [documentId, { id: documentId, mimeType: "image/png", nookDocumentId: documentId }]))
});
const save = (owner: Session, id: string, baseRevision: number, scene: unknown) => api(owner, "PUT", `/whiteboards/${id}/scene`, { baseRevision, scene });
const share = (owner: Session, id: string, userIds: string[]) => api(owner, "PUT", `/files/${id}/sharing`, { visibility: userIds.length ? "selected" : "private", userIds });

describe("Wave 24 review probes", () => {
  test("the embed summary: binned boards answer 404 to everyone, and no 404 body names the board", async () => {
    const owner = await createUser("W24R summary owner");
    const reader = await createUser("W24R summary reader");
    const board = await create(owner, "Secret plan zebra");
    await share(owner, board.id, [reader.userId]);
    expect((await api(reader, "GET", `/whiteboards/${board.id}/summary`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/files/${board.id}`)).status).toBe(200);
    for (const who of [owner, reader]) {
      const binned = await api(who, "GET", `/whiteboards/${board.id}/summary`);
      expect(binned.status).toBe(404);
      expect(binned.text).not.toContain("zebra");
    }
  }, 30_000);

  test("import: a reference to someone else's private file is left out, never kept", async () => {
    const owner = await createUser("W24R import owner");
    const other = await createUser("W24R import other");
    const theirs = await upload(other, PNG, "theirs.png");
    const file = {
      type: "excalidraw", version: 2, source: "x", appState: {},
      elements: [rect("r"), imageEl("i", "k")],
      files: { k: { id: "k", mimeType: "image/png", nookDocumentId: theirs.id } }
    };
    const result = await api(owner, "POST", "/whiteboards/import", { name: "Ref", file });
    expect(result.status).toBe(201);
    expect(result.body.imagesLeftOut).toBe(1);
    const scene = (await api(owner, "GET", `/whiteboards/${result.body.whiteboard.id}`)).body.scene;
    expect(JSON.stringify(scene)).not.toContain(theirs.id);
  }, 30_000);

  // FINDING (MEDIUM): "a picture deleted or unshared since … never makes the board unsavable" does
  // not hold once the picture has left the board: an undo (or a pending copy, or another tab) that
  // brings it back makes every later save of the board fail with 400 IMAGE_NOT_AVAILABLE, and the
  // client does not strip the refused ids (it only does so in saveAsCopy).
  test("an undo that brings back a picture unshared since it left the board is refused", async () => {
    const owner = await createUser("W24R undo owner");
    const other = await createUser("W24R undo other");
    const picture = await upload(other, PNG, "shared.png");
    await share(other, picture.id, [owner.userId]);
    const board = await create(owner, "Undo");
    expect((await save(owner, board.id, 1, sceneWith([rect("r")], [picture.id]))).status).toBe(200);
    // The owner deletes the picture from the board; later its file is unshared.
    expect((await save(owner, board.id, 2, sceneWith([rect("r")]))).status).toBe(200);
    await share(other, picture.id, []);
    // Undo on the canvas: the picture element comes back with the same file id.
    const undo = await save(owner, board.id, 3, sceneWith([rect("r"), rect("s")], [picture.id]));
    expect(undo.status).toBe(400);
    expect(undo.body.code).toBe("IMAGE_NOT_AVAILABLE");
    // … and so is every further edit while the picture is on the canvas.
    expect((await save(owner, board.id, 3, sceneWith([rect("r"), rect("s"), rect("t")], [picture.id]))).body.code).toBe("IMAGE_NOT_AVAILABLE");
  }, 30_000);

  // FINDING (MEDIUM): the optional periodic snapshot (D207) is charged to the save, so near the quota
  // an ordinary small edit is refused 507 although the edit itself fits; the next save is refused the
  // same way (the snapshot is still due), so the board cannot be saved until space is freed.
  test("near the quota, a small edit is refused only because a periodic snapshot is due", async () => {
    const { config } = await import("../server/config");
    const { storedBytes } = await import("../server/documents");
    const owner = await createUser("W24R quota owner");
    const board = await create(owner, "Quota");
    const text = (id: string, size: number) => ({ id, type: "text", x: 0, y: 0, width: 40, height: 30, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", version: 1, text: "x".repeat(size), originalText: "x".repeat(size), fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", lineHeight: 1.25, containerId: null, autoResize: true });
    const texts = (extra: number) => Array.from({ length: 20 }, (_, index) => text(`t${index}`, 19_000 + (index === 0 ? extra : 0)));
    const first = await save(owner, board.id, 1, sceneWith(texts(0)));
    expect(first.status).toBe(200);
    // Fill the quota so that a same-size edit fits but a second copy of the scene does not.
    const room = config.userStorageQuotaBytes - storedBytes(owner.userId);
    const filler = room - 100_000;
    const timestamp = new Date().toISOString();
    db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at)
      VALUES (?, ?, NULL, 'filler.bin', 'application/octet-stream', 'none', ?, ?, ?, ?)`).run(crypto.randomUUID(), owner.userId, filler, "0".repeat(64), timestamp, timestamp);
    // A one-character edit: the scene grows by a byte, well within the 100 KB left.
    const edit = await save(owner, board.id, 2, sceneWith(texts(1)));
    expect(edit.status).toBe(507);
    expect(edit.body.code).toBe("QUOTA_EXCEEDED");
    expect((await save(owner, board.id, 2, sceneWith(texts(2)))).status).toBe(507);
  }, 30_000);
});
