import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, s3Backend, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { copyThumbnailFiles, thumbnailFiles } from "../src/whiteboards/boardImages";
import type { SceneFile } from "../shared/whiteboardScene";

const { resetWhiteboardLimitsForTests } = await import("../server/whiteboards/service");

/**
 * Whiteboard thumbnails with pictures (v0.35.0). The owner's client draws the thumbnail from the
 * pictures it already loaded, keeping only those the server lists as the board owner's own live
 * pictures (GET …/thumbnail-pictures), which follow the board's sharing. Someone else's picture,
 * or one binned or taken off the board since, is never listed. Runs on S3 with MYNOTES_TEST_STORAGE=s3.
 */

retireUsersAfterFile();
beforeAll(async () => {
  const admin = await createUser("WBT file admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
});
beforeEach(() => resetWhiteboardLimitsForTests());

type Json = Record<string, any>;
async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

// A 2×2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");

async function upload(session: Session, bytes: Uint8Array, filename: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const response = await request("/files", { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return (await response.json() as { document: Json }).document;
}

async function create(owner: Session, name = "Board") {
  const result = await api(owner, "POST", "/whiteboards", { name });
  expect(result.status).toBe(201);
  return result.body.whiteboard as Json;
}

const rect = (id: string) => ({ id, type: "rectangle", x: 0, y: 0, width: 40, height: 30, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", version: 1 });
const imageEl = (id: string, fileId: string) => ({ id, type: "image", x: 0, y: 50, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId, status: "pending", scale: [1, 1], version: 1 });
function sceneWith(documentIds: string[]) {
  const files = Object.fromEntries(documentIds.map((id) => [id, { id, mimeType: "image/png", nookDocumentId: id }]));
  return { type: "excalidraw", version: 2, source: "test", elements: [rect("r"), ...documentIds.map((id, index) => imageEl(`img${index}`, id))], appState: {}, files };
}
const save = (owner: Session, id: string, baseRevision: number, scene: unknown) => api(owner, "PUT", `/whiteboards/${id}/scene`, { baseRevision, scene });
const share = (owner: Session, id: string, userIds: string[]) => api(owner, "PUT", `/files/${id}/sharing`, { visibility: "selected", userIds });
const pictures = async (session: Session, id: string) => api(session, "GET", `/whiteboards/${id}/thumbnail-pictures`);
const putThumb = (owner: Session, id: string, revision: number) => api(owner, "PUT", `/whiteboards/${id}/thumbnail`, { revision, png: PNG.toString("base64") });

describe(`thumbnail pictures (${s3Backend ? "S3" : "local"} storage)`, () => {
  test("the owner's pictures are listed; a picture someone else owns never is; a sharee reads the thumbnail but not the list", async () => {
    const owner = await createUser("WBT owner");
    const sharee = await createUser("WBT sharee");
    const third = await createUser("WBT third");
    const board = await create(owner, "Photos");
    const mine = await upload(owner, PNG, "mine.png");
    const theirs = await upload(third, PNG, "theirs.png");
    // Shared with the board's owner only: the owner may place it, but the board's readers cannot open it.
    await share(third, theirs.id, [owner.userId]);
    const saved = await save(owner, board.id, 1, sceneWith([mine.id, theirs.id]));
    expect(saved.status).toBe(200);

    const listed = await pictures(owner, board.id);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ revision: 2, documentIds: [mine.id] });

    await share(owner, board.id, [sharee.userId]);
    expect((await putThumb(owner, board.id, 2)).status).toBe(204);
    // The sharee sees the owner's thumbnail and can open the owner's picture through the board…
    const thumb = await request(`/whiteboards/${board.id}/thumbnail`, {}, sharee);
    expect(thumb.status).toBe(200);
    expect((await request(`/files/${mine.id}/content?disposition=inline`, {}, sharee)).status).toBe(200);
    // …but not the third person's, which is exactly what the list leaves out.
    expect((await request(`/files/${theirs.id}/content?disposition=inline`, {}, sharee)).status).toBe(404);
    // The list is the owner's (the only one who draws thumbnails); anyone else gets 404.
    expect((await pictures(sharee, board.id)).status).toBe(404);
    expect((await pictures(third, board.id)).status).toBe(404);
  }, 30_000);

  test("a binned picture drops out, comes back when restored, and a picture taken off the board is gone", async () => {
    const owner = await createUser("WBT binner");
    const board = await create(owner, "Bin");
    const first = await upload(owner, PNG, "first.png");
    const second = await upload(owner, PNG, "second.png");
    expect((await save(owner, board.id, 1, sceneWith([first.id, second.id]))).status).toBe(200);
    expect(new Set((await pictures(owner, board.id)).body.documentIds)).toEqual(new Set([first.id, second.id]));

    expect((await request(`/files/${first.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBeLessThan(300);
    expect((await pictures(owner, board.id)).body.documentIds).toEqual([second.id]);
    expect((await request(`/bin/document/${first.id}/restore`, { method: "POST", body: "{}" }, owner)).status).toBeLessThan(300);
    expect(new Set((await pictures(owner, board.id)).body.documentIds)).toEqual(new Set([first.id, second.id]));

    expect((await save(owner, board.id, 2, sceneWith([second.id]))).status).toBe(200);
    expect((await pictures(owner, board.id)).body).toEqual({ revision: 3, documentIds: [second.id] });
  }, 30_000);

  test("duplicate: a sharee's copy of a board with pictures starts without the owner's thumbnail; the owner's copy keeps it", async () => {
    const owner = await createUser("WBT dup owner");
    const sharee = await createUser("WBT dup sharee");
    const board = await create(owner, "Plan");
    const mine = await upload(owner, PNG, "mine.png");
    expect((await save(owner, board.id, 1, sceneWith([mine.id]))).status).toBe(200);
    expect((await putThumb(owner, board.id, 2)).status).toBe(204);
    await share(owner, board.id, [sharee.userId]);

    const theirCopy = await api(sharee, "POST", `/whiteboards/${board.id}/duplicate`, {});
    expect(theirCopy.status).toBe(201);
    expect(theirCopy.body.whiteboard.hasThumbnail).toBe(false);
    const ownCopy = await api(owner, "POST", `/whiteboards/${board.id}/duplicate`, {});
    expect(ownCopy.status).toBe(201);
    expect(ownCopy.body.whiteboard.hasThumbnail).toBe(true);

    // A board without pictures still copies its thumbnail for anyone who may duplicate it.
    const plain = await create(owner, "Plain");
    expect((await save(owner, plain.id, 1, sceneWith([]))).status).toBe(200);
    expect((await putThumb(owner, plain.id, 2)).status).toBe(204);
    await share(owner, plain.id, [sharee.userId]);
    expect((await api(sharee, "POST", `/whiteboards/${plain.id}/duplicate`, {})).body.whiteboard.hasThumbnail).toBe(true);
  }, 30_000);
  test("save as copy: the saver owns the copy, so the copy lists only the saver's own pictures", async () => {
    const owner = await createUser("WBT copy owner");
    const saver = await createUser("WBT copy saver");
    const board = await create(owner, "Shared plan");
    const ownersPicture = await upload(owner, PNG, "owners.png");
    const saversPicture = await upload(saver, PNG, "savers.png");
    // The saver may place the owner's picture (shared with them), but it is not theirs to show.
    await share(owner, ownersPicture.id, [saver.userId]);
    expect((await save(owner, board.id, 1, sceneWith([ownersPicture.id]))).status).toBe(200);
    await share(owner, board.id, [saver.userId]);

    // The client's "Save as copy": a new board of the saver's, then the local scene saved into it.
    const copy = await create(saver, "Shared plan (copy)");
    expect((await save(saver, copy.id, 1, sceneWith([ownersPicture.id, saversPicture.id]))).status).toBe(200);
    expect((await pictures(saver, copy.id)).body).toEqual({ revision: 2, documentIds: [saversPicture.id] });
    // The original board's list is still the owner's alone, and the copy's list is the saver's alone.
    expect((await pictures(owner, board.id)).body.documentIds).toEqual([ownersPicture.id]);
    expect((await pictures(owner, copy.id)).status).toBe(404);
    expect((await putThumb(saver, copy.id, 2)).status).toBe(204);
  }, 30_000);
});

describe("thumbnailFiles (client)", () => {
  const refs = new Map<string, SceneFile>([
    ["f-own", { id: "f-own", mimeType: "image/png", nookDocumentId: "AAAA-own" }],
    ["f-other", { id: "f-other", mimeType: "image/png", nookDocumentId: "bbbb-other" }],
    ["f-unloaded", { id: "f-unloaded", mimeType: "image/png", nookDocumentId: "cccc-unloaded" }]
  ]);
  const loaded = { "f-own": "data:own", "f-other": "data:other", "f-stray": "data:stray" };

  test("pictures the owner owns are drawn into the thumbnail from what the canvas already loaded", () => {
    expect(thumbnailFiles(loaded, refs, ["aaaa-own", "cccc-unloaded"])).toEqual({ "f-own": "data:own" });
  });

  test("a picture the server did not list (someone else's, binned, or taken off) is left out", () => {
    expect(thumbnailFiles(loaded, refs, [])).toEqual({});
    expect(thumbnailFiles(loaded, refs, ["bbbb-other"])).toEqual({ "f-other": "data:other" });
    expect(Object.keys(thumbnailFiles(loaded, refs, ["aaaa-own"]))).not.toContain("f-other");
  });
});

describe("copyThumbnailFiles (client, Save as copy)", () => {
  const scene = {
    files: {
      "f-mine": { id: "f-mine", mimeType: "image/png", nookDocumentId: "dddd-mine" },
      "f-owner": { id: "f-owner", mimeType: "image/png", nookDocumentId: "eeee-owner" }
    }
  };
  const loaded = { "f-mine": "data:mine", "f-owner": "data:owner" };

  test("draws only the pictures the server lists for the new board", async () => {
    const asked: string[] = [];
    const listed = (id: string) => async () => { asked.push(id); return { documentIds: ["DDDD-mine"] }; };
    expect(await copyThumbnailFiles(loaded, scene, listed("copy-id"))).toEqual({ "f-mine": "data:mine" });
    expect(asked).toEqual(["copy-id"]);
  });

  test("a failed list, a board without pictures, or nothing loaded draws no pictures", async () => {
    expect(await copyThumbnailFiles(loaded, scene, async () => { throw new Error("offline"); })).toEqual({});
    let called = false;
    const listed = async () => { called = true; return { documentIds: ["dddd-mine"] }; };
    expect(await copyThumbnailFiles(loaded, { files: {} }, listed)).toEqual({});
    expect(await copyThumbnailFiles({}, scene, listed)).toEqual({});
    expect(called).toBe(false);
  });
});
