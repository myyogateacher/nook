import { describe, expect, test } from "bun:test";
import { audienceText, confirmLaterMessage, confirmRequiredOf, fileNames, publishFilesConfirm } from "../src/publishFilesConfirm";
import { bulkSummary } from "../src/inbox/inboxFormat";

/**
 * v0.35.0 review M1, the client side: a publish (or an approval) answered 409 CONFIRM_REQUIRED asks
 * with the app's own confirm (useConfirm: a history layer, so Back is Cancel; never the browser's
 * confirm, D91), then publishes again with the confirmed ids. Leaving a note never asks. The browser
 * proof (Back closes it at 1280 and 390 px) is in the live QA.
 */

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
const A = { id: "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", name: "salaries.txt" };
const B = { id: "6f1d2c3b-4a59-4e8f-8a7b-1c2d3e4f5a6b", name: "plan.pdf" };

describe("the confirm's words", () => {
  test("reads the 409 body, and nothing else", () => {
    const body = { code: "CONFIRM_REQUIRED", files: [A], audience: { visibility: "selected", people: 2, groups: 1 } };
    expect(confirmRequiredOf(409, body)).toEqual({ files: [A], audience: { visibility: "selected", people: 2, groups: 1 } });
    expect(confirmRequiredOf(409, { code: "DRAFT_CHANGED" })).toBeNull();
    expect(confirmRequiredOf(400, body)).toBeNull();
    expect(confirmRequiredOf(409, { code: "CONFIRM_REQUIRED", files: [] })).toBeNull();
    expect(confirmRequiredOf(409, { code: "CONFIRM_REQUIRED", files: [A] })!.audience.visibility).toBe("private");
  });

  test("names the files and who will be able to open them", () => {
    expect(fileNames([A])).toBe("“salaries.txt”");
    expect(fileNames([A, B])).toBe("“salaries.txt” and “plan.pdf”");
    expect(fileNames([A, B, A, B])).toBe("“salaries.txt”, “plan.pdf” and 2 more files");
    expect(audienceText({ visibility: "selected", people: 1, groups: 0 })).toBe("The 1 person this note is shared with will be able to open");
    expect(audienceText({ visibility: "selected", people: 3, groups: 2 })).toBe("The 3 people and 2 groups this note is shared with will be able to open");
    expect(audienceText({ visibility: "all_users", people: 0, groups: 0 })).toContain("Everyone signed in");
    expect(audienceText({ visibility: "private", people: 0, groups: 0 })).toContain("anyone you share it with later");
    const request = publishFilesConfirm({ files: [A], audience: { visibility: "selected", people: 2, groups: 0 } });
    expect(request).toEqual({ title: "Share a file from Files with this note?", message: "The 2 people this note is shared with will be able to open “salaries.txt”. It stays in its folder in Files.", confirmLabel: "Share and publish" });
    expect(publishFilesConfirm({ files: [A, B], audience: { visibility: "private", people: 0, groups: 0 } }, "approve")).toMatchObject({ title: "Share 2 files from Files with this note?", confirmLabel: "Share and approve" });
    expect(confirmLaterMessage({ files: [A], audience: { visibility: "private", people: 0, groups: 0 } })).toContain("Not published yet");
  });

  test("a bulk approval that left some pending says so, not that they failed", () => {
    expect(bulkSummary([{ id: "a", status: "applied" }, { id: "b", status: "pending", code: "CONFIRM_REQUIRED" }])).toBe("1 applied · 1 left pending: it shares files from your Files, so approve it on its own");
  });
});

describe("the wiring", () => {
  test("Publish asks through the app's confirm and publishes again with the ids; leaving a note never asks", async () => {
    const app = await read("App.tsx");
    expect(app).toContain("if (!await appConfirm.ask(publishFilesConfirm(required))) return false;");
    expect(app).toContain("confirmAttachments: [...confirmedFiles]");
    expect(app).toContain("notify.warning(confirmLaterMessage(required));");
    // Only the buttons are interactive; finalizeCurrentNote calls publish(reloadCurrent).
    expect(app.match(/void publish\(true, true\)/g)?.length).toBe(2);
    expect(app).toContain("publish: () => publish(reloadCurrent)");
    // Files confirmed in the From Files picker are sent up front (not asked twice).
    expect(app).toContain("onFileConfirmed={(documentId) =>");
    const editor = await read("editor/NoteEditor.tsx");
    expect(editor.match(/options\.confirmed\) latest\.current\.onFileConfirmed\?\.\(document\.id\)/g)?.length).toBe(2);
    expect(app + editor).not.toContain("window.confirm");
  });

  test("approving an agent's note draft asks the same way", async () => {
    const inbox = await read("inbox/InboxApp.tsx");
    expect(inbox).toContain("const { ask, confirmElement } = useConfirm();");
    expect(inbox).toContain('if (!await ask(publishFilesConfirm(required, "approve"))) return;');
    expect(inbox).toContain("result = await approveProposal(proposal.id, required.files.map((file) => file.id));");
    expect(inbox).toContain("{confirmElement}");
    // The confirm is a history layer: Back (or Forward) is Cancel.
    expect(await read("ui/useConfirm.tsx")).toContain("useHistoryDialogGuard(true, cancel);");
  });
});
