import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetSearchRateLimit } = await import("../server/searchRoutes");

type Segment = { text: string; hit: boolean };
type Hit = { id: string; source: "published" | "draft"; title: Segment[]; snippet: Segment[]; folder_id: string | null; owner_name: string; is_owner: 0 | 1; visibility: string; updated_at: string };

async function json<T>(response: Response) {
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as T;
}

async function search(session: Session, q: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({ q, ...params });
  return json<{ results: Hit[]; truncated: boolean }>(await request(`/search?${query}`, {}, session));
}
const ids = async (session: Session, q: string, params: Record<string, string> = {}) => (await search(session, q, params)).results.map((hit) => hit.id).sort();
const text = (segments: Segment[]) => segments.map((segment) => segment.text).join("");
const hits = (segments: Segment[]) => segments.filter((segment) => segment.hit).map((segment) => segment.text);

async function createFolder(session: Session, name: string) {
  return (await json<{ folder: { id: string } }>(await request("/folders", { method: "POST", body: JSON.stringify({ name }) }, session))).folder.id;
}

async function saveDraft(session: Session, id: string, markdown: string) {
  const current = db.query("SELECT draft_revision FROM notes WHERE id = ?").get(id) as { draft_revision: number | null };
  await json(await request(`/notes/${id}/draft`, { method: "PUT", body: JSON.stringify({ markdown, revision: current.draft_revision }) }, session));
}
const publish = async (session: Session, id: string) => json(await request(`/notes/${id}/publish`, { method: "POST", body: "{}" }, session));

async function createNote(session: Session, markdown: string, options: { publish?: boolean; folderId?: string } = {}) {
  const id = (await json<{ note: { id: string } }>(await request("/notes", { method: "POST", body: JSON.stringify({ folderId: options.folderId ?? null }) }, session))).note.id;
  await saveDraft(session, id, markdown);
  if (options.publish) await publish(session, id);
  return id;
}

const shareFolder = async (owner: Session, folderId: string, visibility: string, users: Session[] = []) =>
  json(await request(`/folders/${folderId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility, userIds: users.map((user) => user.userId) }) }, owner));
const shareNote = async (owner: Session, noteId: string, visibility: string, users: Session[] = []) =>
  json(await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility, userIds: users.map((user) => user.userId) }) }, owner));
const listedIds = async (session: Session) => (await json<{ notes: Array<{ id: string }> }>(await request("/notes", {}, session))).notes.map((note) => note.id);

beforeEach(() => resetSearchRateLimit());

describe("GET /api/search matching", () => {
  test("folds accents and case, prefixes the last word, and returns text segments", async () => {
    const owner = await createUser("Search matcher");
    const id = await createNote(owner, "# Crème brûlée\n\nA custard with <b>caramel</b> & a crack.", { publish: true });

    expect(await ids(owner, "creme brulee")).toEqual([id]);
    expect(await ids(owner, "CRÈME")).toEqual([id]);
    expect(await ids(owner, "brul")).toEqual([id]);
    expect(await ids(owner, "brul ")).toEqual([]);
    expect(await ids(owner, "caram")).toEqual([id]);

    const [hit] = (await search(owner, "creme custard")).results;
    expect(hit).toMatchObject({ id, source: "published", is_owner: 1, owner_name: "Search matcher", visibility: "private" });
    expect(text(hit!.title)).toBe("Crème brûlée");
    expect(hits(hit!.title)).toEqual(["Crème"]);
    expect(hits(hit!.snippet)).toEqual(["custard"]);
    expect(text(hit!.snippet)).not.toContain("brûlée");
    expect(text(hit!.snippet)).not.toContain("<b>");
    expect(Object.keys(hit!)).not.toContain("score");
  });

  test("weights title matches above body matches and reports truncation", async () => {
    const owner = await createUser("Search weigher");
    const bodyOnly = await createNote(owner, "# Plain heading\n\nThis note mentions a wallaby once.", { publish: true });
    const titled = await createNote(owner, "# Wallaby notes\n\nThis note is about something else.", { publish: true });
    const results = (await search(owner, "wallaby")).results.map((hit) => hit.id);
    expect(results).toEqual([titled, bodyOnly]);
    const page = await search(owner, "wallaby", { limit: "1" });
    expect(page.results.map((hit) => hit.id)).toEqual([titled]);
    expect(page.truncated).toBe(true);
    expect((await search(owner, "wallaby", { limit: "2" })).truncated).toBe(false);
  });

  test("treats FTS syntax as plain words", async () => {
    const owner = await createUser("Search injector");
    const id = await createNote(owner, "# Title words\n\nnear the kookaburra", { publish: true });
    expect(await ids(owner, "title:kookaburra")).toEqual([id]);
    expect(await ids(owner, "NEAR(kookaburra")).toEqual([id]);
    expect(await ids(owner, "kookaburra OR nothingmatches")).toEqual([]);
    expect((await search(owner, "***")).results).toEqual([]);
    expect((await search(owner, "")).results).toEqual([]);
  });
});

describe("GET /api/search drafts and access", () => {
  test("only the owner finds draft text, and the draft row is gone after publish", async () => {
    const owner = await createUser("Draft owner");
    const reader = await createUser("Draft reader");
    const folderId = await createFolder(owner, "Search shared");
    await shareFolder(owner, folderId, "selected", [reader]);
    const id = await createNote(owner, "# Alpaca\n\nfirst published text", { publish: true, folderId });
    await saveDraft(owner, id, "# Alpaca\n\nsecret draft wording");

    expect((await search(owner, "secret draft")).results.map((hit) => [hit.id, hit.source])).toEqual([[id, "draft"]]);
    // The owner sees what GET /api/notes/:id shows them: the draft, not the published text.
    expect(await ids(owner, "first published")).toEqual([]);
    expect(await ids(reader, "secret draft")).toEqual([]);
    expect((await search(reader, "first published")).results.map((hit) => [hit.id, hit.source, hit.is_owner])).toEqual([[id, "published", 0]]);

    await publish(owner, id);
    expect((db.query("SELECT kind FROM note_search_rows WHERE note_id = ?").all(id) as Array<{ kind: string }>).map((row) => row.kind)).toEqual(["published"]);
    expect((await search(owner, "secret draft")).results.map((hit) => [hit.id, hit.source])).toEqual([[id, "published"]]);
    expect(await ids(reader, "secret draft")).toEqual([id]);
    expect(await ids(reader, "first published")).toEqual([]);

    // A never-published note in a shared folder is invisible to readers.
    const draftOnly = await createNote(owner, "# Alpaca draft only\n\nunpublished", { folderId });
    expect(await ids(owner, "unpublished")).toEqual([draftOnly]);
    expect(await ids(reader, "unpublished")).toEqual([]);
  });

  test("results are a subset of GET /api/notes across the share matrix, and unsharing applies at once", async () => {
    const owner = await createUser("Matrix owner");
    const folderReader = await createUser("Matrix folder reader");
    const noteReader = await createUser("Matrix note reader");
    const stranger = await createUser("Matrix stranger");
    const guest = await createUser("Matrix guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    const selectedFolder = await createFolder(owner, "Matrix selected");
    const everyoneFolder = await createFolder(owner, "Matrix everyone");
    const privateFolder = await createFolder(owner, "Matrix private");
    await shareFolder(owner, selectedFolder, "selected", [folderReader]);
    await shareFolder(owner, everyoneFolder, "all_users");

    const word = "matrixquoll";
    const notes = {
      private: await createNote(owner, `# Private ${word}`, { publish: true, folderId: privateFolder }),
      inSelected: await createNote(owner, `# Selected ${word}`, { publish: true, folderId: selectedFolder }),
      inEveryone: await createNote(owner, `# Everyone ${word}`, { publish: true, folderId: everyoneFolder }),
      overrideAll: await createNote(owner, `# Override all ${word}`, { publish: true, folderId: privateFolder }),
      overrideSelected: await createNote(owner, `# Override selected ${word}`, { publish: true, folderId: privateFolder }),
      overridePrivate: await createNote(owner, `# Override private ${word}`, { publish: true, folderId: selectedFolder }),
      unpublished: await createNote(owner, `# Unpublished ${word}`, { folderId: everyoneFolder })
    };
    await shareNote(owner, notes.overrideAll, "all_users");
    await shareNote(owner, notes.overrideSelected, "selected", [noteReader]);
    await shareNote(owner, notes.overridePrivate, "private");

    const expected = {
      owner: Object.values(notes).sort(),
      folderReader: [notes.inSelected, notes.inEveryone, notes.overrideAll].sort(),
      noteReader: [notes.inEveryone, notes.overrideAll, notes.overrideSelected].sort(),
      stranger: [notes.inEveryone, notes.overrideAll].sort(),
      // T84: a guest is outside every all-users audience.
      guest: [] as string[]
    };
    for (const [label, session] of Object.entries({ owner, folderReader, noteReader, stranger, guest })) {
      const found = await ids(session, word);
      expect(found).toEqual(expected[label as keyof typeof expected]);
      const listed = new Set(await listedIds(session));
      for (const id of found) expect(listed.has(id)).toBe(true);
    }

    // folder_id is masked like GET /api/notes: the note reader cannot see the private folder.
    const overrideHit = (await search(noteReader, `override selected ${word}`)).results[0]!;
    expect(overrideHit.folder_id).toBeNull();
    expect((await search(folderReader, `selected ${word}`)).results.find((hit) => hit.id === notes.inSelected)!.folder_id).toBe(selectedFolder);

    // Folder filters.
    expect(await ids(owner, word, { folder: selectedFolder })).toEqual([notes.inSelected, notes.overridePrivate].sort());
    expect(await ids(owner, word, { folder: "shared" })).toEqual([]);
    expect(await ids(folderReader, word, { folder: "shared" })).toEqual(expected.folderReader);
    expect(await ids(noteReader, word, { folder: privateFolder })).toEqual([]);

    await shareFolder(owner, selectedFolder, "private");
    await shareNote(owner, notes.overrideSelected, "private");
    expect(await ids(folderReader, word)).toEqual([notes.inEveryone, notes.overrideAll].sort());
    expect(await ids(noteReader, word)).toEqual([notes.inEveryone, notes.overrideAll].sort());
  });

  test("binned notes are hidden, restored notes return, and purge removes their rows", async () => {
    const owner = await createUser("Bin searcher");
    const reader = await createUser("Bin search reader");
    const folderId = await createFolder(owner, "Bin search shared");
    await shareFolder(owner, folderId, "all_users");
    const id = await createNote(owner, "# Platypus bin test", { publish: true, folderId });
    expect(await ids(reader, "platypus bin")).toEqual([id]);

    expect((await request(`/notes/${id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(await ids(owner, "platypus bin")).toEqual([]);
    expect(await ids(reader, "platypus bin")).toEqual([]);

    expect((await request(`/bin/note/${id}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(await ids(owner, "platypus bin")).toEqual([id]);
    expect(await ids(reader, "platypus bin")).toEqual([id]);

    expect((await request(`/notes/${id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await request(`/bin/note/${id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((db.query("SELECT COUNT(*) AS count FROM note_search_rows WHERE note_id = ?").get(id) as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM note_fts WHERE note_fts MATCH ?").get('"platypus" "bin"') as { count: number }).count).toBe(0);
  });

  test("restoring a version reindexes the draft", async () => {
    const owner = await createUser("Version searcher");
    const id = await createNote(owner, "# Numbat\n\noriginal wording", { publish: true });
    await saveDraft(owner, id, "# Numbat\n\nrevised wording");
    await publish(owner, id);
    expect(await ids(owner, "original")).toEqual([]);
    expect((await request(`/notes/${id}/versions/1/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect((await search(owner, "original")).results.map((hit) => [hit.id, hit.source])).toEqual([[id, "draft"]]);
    expect(await ids(owner, "revised")).toEqual([]);
  });
});

describe("GET /api/search validation and limits", () => {
  test("rejects bad parameters with 400", async () => {
    const user = await createUser("Search validator");
    for (const query of ["q=x&scope=pages", "q=x&folder=nope", "q=x&limit=0", "q=x&limit=51", "q=x&limit=abc", "q=x&limit=1.5", `q=${"a".repeat(201)}`]) {
      const response = await request(`/search?${query}`, {}, user);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("Invalid request");
    }
    expect((await request(`/search?q=${"a".repeat(200)}&limit=50&folder=all&scope=notes`, {}, user)).status).toBe(200);
    expect((await request("/search?q=x")).status).toBe(401);
  });

  test("rate limits each user to 20 searches per 10 seconds", async () => {
    const user = await createUser("Search flooder");
    const other = await createUser("Search bystander");
    for (let index = 0; index < 20; index += 1) expect((await request("/search?q=flood", {}, user)).status).toBe(200);
    const limited = await request("/search?q=flood", {}, user);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await request("/search?q=flood", {}, other)).status).toBe(200);
  });
});
