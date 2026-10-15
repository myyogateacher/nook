import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createUser, db, request, type Session } from "./support/harness";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import type { Migration } from "../server/migrations/types";

/**
 * Lane FTS (migration 060): the Files full-text index. Sync on upload, rename, Bin, restore, and
 * purge; access exactly as `read_document_text` (Files listing access); ranking; the backfill;
 * storage trouble; and the migration. The local store here (S3 off); tests/s3Flows.test.ts indexes
 * through the S3 backend.
 */

const search = await import("../server/documentSearch");
const { DOCUMENT_INDEX_LIMITS, documentIndexDeps, documentIndexReady, indexDocumentsOnce, resetDocumentIndexForTests, scheduleDocumentIndex, whenDocumentIndexIdle } = search;
const { resetSearchRateLimit } = await import("../server/searchRoutes");
const { StorageUnavailableError } = await import("../server/objectStore");
const { PDF_TEXT_LIMITS } = await import("../server/pdfText");
const { makePdf } = await import("./support/pdf");


type Json = Record<string, any>;
let owner: Session;
let other: Session;
const savedLimits = { ...DOCUMENT_INDEX_LIMITS };
const savedRead = documentIndexDeps.readText;
const savedPdf = documentIndexDeps.readPdfText;

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
}
async function upload(session: Session, name: string, text: string | Uint8Array, type = "text/markdown") {
  const form = new FormData();
  form.append("file", new Blob([text], { type }), name);
  const response = await request("/files", { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}
async function find(session: Session, q: string, limit = 20) {
  resetSearchRateLimit();
  await whenDocumentIndexIdle();
  const answer = await api(session, "GET", `/search?${new URLSearchParams({ q, scope: "files", limit: String(limit) })}`);
  expect(answer.status).toBe(200);
  return answer.body as { results: Json[]; truncated: boolean };
}
const ids = (body: { results: Json[] }) => body.results.map((hit) => hit.id as string);
const word = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const row = (id: string) => db.query("SELECT body_state, source_sha256 FROM document_search WHERE document_id = ?").get(id) as { body_state: string; source_sha256: string } | null;

beforeAll(async () => {
  owner = await createUser("FTS owner");
  other = await createUser("FTS other");
});
afterEach(() => {
  Object.assign(DOCUMENT_INDEX_LIMITS, savedLimits);
  documentIndexDeps.readText = savedRead;
  documentIndexDeps.readPdfText = savedPdf;
});

describe("Files search index: sync", () => {
  test("upload indexes the name and the text; the hit has highlighted segments, never HTML", async () => {
    const term = word("up");
    const id = await upload(owner, "Pricing memo.md", `# Memo\n\nThe ${term} discount ends <b>Friday</b>.`);
    const found = await find(owner, term);
    expect(ids(found)).toEqual([id]);
    const hit = found.results[0]!;
    expect(hit).toMatchObject({ name: "Pricing memo.md", is_owner: 1, owner_name: "FTS owner", mime_type: expect.stringContaining("text") });
    expect(hit.snippet.some((segment: Json) => segment.hit && segment.text.toLowerCase() === term)).toBe(true);
    expect(hit.snippet.map((segment: Json) => segment.text).join("")).toContain("<b>Friday</b>");
    expect(row(id)).toMatchObject({ body_state: "text" });
    // A prefix of the last word finds it as the user types.
    expect(ids(await find(owner, term.slice(0, 5)))).toContain(id);
  });

  test("names of files that are not text are indexed; their bytes are never read", async () => {
    const term = word("bin");
    const reads: string[] = [];
    documentIndexDeps.readText = async (document) => { reads.push(document.id); return savedRead(document); };
    const id = await upload(owner, `${term} scan.bin`, new Uint8Array([0, 1, 2, 3]), "application/octet-stream");
    expect(ids(await find(owner, term))).toEqual([id]);
    expect(row(id)).toMatchObject({ body_state: "none" });
    expect(reads).not.toContain(id);
  });

  test("rename rewrites the title at once; Bin hides, restore shows again, purge removes the row", async () => {
    const term = word("life");
    const renamed = word("ren");
    const id = await upload(owner, `${term} plan.md`, "body without the word");
    expect(ids(await find(owner, term))).toEqual([id]);

    expect((await api(owner, "PATCH", `/files/${id}`, { name: `${renamed} plan.md` })).status).toBe(200);
    // No background work needed: the rename transaction updated the title.
    expect(ids(await find(owner, renamed))).toEqual([id]);
    expect(ids(await find(owner, term))).toEqual([]);

    expect((await api(owner, "DELETE", `/files/${id}`)).status).toBe(200);
    expect(ids(await find(owner, renamed))).toEqual([]);
    expect(row(id)).not.toBeNull(); // kept for a restore

    expect((await api(owner, "POST", `/bin/document/${id}/restore`)).status).toBe(200);
    expect(ids(await find(owner, renamed))).toEqual([id]);

    expect((await api(owner, "DELETE", `/files/${id}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/document/${id}`)).status).toBeLessThan(300);
    expect(row(id)).toBeNull();
    const ftsRows = (db.query("SELECT COUNT(*) AS n FROM document_fts WHERE rowid NOT IN (SELECT id FROM document_search)").get() as { n: number }).n;
    expect(ftsRows).toBe(0);
  });

  test("whiteboards stay out (they have their own index)", async () => {
    const term = word("wb");
    const board = await api(owner, "POST", "/whiteboards", { name: `${term} board` });
    expect(board.status).toBe(201);
    expect(ids(await find(owner, term))).toEqual([]);
    expect(row(board.body.whiteboard.id)).toBeNull();
  });
});

describe("Files search index: access", () => {
  test("another person's private file never appears; a shared one does, with its owner", async () => {
    const term = word("acl");
    const mine = await upload(owner, "Mine.md", `${term} mine`);
    const theirs = await upload(other, "Theirs.md", `${term} private`);
    const shared = await upload(other, "Shared.md", `${term} shared`);
    expect((await api(other, "PUT", `/files/${shared}/sharing`, { visibility: "all_users", userIds: [] })).status).toBe(200);
    const seen = await find(owner, term);
    expect(ids(seen).sort()).toEqual([mine, shared].sort());
    expect(seen.results.find((hit) => hit.id === shared)).toMatchObject({ is_owner: 0, owner_name: "FTS other" });
    expect(ids(await find(other, term)).sort()).toEqual([theirs, shared].sort());
    // Sharing ends: gone at once (the ACL is in the query, not the index).
    expect((await api(other, "PUT", `/files/${shared}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect(ids(await find(owner, term))).toEqual([mine]);
  });
});

describe("Files search index: ranking", () => {
  test("a name match outranks a text match; more mentions outrank fewer; limit and truncated", async () => {
    const term = word("rk");
    const once = await upload(owner, "Once.md", `intro ${term} and a lot of other words that dilute it ${"filler ".repeat(40)}`);
    const often = await upload(owner, "Often.md", `${term} ${term} ${term} notes`);
    const named = await upload(owner, `${term}.md`, "nothing related");
    const found = await find(owner, term);
    expect(ids(found)).toEqual([named, often, once]);
    expect(found.truncated).toBe(false);
    const top = await find(owner, term, 2);
    expect(ids(top)).toEqual([named, often]);
    expect(top.truncated).toBe(true);
  });

  test("the body is capped per document", async () => {
    const term = word("cap");
    DOCUMENT_INDEX_LIMITS.bodyBytes = 64;
    const id = await upload(owner, "Long.md", `${"padding ".repeat(20)} ${term}`);
    expect(ids(await find(owner, term))).toEqual([]);
    expect(row(id)).toMatchObject({ body_state: "text" });
  });
});

describe("Files search index: backfill and storage", () => {
  test("a lost index is rebuilt in the background, in batches, newest first; ready only once done", async () => {
    const term = word("bf");
    const made: string[] = [];
    for (let index = 0; index < 5; index += 1) made.push(await upload(owner, `Backfill ${index}.md`, `${term} ${index}`));
    await whenDocumentIndexIdle();
    // As after migration 060: these files have no rows (the rest of the suite's files keep theirs).
    db.query("DELETE FROM document_search WHERE document_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(made));
    resetDocumentIndexForTests({ ready: false });
    expect(ids(await find(owner, term))).toEqual([]);

    DOCUMENT_INDEX_LIMITS.batchDocs = 2;
    const first = await indexDocumentsOnce();
    expect(first).toMatchObject({ more: true, storageDown: false });
    expect(first.indexed + first.unreadable).toBe(2);
    expect(documentIndexReady()).toBe(false);

    DOCUMENT_INDEX_LIMITS.batchDocs = savedLimits.batchDocs;
    scheduleDocumentIndex();
    await whenDocumentIndexIdle();
    expect(documentIndexReady()).toBe(true);
    expect(ids(await find(owner, term)).sort()).toEqual([...made].sort());
    const missing = db.query(`SELECT COUNT(*) AS n FROM documents d LEFT JOIN document_search s ON s.document_id = d.id
      WHERE d.purpose = 'file' AND d.purge_started_at IS NULL AND s.id IS NULL AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)`).get() as { n: number };
    expect(missing.n).toBe(0);
  });

  test("storage trouble leaves the file waiting and retries; a file that fails its checks is indexed by name", async () => {
    const term = word("st");
    let down = true;
    DOCUMENT_INDEX_LIMITS.retryMs = 50;
    documentIndexDeps.readText = async (document) => {
      if (down) throw new StorageUnavailableError("down for the test", "Timeout");
      return savedRead(document);
    };
    const id = await upload(owner, "Stored.md", `${term} text`);
    await whenDocumentIndexIdle();
    expect(row(id)).toBeNull();
    down = false;
    const deadline = Date.now() + 3000;
    while (!row(id) && Date.now() < deadline) await Bun.sleep(20);
    await whenDocumentIndexIdle();
    expect(row(id)).toMatchObject({ body_state: "text" });
    expect(ids(await find(owner, term))).toEqual([id]);

    const broken = word("br");
    documentIndexDeps.readText = async () => { throw Object.assign(new Error("File content failed integrity verification"), { code: "INTERNAL" }); };
    const bad = await upload(owner, `${broken} notes.md`, `${term} hidden text`);
    await whenDocumentIndexIdle();
    expect(row(bad)).toMatchObject({ body_state: "unreadable" });
    expect(ids(await find(owner, broken))).toEqual([bad]);
    expect(ids(await find(owner, term))).toEqual([id]);
  });
});

describe("Files search index: PDF text (lane FILES, D496)", () => {
  test("a PDF's text layer is indexed; a PDF row from before PDF text is backfilled with no migration", async () => {
    const term = word("pdf");
    const id = await upload(owner, "Board minutes.pdf", makePdf([`Minutes ${term} approved`, "Next meeting"]), "application/pdf");
    const found = await find(owner, term);
    expect(ids(found)).toEqual([id]);
    expect(found.results[0]!.snippet.some((segment: Json) => segment.hit && segment.text.toLowerCase() === term)).toBe(true);
    expect(row(id)).toMatchObject({ body_state: "text" });

    // As indexed before D496: the name only, body_state 'none'. The next pass reads the text.
    db.query("UPDATE document_fts SET body = '' WHERE rowid = (SELECT id FROM document_search WHERE document_id = ?)").run(id);
    db.query("UPDATE document_search SET body_state = 'none' WHERE document_id = ?").run(id);
    expect(ids(await find(owner, term))).toEqual([]);
    scheduleDocumentIndex();
    await whenDocumentIndexIdle();
    expect(row(id)).toMatchObject({ body_state: "text" });
    expect(ids(await find(owner, term))).toEqual([id]);
  });

  test("a PDF that cannot be read is indexed by name and not retried; one over the size cap is never read", async () => {
    const broken = word("bpdf");
    const bad = await upload(owner, `${broken} scan.pdf`, "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "application/pdf");
    await whenDocumentIndexIdle();
    expect(row(bad)).toMatchObject({ body_state: "unreadable" });
    expect(ids(await find(owner, broken))).toEqual([bad]);
    const at = (db.query("SELECT indexed_at FROM document_search WHERE document_id = ?").get(bad) as { indexed_at: string }).indexed_at;
    scheduleDocumentIndex();
    await whenDocumentIndexIdle();
    expect((db.query("SELECT indexed_at FROM document_search WHERE document_id = ?").get(bad) as { indexed_at: string }).indexed_at).toBe(at);

    const reads: string[] = [];
    documentIndexDeps.readPdfText = async (document) => { reads.push(document.id); return savedPdf(document); };
    const saved = PDF_TEXT_LIMITS.maxBytes;
    PDF_TEXT_LIMITS.maxBytes = 100;
    try {
      const big = await upload(owner, "Big.pdf", makePdf([`${word("big")} text`]), "application/pdf");
      await whenDocumentIndexIdle();
      expect(row(big)).toMatchObject({ body_state: "none" });
      expect(reads).not.toContain(big);
    } finally {
      PDF_TEXT_LIMITS.maxBytes = saved;
    }
  });
});

async function migrationsBefore(id: number) {
  const dir = join(import.meta.dir, "..", "server", "migrations");
  const found: Migration[] = [];
  for (const file of readdirSync(dir).filter((name) => /^\d{3}_.*\.ts$/.test(name))) {
    const module = await import(join(dir, file)) as Record<string, unknown>;
    for (const value of Object.values(module)) if (value && typeof value === "object" && "up" in value && "id" in value) found.push(value as Migration);
  }
  return found.filter((migration) => migration.id < id && registeredMigrationIds.includes(migration.id)).sort((a, b) => a.id - b.id);
}

describe("migration 060_document_fts", () => {
  const at = "2026-10-15T00:00:00.000Z";
  const hasTable = (database: Database, name: string) => Boolean(database.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));

  test("is registered after 059", () => {
    expect(registeredMigrationIds.indexOf(60)).toBe(registeredMigrationIds.indexOf(59) + 1);
  });

  test("an upgrade from 059 adds the tables and trigger; existing documents wait for the backfill; purge cascades", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of await migrationsBefore(60)) {
      migration.up(database);
      database.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    }
    expect(hasTable(database, "document_fts")).toBe(false);
    database.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', ?)").run(at);
    database.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES ('d1', 'u1', NULL, 'Plan.md', 'text/markdown', 'text', 2, ?, 'file', ?, ?)`).run("a".repeat(64), at, at);
    // 060 and every migration after it (061, report favorites).
    expect(runMigrations(database)).toBe(registeredMigrationIds.filter((id) => id >= 60).length);
    for (const name of ["document_search", "document_fts", "document_search_ad"]) expect({ name, found: hasTable(database, name) }).toEqual({ name, found: true });
    expect(database.query("SELECT COUNT(*) AS n FROM document_search").get()).toEqual({ n: 0 });

    database.query("INSERT INTO document_search (id, document_id, source_sha256, body_state, indexed_at) VALUES (7, 'd1', ?, 'text', ?)").run("a".repeat(64), at);
    database.query("INSERT INTO document_fts (rowid, title, body) VALUES (7, 'Plan.md', 'hello')").run();
    expect(() => database.query("INSERT INTO document_search (document_id, source_sha256, body_state, indexed_at) VALUES ('d1', 'x', 'odd', ?)").run(at)).toThrow();
    database.query("DELETE FROM documents WHERE id = 'd1'").run();
    expect(database.query("SELECT COUNT(*) AS n FROM document_search").get()).toEqual({ n: 0 });
    expect(database.query("SELECT COUNT(*) AS n FROM document_fts").get()).toEqual({ n: 0 });
    expect(runMigrations(database)).toBe(0);
    database.close();
  });
});
