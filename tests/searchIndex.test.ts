import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, request, type Session } from "./support/harness";

const { reconcileSearchIndex } = await import("../server/searchIndex");
const { registeredMigrationIds } = await import("../server/migrations");
const { checksum } = await import("../server/storage");

type Row = { kind: string; source_checksum: string; title: string; body: string };
const rows = (noteId: string) => db.query(`
  SELECT r.kind, r.source_checksum, f.title, f.body FROM note_search_rows r JOIN note_fts f ON f.rowid = r.id
  WHERE r.note_id = ? ORDER BY r.kind
`).all(noteId) as Row[];
const kinds = (noteId: string) => rows(noteId).map((row) => row.kind);
const ftsCount = () => (db.query("SELECT COUNT(*) AS count FROM note_fts").get() as { count: number }).count;
const mappedCount = () => (db.query("SELECT COUNT(*) AS count FROM note_search_rows").get() as { count: number }).count;

async function json<T>(response: Response) {
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as T;
}

async function createNote(session: Session) {
  return (await json<{ note: { id: string } }>(await request("/notes", { method: "POST", body: "{}" }, session))).note.id;
}

async function saveDraft(session: Session, id: string, markdown: string) {
  const current = db.query("SELECT draft_revision FROM notes WHERE id = ?").get(id) as { draft_revision: number | null };
  return json<{ revision: number }>(await request(`/notes/${id}/draft`, { method: "PUT", body: JSON.stringify({ markdown, revision: current.draft_revision }) }, session));
}

const publish = async (session: Session, id: string) => json(await request(`/notes/${id}/publish`, { method: "POST", body: "{}" }, session));

describe("search index sync", () => {
  test("drafts, publishes, discards, and restores keep the note's rows in step", async () => {
    const owner = await createUser("Index owner");
    const id = await createNote(owner);
    expect(kinds(id)).toEqual([]);

    await saveDraft(owner, id, "# Quokka plans\n\nSee [the zoo](https://zoo.example/path).");
    const draftRows = rows(id);
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]).toMatchObject({ kind: "draft", title: "Quokka plans", body: "See the zoo ." });
    // The title line is kept out of the body so snippets do not repeat it.
    expect(draftRows[0]!.source_checksum).toBe((db.query("SELECT draft_checksum FROM notes WHERE id = ?").get(id) as { draft_checksum: string }).draft_checksum);

    await saveDraft(owner, id, "   ");
    expect(kinds(id)).toEqual([]);

    await saveDraft(owner, id, "# Quokka v1\n\nfirst body");
    await publish(owner, id);
    const published = rows(id);
    expect(published.map((row) => row.kind)).toEqual(["published"]);
    expect(published[0]).toMatchObject({ title: "Quokka v1", source_checksum: checksum("# Quokka v1\n\nfirst body") });

    await saveDraft(owner, id, "# Quokka v2\n\nsecond body");
    expect(kinds(id)).toEqual(["draft", "published"]);
    expect(rows(id)[0]!.body).toContain("second body");

    expect((await request(`/notes/${id}/draft`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(kinds(id)).toEqual(["published"]);

    await saveDraft(owner, id, "# Quokka v2\n\nsecond body");
    await publish(owner, id);
    expect(rows(id).map((row) => [row.kind, row.title])).toEqual([["published", "Quokka v2"]]);

    expect((await request(`/notes/${id}/versions/1/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    const restored = rows(id);
    expect(restored.map((row) => [row.kind, row.title])).toEqual([["draft", "Quokka v1"], ["published", "Quokka v2"]]);
    expect(restored[0]!.source_checksum).toBe(checksum("# Quokka v1\n\nfirst body"));
  });

  test("the Bin keeps rows, and purge removes them through the cascade and trigger", async () => {
    const owner = await createUser("Index binner");
    const id = await createNote(owner);
    await saveDraft(owner, id, "# Wombat\n\nburrow");
    await publish(owner, id);
    await saveDraft(owner, id, "# Wombat\n\nburrow draft");
    expect(kinds(id)).toEqual(["draft", "published"]);

    expect((await request(`/notes/${id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(kinds(id)).toEqual(["draft", "published"]);
    expect((await request(`/bin/note/${id}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(kinds(id)).toEqual(["draft", "published"]);

    expect((await request(`/notes/${id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    const beforeFts = ftsCount();
    expect((await request(`/bin/note/${id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((db.query("SELECT COUNT(*) AS count FROM note_search_rows WHERE note_id = ?").get(id) as { count: number }).count).toBe(0);
    expect(ftsCount()).toBe(beforeFts - 2);
  });

  test("discarding a never-published draft bins it with its row, and a blank one is purged", async () => {
    const owner = await createUser("Index discarder");
    const kept = await createNote(owner);
    await saveDraft(owner, kept, "# Numbat\n\nnotes");
    expect((await request(`/notes/${kept}/draft`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(kinds(kept)).toEqual(["draft"]);
    const blank = await createNote(owner);
    expect((await request(`/notes/${blank}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(kinds(blank)).toEqual([]);
  });

  test("reconcile reindexes missing and stale rows, removes orphans, and skips intact rows", async () => {
    const owner = await createUser("Index reconciler");
    const first = await createNote(owner);
    await saveDraft(owner, first, "# Echidna\n\nspines");
    await publish(owner, first);
    const second = await createNote(owner);
    await saveDraft(owner, second, "# Bilby\n\nears");
    const third = await createNote(owner);
    await saveDraft(owner, third, "# Dunnart\n\ntail");

    // Missing: drop the published row. Stale: change a checksum. Orphan: FTS row with no mapping.
    db.query("DELETE FROM note_search_rows WHERE note_id = ?").run(first);
    db.query("UPDATE note_search_rows SET source_checksum = ? WHERE note_id = ?").run("0".repeat(64), second);
    db.query("INSERT INTO note_fts (rowid, title, body) VALUES (?, 'orphan', 'orphan text')").run(9_000_000);
    // A draft whose file no longer matches its checksum is left out.
    writeFileSync(join(dataDir, "notes", third, "draft.md"), "tampered", { mode: 0o600 });
    db.query("UPDATE note_search_rows SET source_checksum = ? WHERE note_id = ?").run("1".repeat(64), third);

    const counts = await reconcileSearchIndex();
    expect(counts.indexed).toBeGreaterThanOrEqual(2);
    expect(counts.removed).toBeGreaterThanOrEqual(1);
    expect(counts.unreadable).toBeGreaterThanOrEqual(1);
    expect(kinds(first)).toEqual(["published"]);
    expect(rows(second)[0]!.source_checksum).toBe(checksum("# Bilby\n\nears"));
    expect(kinds(third)).toEqual([]);
    expect(db.query("SELECT rowid FROM note_fts WHERE rowid = 9000000").get()).toBeNull();
    expect(ftsCount()).toBe(mappedCount());

    const again = await reconcileSearchIndex();
    expect(again.indexed).toBe(0);
    expect(again.removed).toBe(0);
  });

  test("boot backfills a 007-shaped data directory from verified files, never from current.md", () => {
    const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "searchBackfillProbe.ts")], { stdout: "pipe", stderr: "pipe" });
    const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
    const result = JSON.parse(output) as Record<string, unknown>;
    // 1–22 are on main; later waves (023 and up) may or may not be registered yet.
    expect(registeredMigrationIds.slice(0, 22)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(registeredMigrationIds.slice(22).every((id) => id >= 23)).toBe(true);
    expect(result).toMatchObject({
      migrations: [...registeredMigrationIds],
      rows: ["binned:published", "both:draft", "both:published", "draftOnly:draft", "published:published"],
      checksumsMatch: true,
      aardvark: ["published:published"],
      zebras: ["published:published"],
      mongoose: [],
      pangolin: ["draftOnly:draft"],
      platypus: ["both:published"],
      dingo: ["both:draft"],
      bison: ["binned:published"],
      tampered: []
    });
    expect(result.second).toMatchObject({ indexed: 0, removed: 0 });
    expect(probe.stderr.toString()).not.toContain("tampered");
  }, 20_000);
});
