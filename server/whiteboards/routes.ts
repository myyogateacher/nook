import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { REVALIDATE_CACHE } from "../documents";
import { readBoundedBody, uuid } from "../validation";
import { WHITEBOARD_MAX_SCENE_BYTES } from "../../shared/whiteboardScene";
import {
  createWhiteboard, duplicateWhiteboard, listSnapshots, listWhiteboardsPage, previousVersion, putThumbnail, readableWhiteboard, readSnapshot, readThumbnail, readWhiteboard,
  restorePreviousVersion, restoreSnapshot, saveScene, THUMBNAIL_MAX_BYTES, WHITEBOARD_SORTS, WhiteboardError, type WhiteboardSort
} from "./service";
import { importWhiteboard, WHITEBOARD_IMPORT_MAX_BYTES } from "./import";

/**
 * docs/plan/API_CONTRACTS.md § Whiteboards (whiteboard plan §8). Every route needs a session;
 * mutations also need CSRF and a role that writes (the Wave 15 gate refuses viewers and guests),
 * and act only on the caller's own boards. Missing and forbidden are the same 404 (T168).
 * Rename, move, share, and delete use the Files routes unchanged (D196).
 */

const createSchema = z.object({ name: z.string().max(1024), folderId: uuid.nullish() }).strict();
const thumbnailSchema = z.object({ revision: z.number().int().min(1), png: z.string().max(Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4 + 4) }).strict();
/** The scene body cap (4 MiB, 413 SCENE_TOO_LARGE) with room for `{"baseRevision":…,"scene":…}`. */
const SCENE_BODY_LIMIT = WHITEBOARD_MAX_SCENE_BYTES + 1024;
const THUMBNAIL_BODY_LIMIT = Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4 + 1024;

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof WhiteboardError) {
    if (error.status === 429 && typeof error.details.retryAfter === "number") c.header("Retry-After", String(error.details.retryAfter));
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  }
  throw error;
}

async function readJson(c: Context<AppEnv>, limit: number, tooLargeCode: string) {
  let body: Uint8Array;
  try {
    body = await readBoundedBody(c.req.raw, limit);
  } catch (error) {
    if ((error as { status?: number }).status === 413) throw new WhiteboardError(413, tooLargeCode, "This whiteboard is too large to save");
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new WhiteboardError(400, "INVALID_SCENE", "Invalid JSON");
  }
}

const idParam = (c: Context<AppEnv>) => {
  const parsed = uuid.safeParse(c.req.param("id")?.toLowerCase());
  if (!parsed.success) throw new WhiteboardError(404, "NOT_FOUND", "Whiteboard not found");
  return parsed.data;
};

const snapshotParam = (c: Context<AppEnv>) => {
  const parsed = uuid.safeParse(c.req.param("snapshotId")?.toLowerCase());
  if (!parsed.success) throw new WhiteboardError(404, "NO_SNAPSHOT", "There is no such version");
  return parsed.data;
};

export function registerWhiteboardRoutes(app: Hono<AppEnv>) {
  app.post("/api/whiteboards", async (c) => {
    try {
      const keyHeader = c.req.header("Idempotency-Key");
      const uploadKey = keyHeader === undefined ? null : uuid.safeParse(keyHeader.trim().toLowerCase()).data ?? null;
      if (keyHeader !== undefined && !uploadKey) return c.json({ error: "Idempotency-Key must be a UUID" }, 400);
      const body = createSchema.parse(await readJson(c, 16_384, "INVALID"));
      const result = await createWhiteboard(c.get("user").id, { name: body.name, folderId: body.folderId ?? null, uploadKey });
      return c.json({ whiteboard: result.whiteboard, ...(result.replay ? { idempotentReplay: true } : {}) }, result.replay ? 200 : 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  // Pages of at most 500, newest edit first; pass nextCursor back as cursor (review L7).
  app.get("/api/whiteboards", (c) => {
    const folder = (c.req.query("folder") ?? "all").toLowerCase();
    if (folder !== "all" && folder !== "shared" && !uuid.safeParse(folder).success) return c.json({ error: "Invalid request", details: ["folder must be all, shared, or a folder id"] }, 400);
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!/^\d{1,3}$/.test(limitParam!) || limit < 1 || limit > 500)) return c.json({ error: "Invalid request", details: ["limit must be an integer from 1 to 500"] }, 400);
    const sortParam = c.req.query("sort") ?? "updated-desc";
    if (!(WHITEBOARD_SORTS as readonly string[]).includes(sortParam)) return c.json({ error: "Invalid request", details: [`sort must be one of ${WHITEBOARD_SORTS.join(", ")}`] }, 400);
    try {
      return c.json(listWhiteboardsPage(c.get("user").id, folder, { limit, cursor: c.req.query("cursor") ?? null, sort: sortParam as WhiteboardSort }));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/api/whiteboards/:id", async (c) => {
    try {
      const result = await readWhiteboard(idParam(c), c.get("user").id);
      c.header("ETag", `"r${result.whiteboard.revision}"`);
      return c.json(result);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.put("/api/whiteboards/:id/scene", async (c) => {
    try {
      const id = idParam(c);
      const body = await readJson(c, SCENE_BODY_LIMIT, "SCENE_TOO_LARGE");
      const parsed = z.object({ baseRevision: z.number().int().min(1), scene: z.unknown() }).strict().safeParse(body);
      if (!parsed.success) throw new WhiteboardError(400, "INVALID_SCENE", "Send baseRevision and scene");
      return c.json(await saveScene(id, c.get("user").id, parsed.data.baseRevision, parsed.data.scene));
    } catch (error) {
      return fail(c, error);
    }
  });

  // The owner's "Restore previous version" (QA D1–D3 safety net): the newest safety snapshot is
  // saved as a new revision through the CAS. No MCP tool does this.
  app.get("/api/whiteboards/:id/previous-version", async (c) => {
    try {
      return c.json(await previousVersion(idParam(c), c.get("user").id));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/whiteboards/:id/restore-previous", async (c) => {
    try {
      const id = idParam(c);
      const parsed = z.object({ baseRevision: z.number().int().min(1) }).strict().safeParse(await readJson(c, 1024, "INVALID"));
      if (!parsed.success) throw new WhiteboardError(400, "INVALID", "Send baseRevision");
      return c.json(await restorePreviousVersion(id, c.get("user").id, parsed.data.baseRevision));
    } catch (error) {
      return fail(c, error);
    }
  });

  // D207: the History sheet. The owner's only; anyone else gets 404 like a missing board.
  app.get("/api/whiteboards/:id/snapshots", async (c) => {
    try {
      return c.json(await listSnapshots(idParam(c), c.get("user").id));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/api/whiteboards/:id/snapshots/:snapshotId", async (c) => {
    try {
      return c.json(await readSnapshot(idParam(c), c.get("user").id, snapshotParam(c)));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/api/whiteboards/:id/snapshots/:snapshotId/restore", async (c) => {
    try {
      const id = idParam(c);
      const snapshotId = snapshotParam(c);
      const parsed = z.object({ baseRevision: z.number().int().min(1) }).strict().safeParse(await readJson(c, 1024, "INVALID"));
      if (!parsed.success) throw new WhiteboardError(400, "INVALID", "Send baseRevision");
      return c.json(await restoreSnapshot(id, c.get("user").id, snapshotId, parsed.data.baseRevision));
    } catch (error) {
      return fail(c, error);
    }
  });

  // A copy owned by the caller (any reader who writes), from the board or, for its owner, a snapshot.
  app.post("/api/whiteboards/:id/duplicate", async (c) => {
    try {
      const id = idParam(c);
      const parsed = z.object({ folderId: uuid.nullish(), snapshotId: uuid.nullish() }).strict().safeParse(await readJson(c, 1024, "INVALID"));
      if (!parsed.success) throw new WhiteboardError(400, "INVALID", "Send folderId or snapshotId, or nothing");
      return c.json(await duplicateWhiteboard(id, c.get("user").id, { folderId: parsed.data.folderId ?? null, snapshotId: parsed.data.snapshotId ?? null }), 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  // Import `.excalidraw`: the parsed file, through the same validator as a save; embedded images become Files.
  app.post("/api/whiteboards/import", async (c) => {
    try {
      const body = await readJson(c, WHITEBOARD_IMPORT_MAX_BYTES, "IMPORT_TOO_LARGE");
      const parsed = z.object({ name: z.string().max(1024), folderId: uuid.nullish(), file: z.unknown() }).strict().safeParse(body);
      if (!parsed.success) throw new WhiteboardError(400, "INVALID_SCENE", "Send name and file");
      return c.json(await importWhiteboard(c.get("user").id, { name: parsed.data.name, folderId: parsed.data.folderId ?? null, file: parsed.data.file }), 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  // The embed card in notes (D208): only what the card shows, for readers; 404 for anyone else (D73).
  app.get("/api/whiteboards/:id/summary", (c) => {
    try {
      const board = readableWhiteboard(idParam(c), c.get("user").id);
      if (!board) throw new WhiteboardError(404, "NOT_FOUND", "Whiteboard not found");
      return c.json({ whiteboard: { id: board.id, name: board.name, updated_at: board.updated_at, hasThumbnail: board.hasThumbnail, thumbRevision: board.thumbRevision, elementCount: board.elementCount, owner_name: board.owner_name, is_owner: board.is_owner } });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.put("/api/whiteboards/:id/thumbnail", async (c) => {
    try {
      const id = idParam(c);
      const parsed = thumbnailSchema.safeParse(await readJson(c, THUMBNAIL_BODY_LIMIT, "THUMBNAIL_TOO_LARGE"));
      if (!parsed.success) throw new WhiteboardError(400, "INVALID", "Send revision and a base64 PNG");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.data.png)) throw new WhiteboardError(415, "NOT_PNG", "Thumbnails must be PNG images");
      await putThumbnail(id, c.get("user").id, parsed.data.revision, new Uint8Array(Buffer.from(parsed.data.png, "base64")));
      return c.body(null, 204);
    } catch (error) {
      return fail(c, error);
    }
  });

  // Served under the content route's strict header set (documents.ts isContentRequest): sandboxed,
  // nosniff, same-origin only, revalidated by its hash. Only ever used in <img> (T169).
  app.on(["GET", "HEAD"], "/api/whiteboards/:id/thumbnail", (c) => {
    const parsed = uuid.safeParse(c.req.param("id")?.toLowerCase());
    const thumbnail = parsed.success ? readThumbnail(parsed.data, c.get("user").id) : null;
    if (!thumbnail) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const etag = `"${thumbnail.sha256}"`;
    const headers = new Headers({ "Content-Type": "image/png", ETag: etag, "Cache-Control": REVALIDATE_CACHE, "Content-Disposition": "inline" });
    if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(thumbnail.bytes.byteLength));
    return new Response(c.req.method === "HEAD" ? null : new Uint8Array(thumbnail.bytes) as Uint8Array<ArrayBuffer>, { status: 200, headers });
  });
}
