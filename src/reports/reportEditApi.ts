import { api } from "../api";
import type { InstructionsView, PatchOp, ProposalView, ReportInstruction, OwnerReview, OwnerReviewScope, ReportOwners, ReportSharing, SharingInput } from "../../shared/reportsEdit";
import type { VersionDiff, VersionHistoryItem, VersionSnapshot } from "../../shared/reportVersions";

/** The Wave 48 report routes (server/reports/editRoutes.ts): instructions, proposals, versions, manual edits, sharing. */

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const listInstructions = (id: string) => api<InstructionsView>(`/reports/${id}/instructions`);
export const addInstruction = (id: string, text: string, blockId: string | null) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions`, json("POST", { text, blockId }));
export const reorderInstructions = (id: string, ids: string[]) => api<InstructionsView>(`/reports/${id}/instructions/reorder`, json("POST", { ids }));
export const cancelInstruction = (id: string, instructionId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions/${instructionId}/cancel`, json("POST", {}));
export const getProposal = (id: string, instructionId: string) => api<{ proposal: ProposalView }>(`/reports/${id}/instructions/${instructionId}/proposal`);
export const applyProposal = (id: string, instructionId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions/${instructionId}/apply`, json("POST", {}));
export const rejectProposal = (id: string, instructionId: string) => api<{ instruction: ReportInstruction }>(`/reports/${id}/instructions/${instructionId}/reject`, json("POST", {}));
export const setAutoApply = (id: string, autoApply: boolean) => api<{ autoApply: boolean }>(`/reports/${id}/auto-apply`, json("PUT", { autoApply }));

export const listVersions = (id: string) => api<{ versions: VersionHistoryItem[] }>(`/reports/${id}/versions`);
/** The owner: one version's spec and its stored results (the read-only view). */
export const getVersion = (id: string, version: number) => api<VersionSnapshot>(`/reports/${id}/versions/${version}`);
/** The owner: what changed from `from` (default: the version before) to `to`. */
export const getVersionDiff = (id: string, to: number, from?: number | null) => api<{ diff: VersionDiff }>(`/reports/${id}/version-diff?to=${to}${from ? `&from=${from}` : ""}`);
/** The owner: "Run with today's data" on a version (a run in Runs; the report is unchanged). */
export const previewVersion = (id: string, version: number) => api<{ runId: string; status: string; results: VersionSnapshot["results"] }>(`/reports/${id}/versions/${version}/preview`, json("POST", {}));
export const restoreVersion = (id: string, version: number) => api<{ version: number; refreshRunId: string | null }>(`/reports/${id}/versions/${version}/restore`, json("POST", {}));

export const editSpec = (id: string, ops: PatchOp[], expectedRevision: number) => api<{ version: number; revision: number }>(`/reports/${id}/spec/edit`, json("POST", { ops, expectedRevision }));

export const getSharing = (id: string) => api<{ sharing: ReportSharing }>(`/reports/${id}/sharing`);
export const saveSharing = (id: string, input: SharingInput) => api<{ sharing: ReportSharing }>(`/reports/${id}/sharing`, json("PUT", input));

/** Whether any instruction is still moving (queued or running): the panel polls while it is. */
export const threadMoving = (instructions: readonly Pick<ReportInstruction, "status">[]) => instructions.some((item) => item.status === "queued" || item.status === "running");

/** Phase 2 (D482): a report's owners; owners and admins add and remove them (never the last one). */
export const getOwners = (id: string) => api<ReportOwners>(`/reports/${id}/owners`);
export const addOwner = (id: string, userId: string) => api<ReportOwners>(`/reports/${id}/owners`, json("POST", { userId }));
export const removeOwner = (id: string, userId: string) => api<ReportOwners>(`/reports/${id}/owners/${userId}`, { method: "DELETE", body: "{}" });
/** D500: Settings → Report owners (admins): reports nobody can manage, or the admin cannot open. */
export const ownerReview = (scope: OwnerReviewScope, q: string) => api<OwnerReview>(`/reports/admin/owner-review?${new URLSearchParams({ scope, ...(q.trim() ? { q: q.trim() } : {}) })}`);
