import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { api, auditRows, call, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";

const { resetMcpLimits, consumeMcpLimits } = await import("../server/mcpRateLimit");
const { resetSeenDrafts } = await import("../server/mcpSeenDrafts");

beforeEach(() => resetMcpLimits());

async function publishedNote(session: Session, markdown: string, folderId: string | null = null) {
  const { note } = (await api(session, "POST", "/notes", { folderId })).body as { note: { id: string } };
  expect((await api(session, "PUT", `/notes/${note.id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  expect((await api(session, "POST", `/notes/${note.id}/publish`, {})).status).toBe(200);
  return note.id;
}

const noteRow = (id: string) => db.query("SELECT current_version, draft_revision, draft_mcp_key_id, deleted_at, purge_after FROM notes WHERE id = ?").get(id) as
  { current_version: number; draft_revision: number | null; draft_mcp_key_id: string | null; deleted_at: string | null; purge_after: string | null } | null;

describe("publish_note_draft (D173)", () => {
  test("is listed only for notes:publish, which also reads drafts but cannot write them", async () => {
    const owner = await createUser("Publish scopes");
    const drafter = makeKey(owner, ["notes:write-draft"]);
    expect(await toolNames(drafter)).not.toContain("publish_note_draft");
    const publisher = makeKey(owner, ["notes:publish"]);
    const names = await toolNames(publisher);
    expect(names).toContain("publish_note_draft");
    expect(names).toContain("get_note_draft");
    expect(names).not.toContain("update_note_draft");
    expect(names).not.toContain("create_note");
    const noteId = await publishedNote(owner, "# Scoped\n\nv1");
    expect(await errorCode(drafter, "publish_note_draft", { noteId, revision: 1 })).toBe("SCOPE_REQUIRED");
  });

  test("needs a revision this key was shown: unseen, guessed, and after a restart are DRAFT_NOT_SEEN", async () => {
    const owner = await createUser("Publish unseen");
    const key = makeKey(owner, ["notes:write-draft", "notes:publish"]);
    const noteId = await publishedNote(owner, "# Plan\n\nv1");
    // A person's draft this key never read.
    expect((await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Plan\n\nhuman v2", revision: null })).status).toBe(200);
    expect(await errorCode(key, "publish_note_draft", { noteId, revision: 1 })).toBe("DRAFT_NOT_SEEN");
    expect(await errorCode(key, "publish_note_draft", { noteId, revision: 2 })).toBe("DRAFT_NOT_SEEN");
    // Reading it records revision 1; a guessed other revision is still unseen.
    expect((await ok(key, "get_note_draft", { noteId })).revision).toBe(1);
    expect(await errorCode(key, "publish_note_draft", { noteId, revision: 2 })).toBe("DRAFT_NOT_SEEN");
    // Another key of the same user did not see it.
    const other = makeKey(owner, ["notes:publish"]);
    expect(await errorCode(other, "publish_note_draft", { noteId, revision: 1 })).toBe("DRAFT_NOT_SEEN");
    // A restart forgets what every key saw.
    resetSeenDrafts();
    expect(await errorCode(key, "publish_note_draft", { noteId, revision: 1 })).toBe("DRAFT_NOT_SEEN");
    expect(noteRow(noteId)!.current_version).toBe(1);
  });

  test("a person's edit after the read is DRAFT_CHANGED and publishes nothing", async () => {
    const owner = await createUser("Publish race");
    const key = makeKey(owner, ["notes:write-draft", "notes:publish"]);
    const noteId = await publishedNote(owner, "# Race\n\nv1");
    const updated = await ok(key, "update_note_draft", { noteId, markdown: "# Race\n\nagent v2", baseRevision: null });
    expect((await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Race\n\nhuman v3", revision: updated.revision })).status).toBe(200);
    const changed = await call(key, "publish_note_draft", { noteId, revision: updated.revision });
    expect(changed.value).toMatchObject({ code: "DRAFT_CHANGED", currentRevision: updated.revision + 1 });
    expect(noteRow(noteId)!.current_version).toBe(1);
  });

  test("publishes what the key wrote: a version, the badge cleared, the index updated, and an audit row with the key", async () => {
    const owner = await createUser("Publish happy");
    const key = makeKey(owner, ["notes:write-draft", "notes:publish"], "Writer bot");
    const created = await ok(key, "create_note", { markdown: "# Zebrafinch report\n\nThe zebrafinch sings." });
    expect(noteRow(created.noteId)!.draft_mcp_key_id).toBe(key.id);
    const published = await ok(key, "publish_note_draft", { noteId: created.noteId, revision: created.revision });
    expect(published).toMatchObject({ noteId: created.noteId, version: 1, audience: "private" });
    expect(typeof published.publishedAt).toBe("string");
    expect(published.url).toContain(`/notes/${created.noteId}`);
    expect(noteRow(created.noteId)).toMatchObject({ current_version: 1, draft_revision: null, draft_mcp_key_id: null });
    const search = await api(owner, "GET", `/search?q=zebrafinch`);
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).toContain(created.noteId);
    expect(auditRows(owner.userId, "note.publish").find((row) => row.noteId === created.noteId)).toMatchObject({ version: 1, via: "mcp", keyId: key.id });
    // The ledger entry is used up: a second publish needs a fresh read (and there is no draft).
    expect(await errorCode(key, "publish_note_draft", { noteId: created.noteId, revision: created.revision })).toBe("NO_DRAFT");
    // A draft identical to the published text is NO_CHANGES.
    const same = await ok(key, "update_note_draft", { noteId: created.noteId, markdown: "# Zebrafinch report\n\nThe zebrafinch sings.", baseRevision: null });
    expect(await errorCode(key, "publish_note_draft", { noteId: created.noteId, revision: same.revision })).toBe("NO_CHANGES");
  });

  test("reports a shared audience, and a note shared with the key's user or in the Bin is NOT_FOUND", async () => {
    const owner = await createUser("Publish audience");
    const reader = await createUser("Publish reader");
    const ownerKey = makeKey(owner, ["notes:write-draft", "notes:publish"]);
    const noteId = await publishedNote(owner, "# Shared\n\nv1");
    expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    const draft = await ok(ownerKey, "update_note_draft", { noteId, markdown: "# Shared\n\nv2", baseRevision: null });
    expect((await ok(ownerKey, "publish_note_draft", { noteId, revision: draft.revision })).audience).toBe("shared");
    // The reader's own key cannot publish (or even read the draft of) a note they do not own.
    const readerKey = makeKey(reader, ["notes:publish"]);
    expect(await errorCode(readerKey, "get_note_draft", { noteId })).toBe("NOT_FOUND");
    expect(await errorCode(readerKey, "publish_note_draft", { noteId, revision: 1 })).toBe("NOT_FOUND");
    // Binned: NOT_FOUND.
    const next = await ok(ownerKey, "update_note_draft", { noteId, markdown: "# Shared\n\nv3", baseRevision: null });
    expect((await api(owner, "DELETE", `/notes/${noteId}`)).status).toBe(200);
    expect(await errorCode(ownerKey, "publish_note_draft", { noteId, revision: next.revision })).toBe("NOT_FOUND");
  });

  test("the HTTP publish route is unchanged", async () => {
    const owner = await createUser("Publish http");
    const noteId = await publishedNote(owner, "# Web\n\nv1");
    expect((await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Web\n\nv2", revision: null })).status).toBe(200);
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: 5 })).body).toMatchObject({ code: "DRAFT_CHANGED", currentRevision: 1 });
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: 1 })).body).toMatchObject({ version: 2 });
  });
});

describe("create_folder", () => {
  test("creates a private folder for notes:write-draft or files:write, with NAME_TAKEN and owned parents only", async () => {
    const owner = await createUser("Folder owner");
    const other = await createUser("Folder other");
    const notesKey = makeKey(owner, ["notes:write-draft"]);
    const filesKey = makeKey(owner, ["files:write"]);
    expect(await toolNames(notesKey)).toContain("create_folder");
    expect(await toolNames(filesKey)).toContain("create_folder");
    expect(await toolNames(makeKey(owner, ["notes:read", "files:read"]))).not.toContain("create_folder");
    const parent = (await ok(notesKey, "create_folder", { name: "Projects" })).folder;
    // A shared parent never shares the child (no cascade, D3).
    // (Shared with one person: an all_users folder would show up in every other test's folder list.)
    expect((await api(owner, "PUT", `/folders/${parent.id}/sharing`, { visibility: "selected", userIds: [other.userId] })).status).toBe(200);
    const child = (await ok(filesKey, "create_folder", { name: "  Drafts  ", parentId: parent.id })).folder;
    expect(child).toMatchObject({ name: "Drafts", parent_id: parent.id });
    expect((db.query("SELECT visibility FROM folders WHERE id = ?").get(child.id) as { visibility: string }).visibility).toBe("private");
    expect(await errorCode(notesKey, "create_folder", { name: "default" })).toBe("NAME_TAKEN");
    const foreign = (await api(other, "POST", "/folders", { name: "Theirs" })).body.folder as { id: string };
    expect(await errorCode(notesKey, "create_folder", { name: "Sneaky", parentId: foreign.id })).toBe("NOT_FOUND");
    expect(auditRows(owner.userId, "folder.create").find((row) => row.folderId === child.id)).toMatchObject({ via: "mcp", keyId: filesKey.id, parentId: parent.id });
    // The HTTP route keeps its answers.
    expect((await api(owner, "POST", "/folders", { name: "Default" })).status).toBe(409);
  });
});

describe("bin_note and restore_note (D174)", () => {
  test("need bin:write and notes:write-draft together; bin:write alone lists no Bin tools", async () => {
    const owner = await createUser("Bin scopes");
    const binOnly = makeKey(owner, ["bin:write"]);
    const names = await toolNames(binOnly);
    expect(names.filter((name) => name.startsWith("bin_") || name.startsWith("restore_"))).toEqual([]);
    const drafter = makeKey(owner, ["notes:write-draft"]);
    expect(await toolNames(drafter)).not.toContain("bin_note");
    const noteId = await publishedNote(owner, "# Keep\n\nv1");
    expect(await errorCode(drafter, "bin_note", { noteId })).toBe("SCOPE_REQUIRED");
    expect(await errorCode(binOnly, "bin_note", { noteId })).toBe("SCOPE_REQUIRED");
    const both = makeKey(owner, ["notes:write-draft", "bin:write"]);
    expect(await toolNames(both)).toEqual(expect.arrayContaining(["bin_note", "restore_note"]));
    // bin:write with tasks:write lists only card tools, never note ones.
    const cardsOnly = await toolNames(makeKey(owner, ["tasks:write", "bin:write"]));
    expect(cardsOnly).not.toContain("bin_note");
  });

  test("a blank never-published note goes to the Bin (not purged) and restores to its folder", async () => {
    const owner = await createUser("Bin blank");
    const key = makeKey(owner, ["notes:write-draft", "bin:write"]);
    const { note } = (await api(owner, "POST", "/notes", {})).body as { note: { id: string } };
    const binned = await ok(key, "bin_note", { noteId: note.id });
    expect(binned).toMatchObject({ noteId: note.id, binned: true });
    expect(noteRow(note.id)!.deleted_at).not.toBeNull();
    expect((await api(owner, "GET", "/bin")).body.items.some((item: { id: string }) => item.id === note.id)).toBe(true);
    expect(auditRows(owner.userId, "note.delete").find((row) => row.noteId === note.id)).toMatchObject({ via: "mcp", keyId: key.id });
    expect(await errorCode(key, "bin_note", { noteId: note.id })).toBe("NOT_FOUND");
    const restored = await ok(key, "restore_note", { noteId: note.id });
    expect(restored).toMatchObject({ noteId: note.id, restored: true });
    expect(noteRow(note.id)!.deleted_at).toBeNull();
    expect((await ok(key, "restore_note", { noteId: note.id })).alreadyRestored).toBe(true);
  });

  test("only the owner's notes: another user's note, shared or not, is NOT_FOUND to bin and restore", async () => {
    const owner = await createUser("Bin note owner");
    const reader = await createUser("Bin note reader");
    const noteId = await publishedNote(owner, "# Theirs\n\nv1");
    expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    const readerKey = makeKey(reader, ["notes:write-draft", "bin:write"]);
    expect(await errorCode(readerKey, "bin_note", { noteId })).toBe("NOT_FOUND");
    expect((await api(owner, "DELETE", `/notes/${noteId}`)).status).toBe(200);
    expect(await errorCode(readerKey, "restore_note", { noteId })).toBe("NOT_FOUND");
  });

  test("the 11th bin in a minute and the 51st in a day are RATE_LIMITED, while restores still work", async () => {
    const owner = await createUser("Bin caps");
    const key = makeKey(owner, ["notes:write-draft", "bin:write"]);
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) ids.push(await publishedNote(owner, `# Item ${index}\n\ntext`));
    for (const id of ids.slice(0, 10)) await ok(key, "bin_note", { noteId: id });
    const limited = await call(key, "bin_note", { noteId: ids[10] });
    expect(limited.value.code).toBe("RATE_LIMITED");
    expect(limited.value.retryAfterSeconds).toBeGreaterThan(0);
    expect(noteRow(ids[10]!)!.deleted_at).toBeNull();
    for (const id of ids.slice(0, 10)) await ok(key, "restore_note", { noteId: id });

    // Daily cap: 50 per key (pre-charged here; the minute window is separate).
    const daily = makeKey(owner, ["notes:write-draft", "bin:write"]);
    for (let index = 0; index < 50; index += 1) expect(consumeMcpLimits({ keyId: daily.id }, ["bin_action"])).toBe(0);
    expect((await call(daily, "bin_note", { noteId: ids[10] })).value.code).toBe("RATE_LIMITED");
    expect(noteRow(ids[10]!)!.deleted_at).toBeNull();
  });
});

describe("the HTTP delete still purges blank notes (D12)", () => {
  test("DELETE /api/notes/:id on a blank note purges it", async () => {
    const owner = await createUser("Bin http blank");
    const { note } = (await api(owner, "POST", "/notes", {})).body as { note: { id: string } };
    expect((await request(`/notes/${note.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(noteRow(note.id)).toBeNull();
  });
});
