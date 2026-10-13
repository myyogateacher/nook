import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySheetAttachmentChanges, notifySheetSaved, savedWithRemovals, sheetUndoMessage, undoSheetRemovals, type SheetRemoval } from "../src/calendar/EventAttachments";
import type { HostAttachment } from "../src/ui/attachments";
import type { NotifyOptions } from "../src/ui/notify";

/**
 * v0.37.0: the event sheet's Undo after Save. Save unlinks the staged removals (each unlink commits
 * the server's Undo record); one toast then offers Undo, which re-links every removed file through
 * POST /api/attachments/relink and says how it went ("Restored N of M", or the refusal for one file).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const file = (id: string, name: string, extra: Partial<Extract<HostAttachment, { removed: false }>> = {}): HostAttachment =>
  ({ documentId: id, removed: false, name, mimeType: "text/plain", previewKind: "text", sizeBytes: 10, partId: null, position: 0, linkedAt: "2026-10-09T10:00:00Z", isOwner: true, inAttachmentsFolder: true, ...extra });

function sink() {
  const calls: Array<{ kind: string; message: string; options?: NotifyOptions }> = [];
  const record = (kind: string) => (message: string, options?: NotifyOptions) => { calls.push({ kind, message, options }); };
  return { calls, sink: { success: record("success"), warning: record("warning"), error: record("error") } };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Save collects what Undo may put back", () => {
  test("every removal that went through, except a file that went to someone else's Bin or has no name", async () => {
    const original = globalThis.fetch;
    const binned = new Set(["mine-binned", "theirs-binned"]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const id = String(input).split("/").at(-1)!;
      if (id === "fails") return json({ error: "Attachment not found", code: "NOT_FOUND" }, 404);
      return json(init?.method === "DELETE" ? { ok: true, documentBinned: binned.has(id) } : { created: true });
    }) as typeof fetch;
    try {
      const existing = [
        file("mine-binned", "mine.txt"), file("theirs-kept", "theirs.txt", { isOwner: false, inAttachmentsFolder: false }),
        file("theirs-binned", "gone.txt", { isOwner: false }), file("fails", "fails.txt"),
        { documentId: "hidden", removed: true, partId: null, position: 0, linkedAt: "" } as HostAttachment
      ];
      const result = await applySheetAttachmentChanges("e1", { existing, removed: existing.map((item) => item.documentId), added: [] });
      expect(result.removed).toEqual([{ documentId: "mine-binned", name: "mine.txt" }, { documentId: "theirs-kept", name: "theirs.txt" }]);
      expect(result.failures).toEqual(["fails.txt: Attachment not found"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the saved message names one file, or counts several", () => {
    expect(savedWithRemovals("Event saved", [])).toBe("Event saved");
    expect(savedWithRemovals("Event saved", [{ documentId: "a", name: "a.txt" }])).toBe("Event saved. Removed “a.txt”.");
    expect(savedWithRemovals("Event saved", [{ documentId: "a", name: "a.txt" }, { documentId: "b", name: "b.txt" }])).toBe("Event saved. Removed 2 files.");
  });
});

describe("Undo after Save", () => {
  const removals: SheetRemoval[] = [{ documentId: "a", name: "a.txt" }, { documentId: "b", name: "b.txt" }, { documentId: "c", name: "c.txt" }];

  test("re-links every file through the relink route, in order", async () => {
    const calls: string[] = [];
    const result = await undoSheetRemovals("e1", removals, async (kind, hostId, documentId) => { calls.push(`${kind}/${hostId}/${documentId}`); return { relinked: true, restored: false }; });
    expect(calls).toEqual(["event/e1/a", "event/e1/b", "event/e1/c"]);
    expect(result).toEqual({ restored: 3, total: 3, refusals: [] });
    expect(sheetUndoMessage(result)).toEqual({ kind: "success", message: "Put back 3 files" });
  });

  test("some refused: Restored N of M, with why", async () => {
    const result = await undoSheetRemovals("e1", removals, async (_kind, _hostId, documentId) => {
      if (documentId === "b") throw new Error("This file is in its owner's Bin. Only they can restore it.");
      return { relinked: true, restored: false };
    });
    expect(result.restored).toBe(2);
    const message = sheetUndoMessage(result);
    expect(message.kind).toBe("warning");
    expect(message.message).toBe("Restored 2 of 3 files. b.txt: This file is in its owner's Bin. Only they can restore it.");
    const none = await undoSheetRemovals("e1", removals.slice(0, 2), async () => { throw new Error("Not found"); });
    expect(sheetUndoMessage(none)).toEqual({ kind: "error", message: "Restored 0 of 2 files. a.txt: Not found; b.txt: Not found" });
  });

  test("one file refused: the refusal itself", async () => {
    const result = await undoSheetRemovals("e1", removals.slice(0, 1), async () => { throw new Error("Attach spec.txt again from Files"); });
    expect(sheetUndoMessage(result)).toEqual({ kind: "error", message: "Attach spec.txt again from Files" });
    const ok = await undoSheetRemovals("e1", removals.slice(0, 1), async () => ({ relinked: true, restored: true }));
    expect(sheetUndoMessage(ok)).toEqual({ kind: "success", message: "File put back" });
  });

  test("one success toast with Undo; Undo puts them back, reports, then refreshes", async () => {
    const { calls, sink: fake } = sink();
    const relinked: string[] = [];
    let refreshed = 0;
    notifySheetSaved("Event saved. Removed 2 files.", { warning: false, eventId: "e1", removals: removals.slice(0, 2), onUndone: () => { refreshed += 1; },
      relink: async (_kind, _hostId, documentId) => { relinked.push(documentId); return { relinked: true, restored: false }; } }, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "success", message: "Event saved. Removed 2 files." });
    expect(calls[0]!.options?.action?.label).toBe("Undo");
    calls[0]!.options!.action!.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relinked).toEqual(["a", "b"]);
    expect(calls.at(-1)).toMatchObject({ kind: "success", message: "Put back 2 files" });
    expect(refreshed).toBe(1);
  });

  test("no removals: a plain toast; a partial Save is a warning that still carries Undo", () => {
    const { calls, sink: fake } = sink();
    notifySheetSaved("Event saved", { warning: false, eventId: "e1", removals: [], onUndone: () => undefined }, fake);
    expect(calls).toEqual([{ kind: "success", message: "Event saved", options: undefined }]);
    notifySheetSaved("Event saved, but x.pdf: too big", { warning: true, eventId: "e1", removals: removals.slice(0, 1), onUndone: () => undefined }, fake);
    expect(calls[1]).toMatchObject({ kind: "warning" });
    expect(calls[1]!.options?.action?.label).toBe("Undo");
  });

  test("CalendarApp's edit Save uses it", () => {
    const app = source("calendar/CalendarApp.tsx");
    expect(app).toContain("applySheetAttachmentChanges(eventId, sheet.attachments)");
    expect(app).toContain("notifySheetSaved(");
  });
});
