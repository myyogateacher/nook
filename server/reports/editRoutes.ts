import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { BLOCK_ID } from "../../shared/reports";
import { INSTRUCTION_LIMITS, SHARE_LEVELS, type ReportPatch } from "../../shared/reportsEdit";
import { ReportError } from "./errors";
import { addInstruction, applyProposal, cancelInstruction, listInstructions, proposalView, rejectProposal, reorderInstructions, setAutoApply } from "./instructions";
import { manualEdit } from "./manualEdit";
import { patchSchema } from "./patch";
import { handle, id } from "./routes";
import { getSharing, setSharing } from "./sharing";
import { getVersion, listVersions, restoreVersion } from "./versions";

/**
 * docs/plan/API_CONTRACTS.md § Analytics reports, Wave 48: instructions to the edit agent (the queue,
 * proposals, Apply and Reject, auto-apply), versions and restore, manual edits, and sharing. Same rules
 * as routes.ts: a session, CSRF and a writing role for mutations, 404 for guests and for reports the
 * person cannot read; owner-only actions answer 404 to readers.
 */

const instructionCreate = z.object({ text: z.string().min(1).max(INSTRUCTION_LIMITS.text), blockId: z.string().regex(BLOCK_ID).nullish() }).strict();
const reorderSchema = z.object({ ids: z.array(uuid).max(INSTRUCTION_LIMITS.queued * 2) }).strict();
const autoApplySchema = z.object({ autoApply: z.boolean() }).strict();
const emptySchema = z.object({}).strict();
const editSchema = patchSchema.extend({ expectedRevision: z.number().int().min(1) }).strict();
const sharingSchema = z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  shares: z.array(z.object({ kind: z.enum(["user", "group"]), id: uuid, level: z.enum(SHARE_LEVELS) }).strict()).max(100)
}).strict();

function versionParam(value: string | undefined) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new ReportError(404, "NOT_FOUND", "Version not found");
  return version;
}

export function registerReportEditRoutes(app: Hono<AppEnv>) {
  app.get("/api/reports/:reportId/instructions", handle((c) => listInstructions(id(c, "reportId"), c.get("user").id, c.get("user").role)));
  app.post("/api/reports/:reportId/instructions", handle(async (c) => {
    const user = c.get("user");
    const reportId = id(c, "reportId");
    const body = await parseJson(c.req.raw, instructionCreate);
    return c.json({ instruction: addInstruction({ userId: user.id, role: user.role }, reportId, { text: body.text, blockId: body.blockId ?? null }) }, 201);
  }));
  app.post("/api/reports/:reportId/instructions/reorder", handle(async (c) => {
    const reportId = id(c, "reportId");
    const { ids } = await parseJson(c.req.raw, reorderSchema);
    return reorderInstructions(c.get("user").id, reportId, ids);
  }));
  app.post("/api/reports/:reportId/instructions/:instructionId/cancel", handle(async (c) => {
    const reportId = id(c, "reportId");
    const instructionId = id(c, "instructionId");
    await parseJson(c.req.raw, emptySchema);
    return { instruction: cancelInstruction(c.get("user").id, reportId, instructionId) };
  }));
  app.get("/api/reports/:reportId/instructions/:instructionId/proposal", handle((c) => ({ proposal: proposalView(id(c, "reportId"), id(c, "instructionId"), c.get("user").id) })));
  app.post("/api/reports/:reportId/instructions/:instructionId/apply", handle(async (c) => {
    const reportId = id(c, "reportId");
    const instructionId = id(c, "instructionId");
    await parseJson(c.req.raw, emptySchema);
    return { instruction: applyProposal(c.get("user").id, reportId, instructionId) };
  }));
  app.post("/api/reports/:reportId/instructions/:instructionId/reject", handle(async (c) => {
    const reportId = id(c, "reportId");
    const instructionId = id(c, "instructionId");
    await parseJson(c.req.raw, emptySchema);
    return { instruction: rejectProposal(c.get("user").id, reportId, instructionId) };
  }));
  app.put("/api/reports/:reportId/auto-apply", handle(async (c) => {
    const reportId = id(c, "reportId");
    const { autoApply } = await parseJson(c.req.raw, autoApplySchema);
    return setAutoApply(c.get("user").id, reportId, autoApply);
  }));

  app.get("/api/reports/:reportId/versions", handle((c) => ({ versions: listVersions(id(c, "reportId"), c.get("user").id) })));
  app.get("/api/reports/:reportId/versions/:version", handle((c) => getVersion(id(c, "reportId"), versionParam(c.req.param("version")), c.get("user").id)));
  app.post("/api/reports/:reportId/versions/:version/restore", handle(async (c) => {
    const reportId = id(c, "reportId");
    const version = versionParam(c.req.param("version"));
    await parseJson(c.req.raw, emptySchema);
    return restoreVersion(c.get("user").id, reportId, version);
  }));

  // Manual edits: reorder or remove blocks, edit a query's SQL (re-validated); each is a version.
  app.post("/api/reports/:reportId/spec/edit", handle(async (c) => {
    const reportId = id(c, "reportId");
    const { expectedRevision, ...patch } = await parseJson(c.req.raw, editSchema);
    return await manualEdit(c.get("user").id, reportId, { patch: patch as ReportPatch, expectedRevision }, { signal: c.req.raw.signal });
  }));

  app.get("/api/reports/:reportId/sharing", handle((c) => ({ sharing: getSharing(id(c, "reportId"), c.get("user").id) })));
  app.put("/api/reports/:reportId/sharing", handle(async (c) => {
    const reportId = id(c, "reportId");
    return { sharing: setSharing(c.get("user").id, reportId, await parseJson(c.req.raw, sharingSchema)) };
  }));
}
