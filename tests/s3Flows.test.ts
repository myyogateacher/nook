import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUser, db, fakeS3, request, s3Backend, type Session } from "./support/harness";
import { makePng } from "./support/images";
import { startBlackHole } from "./support/fakeS3";

/**
 * File flows through the S3 backend (S3 storage slice, docs/plan/research/2026-10-09-s3-storage.md):
 * Files, note pictures, whiteboard scenes and pictures, thumbnails, profile pictures, ranges, limits,
 * the Bin, the orphan sweep, and cleanup after a failed upload, against the in-process fake S3.
 *
 * Runs only with MYNOTES_TEST_STORAGE=s3; tests/s3Storage.test.ts runs it that way in its own process,
 * so the default `bun test` covers it too.
 */

const { runSweep } = await import("../server/sweeper");
const objectStoreModule = await import("../server/objectStore");
const { objectStore } = objectStoreModule;
const { purgeAfterFrom } = await import("../server/bin");

type Json = Record<string, any>;
const PREFIX = "nook-test/";
const key = (id: string, namespace = "documents") => `${PREFIX}${namespace}/${id}`;
const documentKeys = () => [...fakeS3!.objects.keys()].filter((name) => name.startsWith(`${PREFIX}documents/`));

async function api(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method === "GET" || method === "HEAD" ? { method, headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

function upload(session: Session, content: string | Uint8Array, filename: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  return request("/files", { method: "POST", body: form, headers }, session);
}
async function uploadOk(session: Session, content: string | Uint8Array, filename: string) {
  const response = await upload(session, content, filename);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: Json }).document;
}
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}

describe.skipIf(!s3Backend)("S3 backend: file flows", () => {
  test("the server started on S3: probe done, prefix claimed, nothing on local disk", () => {
    expect(objectStore().backend).toBe("s3");
    expect(fakeS3!.objects.has(`${PREFIX}.nook-instance`)).toBe(true);
    expect(fakeS3!.log.some((line) => line.startsWith(`PUT ${PREFIX}.probe/`))).toBe(true);
    expect([...fakeS3!.objects.keys()].some((name) => name.includes(".probe/"))).toBe(false);
  });

  test("Files: upload stores the bytes under the document id only; download, preview, and headers are unchanged", async () => {
    const owner = await createUser("S3 files owner");
    const content = "# Plan\nhello é";
    const document = await uploadOk(owner, content, "../Q3 plan.md");
    expect(document.name).toBe("Q3 plan.md");
    const object = fakeS3!.objects.get(key(document.id));
    expect(new TextDecoder().decode(object!.bytes)).toBe(content);
    // The key is the id: no file name, no title, no folder.
    expect([...fakeS3!.objects.keys()].filter((name) => name.includes("plan") || name.includes("Q3"))).toEqual([]);
    expect(db.query("SELECT sha256 FROM documents WHERE id = ?").get(document.id)).toEqual({ sha256: sha(content) });

    const download = await request(`/files/${document.id}/content`, {}, owner);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(content);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("etag")).toBe(`"${sha(content)}"`);

    const preview = await request(`/files/${document.id}/content?disposition=inline`, {}, owner);
    expect(preview.headers.get("content-type")).toContain("text/");
    expect(preview.headers.get("content-disposition")).toContain("inline");
    expect(await preview.text()).toBe(content);

    // Access checks stay in front of the bytes.
    const stranger = await createUser("S3 files stranger");
    expect((await request(`/files/${document.id}/content`, {}, stranger)).status).toBe(404);
  });

  test("Range requests: a single range is 206 from a ranged GET, If-Range and HEAD behave as on disk", async () => {
    const owner = await createUser("S3 range owner");
    const document = await uploadOk(owner, "0123456789", "digits.txt");
    const before = fakeS3!.log.length;
    const ranged = await request(`/files/${document.id}/content`, { headers: { Range: "bytes=2-5" } }, owner);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(ranged.headers.get("content-length")).toBe("4");
    expect(await ranged.text()).toBe("2345");
    expect(fakeS3!.log.slice(before).some((line) => line.startsWith(`GET ${key(document.id)}`))).toBe(true);

    const suffix = await request(`/files/${document.id}/content`, { headers: { Range: "bytes=-3" } }, owner);
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");
    const stale = await request(`/files/${document.id}/content`, { headers: { Range: "bytes=0-1", "If-Range": '"other"' } }, owner);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("0123456789");
    const unsatisfiable = await request(`/files/${document.id}/content`, { headers: { Range: "bytes=50-60" } }, owner);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
    const head = await request(`/files/${document.id}/content`, { method: "HEAD" }, owner);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
  });

  test("note pictures: an image File is stored on S3 and served inline as image/png", async () => {
    const owner = await createUser("S3 note owner");
    const png = makePng(32, 20);
    const image = await uploadOk(owner, png, "photo.png");
    expect(image).toMatchObject({ mime_type: "image/png", preview_kind: "image" });
    expect(fakeS3!.objects.get(key(image.id))?.bytes.byteLength).toBe(png.byteLength);
    const note = await api(owner, "POST", "/notes", { folderId: null });
    expect(note.status).toBe(201);
    const noteId = note.body.note.id as string;
    const markdown = `A picture\n\n![photo](/api/files/${image.id}/content?disposition=inline)\n`;
    expect((await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown, revision: note.body.note.draft_revision ?? 0 })).status).toBeLessThan(300);
    const served = await request(`/files/${image.id}/content?disposition=inline`, {}, owner);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
  });

  test("whiteboards: scenes are S3 objects, pictures are Files on S3, thumbnails are served, saves copy on write", async () => {
    const owner = await createUser("S3 board owner");
    const created = await api(owner, "POST", "/whiteboards", { name: "Plan" });
    expect(created.status).toBe(201);
    const boardId = created.body.whiteboard.id as string;
    const firstObject = (db.query("SELECT object_id FROM whiteboards WHERE document_id = ?").get(boardId) as { object_id: string }).object_id;
    expect(fakeS3!.objects.has(key(firstObject))).toBe(true);
    expect(fakeS3!.objects.has(key(boardId))).toBe(false);

    const picture = await uploadOk(owner, makePng(16, 16), "board.png");
    const scene = {
      type: "excalidraw", version: 2, source: "test", appState: {},
      elements: [{ id: "img0", type: "image", x: 0, y: 0, width: 16, height: 16, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId: picture.id, status: "pending", scale: [1, 1], version: 1 }],
      files: { [picture.id]: { id: picture.id, mimeType: "image/png", nookDocumentId: picture.id } }
    };
    const saved = await api(owner, "PUT", `/whiteboards/${boardId}/scene`, { baseRevision: 1, scene });
    expect(saved.status).toBe(200);
    const secondObject = (db.query("SELECT object_id FROM whiteboards WHERE document_id = ?").get(boardId) as { object_id: string }).object_id;
    expect(secondObject).not.toBe(firstObject);
    expect(fakeS3!.objects.has(key(secondObject))).toBe(true);
    expect(fakeS3!.objects.has(key(firstObject))).toBe(false);

    const read = await api(owner, "GET", `/whiteboards/${boardId}`);
    expect(read.status).toBe(200);
    expect(read.body.scene.files[picture.id].nookDocumentId).toBe(picture.id);
    const pictureResponse = await request(`/files/${picture.id}/content?disposition=inline`, {}, owner);
    expect(pictureResponse.headers.get("content-type")).toBe("image/png");
    // A whiteboard's own content route reads its current scene object from S3.
    const content = await request(`/files/${boardId}/content`, {}, owner);
    expect(content.status).toBe(200);
    expect(sha(new Uint8Array(await content.arrayBuffer()))).toBe(saved.body.sha256);

    // The thumbnail's pictures (v0.35.0) come from the scene object read back from S3.
    expect((await api(owner, "GET", `/whiteboards/${boardId}/thumbnail-pictures`)).body).toEqual({ revision: 2, documentIds: [picture.id] });

    const thumb = makePng(24, 16);
    expect((await api(owner, "PUT", `/whiteboards/${boardId}/thumbnail`, { revision: 2, png: Buffer.from(thumb).toString("base64") })).status).toBe(204);
    const thumbnail = await request(`/whiteboards/${boardId}/thumbnail`, {}, owner);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await thumbnail.arrayBuffer())).toEqual(thumb);
  });

  test("profile pictures: stored and served from the avatars namespace, removed when cleared", async () => {
    const person = await createUser("S3 avatar person");
    const { clearAvatar } = await import("../server/avatars");
    const avatarId = crypto.randomUUID();
    const png = makePng(8, 8);
    await objectStore().put("avatars", avatarId, png);
    db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(avatarId, person.userId);
    expect(fakeS3!.objects.has(key(avatarId, "avatars"))).toBe(true);
    const served = await request(`/users/${person.userId}/avatar?v=${avatarId}`, {}, person);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    await clearAvatar(person.userId);
    expect(fakeS3!.objects.has(key(avatarId, "avatars"))).toBe(false);
    expect((await request(`/users/${person.userId}/avatar?v=${avatarId}`, {}, person)).status).toBe(404);
  });

  test("limits and quota: refused uploads store nothing on S3", async () => {
    const owner = await createUser("S3 limits owner");
    const before = documentKeys().length;
    const tooLarge = await upload(owner, new Uint8Array(4_194_305), "big.bin");
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json() as Json).code).toBe("FILE_TOO_LARGE");
    // Quota: 12 MiB in the harness. Fill most of it, then one more upload must not fit.
    for (let index = 0; index < 3; index += 1) await uploadOk(owner, new Uint8Array(4_000_000).fill(index), `fill-${index}.bin`);
    const over = await upload(owner, new Uint8Array(1_000_000), "over.bin");
    expect(over.status).toBe(507);
    expect((await over.json() as Json).code).toBe("QUOTA_EXCEEDED");
    expect(documentKeys().length).toBe(before + 3);
  });

  test("a storage failure mid-upload answers 503 and leaves no row and no object", async () => {
    const owner = await createUser("S3 failing upload");
    const before = documentKeys().length;
    const rows = () => (db.query("SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?").get(owner.userId) as { n: number }).n;
    fakeS3!.failNext(new RegExp(`^PUT ${PREFIX}documents/`), 10);
    const response = await upload(owner, "will not be stored", "fail.txt");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    fakeS3!.clearFailures();
    expect(rows()).toBe(0);
    expect(documentKeys().length).toBe(before);
  });

  test("a row that cannot be committed removes the object it wrote (blocked mid-upload)", async () => {
    const owner = await createUser("S3 blocked mid-upload");
    const before = documentKeys().length;
    const boundary = "s3-flow-boundary";
    const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.txt"\r\n\r\n`);
    const tail = new TextEncoder().encode(`payload\r\n--${boundary}--\r\n`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(head);
        await gate;
        controller.enqueue(tail);
        controller.close();
      }
    });
    const pending = request("/files", { method: "POST", body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(head.byteLength + tail.byteLength) }, duplex: "half" } as RequestInit, owner);
    await Bun.sleep(100);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), owner.userId);
    release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(documentKeys().length).toBe(before);
    expect(fakeS3!.uploads.size).toBe(0);
  });

  test("a client abort mid-upload leaves no row and no object", async () => {
    const owner = await createUser("S3 aborted upload");
    const before = documentKeys().length;
    const controller = new AbortController();
    const boundary = "s3-abort-boundary";
    const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.bin"\r\n\r\n${"x".repeat(8192)}`);
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(head); }, pull: () => new Promise<void>(() => undefined) });
    const pending = request("/files", { method: "POST", body, signal: controller.signal, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": "100000" }, duplex: "half" } as RequestInit, owner).catch((error: Error) => error.name);
    await Bun.sleep(150);
    controller.abort();
    expect(await pending).toBe("AbortError");
    // The discarded writer completes and deletes its object; give it a moment.
    await waitFor(() => !fakeS3!.log.slice(-20).some((line) => line.startsWith("PUT") && !line.includes("partNumber")) || documentKeys().length === before);
    await Bun.sleep(200);
    expect(documentKeys().length).toBe(before);
    expect((db.query("SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?").get(owner.userId) as { n: number }).n).toBe(0);
  });

  test("the Files search index reads text through S3 (lane FTS); a missing object is indexed by name only", async () => {
    const { whenDocumentIndexIdle } = await import("../server/documentSearch");
    const { resetSearchRateLimit } = await import("../server/searchRoutes");
    const owner = await createUser("S3 search owner");
    const term = `s3w${crypto.randomUUID().slice(0, 8)}`;
    const document = await uploadOk(owner, `Notes about ${term} in the bucket`, "bucket.md");
    await whenDocumentIndexIdle();
    expect(db.query("SELECT body_state FROM document_search WHERE document_id = ?").get(document.id)).toEqual({ body_state: "text" });
    resetSearchRateLimit();
    const found = await api(owner, "GET", `/search?q=${term}&scope=files`);
    expect(found.body.results.map((hit: Json) => hit.id)).toEqual([document.id]);

    const missing = `s3m${crypto.randomUUID().slice(0, 8)}`;
    const failing = await uploadOk(owner, `${missing} body`, `${missing}.md`);
    // The object vanished before the indexer read it: an integrity failure, not storage trouble.
    db.query("DELETE FROM document_search WHERE document_id = ?").run(failing.id);
    fakeS3!.objects.delete(key(failing.id));
    const { scheduleDocumentIndex } = await import("../server/documentSearch");
    scheduleDocumentIndex();
    await whenDocumentIndexIdle();
    expect(db.query("SELECT body_state FROM document_search WHERE document_id = ?").get(failing.id)).toEqual({ body_state: "unreadable" });
  });

  test("a missing or truncated object fails closed with 500", async () => {
    const owner = await createUser("S3 integrity owner");
    const document = await uploadOk(owner, "intact", "intact.txt");
    fakeS3!.objects.get(key(document.id))!.bytes = new TextEncoder().encode("short");
    expect((await request(`/files/${document.id}/content`, {}, owner)).status).toBe(500);
    fakeS3!.objects.delete(key(document.id));
    expect((await request(`/files/${document.id}/content`, {}, owner)).status).toBe(500);
  });

  test("Bin purge deletes the objects: a file, and a whiteboard's scene and snapshots", async () => {
    const owner = await createUser("S3 purge owner");
    const document = await uploadOk(owner, "binned bytes", "binned.txt");
    expect((await api(owner, "DELETE", `/files/${document.id}`)).status).toBe(200);
    // Binned: still stored (restorable).
    expect(fakeS3!.objects.has(key(document.id))).toBe(true);
    expect((await api(owner, "DELETE", `/bin/document/${document.id}`)).status).toBeLessThan(300);
    expect(fakeS3!.objects.has(key(document.id))).toBe(false);

    const board = (await api(owner, "POST", "/whiteboards", { name: "Purged board" })).body.whiteboard as Json;
    const sceneObject = (db.query("SELECT object_id FROM whiteboards WHERE document_id = ?").get(board.id) as { object_id: string }).object_id;
    const snapshotObject = crypto.randomUUID();
    await objectStore().put("documents", snapshotObject, new TextEncoder().encode("{}"));
    db.query("INSERT INTO whiteboard_snapshots (id, document_id, revision, object_id, size_bytes, sha256, created_at) VALUES (?, ?, 1, ?, 2, ?, ?)")
      .run(crypto.randomUUID(), board.id, snapshotObject, sha("{}"), new Date().toISOString());
    await api(owner, "DELETE", `/files/${board.id}`);
    expect((await api(owner, "DELETE", `/bin/document/${board.id}`)).status).toBeLessThan(300);
    expect(fakeS3!.objects.has(key(sceneObject))).toBe(false);
    expect(fakeS3!.objects.has(key(snapshotObject))).toBe(false);
  });

  test("the retention sweep purges binned files from S3 too", async () => {
    const owner = await createUser("S3 retention owner");
    const document = await uploadOk(owner, "old binned bytes", "old.txt");
    await api(owner, "DELETE", `/files/${document.id}`);
    db.query("UPDATE documents SET purge_after = ? WHERE id = ?").run(purgeAfterFrom(new Date(Date.now() - 31 * 86_400_000)), document.id);
    await runSweep();
    expect(fakeS3!.objects.has(key(document.id))).toBe(false);
    expect(db.query("SELECT 1 FROM documents WHERE id = ?").get(document.id)).toBeNull();
  });

  test("the hourly sweep removes S3 orphans past the grace period only, and never touches other keys", async () => {
    const owner = await createUser("S3 sweep owner");
    const live = await uploadOk(owner, "live", "live.txt");
    const orphan = crypto.randomUUID();
    const young = crypto.randomUUID();
    const avatarOrphan = crypto.randomUUID();
    await objectStore().put("documents", orphan, new TextEncoder().encode("orphan"));
    await objectStore().put("documents", young, new TextEncoder().encode("young"));
    await objectStore().put("avatars", avatarOrphan, new TextEncoder().encode("avatar"));
    fakeS3!.age(key(live.id), 86_400_000);
    fakeS3!.age(key(orphan), 86_400_000);
    fakeS3!.age(key(avatarOrphan, "avatars"), 86_400_000);
    fakeS3!.objects.set(`${PREFIX}documents/not-a-uuid`, { bytes: new Uint8Array(1), lastModified: new Date(0), etag: '"x"', contentType: "text/plain" });
    fakeS3!.objects.set("outside-prefix/documents/" + crypto.randomUUID(), { bytes: new Uint8Array(1), lastModified: new Date(0), etag: '"x"', contentType: "text/plain" });
    const counts = await runSweep();
    expect(counts!.orphansRemoved).toBeGreaterThanOrEqual(1);
    expect(counts!.ignored).toBeGreaterThanOrEqual(1);
    expect(fakeS3!.objects.has(key(orphan))).toBe(false);
    expect(fakeS3!.objects.has(key(avatarOrphan, "avatars"))).toBe(false);
    expect(fakeS3!.objects.has(key(live.id))).toBe(true);
    expect(fakeS3!.objects.has(key(young))).toBe(true);
    expect(fakeS3!.objects.has(`${PREFIX}documents/not-a-uuid`)).toBe(true);
    expect([...fakeS3!.objects.keys()].some((name) => name.startsWith("outside-prefix/"))).toBe(true);
    expect(fakeS3!.objects.has(`${PREFIX}.nook-instance`)).toBe(true);
  });
});

describe.skipIf(!s3Backend)("S3 backend: outages and limits (review H2, L1, M3)", () => {
  const { createS3ObjectStore, setObjectStoreForTests, setS3UploadLimitForTests } = objectStoreModule;
  const settings = (endpoint: string) => ({ bucket: fakeS3!.bucket, endpoint, region: "us-east-1", accessKeyId: fakeS3!.accessKeyId, secretAccessKey: fakeS3!.secretAccessKey, prefix: PREFIX, timeoutMs: 300 });

  test("a store that accepts and never answers: uploads, downloads, and whiteboard reads answer 503 in time; the sweep still finishes", async () => {
    const owner = await createUser("S3 outage owner");
    const document = await uploadOk(owner, "before the outage", "before.txt");
    const board = (await api(owner, "POST", "/whiteboards", { name: "Outage board" })).body.whiteboard as Json;
    const original = objectStore();
    const hole = startBlackHole();
    setObjectStoreForTests(createS3ObjectStore(settings(hole.url)));
    try {
      const started = Date.now();
      const download = await request(`/files/${document.id}/content`, {}, owner);
      expect(download.status).toBe(503);
      expect(download.headers.get("retry-after")).toBe("5");
      expect(await download.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      const uploaded = await upload(owner, "during the outage", "during.txt");
      expect(uploaded.status).toBe(503);
      expect(uploaded.headers.get("retry-after")).toBe("5");
      expect(await uploaded.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      const read = await api(owner, "GET", `/whiteboards/${board.id}`);
      expect(read.status).toBe(503);
      expect(read.body.code).toBe("STORAGE_UNAVAILABLE");
      // The hourly sweep finishes (its file part is skipped) instead of holding its in-flight run forever.
      expect(await runSweep()).toBeNull();
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      setObjectStoreForTests(original);
      hole.stop();
    }
    expect((await request(`/files/${document.id}/content`, {}, owner)).status).toBe(200);
  }, 30_000);

  test("a download that stalls mid-body is cut after the idle deadline instead of staying pending", async () => {
    const owner = await createUser("S3 stalled download");
    const document = await uploadOk(owner, "x".repeat(5000), "stalled.txt");
    // The Files search index reads a new upload in the background; let it finish so the stall hits the download.
    await (await import("../server/documentSearch")).whenDocumentIndexIdle();
    const original = objectStore();
    setObjectStoreForTests(createS3ObjectStore(settings(fakeS3!.url)));
    fakeS3!.stallBodyNext(new RegExp(`^GET ${PREFIX}documents/${document.id}`));
    try {
      const response = await request(`/files/${document.id}/content`, {}, owner);
      expect(response.status).toBe(200);
      const outcome = await response.arrayBuffer().then((body) => body.byteLength, () => "cut");
      expect(outcome === "cut" || (typeof outcome === "number" && outcome < 5000)).toBe(true);
    } finally {
      fakeS3!.clearFailures();
      setObjectStoreForTests(original);
    }
  }, 30_000);

  test("past the concurrent S3 upload cap an upload answers 503 STORAGE_BUSY with Retry-After and stores nothing", async () => {
    const owner = await createUser("S3 busy owner");
    const before = documentKeys().length;
    setS3UploadLimitForTests(0);
    try {
      const response = await upload(owner, "no slot", "busy.txt");
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({ code: "STORAGE_BUSY" });
    } finally {
      setS3UploadLimitForTests(null);
    }
    expect(documentKeys().length).toBe(before);
    expect((await upload(owner, "a slot again", "after.txt")).status).toBe(201);
  });
});

describe.skipIf(!s3Backend)("S3 backend: uploads everywhere (U0, U1, U5)", () => {
  test("an attachment upload (?attachTo=event) is stored on S3 under its id, links to an event, and is served", async () => {
    const owner = await createUser("S3 attachment owner");
    const calendar = await api(owner, "POST", "/calendars", { name: "S3 calendar" });
    const event = await api(owner, "POST", `/calendars/${calendar.body.calendar.id}/events`, { title: "S3 planning", allDay: true, startDate: "2026-10-12", endDate: "2026-10-13" });
    const form = new FormData();
    form.append("file", new Blob(["agenda stored on S3"]), "s3-agenda.txt");
    const uploaded = await request("/files?attachTo=event", { method: "POST", body: form }, owner);
    expect(uploaded.status).toBe(201);
    const document = ((await uploaded.json()) as { document: Json }).document;
    expect(new TextDecoder().decode(fakeS3!.objects.get(key(document.id))!.bytes)).toBe("agenda stored on S3");
    expect((await api(owner, "POST", `/attachments/event/${event.body.event.id}`, { documentId: document.id })).status).toBeLessThan(300);
    const listed = await api(owner, "GET", `/attachments/event/${event.body.event.id}`);
    expect(JSON.stringify(listed.body)).toContain(document.id);
    const served = await request(`/files/${document.id}/content`, {}, owner);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("agenda stored on S3");
  });

  test("a chat image (?attachTo=chat_message) is stored on S3 and read back through the store for a model turn", async () => {
    const owner = await createUser("S3 chat image owner");
    const png = makePng(12, 12);
    const form = new FormData();
    form.append("file", new Blob([png]), "s3-chat.png");
    const uploaded = await request("/files?attachTo=chat_message", { method: "POST", body: form }, owner);
    expect(uploaded.status).toBe(201);
    const document = ((await uploaded.json()) as { document: Json }).document;
    expect(fakeS3!.objects.get(key(document.id))?.bytes.byteLength).toBe(png.byteLength);
    // The model-turn reader (server/agents/chatImages.ts) goes through openObjectForRead → the S3 store.
    const before = fakeS3!.log.length;
    const bytes = await (await objectStoreModule.objectStore().open("documents", document.id, png.byteLength)).bytes();
    expect(bytes).toEqual(png);
    expect(fakeS3!.log.slice(before).some((line) => line.startsWith(`GET ${key(document.id)}`))).toBe(true);
  });
});

describe.skipIf(!s3Backend)("S3 backend: card and comment attachments (U2)", () => {
  test("a card attachment and a files-only comment's attachment are stored on S3 and served to board readers", async () => {
    const owner = await createUser("S3 card owner");
    const created = await api(owner, "POST", "/tasks/boards", { name: "S3 board" });
    const card = (await api(owner, "POST", `/tasks/boards/${created.body.board.id}/cards`, { columnId: created.body.columns[0].id, title: "S3 card" })).body.card as Json;
    const uploadTo = async (name: string, content: string) => {
      const form = new FormData();
      form.append("file", new Blob([content]), name);
      const response = await request("/files?attachTo=card", { method: "POST", body: form }, owner);
      expect(response.status).toBe(201);
      return ((await response.json()) as { document: Json }).document.id as string;
    };
    const onCard = await uploadTo("s3-card.txt", "card bytes on S3");
    expect((await api(owner, "POST", `/tasks/cards/${card.id}/attachments`, { documentId: onCard })).status).toBe(201);
    const onComment = await uploadTo("s3-comment.txt", "comment bytes on S3");
    expect((await api(owner, "POST", `/tasks/cards/${card.id}/comments`, { body: "", attachmentIds: [onComment] })).status).toBeLessThan(300);
    for (const [id, text] of [[onCard, "card bytes on S3"], [onComment, "comment bytes on S3"]] as const) {
      expect(new TextDecoder().decode(fakeS3!.objects.get(key(id))!.bytes)).toBe(text);
      const served = await request(`/files/${id}/content`, {}, owner);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe(text);
    }
  });
});
