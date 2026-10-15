import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, type Session } from "./support/harness";
import { insertNote } from "./support/collections";
import { attachmentsFolderOf, calendarWithEvent, documentRow, link, upload, uploadAttachment } from "./support/attachments";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { syncDerivedLinks } = await import("../server/attachments/service");
const { PDF_TEXT_LIMITS } = await import("../server/pdfText");
const { makePdf } = await import("./support/pdf");
type Grant = import("../server/keyGrants").Grant;

/**
 * Uploads everywhere U0 (D402, D403, T345): list_attachments and read_attachment_text are gated by
 * the HOST module's read scope and the key's grant on the host, never by files:read; REST runs the
 * same tools. `purpose: "attachment"` stores into the Attachments folder; no MCP path writes into a
 * system folder by id.
 */

beforeEach(() => resetMcpLimits());

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });
const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Attachments agent", surfaces: "both", grants, expiresInDays: 30 });

async function call(keyId: string, name: string, args: Record<string, unknown> = {}) {
  const result = await invokeMcpToolForTests(name, args, keyId);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
const visible = (keyId: string) => mcpToolSpecs.filter((spec) => toolVisible(spec, loadLiveKey(keyId)!)).map((spec) => spec.name);

describe("attachment tools over MCP and REST", () => {
  test("the host module's scope and the key's grant on the host decide; files:read alone reaches nothing", async () => {
    const owner = await createUser("MCP attach owner");
    const first = await calendarWithEvent(owner, "First");
    const second = await calendarWithEvent(owner, "Second");
    const text = await uploadAttachment(owner, "minutes.md", "# Minutes\nShip U0.");
    const binary = await uploadAttachment(owner, "photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    for (const documentId of [text, binary]) expect((await link(owner, "event", first.eventId, { documentId })).status).toBe(201);
    expect((await link(owner, "event", second.eventId, { documentId: text })).status).toBe(201);

    const calendarKey = key(owner, [all("calendar", "read")]);
    const listed = await call(calendarKey.id, "list_attachments", { hostKind: "event", hostId: first.eventId });
    expect(listed.isError).toBe(false);
    expect(listed.value.attachments.map((item: { name: string }) => item.name)).toEqual(["minutes.md", "photo.png"]);
    expect(listed.value.limit).toBe(20);
    const read = await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: first.eventId, documentId: text });
    expect(read.value).toMatchObject({ id: text, name: "minutes.md", text: "# Minutes\nShip U0." });
    expect((await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: first.eventId, documentId: binary })).value.code).toBe("NOT_TEXT");
    // A document not linked to that host is the same NOT_FOUND as a missing one.
    const unlinked = await uploadAttachment(owner, "other.txt");
    expect((await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: first.eventId, documentId: unlinked })).value.code).toBe("NOT_FOUND");

    // A key over the first calendar only: the second calendar's event is NOT_FOUND.
    const chosen = key(owner, [on("calendar", "read", "calendar", first.calendarId)]);
    expect((await call(chosen.id, "list_attachments", { hostKind: "event", hostId: first.eventId })).isError).toBe(false);
    expect((await call(chosen.id, "list_attachments", { hostKind: "event", hostId: second.eventId })).value.code).toBe("NOT_FOUND");
    expect((await call(chosen.id, "read_attachment_text", { hostKind: "event", hostId: second.eventId, documentId: text })).value.code).toBe("NOT_FOUND");

    // Another module's scope does not reach events; files:read alone is not offered the tools at all.
    const tasksKey = key(owner, [all("tasks", "read")]);
    expect((await call(tasksKey.id, "list_attachments", { hostKind: "event", hostId: first.eventId })).value.code).toBe("NOT_FOUND");
    const filesKey = key(owner, [all("files", "read")]);
    expect(visible(filesKey.id)).not.toContain("list_attachments");
    expect((await call(filesKey.id, "list_attachments", { hostKind: "event", hostId: first.eventId })).value.code).toBe("SCOPE_REQUIRED");
    // The file itself is still the owner's to read through Files tools (it is an ordinary Files document).
    expect((await call(filesKey.id, "read_document_text", { documentId: text })).value.text).toBe("# Minutes\nShip U0.");

    // A stranger's key reads nothing of this event, whatever its scopes.
    const stranger = await createUser("MCP attach stranger");
    const strangerKey = key(stranger, [all("calendar", "read")]);
    expect((await call(strangerKey.id, "list_attachments", { hostKind: "event", hostId: first.eventId })).value.code).toBe("NOT_FOUND");

    // REST runs the same tool definitions (D403).
    const response = await fetch(`${origin}/api/v1/tools/list_attachments`, { method: "POST", headers: { Authorization: `Bearer ${calendarKey.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ hostKind: "event", hostId: first.eventId }) });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("minutes.md");
  });

  test("an attached PDF's text layer is read through the PDF worker; a scan, a broken PDF, and the time cap are clear NOT_TEXT / TOO_LARGE errors (D510)", async () => {
    const owner = await createUser("MCP attach pdf");
    const { eventId } = await calendarWithEvent(owner, "PDF event");
    const paper = await uploadAttachment(owner, "agenda.pdf", makePdf(["Agenda numbat", "Second page"]));
    const scan = await uploadAttachment(owner, "scan.pdf", makePdf([""]));
    const broken = await uploadAttachment(owner, "broken.pdf", "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    for (const documentId of [paper, scan, broken]) expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);
    const calendarKey = key(owner, [all("calendar", "read")]);
    const read = await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: eventId, documentId: paper });
    expect(read.value).toEqual(expect.objectContaining({ id: paper, name: "agenda.pdf", hostKind: "event", text: "Agenda numbat\n\nSecond page", pdf: { pages: 2, pagesRead: 2, truncated: false } }));
    expect((await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: eventId, documentId: scan })).value).toMatchObject({ code: "NOT_TEXT", error: expect.stringContaining("no text layer (scanned?)") });
    expect((await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: eventId, documentId: broken })).value).toMatchObject({ code: "NOT_TEXT" });
    // read_document_text answers the scan the same way (no empty text).
    const filesKey = key(owner, [all("files", "read")]);
    expect((await call(filesKey.id, "read_document_text", { documentId: scan })).value).toMatchObject({ code: "NOT_TEXT", error: expect.stringContaining("no text layer (scanned?)") });
    const saved = PDF_TEXT_LIMITS.timeoutMs;
    PDF_TEXT_LIMITS.timeoutMs = 1;
    try {
      expect((await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: eventId, documentId: paper })).value).toMatchObject({ code: "TOO_LARGE", error: expect.stringContaining("took too long") });
    } finally {
      PDF_TEXT_LIMITS.timeoutMs = saved;
    }
    expect((await call(calendarKey.id, "read_attachment_text", { hostKind: "event", hostId: eventId, documentId: paper })).value.text).toBe("Agenda numbat\n\nSecond page");
  });

  test("notes need notes:read; chats need a whole-module agents:read; a key over chosen knowledge bases is not offered the tools", async () => {
    const owner = await createUser("MCP attach notes");
    const noteId = insertNote(owner.userId, "Published");
    const image = await uploadAttachment(owner, "diagram.txt", "boxes and arrows", "note");
    syncDerivedLinks("note", noteId, owner.userId, [image]);
    const notesKey = key(owner, [all("notes", "read")]);
    expect((await call(notesKey.id, "read_attachment_text", { hostKind: "note", hostId: noteId, documentId: image })).value.text).toBe("boxes and arrows");
    const calendarKey = key(owner, [all("calendar", "read")]);
    expect((await call(calendarKey.id, "list_attachments", { hostKind: "note", hostId: noteId })).value.code).toBe("NOT_FOUND");

    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, active_leaf_id, created_at, updated_at) VALUES (?, ?, NULL, 'Chat', ?, ?, ?)").run(chatId, owner.userId, messageId, at, at);
    db.query("INSERT INTO chat_messages (id, chat_id, parent_id, role, content, author_id, created_at) VALUES (?, ?, NULL, 'user', 'see file', ?, ?)").run(messageId, chatId, owner.userId, at);
    const chatFile = await uploadAttachment(owner, "chat.txt", "from chat", "chat_message");
    expect((await link(owner, "chat_message", messageId, { documentId: chatFile })).status).toBe(201);
    const agentsKey = key(owner, [all("agents", "read")]);
    expect((await call(agentsKey.id, "read_attachment_text", { hostKind: "chat_message", hostId: messageId, documentId: chatFile })).value.text).toBe("from chat");
    const kbKey = key(owner, [on("agents", "read", "knowledge_base", crypto.randomUUID())]);
    expect(visible(kbKey.id)).not.toContain("list_attachments");
  });

  test("purpose attachment stores into the Attachments folder; no MCP write reaches a system folder by id", async () => {
    const owner = await createUser("MCP attach writer");
    const writer = key(owner, [all("files", "write"), all("notes", "draft")]);
    const created = await call(writer.id, "create_text_file", { name: "notes.md", text: "hello", purpose: "attachment" });
    expect(created.isError).toBe(false);
    const folderId = attachmentsFolderOf(owner.userId)!;
    expect(documentRow(created.value.document.id)).toMatchObject({ folder_id: folderId, purpose: "file" });
    expect((await call(writer.id, "create_text_file", { name: "x.md", text: "x", purpose: "attachment", folderId })).value.code).toBe("INVALID");
    expect((await call(writer.id, "create_text_file", { name: "x.md", text: "x", folderId })).value).toMatchObject({ code: "INVALID", reason: "SYSTEM_FOLDER" });
    expect((await call(writer.id, "begin_upload", { name: "x.bin", sizeBytes: 3, sha256: "0".repeat(64), folderId })).value).toMatchObject({ code: "INVALID", reason: "SYSTEM_FOLDER" });
    const begun = await call(writer.id, "begin_upload", { name: "x.bin", sizeBytes: 3, sha256: "0".repeat(64), purpose: "attachment" });
    expect(begun.isError).toBe(false);
    const ordinary = (await upload(owner, "plain.txt", "p")).id;
    expect((await call(writer.id, "move_file", { documentId: ordinary, folderId })).value.code).toBe("INVALID");
    expect((await call(writer.id, "create_note", { markdown: "# In attachments", folderId })).value).toMatchObject({ code: "INVALID", reason: "SYSTEM_FOLDER" });
    // The folder is listed to agents like any other, marked as a system folder.
    const folders = await call(key(owner, [all("notes", "read")]).id, "list_folders");
    expect(JSON.stringify(folders.value)).toContain("attachments");
  });
});
