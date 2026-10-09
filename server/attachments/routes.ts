import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { HOSTS, isHostKind, type HostKind } from "./hosts";
import { AttachmentError, documentUsage, linkAttachment, listAttachments, unlinkAttachment } from "./service";

/**
 * The generic attachment routes (uploads everywhere plan §6 U0 "API"). Every host kind answers the
 * same shapes; who may read, link, and unlink is the host registry's (server/attachments/hosts.ts).
 *
 * - GET    /api/attachments/:hostKind/:hostId               → { attachments, caps, linking }
 * - POST   /api/attachments/:hostKind/:hostId               { documentId, partId?, confirmed? } → 201 { documentId, created }
 * - DELETE /api/attachments/:hostKind/:hostId/:documentId   → { ok, documentBinned? }: the file's owner always (any host
 *   kind, whatever their access to the host now; `{ ok }` only when they cannot read it), others by the host's rule
 * - GET    /api/files/:id/usage                             → { uses, hidden, hiddenCount, total } (owner only)
 *
 * Unknown kinds and malformed ids are the same 404 as a missing host (T340). The write routes are
 * default-denied for viewers and guests by the role write gate (D75, D406), except DELETE, which a
 * read-only role may use for its own file only (review M1).
 */

const linkSchema = z.object({
  documentId: uuid,
  // Parts are a comment id (cards) or a field id (rows): ids, never free text.
  partId: z.string().min(1).max(64).regex(/^[0-9a-zA-Z_-]+$/).nullable().optional(),
  confirmed: z.boolean().optional()
}).strict();

function respond(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AttachmentError) return c.json(error.body, error.status);
  throw error;
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404);

function hostOf(c: Context<AppEnv>): { kind: HostKind; hostId: string } | null {
  const kind = c.req.param("hostKind");
  const hostId = uuid.safeParse(c.req.param("hostId")?.toLowerCase()).data;
  return isHostKind(kind) && hostId ? { kind, hostId } : null;
}

export function registerAttachmentRoutes(app: Hono<AppEnv>) {
  app.get("/api/attachments/:hostKind/:hostId", (c) => {
    const host = hostOf(c);
    if (!host) return notFound(c);
    try {
      const spec = HOSTS[host.kind];
      c.header("Cache-Control", "no-store");
      return c.json({ attachments: listAttachments(host.kind, host.hostId, c.get("user").id), caps: spec.caps, linking: spec.linking });
    } catch (error) {
      return respond(c, error);
    }
  });

  app.post("/api/attachments/:hostKind/:hostId", async (c) => {
    const host = hostOf(c);
    if (!host) return notFound(c);
    const body = await parseJson(c.req.raw, linkSchema);
    try {
      const result = linkAttachment(c.get("user").id, host.kind, host.hostId, { documentId: body.documentId.toLowerCase(), partId: body.partId ?? null, confirmed: body.confirmed });
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      return respond(c, error);
    }
  });

  app.delete("/api/attachments/:hostKind/:hostId/:documentId", (c) => {
    const host = hostOf(c);
    const documentId = uuid.safeParse(c.req.param("documentId")?.toLowerCase()).data;
    if (!host || !documentId) return notFound(c);
    try {
      return c.json({ ok: true, ...unlinkAttachment(c.get("user").id, host.kind, host.hostId, documentId) });
    } catch (error) {
      return respond(c, error);
    }
  });

  app.get("/api/files/:id/usage", (c) => {
    const id = uuid.safeParse(c.req.param("id")?.toLowerCase()).data;
    if (!id) return c.json({ error: "File not found" }, 404);
    try {
      c.header("Cache-Control", "no-store");
      return c.json(documentUsage(id, c.get("user").id));
    } catch (error) {
      return respond(c, error);
    }
  });
}
