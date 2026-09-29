import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, request, type Session } from "./support/harness";

const { runSweep, hasDocumentRow } = await import("../server/sweeper");
const { resetSearchRateLimit } = await import("../server/searchRoutes");
const { reconcileWhiteboardSearchIndex } = await import("../server/whiteboards/service");

/**
 * Whiteboards on Files (Wave 23, whiteboard plan §8, §12, T160–T172): create, list, read, the
 * revision CAS save with copy-on-write objects, thumbnails, Files and Bin parity, the sweeper,
 * and search. MCP is in whiteboardsMcp.test.ts.
 */

beforeEach(() => resetSearchRateLimit());

type Json = Record<string, any>;
async function api(session: Session | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method === "GET" || method === "HEAD" ? { method, headers } : { method, headers, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

const objectPath = (id: string) => join(dataDir, "documents", "objects", id);
const boardRow = (id: string) => db.query("SELECT * FROM whiteboards WHERE document_id = ?").get(id) as Json | null;
const docRow = (id: string) => db.query("SELECT * FROM documents WHERE id = ?").get(id) as Json | null;

async function create(owner: Session, name = "Floor plan", extra: Json = {}, headers: Record<string, string> = {}) {
  const result = await api(owner, "POST", "/whiteboards", { name, ...extra }, headers);
  expect(result.status).toBe(201);
  return result.body.whiteboard as Json;
}

let seq = 0;
function sceneWith(texts: string[] = [], extra: Json = {}) {
  const elements = texts.map((text) => {
    seq += 1;
    return { id: `t${seq}`, type: "text", x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", text, originalText: text, fontSize: 20, fontFamily: 5, containerId: null };
  });
  return { type: "excalidraw", version: 2, source: "test", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {}, ...extra };
}

async function save(owner: Session, id: string, baseRevision: number, scene: unknown) {
  return api(owner, "PUT", `/whiteboards/${id}/scene`, { baseRevision, scene });
}

// A 2×2 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");
function pngWithSize(width: number, height: number) {
  const copy = Buffer.from(PNG);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  return copy;
}

describe("whiteboards API", () => {
  test("create: an empty private board in Default, a Files document with the Excalidraw MIME; Idempotency-Key replays", async () => {
    const owner = await createUser("WB creator");
    const key = crypto.randomUUID();
    const first = await api(owner, "POST", "/whiteboards", { name: "Kitchen" }, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const board = first.body.whiteboard;
    expect(board).toMatchObject({ name: "Kitchen.excalidraw", kind: "whiteboard", revision: 1, elementCount: 0, hasThumbnail: false, canEdit: true, is_owner: 1, mime_type: "application/vnd.excalidraw+json", preview_kind: "none", visibility: "private" });
    const replay = await api(owner, "POST", "/whiteboards", { name: "Kitchen" }, { "Idempotency-Key": key });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true, whiteboard: { id: board.id } });
    expect(db.query("SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ n: 1 });
    // The board's bytes are its scene object, never an object under the document id (D193).
    const row = boardRow(board.id)!;
    expect(existsSync(objectPath(row.object_id))).toBe(true);
    expect(existsSync(objectPath(board.id))).toBe(false);
    expect(JSON.parse(readFileSync(objectPath(row.object_id), "utf8"))).toMatchObject({ type: "excalidraw", source: "nook", elements: [] });
    // Files lists it too, as a whiteboard (Q2).
    const files = await api(owner, "GET", "/files");
    expect(files.body.documents.find((item: Json) => item.id === board.id)).toMatchObject({ kind: "whiteboard" });
    expect((await api(owner, "POST", "/whiteboards", { name: "   " })).status).toBe(400);
    expect((await api(owner, "POST", "/whiteboards", { name: "x".repeat(201) })).status).toBe(400);
    expect((await api(owner, "POST", "/whiteboards", { name: "Mine", folderId: crypto.randomUUID() })).status).toBe(404);
    expect(db.query("SELECT event_type FROM audit_log WHERE actor_id = ? AND event_type = 'whiteboard.create'").all(owner.userId)).toHaveLength(1);
  });

  test("read and list follow the Files parity matrix: owner, selected, everyone, folder inheritance; others get 404", async () => {
    const owner = await createUser("WB owner");
    const reader = await createUser("WB reader");
    const stranger = await createUser("WB stranger");
    const direct = await create(owner, "Direct");
    const inherited = await create(owner, "Inherited");
    const everyone = await create(owner, "Everyone");
    const privateBoard = await create(owner, "Private");
    expect((await api(owner, "PUT", `/files/${direct.id}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    expect((await api(owner, "PUT", `/files/${everyone.id}/sharing`, { visibility: "all_users", userIds: [] })).status).toBe(200);
    const folder = (await api(owner, "POST", "/folders", { name: "Shared plans", parentId: null })).body.folder;
    expect((await api(owner, "PATCH", `/files/${inherited.id}`, { folderId: folder.id })).status).toBe(200);
    expect((await api(owner, "PUT", `/folders/${folder.id}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);

    const listed = (session: Session, folderParam = "all") => api(session, "GET", `/whiteboards?folder=${folderParam}`).then((result) => (result.body.whiteboards as Json[]).map((board) => board.name).sort());
    expect(await listed(owner)).toEqual(["Direct.excalidraw", "Everyone.excalidraw", "Inherited.excalidraw", "Private.excalidraw"]);
    expect(await listed(reader)).toEqual(["Direct.excalidraw", "Everyone.excalidraw", "Inherited.excalidraw"]);
    expect(await listed(reader, "shared")).toEqual(["Direct.excalidraw", "Everyone.excalidraw", "Inherited.excalidraw"]);
    expect(await listed(owner, folder.id)).toEqual(["Inherited.excalidraw"]);
    expect(await listed(stranger)).toContain("Everyone.excalidraw");
    expect(await listed(stranger)).not.toContain("Direct.excalidraw");

    const read = await api(reader, "GET", `/whiteboards/${direct.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe("\"r1\"");
    expect(read.body.whiteboard).toMatchObject({ canEdit: false, is_owner: 0, owner_name: "WB owner" });
    expect(read.body.scene).toMatchObject({ type: "excalidraw", elements: [] });
    expect((await api(stranger, "GET", `/whiteboards/${direct.id}`)).status).toBe(404);
    expect((await api(reader, "GET", `/whiteboards/${privateBoard.id}`)).status).toBe(404);
    expect((await api(reader, "GET", `/whiteboards/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await api(reader, "GET", "/whiteboards/not-a-uuid")).status).toBe(404);
    // A plain file is not a whiteboard.
    expect((await api(owner, "GET", "/whiteboards?folder=nope")).status).toBe(400);
  });

  test("only the owner writes: a recipient's save and thumbnail are 404, a viewer's 403 ROLE_READ_ONLY", async () => {
    const owner = await createUser("WB writer");
    const reader = await createUser("WB recipient");
    const board = await create(owner);
    await api(owner, "PUT", `/files/${board.id}/sharing`, { visibility: "selected", userIds: [reader.userId] });
    expect((await save(reader, board.id, 1, sceneWith(["mine now"]))).status).toBe(404);
    expect((await api(reader, "PUT", `/whiteboards/${board.id}/thumbnail`, { revision: 1, png: PNG.toString("base64") })).status).toBe(404);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    const viewer = await save(owner, board.id, 1, sceneWith(["viewer"]));
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe("ROLE_READ_ONLY");
    expect((await api(owner, "POST", "/whiteboards", { name: "New" })).status).toBe(403);
    expect((await api(owner, "GET", `/whiteboards/${board.id}`)).body.whiteboard.canEdit).toBe(false);
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(owner.userId);
    expect(boardRow(board.id)!.revision).toBe(1);
  });

  test("CAS save: copy-on-write objects, 409 on a stale base, identical scenes are a no-op, documents mirror the object", async () => {
    const owner = await createUser("WB saver");
    const board = await create(owner);
    const before = boardRow(board.id)!;
    const first = await save(owner, board.id, 1, sceneWith(["Island", "Sink"]));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 2 });
    const after = boardRow(board.id)!;
    expect(after.object_id).not.toBe(before.object_id);
    expect(existsSync(objectPath(before.object_id))).toBe(false);
    const bytes = readFileSync(objectPath(after.object_id));
    expect(docRow(board.id)).toMatchObject({ size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(first.body.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    // text and originalText both count: (6 + 4) * 2.
    expect(after).toMatchObject({ revision: 2, element_count: 2, text_bytes: 20 });

    const stale = await save(owner, board.id, 1, sceneWith(["Other device"]));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "REVISION_CONFLICT", revision: 2 });
    const same = await save(owner, board.id, 2, JSON.parse(bytes.toString("utf8")));
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ revision: 2, unchanged: true });
    expect(boardRow(board.id)!.object_id).toBe(after.object_id);

    const read = await api(owner, "GET", `/whiteboards/${board.id}`);
    expect(read.body.scene.elements.map((item: Json) => item.text)).toEqual(["Island", "Sink"]);
    expect(read.body.whiteboard).toMatchObject({ revision: 2, elementCount: 2 });
    // Saves are audited, coalesced to one row per board per ten minutes.
    await save(owner, board.id, 2, sceneWith(["Third"]));
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'whiteboard.save' AND metadata_json LIKE ?").get(`%${board.id}%`)).toEqual({ n: 1 });
  });

  test("invalid scenes are 400 with the validator's code and 413 past 4 MiB; nothing is stored", async () => {
    const owner = await createUser("WB validator");
    const board = await create(owner);
    const bad = await save(owner, board.id, 1, sceneWith([], { elements: [{ id: "e", type: "embeddable", x: 0, y: 0 }] }));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("UNSUPPORTED_ELEMENT");
    expect((await save(owner, board.id, 1, sceneWith([], { files: { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA" } } }))).body.code).toBe("DATA_URL_NOT_ALLOWED");
    expect((await save(owner, board.id, 1, { elements: [] })).body.code).toBe("INVALID_SCENE");
    expect((await api(owner, "PUT", `/whiteboards/${board.id}/scene`, "{not json")).status).toBe(400);
    const huge = await api(owner, "PUT", `/whiteboards/${board.id}/scene`, JSON.stringify({ baseRevision: 1, scene: sceneWith([], { elements: [{ id: "big", type: "text", x: 0, y: 0, text: "x".repeat(4 * 1024 * 1024 + 2048) }] }) }));
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe("SCENE_TOO_LARGE");
    expect(boardRow(board.id)!.revision).toBe(1);
  });

  test("quota: a save that grows past the quota is 507 and keeps the old scene", async () => {
    const owner = await createUser("WB quota");
    const board = await create(owner);
    const quota = 12_582_912;
    const filler = crypto.randomUUID();
    db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, NULL, 'filler', 'application/octet-stream', 'none', ?, ?, 'file', ?, ?)`).run(filler, owner.userId, quota - 1000, "0".repeat(64), new Date().toISOString(), new Date().toISOString());
    const full = await save(owner, board.id, 1, sceneWith(["y".repeat(2000)]));
    expect(full.status).toBe(507);
    expect(full.body.code).toBe("QUOTA_EXCEEDED");
    expect(boardRow(board.id)!.revision).toBe(1);
    db.query("DELETE FROM documents WHERE id = ?").run(filler);
  });

  test("the Files content route downloads the current scene as an attachment under the strict CSP", async () => {
    const owner = await createUser("WB download");
    const board = await create(owner, "Download me");
    await save(owner, board.id, 1, sceneWith(["Hello"]));
    const response = await request(`/files/${board.id}/content`, {}, owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("Download me.excalidraw");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const body = JSON.parse(await response.text());
    expect(body.elements.map((item: Json) => item.text)).toEqual(["Hello"]);
    // disposition=inline never renders a board (preview_kind none).
    expect((await request(`/files/${board.id}/content?disposition=inline`, {}, owner)).headers.get("content-type")).toBe("application/octet-stream");
  });

  test("rename keeps the suffix and reindexes the title; the Access sheet works on boards as files", async () => {
    const owner = await createUser("WB renamer");
    const board = await create(owner, "Draft");
    const renamed = await api(owner, "PATCH", `/files/${board.id}`, { name: "Final plan" });
    expect(renamed.body.document).toMatchObject({ name: "Final plan.excalidraw", kind: "whiteboard" });
    expect((await api(owner, "GET", "/search?scope=whiteboards&q=final")).body.results.map((hit: Json) => hit.id)).toEqual([board.id]);
    const access = await api(owner, "GET", `/files/${board.id}/access`);
    expect(access.status).toBe(200);
  });

  test("Bin: delete, list as a whiteboard, restore with the same revision; purge removes the objects and rows", async () => {
    const owner = await createUser("WB binner");
    const board = await create(owner);
    await save(owner, board.id, 1, sceneWith(["Keep me"]));
    const { object_id: objectId } = boardRow(board.id)!;
    expect((await api(owner, "DELETE", `/files/${board.id}`)).status).toBe(200);
    expect((await api(owner, "GET", `/whiteboards/${board.id}`)).status).toBe(404);
    expect((await save(owner, board.id, 2, sceneWith(["binned"]))).status).toBe(404);
    const listed = await api(owner, "GET", "/bin");
    expect(listed.body.items.find((item: Json) => item.id === board.id)).toMatchObject({ type: "document", kind: "whiteboard" });
    expect((await api(owner, "POST", `/bin/document/${board.id}/restore`)).status).toBe(200);
    expect((await api(owner, "GET", `/whiteboards/${board.id}`)).body.whiteboard.revision).toBe(2);

    await api(owner, "DELETE", `/files/${board.id}`);
    const purged = await api(owner, "DELETE", `/bin/document/${board.id}`);
    expect(purged.status).toBe(200);
    expect(docRow(board.id)).toBeNull();
    expect(boardRow(board.id)).toBeNull();
    expect(existsSync(objectPath(objectId))).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM whiteboard_search WHERE document_id = ?").get(board.id)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM whiteboard_fts WHERE whiteboard_fts MATCH 'keep'").get()).toEqual({ n: 0 });
  });

  test("sweeper (T166): live scene and snapshot objects survive; a true orphan older than an hour goes", async () => {
    const owner = await createUser("WB sweep");
    const board = await create(owner);
    await save(owner, board.id, 1, sceneWith(["live"]));
    const live = boardRow(board.id)!.object_id as string;
    const snapshotObject = crypto.randomUUID();
    writeFileSync(objectPath(snapshotObject), "{}", { mode: 0o600 });
    db.query("INSERT INTO whiteboard_snapshots (id, document_id, revision, object_id, size_bytes, sha256, created_at) VALUES (?, ?, 1, ?, 2, ?, ?)")
      .run(crypto.randomUUID(), board.id, snapshotObject, "0".repeat(64), new Date().toISOString());
    const orphan = crypto.randomUUID();
    writeFileSync(objectPath(orphan), "{}", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const id of [live, snapshotObject, orphan]) utimesSync(objectPath(id), old, old);
    expect(hasDocumentRow(live)).toBe(true);
    expect(hasDocumentRow(snapshotObject)).toBe(true);
    expect(hasDocumentRow(orphan)).toBe(false);
    await runSweep();
    expect(existsSync(objectPath(live))).toBe(true);
    expect(existsSync(objectPath(snapshotObject))).toBe(true);
    expect(existsSync(objectPath(orphan))).toBe(false);
    // Snapshots count against the quota (§6).
    const { storedBytes } = await import("../server/documents");
    expect(storedBytes(owner.userId)).toBe((docRow(board.id)!.size_bytes as number) + 2);
    // Purge removes the snapshot object too.
    await api(owner, "DELETE", `/files/${board.id}`);
    await api(owner, "DELETE", `/bin/document/${board.id}`);
    expect(existsSync(objectPath(live))).toBe(false);
    expect(existsSync(objectPath(snapshotObject))).toBe(false);
  });

  test("thumbnails (T169): PNG only, ≤ 128 KiB, ≤ 2048 px, stale revisions ignored, exact headers", async () => {
    const owner = await createUser("WB thumbs");
    const reader = await createUser("WB thumb reader");
    const board = await create(owner);
    await save(owner, board.id, 1, sceneWith(["one"]));
    const put = (revision: number, bytes: Buffer) => api(owner, "PUT", `/whiteboards/${board.id}/thumbnail`, { revision, png: bytes.toString("base64") });
    expect((await api(owner, "GET", `/whiteboards/${board.id}/thumbnail`)).status).toBe(404);
    expect((await put(2, PNG)).status).toBe(204);
    expect(boardRow(board.id)).toMatchObject({ thumb_revision: 2 });
    expect((await put(2, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]))).status).toBe(415);
    expect((await put(2, Buffer.concat([PNG.subarray(0, 8), Buffer.from("GIF89a"), Buffer.alloc(40)]))).status).toBe(415);
    expect((await put(2, pngWithSize(4096, 10))).status).toBe(415);
    expect((await put(2, Buffer.concat([PNG, Buffer.alloc(128 * 1024 + 1 - PNG.byteLength)]))).status).toBe(413);
    // A future revision and a stale one are ignored (still 204).
    expect((await put(5, pngWithSize(3, 3))).status).toBe(204);
    expect((await put(1, pngWithSize(4, 4))).status).toBe(204);
    const stored = boardRow(board.id)!;
    expect(Buffer.from(stored.thumb_png as Uint8Array).equals(PNG)).toBe(true);

    const got = await request(`/whiteboards/${board.id}/thumbnail`, {}, owner);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(got.headers.get("cache-control")).toBe("private, no-cache");
    const etag = got.headers.get("etag");
    expect(etag).toBe(`"${createHash("sha256").update(PNG).digest("hex")}"`);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await request(`/whiteboards/${board.id}/thumbnail`, { headers: { "If-None-Match": etag! } }, owner)).status).toBe(304);
    expect((await request(`/whiteboards/${board.id}/thumbnail`, {}, reader)).status).toBe(404);
    expect((await api(owner, "GET", "/whiteboards")).body.whiteboards.find((item: Json) => item.id === board.id)).toMatchObject({ hasThumbnail: true, thumbRevision: 2 });
  });

  test("search (T171): owner and recipients find board text, others do not; gone once binned; reconcile rebuilds drift", async () => {
    const owner = await createUser("WB searcher");
    const reader = await createUser("WB search reader");
    const stranger = await createUser("WB search stranger");
    const board = await create(owner, "Garden");
    await save(owner, board.id, 1, sceneWith(["Zucchinifield near the fence"]));
    await api(owner, "PUT", `/files/${board.id}/sharing`, { visibility: "selected", userIds: [reader.userId] });
    const hits = async (session: Session, q: string) => (await api(session, "GET", `/search?scope=whiteboards&q=${encodeURIComponent(q)}`)).body.results.map((hit: Json) => hit.id);
    expect(await hits(owner, "zucchinifield")).toEqual([board.id]);
    expect(await hits(reader, "zucchinifield")).toEqual([board.id]);
    expect(await hits(stranger, "zucchinifield")).toEqual([]);
    const hit = (await api(owner, "GET", "/search?scope=whiteboards&q=garden")).body.results[0];
    expect(hit).toMatchObject({ id: board.id, name: "Garden" });
    // Drift: the index row claims another source; reconcile rebuilds it.
    db.query("UPDATE whiteboard_search SET source_sha256 = ? WHERE document_id = ?").run("f".repeat(64), board.id);
    db.query("DELETE FROM whiteboard_fts WHERE rowid = (SELECT id FROM whiteboard_search WHERE document_id = ?)").run(board.id);
    expect(await hits(owner, "zucchinifield")).toEqual([]);
    const counts = await reconcileWhiteboardSearchIndex();
    expect(counts.indexed).toBeGreaterThanOrEqual(1);
    expect(await hits(owner, "zucchinifield")).toEqual([board.id]);
    await api(owner, "DELETE", `/files/${board.id}`);
    expect(await hits(owner, "zucchinifield")).toEqual([]);
    expect(await hits(reader, "zucchinifield")).toEqual([]);
  });
});
