import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { REPORT_FOLDER_NAME_MAX, REPORT_FOLDERS_PER_USER } from "../../shared/reports";
import { binFolder, createFolder, listFolders, moveReportToFolder, updateFolder } from "./folders";
import { handle, id } from "./routes";
import "./folderBin";

/**
 * docs/plan/API_CONTRACTS.md § Analytics reports, report folders (Lane I). The caller's own folders
 * only: anyone else's folder is the same 404 as a missing one. Same rules as routes.ts: a session, CSRF
 * and a writing role for mutations, 404 for guests. Registered before `/api/reports/:reportId`.
 *
 * - GET    /api/reports/folders                 the tree and the counts of All, Unfiled, and Shared
 * - POST   /api/reports/folders                 { name, parentId? }
 * - PATCH  /api/reports/folders/:folderId       { name?, parentId?, position? }: rename, move, reorder
 * - DELETE /api/reports/folders/:folderId       to the Bin; its reports move to Unfiled
 * - PATCH  /api/reports/:reportId/folder        { folderId | null }: file a report (null is Unfiled)
 */

const folderName = z.string().trim().min(1).max(REPORT_FOLDER_NAME_MAX).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const folderCreate = z.object({ name: folderName, parentId: uuid.nullish() }).strict();
const folderPatch = z.object({ name: folderName.optional(), parentId: uuid.nullable().optional(), position: z.number().int().min(0).max(REPORT_FOLDERS_PER_USER).optional() }).strict()
  .refine((patch) => patch.name !== undefined || patch.parentId !== undefined || patch.position !== undefined, "change something");
const reportFolder = z.object({ folderId: uuid.nullable() }).strict();

export function registerReportFolderRoutes(app: Hono<AppEnv>) {
  app.get("/api/reports/folders", handle((c) => listFolders(c.get("user").id)));
  app.post("/api/reports/folders", handle(async (c) => {
    const input = await parseJson(c.req.raw, folderCreate);
    return c.json({ folder: createFolder(c.get("user").id, { name: input.name, parentId: input.parentId?.toLowerCase() ?? null }) }, 201);
  }));
  app.patch("/api/reports/folders/:folderId", handle(async (c) => {
    const folderId = id(c, "folderId");
    const patch = await parseJson(c.req.raw, folderPatch);
    return { folder: updateFolder(c.get("user").id, folderId, { ...patch, ...(patch.parentId !== undefined ? { parentId: patch.parentId?.toLowerCase() ?? null } : {}) }) };
  }));
  app.delete("/api/reports/folders/:folderId", handle((c) => binFolder(c.get("user").id, id(c, "folderId"))));
  app.patch("/api/reports/:reportId/folder", handle(async (c) => {
    const reportId = id(c, "reportId");
    const { folderId } = await parseJson(c.req.raw, reportFolder);
    return moveReportToFolder(c.get("user").id, reportId, folderId?.toLowerCase() ?? null);
  }));
}
