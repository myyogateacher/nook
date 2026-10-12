import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { EventSheet } from "../src/calendar/EventSheet";
import {
  applySheetAttachments, attachmentRights, attachmentRoom, canRemoveAttachment, emptySheetAttachments, EventAttachmentsSection, SheetAttachmentsField,
  sheetAttachmentItems, sheetAttachmentsDirty, sheetUploading, stagedFromDocument, type StagedAttachment
} from "../src/calendar/EventAttachments";
import type { CalendarSummary, EventResponse } from "../src/calendar/calendarApi";
import type { EventForm } from "../src/calendar/calendarFormat";
import type { HostAttachment } from "../src/ui/attachments";
import type { DocumentSummary } from "../src/types";

/**
 * Uploads everywhere U1, the Calendar client: the event sheet stages files until Save, the event view
 * attaches at once, who sees Remove, the cap, and the history layering (one dialog at a time, each a
 * guarded layer, so Back at 390 px closes the Attach sheet or the preview before the event sheet).
 */

const noop = () => undefined;
const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const file = (id: string, name: string, extra: Partial<Extract<HostAttachment, { removed: false }>> = {}): HostAttachment =>
  ({ documentId: id, removed: false, name, mimeType: "image/png", previewKind: "image", sizeBytes: 1200, partId: null, position: 0, linkedAt: "2026-10-09T10:00:00Z", isOwner: false, inAttachmentsFolder: true, ...extra });
const staged = (key: string, status: StagedAttachment["status"], extra: Partial<StagedAttachment> = {}): StagedAttachment =>
  ({ key, name: `${key}.pdf`, sizeBytes: 2048, status, progress: status === "uploading" ? 0.5 : 1, error: status === "failed" ? "Too big" : null, documentId: status === "ready" ? `${key}-doc` : null, mimeType: "application/pdf", previewKind: "pdf", confirmed: false, uploadedHere: true, file: null, ...extra });
const calendar = (extra: Partial<CalendarSummary> = {}) => ({ id: "c1", owner_id: "o", owner_name: "Asha", is_owner: 0, role: "viewer", level: "view", name: "Team", color: "blue", visibility: "selected", share_role: "viewer", created_at: "", updated_at: "", ...extra }) as CalendarSummary;
const response = (attachments: HostAttachment[], extra: Partial<EventResponse> = {}): EventResponse => ({
  event: { id: "e1", calendar_id: "c1", title: "Planning", description: "", location: "", all_day: true, start_date: "2026-10-12", end_date: "2026-10-13", start_local: null, tz: null, duration_minutes: null, repeat: null, exdates: [], revision: 1, canUndo: false, changedByKey: false, changedByKeyName: null, created_by_name: null, updated_by_name: null, created_at: "", updated_at: "" },
  calendar: calendar(), role: "viewer", links: [], attachments, attachmentLimit: 20, ...extra
});

describe("staged sheet attachments", () => {
  test("room counts kept files and additions (failures free their place); dirty and uploading", () => {
    const state = { existing: [file("a", "a.png"), file("b", "b.png")], removed: ["b"], added: [staged("x", "ready"), staged("y", "uploading"), staged("z", "failed")] };
    expect(attachmentRoom(state, 20)).toBe(17);
    expect(attachmentRoom(state, 3)).toBe(0);
    expect(sheetAttachmentItems(state).map((item) => item.documentId)).toEqual(["a", "x-doc"]);
    expect(sheetAttachmentsDirty(state)).toBe(true);
    expect(sheetUploading(state)).toBe(true);
    const clean = emptySheetAttachments([file("a", "a.png")]);
    expect([sheetAttachmentsDirty(clean), sheetUploading(clean)]).toEqual([false, false]);
    // A Files item picked through the confirm keeps `confirmed`, and is never ours to bin on discard.
    const picked = stagedFromDocument({ id: "d", name: "budget.csv", size_bytes: 9, mime_type: "text/csv", preview_kind: "text" } as DocumentSummary, true);
    expect(picked).toMatchObject({ status: "ready", documentId: "d", confirmed: true, uploadedHere: false });
  });

  test("Save unlinks the removals, then links the additions with their confirm", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(init?.body ?? "").includes("bad-doc")) return new Response(JSON.stringify({ error: "An event can have up to 20 files", code: "LIMIT_REACHED" }), { status: 409, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(init?.method === "DELETE" ? { ok: true, documentBinned: true } : { documentId: "x", created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const failures = await applySheetAttachments("e1", { existing: [file("old", "old.png")], removed: ["old"], added: [staged("new", "ready", { confirmed: true }), staged("up", "uploading"), staged("bad", "ready")] });
      expect(calls.map((call) => [call.method, call.url.replace(/^.*\/api/, ""), call.body])).toEqual([
        ["DELETE", "/attachments/event/e1/old", {}],
        ["POST", "/attachments/event/e1", { documentId: "new-doc", confirmed: true }],
        ["POST", "/attachments/event/e1", { documentId: "bad-doc" }]
      ]);
      expect(failures).toEqual(["bad.pdf: An event can have up to 20 files"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("who removes", () => {
  test("the file's owner always (even as a viewer, U0 M1); editors their own; owners and managers anyone's", () => {
    const mine = file("m", "mine.png", { isOwner: true });
    const theirs = file("t", "theirs.png");
    const gone: HostAttachment = { documentId: "g", removed: true, partId: null, position: 0, linkedAt: "" };
    expect(canRemoveAttachment(mine, { canEdit: false, canManage: false })).toBe(true);
    expect(canRemoveAttachment(theirs, { canEdit: false, canManage: false })).toBe(false);
    expect(canRemoveAttachment(theirs, { canEdit: true, canManage: false })).toBe(false);
    expect(canRemoveAttachment(theirs, { canEdit: true, canManage: true })).toBe(true);
    expect(canRemoveAttachment(gone, { canEdit: false, canManage: false })).toBe(false);
    expect(canRemoveAttachment(gone, { canEdit: true, canManage: false })).toBe(true);
    expect(attachmentRights(response([]), true)).toEqual({ canEdit: false, canManage: false });
    expect(attachmentRights(response([], { role: "editor", calendar: calendar({ role: "editor", level: "manage" }) }), true)).toEqual({ canEdit: true, canManage: true });
    expect(attachmentRights(response([], { role: "owner", calendar: calendar({ role: "owner", is_owner: 1, level: "owner" }) }), false)).toEqual({ canEdit: false, canManage: false });
  });
});

describe("rendering", () => {
  test("the event view: readers see thumbnails and open the preview, with Remove only on their own file; editors get Attach", () => {
    const items = [file("a", "photo.png", { isOwner: true }), file("b", "slides.pdf", { mimeType: "application/pdf", previewKind: "pdf" })];
    const reader = renderToStaticMarkup(<EventAttachmentsSection data={response(items)} canEdit={false} canManage={false} onChanged={noop} flash={noop} />);
    expect(reader).toContain("Attachments");
    expect(reader).toContain('src="/api/files/a/content?disposition=inline"');
    expect(reader).toContain('aria-label="Open slides.pdf"');
    expect(reader).toContain('aria-label="Remove photo.png"');
    expect(reader).not.toContain('aria-label="Remove slides.pdf"');
    expect(reader).not.toContain("Attach files");
    // A reader of an event without files sees no section at all.
    expect(renderToStaticMarkup(<EventAttachmentsSection data={response([])} canEdit={false} canManage={false} onChanged={noop} flash={noop} />)).toBe("");

    const editor = renderToStaticMarkup(<EventAttachmentsSection data={response([], { role: "editor" })} canEdit canManage={false} onChanged={noop} flash={noop} />);
    expect(editor).toContain("Attach files");
    expect(editor).toContain('aria-haspopup="dialog"');
    expect(editor).toContain("action-button secondary");
    // At the cap, Attach is disabled and says why.
    const full = Array.from({ length: 20 }, (_, index) => file(`f${index}`, `f${index}.png`));
    const capped = renderToStaticMarkup(<EventAttachmentsSection data={response(full, { role: "editor" })} canEdit canManage onChanged={noop} flash={noop} />);
    expect(capped).toContain("An event can have up to 20 files.");
    expect(capped).toMatch(/<button[^>]*disabled=""[^>]*>.*Attach files/);
  });

  test("the event sheet: the Attachments field after Notes, pending uploads with progress, Retry on failure, and Save waits", () => {
    const state = { existing: [file("a", "a.png", { isOwner: true })], removed: [], added: [staged("up", "uploading"), staged("bad", "failed", { file: new File(["x"], "bad.pdf") })] };
    const field = <SheetAttachmentsField state={state} limit={20} canAttach canRemoveExisting={() => true} onAttach={noop} onOpen={noop} onRemove={noop} onRetry={noop} onRemoveStaged={noop} />;
    const html = renderToStaticMarkup(<EventSheet mode="edit" form={{ title: "Standup", allDay: true, startDate: "2026-10-12", startTime: "09:00", endDate: "2026-10-12", endTime: "09:30", tz: "UTC", location: "", description: "", repeat: null } as unknown as EventForm}
      calendars={[]} calendarId="c1" busy={false} error={null} conflict={false} onChange={noop} onCalendarChange={noop} onRepeat={noop} onSave={noop} onReload={noop} onClose={noop}
      attachments={field} onFiles={noop} uploading />);
    const details = html.slice(html.indexOf('class="calendar-event-details"'), html.indexOf("file-dialog-actions"));
    expect(details.indexOf("Notes")).toBeLessThan(details.indexOf("Attachments"));
    expect(details).toContain('aria-label="Uploading up.pdf"');
    expect(details).toContain("50%");
    expect(details).toContain('aria-label="Retry bad.pdf"');
    expect(details).toContain("Too big");
    expect(details).toContain("They are attached when you save.");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Uploading…<\/button>/);
    // No native select, no browser dialogs (D91).
    expect(html).not.toContain("<select");
  });

  test("source: one dialog at a time, each a guarded history layer; no native confirm", () => {
    const app = source("calendar/CalendarApp.tsx");
    expect(app).toContain("{sheet && !repeatOpen && !sheetLayer && pendingConfirm?.kind !== \"discard\" && <EventSheet");
    expect(app).toContain("sheetLayer?.kind === \"attach\" && <AttachSheet");
    expect(app).toContain("sheetLayer?.kind === \"preview\" && <AttachmentPreview");
    // The kit's sheet and preview each hold their own history guard, so Back closes them first (D18, D21).
    for (const path of ["ui/attachments/AttachSheet.tsx", "ui/attachments/AttachmentPreview.tsx"]) expect(source(path)).toContain("useHistoryDialogGuard(true, onClose");
    for (const path of ["calendar/CalendarApp.tsx", "calendar/EventAttachments.tsx", "calendar/EventSheet.tsx"]) {
      expect(source(path)).not.toMatch(/window\.confirm|\bconfirm\(|<select/);
    }
    // Discarding the sheet stops uploads and bins only what it uploaded itself.
    expect(app).toContain("discardSheetUploads(sheet.attachments)");
    expect(source("calendar/EventAttachments.tsx")).toContain("if (item.uploadedHere && item.status === \"ready\" && item.documentId)");
  });
});

afterEach(noop);
