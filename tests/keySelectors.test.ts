import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTodayRateLimit } = await import("../server/today/rateLimit");
const { resetKeyRouteLimits } = await import("../server/keyRoutes");
type Grant = import("../server/keyGrants").Grant;

/**
 * Chosen-item keys across modules (Wave 34, access plan D281, T203): notes by folder or note, files
 * by folder or file, saved task views, routines, and the cross-module paths (search, Today,
 * proposals). Lists are narrowed before their LIMIT; items outside the grant are NOT_FOUND.
 */

beforeEach(() => { resetMcpLimits(); resetTodayRateLimit(); resetKeyRouteLimits(); });

const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });
const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Scoped", surfaces: "both", grants, expiresInDays: 30 }).id;

async function call(keyId: string, name: string, args: Record<string, unknown> = {}) {
  const result = await invokeMcpToolForTests(name, args, keyId);
  const text = result.content[0]!.text;
  return { isError: result.isError === true, value: JSON.parse(text) as Record<string, any>, text };
}
async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/** A published note in a folder, through the owner's own all-notes key. */
async function publishedNote(writer: string, folderId: string, markdown: string) {
  const created = await call(writer, "create_note", { markdown, folderId });
  await call(writer, "get_note_draft", { noteId: created.value.noteId });
  const published = await call(writer, "publish_note_draft", { noteId: created.value.noteId, revision: created.value.revision });
  expect(published.isError).toBe(false);
  return created.value.noteId as string;
}

async function notesWorld(label: string) {
  const owner = await createUser(label);
  const f1 = (await api(owner, "POST", "/folders", { name: "Granted folder" })).body.folder.id as string;
  const f2 = (await api(owner, "POST", "/folders", { name: "Other folder" })).body.folder.id as string;
  const writer = key(owner, [all("notes", "draft"), all("notes", "publish"), all("files", "write")]);
  const n1 = await publishedNote(writer, f1, "# Granted pelican\n\nshared word zebra");
  const n2 = await publishedNote(writer, f2, "# Hidden heron\n\nshared word zebra");
  const n3 = await publishedNote(writer, f2, "# Single swan\n\nshared word zebra");
  const d1 = (await call(writer, "create_text_file", { name: "granted.md", text: "granted file", folderId: f1 })).value.document.id as string;
  const d2 = (await call(writer, "create_text_file", { name: "hidden-otter.md", text: "hidden file", folderId: f2 })).value.document.id as string;
  return { owner, f1, f2, n1, n2, n3, d1, d2 };
}

describe("chosen notes and files (Wave 34)", () => {
  test("a notes key over one folder and one note lists, searches, and reads only those, before paging", async () => {
    const w = await notesWorld("Selectors notes");
    const scoped = key(w.owner, [on("notes", "read", "folder", w.f1), on("notes", "read", "note", w.n3), all("today", "read")]);
    const listed = await call(scoped, "list_notes");
    expect(listed.value.notes.map((note: { id: string }) => note.id).sort()).toEqual([w.n1, w.n3].sort());
    const searched = await call(scoped, "search_notes", { query: "zebra", limit: 20 });
    expect(searched.value.results.map((hit: { id: string }) => hit.id).sort()).toEqual([w.n1, w.n3].sort());
    expect(searched.value.truncated).toBe(false);
    // A limit of 1 still pages inside the grant: `truncated` counts only granted notes.
    expect((await call(scoped, "search_notes", { query: "zebra", limit: 2 })).value.truncated).toBe(false);
    expect((await call(scoped, "list_folders")).value.folders.map((folder: { id: string }) => folder.id)).toEqual([w.f1]);
    expect((await call(scoped, "read_note", { noteId: w.n3 })).value.title).toBe("Single swan");
    const outside = await call(scoped, "read_note", { noteId: w.n2 });
    expect(outside.value.code).toBe("NOT_FOUND");
    expect(outside.text).not.toContain("heron");
    expect((await call(scoped, "search_notes", { query: "zebra", folderId: w.f2 })).value.code).toBe("NOT_FOUND");
    const today = await call(scoped, "get_today");
    expect(today.text).not.toContain("Hidden heron");
    expect(today.text).toContain("Granted pelican");
    for (const result of [listed, searched]) expect(result.text).not.toContain("Hidden heron");
  });

  test("the Access sheet's key count includes keys over the note's folder", async () => {
    const w = await notesWorld("Selectors access count");
    const before = (await api(w.owner, "GET", `/notes/${w.n1}/access`)).body.keysWithAccess as number;
    key(w.owner, [on("notes", "read", "folder", w.f1)]);
    expect((await api(w.owner, "GET", `/notes/${w.n1}/access`)).body.keysWithAccess).toBe(before + 1);
    expect((await api(w.owner, "GET", `/notes/${w.n2}/access`)).body.keysWithAccess).toBe(before);
  });

  test("a draft key over a folder creates only there and never in Default; writes need owned items", async () => {
    const w = await notesWorld("Selectors drafts");
    const scoped = key(w.owner, [on("notes", "draft", "folder", w.f1)]);
    const names = mcpToolSpecs.filter((spec) => toolVisible(spec, loadLiveKey(scoped)!)).map((spec) => spec.name);
    expect(names).toEqual(expect.arrayContaining(["create_note", "get_note_draft", "update_note_draft", "list_notes"]));
    expect(names).not.toContain("create_folder");
    expect((await call(scoped, "create_note", { markdown: "In Default?" })).value.code).toBe("INVALID");
    expect((await call(scoped, "create_note", { markdown: "Elsewhere", folderId: w.f2 })).value.code).toBe("NOT_FOUND");
    expect((await call(scoped, "create_note", { markdown: "Here", folderId: w.f1 })).isError).toBe(false);
    expect((await call(scoped, "get_note_draft", { noteId: w.n2 })).value.code).toBe("NOT_FOUND");
    expect((await call(scoped, "get_note_draft", { noteId: w.n1 })).isError).toBe(false);
  });

  test("a files key over one file and a folder: list, details, text, and moves stay inside", async () => {
    const w = await notesWorld("Selectors files");
    const byFile = key(w.owner, [on("files", "read", "document", w.d1), all("today", "read")]);
    expect((await call(byFile, "list_documents")).value.documents.map((document: { id: string }) => document.id)).toEqual([w.d1]);
    expect((await call(byFile, "read_document_text", { documentId: w.d1 })).value.text).toBe("granted file");
    const hidden = await call(byFile, "get_document_metadata", { documentId: w.d2 });
    expect(hidden.value.code).toBe("NOT_FOUND");
    expect(hidden.text).not.toContain("otter");
    expect((await call(byFile, "get_today")).text).not.toContain("hidden-otter");
    const byFolder = key(w.owner, [on("files", "write", "folder", w.f1)]);
    expect((await call(byFolder, "move_file", { documentId: w.d1, folderId: w.f2 })).value.code).toBe("NOT_FOUND");
    expect((await call(byFolder, "rename_file", { documentId: w.d2, name: "nope.md" })).value.code).toBe("NOT_FOUND");
    expect((await call(byFolder, "rename_file", { documentId: w.d1, name: "renamed.md" })).isError).toBe(false);
  });

  test("creating a key with folder and note grants names them for the owner, and refuses others' items", async () => {
    const w = await notesWorld("Selectors create");
    const stranger = await createUser("Selectors stranger");
    const body = { name: "Folder key", surfaces: "mcp", password: w.owner.password, grants: [{ module: "notes", permission: "read", resources: [{ kind: "folder", id: w.f1 }, { kind: "note", id: w.n3 }] }] };
    const created = await api(w.owner, "POST", "/keys", body);
    expect(created.status).toBe(201);
    expect(created.body.key.grants.map((grant: { resource: { kind: string; name: string } }) => [grant.resource.kind, grant.resource.name])).toEqual([["folder", "Granted folder"], ["note", "Single swan"]]);
    const theirs = await api(stranger, "POST", "/keys", { ...body, password: stranger.password });
    expect(theirs).toMatchObject({ status: 404, body: { code: "RESOURCE_NOT_FOUND" } });
    // A saved view is read-only through a key; a kind the module does not offer is refused.
    const view = await api(w.owner, "POST", "/keys", { ...body, grants: [{ module: "tasks", permission: "write", resources: [{ kind: "task_view", id: crypto.randomUUID() }] }] });
    expect(view.body.code).toBe("INVALID_GRANT");
    const wrongKind = await api(w.owner, "POST", "/keys", { ...body, grants: [{ module: "notes", permission: "read", resources: [{ kind: "board", id: crypto.randomUUID() }] }] });
    expect(wrongKind.body.code).toBe("INVALID_GRANT");
  });
});

describe("chosen views, boards, routines, and proposals (Wave 34)", () => {
  async function tasksWorld(label: string) {
    const owner = await createUser(label);
    const boardOf = async (name: string) => {
      const created = await api(owner, "POST", "/tasks/boards", { name });
      const boardId = created.body.board.id as string;
      const columnId = (created.body.columns as Array<{ id: string }>)[0]!.id;
      const card = (await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: `${name} card`, dueOn: new Date().toISOString().slice(0, 10) })).body.card as { id: string };
      return { boardId, columnId, cardId: card.id };
    };
    const a = await boardOf("Alpha board");
    const b = await boardOf("Bravo board");
    const view = (await api(owner, "POST", "/tasks/views", { name: "Everything view", query: "" })).body.view as { id: string };
    const other = (await api(owner, "POST", "/tasks/views", { name: "Other view", query: "" })).body.view as { id: string };
    return { owner, a, b, view, other };
  }

  test("a view grant lists and runs only that view; filters then reach no board", async () => {
    const w = await tasksWorld("Selectors views");
    const scoped = key(w.owner, [on("tasks", "read", "task_view", w.view.id)]);
    expect((await call(scoped, "list_views")).value.views.map((view: { id: string }) => view.id)).toEqual([w.view.id]);
    const run = await call(scoped, "query_cards", { viewId: w.view.id });
    expect(run.value.cards.length).toBeGreaterThanOrEqual(2);
    expect((await call(scoped, "query_cards", { viewId: w.other.id })).value.code).toBe("NOT_FOUND");
    expect((await call(scoped, "query_cards", { filter: "" })).value.cards).toEqual([]);
    expect((await call(scoped, "list_boards")).value.boards).toEqual([]);
  });

  test("a board key's query, search, Today, and refs stay on its board", async () => {
    const w = await tasksWorld("Selectors boards");
    const scoped = key(w.owner, [on("tasks", "read", "board", w.a.boardId), all("today", "read")]);
    const queried = await call(scoped, "query_cards", { filter: `board:${w.b.boardId}` });
    expect(queried.value.cards).toEqual([]);
    expect(queried.value.total).toBe(0);
    expect(queried.value.refs.boards).toEqual([{ id: w.b.boardId, restricted: true }]);
    expect(queried.text).not.toContain("Bravo");
    const everything = await call(scoped, "query_cards", { filter: "" });
    expect(everything.value.cards.map((card: { board_id: string }) => card.board_id)).toEqual([w.a.boardId]);
    const today = await call(scoped, "get_today");
    expect(today.text).toContain("Alpha board card");
    expect(today.text).not.toContain("Bravo");
    expect((await call(scoped, "list_views")).value.views).toEqual([]);
  });

  test("routine keys see and run only their routines; proposals stay on granted boards", async () => {
    const w = await tasksWorld("Selectors routines");
    const routine = async (name: string) => (await api(w.owner, "POST", "/inbox/routines", { name, instructions: "Suggest cards.", outputKinds: ["card_create"], cadence: "daily", atTime: "08:00", tz: "UTC" })).body.routine as { id: string };
    const r1 = await routine("Granted routine");
    const r2 = await routine("Other routine");
    const scoped = key(w.owner, [on("inbox", "write", "routine", r1.id), on("tasks", "read", "board", w.a.boardId)]);
    expect((await call(scoped, "list_routines")).value.routines.map((item: { routineId: string }) => item.routineId)).toEqual([r1.id]);
    expect((await call(scoped, "start_run", { routineId: r2.id })).value.code).toBe("NOT_FOUND");
    // Suggesting outside a run is refused for a routine-scoped key.
    expect((await call(scoped, "submit_proposals", { proposals: [{ kind: "card_create", title: "x", payload: { boardId: w.a.boardId, columnId: w.a.columnId, title: "x" } }] })).value.code).toBe("INVALID");
    const run = await call(scoped, "start_run", { routineId: r1.id });
    expect(run.isError).toBe(false);
    const submitted = await call(scoped, "submit_proposals", { runId: run.value.runId, proposals: [
      { kind: "card_create", title: "On A", payload: { boardId: w.a.boardId, columnId: w.a.columnId, title: "On A" } },
      { kind: "card_create", title: "On B", payload: { boardId: w.b.boardId, columnId: w.b.columnId, title: "On B" } }
    ] });
    expect(submitted.value.results[0].status).toBe("pending");
    expect(submitted.value.results[1].code).toBe("NOT_FOUND");
    expect((await call(scoped, "finish_run", { runId: run.value.runId, status: "succeeded", summary: "ok" })).isError).toBe(false);
  });
});
