import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CardDialog } from "../src/tasks/CardDialog";
import { attachTarget, attachZoneOf, uploadFailure } from "../src/tasks/cardUploads";
import { LocationStripError } from "../src/ui/attachments";
import { RoleContext } from "../src/team/roleAccess";
import { createBody, emptyDraft } from "../src/tasks/composerDraft";
import { attachCapReason, commentBodyError, commentFilesOnly, fitToCap, hostAttachment, unlinkConfirmMessage } from "../src/tasks/taskActions";
import type { BoardColumn, CardAttachment, CardDetail, CardView } from "../src/tasks/tasksApi";

/**
 * Uploads everywhere U2, the Tasks client: the attach sheet replaces the hidden file inputs, paste and
 * drop route to the card or the comment, files-only comments show their files alone, "File removed",
 * and the history layers (Back closes the sheet and the preview before the card).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const stamp = "2026-10-09T00:00:00Z";
const attachment = (id: string, commentId: string | null, name: string, extra: Partial<CardAttachment> = {}): CardAttachment => ({
  document_id: id, card_id: "k1", comment_id: commentId, linked_by: "u1", linker_name: "Ann", name, mime_type: "image/png", preview_kind: "image", size_bytes: 2048, created_at: stamp, removed: 0, ...extra
});

describe("helpers", () => {
  test("a comment needs text or files, and files-only reads from the generated body", () => {
    expect(commentBodyError("  ")).not.toBeNull();
    expect(commentBodyError("  ", 1)).toBeNull();
    expect(commentBodyError("é".repeat(8193), 1)).not.toBeNull();
    const files = [attachment("d1", "m1", "shot.png")];
    expect(commentFilesOnly("📎 shot.png", files)).toBe(true);
    expect(commentFilesOnly("📎 2 files", [...files, attachment("d2", "m1", "", { removed: 1 })])).toBe(true);
    expect(commentFilesOnly("📎 shot.png", [])).toBe(false);
    expect(commentFilesOnly("Looks fine", files)).toBe(false);
  });

  test("caps: the sheet says why it is disabled, and extra files are reported, not uploaded", () => {
    expect(attachCapReason(9, 10, "comment")).toBeNull();
    expect(attachCapReason(10, 10, "comment")).toContain("10 files");
    expect(fitToCap(["a", "b", "c"], 48, 50, "card")).toEqual({ kept: ["a", "b"], notice: "1 file was not added: a card holds up to 50 files." });
    expect(fitToCap(["a"], 0, 10, "comment")).toEqual({ kept: ["a"], notice: null });
  });

  test("card attachments map to the kit's shape, removed ones without a name", () => {
    expect(hostAttachment(attachment("d1", null, "shot.png"), "u1")).toMatchObject({ documentId: "d1", removed: false, name: "shot.png", previewKind: "image", isOwner: true });
    expect(hostAttachment(attachment("d2", "m1", "", { removed: 1 }), "u1")).toEqual({ documentId: "d2", removed: true, partId: "m1", position: 0, linkedAt: stamp });
    expect(unlinkConfirmMessage(null, true)).toContain("this removed file");
    expect(unlinkConfirmMessage("a.png", true)).toContain("Files folders stays");
  });

  test("paste and drop go to the comment box, the comment being edited, or the card; never into the description", () => {
    const at = (zone: string | null) => ({ closest: () => zone === null ? null : { getAttribute: () => zone } });
    expect(attachZoneOf(at("comment"))).toBe("comment");
    expect(attachZoneOf(at("edit"))).toBe("edit");
    expect(attachZoneOf(at("editor"))).toBe("editor");
    expect(attachZoneOf(at(null))).toBe("card");
    expect(attachZoneOf({ parentElement: at("comment") })).toBe("comment");
    expect(attachZoneOf(null)).toBe("card");
    const editor = { readOnly: false, commentReadOnly: false };
    expect(attachTarget("card", editor)).toBe("card");
    expect(attachTarget("comment", editor)).toBe("comment");
    expect(attachTarget("editor", editor)).toBeNull();
    // A commenter stages files for comments but cannot attach to the card; a viewer does neither.
    expect(attachTarget("card", { readOnly: true, commentReadOnly: false })).toBeNull();
    expect(attachTarget("comment", { readOnly: true, commentReadOnly: false })).toBe("comment");
    expect(attachTarget("edit", { readOnly: true, commentReadOnly: true })).toBeNull();
  });

  test("the new-card form sends the From Files confirm with the ids", () => {
    const draft = { ...emptyDraft("c1"), attachments: [{ id: "d1", name: "a.png", mime_type: "image/png", preview_kind: "image", size_bytes: 1 }] };
    expect(createBody(draft, "Title").attachmentsConfirmed).toBeUndefined();
    const picked = { ...draft, attachments: [...draft.attachments, { id: "d2", name: "spec.pdf", mime_type: "application/pdf", preview_kind: "pdf", size_bytes: 1, fromFiles: true, confirmed: true }] };
    expect(createBody(picked, "Title")).toMatchObject({ attachmentIds: ["d1", "d2"], attachmentsConfirmed: true });
  });
});

describe("the card dialog", () => {
  const columns: BoardColumn[] = [{ id: "c1", board_id: "b1", name: "To do", position: 1024, is_done: 0, created_at: stamp, updated_at: stamp }];
  const card = {
    id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Bug", has_description: 0, revision: 1, created_by: "u1", creator_name: "Ann",
    due_on: null, comment_count: 2, attachment_count: 3, created_at: stamp, updated_at: stamp, description: "", assignees: [], tag_ids: [], flags: []
  } as unknown as CardDetail;
  const view: CardView = {
    card,
    comments: [
      { id: "m1", card_id: "k1", author_id: "u1", author_name: "Ann", is_author: 1, body: "📎 screen.png", created_at: stamp, edited_at: null },
      { id: "m2", card_id: "k1", author_id: "u1", author_name: "Ann", is_author: 1, body: "Steps to repeat", created_at: stamp, edited_at: null }
    ],
    hasMoreComments: false,
    attachments: [attachment("d1", "m1", "screen.png"), attachment("d2", null, "spec.pdf", { mime_type: "application/pdf", preview_kind: "pdf" }), attachment("d3", null, "", { removed: 1 })]
  };
  const markup = renderToStaticMarkup(<CardDialog userId="u1" cardId="k1" columns={columns} boardOwner boardLevel="edit"
    onClose={() => undefined} onMissing={() => undefined} onChanged={() => undefined} onMove={() => undefined} onDelete={async () => undefined} notify={() => undefined} initialView={view} />);

  test("Attach opens the shared sheet instead of a hidden file input", () => {
    expect(markup).not.toContain('type="file"');
    expect(markup).toContain('aria-haspopup="dialog"><svg');
    expect((markup.match(/>Attach</g) ?? []).length).toBe(2);
  });

  test("a files-only comment shows its file and no generated text; a text comment keeps its text", () => {
    expect(markup).not.toContain("📎 screen.png");
    expect(markup).toContain('aria-label="Files in this comment"');
    expect(markup).toContain("Steps to repeat");
    expect(markup).toContain('aria-label="Open screen.png"');
  });

  test("the card lists its files with thumbnails or icons, and a binned file as File removed", () => {
    expect(markup).toContain('aria-label="Files on this card"');
    expect(markup).toContain('aria-label="Download spec.pdf"');
    expect(markup).toContain("File removed");
    expect(markup).toContain('src="/api/files/d1/content?disposition=inline"');
    // Drop zones: the comment box stages for the comment, the description keeps its own drops.
    expect(markup).toContain('data-attach-zone="comment"');
  });

  test("without edit rights only the file's owner sees Remove, and it goes through the generic route (U0 review M1)", () => {
    const readOnly = renderToStaticMarkup(<RoleContext.Provider value="viewer"><CardDialog userId="u1" cardId="k1" columns={columns} boardOwner={false} boardLevel="view"
      onClose={() => undefined} onMissing={() => undefined} onChanged={() => undefined} onMove={() => undefined} onDelete={async () => undefined} notify={() => undefined}
      initialView={{ ...view, attachments: [attachment("d1", null, "mine.png"), attachment("d2", null, "theirs.pdf", { linked_by: "u2" })] }} /></RoleContext.Provider>);
    expect(readOnly).toContain('aria-label="Remove mine.png"');
    expect(readOnly).not.toContain('aria-label="Remove theirs.pdf"');
    expect(readOnly).not.toContain(">Attach<");
    expect(source("tasks/CardDialog.tsx")).toContain('unlinkFromHost("card", cardId, attachment.document_id)');
  });

  test("a picture whose location could not be removed is refused with a plain message", () => {
    expect(uploadFailure({ name: "IMG_1.jpg" }, new LocationStripError("IMG_1.jpg"))).toContain("could not remove the photo's location");
    expect(uploadFailure({ name: "a.txt" }, new Error("Quota exceeded"))).toBe("a.txt: Quota exceeded");
  });

  test("history layers: the sheet and the preview are guarded, and the card's Escape waits for them (D18, D21)", () => {
    const dialog = source("tasks/CardDialog.tsx");
    expect(dialog).toContain("<AttachSheet");
    expect(dialog).toContain("<AttachmentPreview");
    expect(dialog).toContain("subDialogOpen || editingComment || sheet || preview");
    expect(dialog).not.toContain('target="_blank"');
    for (const kit of ["ui/attachments/AttachSheet.tsx", "ui/attachments/AttachmentPreview.tsx"]) expect(source(kit)).toContain("useHistoryDialogGuard(true, onClose");
    const composer = source("tasks/CardComposer.tsx");
    expect(composer).toContain("<AttachSheet");
    expect(composer).not.toContain('type="file"');
  });
});
