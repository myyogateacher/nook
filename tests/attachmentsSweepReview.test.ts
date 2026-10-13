import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api, attachmentsFolderOf, documentRow, upload, uploadAttachment } from "./support/attachments";

const { sweepOrphanedAttachments, UNLINKED_GRACE_MS } = await import("../server/attachments/sweep");
const { referenceIndexStats, registerAttachmentReferenceChecker, resetReferenceCacheForTests } = await import("../server/attachments/references");

/**
 * v0.35.0 security review L1 and L2: an unlinked attachment restored from the Bin goes back to
 * Attachments and is left alone by the orphan sweep for a day; the sweep re-checks each file in the
 * bin step's own transaction (a draft saved or a restore since the scan keeps it); and the sweep
 * reads only content its reference index (048) has not seen.
 */

beforeEach(() => resetReferenceCacheForTests());

const longAgo = () => new Date(Date.now() - UNLINKED_GRACE_MS - 3_600_000).toISOString();
const backdate = (id: string) => db.query("UPDATE documents SET created_at = ?, updated_at = ? WHERE id = ?").run(longAgo(), longAgo(), id);
const binned = (id: string) => documentRow(id)!.deleted_at !== null;
const chip = (id: string) => `[📎 x.txt](/files/${id})`;

async function orphan(owner: Session, name: string) {
  const id = await uploadAttachment(owner, name, "orphan", "note");
  backdate(id);
  return id;
}

async function draft(owner: Session, noteId: string, markdown: string) {
  const note = (await api(owner, "GET", `/notes/${noteId}`)).body.note;
  expect((await api(owner, "PUT", `/notes/${noteId}/draft`, { revision: note.draft_revision ?? null, markdown })).status).toBe(200);
}

describe("L1: restoring an unlinked attachment", () => {
  test("goes back to Attachments, and the sweep leaves it for a day before binning it again", async () => {
    const owner = await createUser("L1 restore");
    const file = await orphan(owner, "restored.txt");
    await sweepOrphanedAttachments();
    expect(binned(file)).toBe(true);
    expect((await api(owner, "POST", `/bin/document/${file}/restore`, {})).body).toMatchObject({ folderName: "Attachments" });
    expect(documentRow(file)).toMatchObject({ folder_id: attachmentsFolderOf(owner.userId), deleted_at: null });
    // Exempt for a day (the restore set updated_at)...
    await sweepOrphanedAttachments();
    expect(binned(file)).toBe(false);
    // ...then an attachment nothing uses goes back to the Bin.
    await sweepOrphanedAttachments({ nowMs: Date.now() + UNLINKED_GRACE_MS + 60_000 });
    expect(binned(file)).toBe(true);
  }, 30_000);
});

describe("L2: the orphan sweep", () => {
  test("re-checks in the bin step: a draft saved after the scan, or a restore, keeps the file", async () => {
    const owner = await createUser("L2 race");
    const noteId = (await api(owner, "POST", "/notes", {})).body.note.id as string;
    const referencedLate = await orphan(owner, "late.txt");
    const touchedLate = await orphan(owner, "touched.txt");
    const plain = await orphan(owner, "plain.txt");
    // Runs after the index is refreshed and the candidates are chosen, before the bin step.
    const unregister = registerAttachmentReferenceChecker("race", async () => {
      await draft(owner, noteId, `# Late\n\n${chip(referencedLate)}`);
      db.query("UPDATE documents SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - UNLINKED_GRACE_MS - 1_000).toISOString(), touchedLate);
      return new Set();
    });
    try {
      await sweepOrphanedAttachments();
    } finally {
      unregister();
    }
    expect(binned(referencedLate)).toBe(false);
    expect(binned(touchedLate)).toBe(false);
    expect(binned(plain)).toBe(true);
  }, 30_000);

  test("reads only content its index has not seen: none at all on the next run", async () => {
    const owner = await createUser("L2 cost");
    for (let index = 0; index < 5; index += 1) {
      const noteId = (await api(owner, "POST", "/notes", {})).body.note.id as string;
      await draft(owner, noteId, `# Note ${index}`);
      expect((await api(owner, "POST", `/notes/${noteId}/publish`, {})).status).toBe(200);
    }
    const kept = await orphan(owner, "kept.txt");
    const keeper = (await api(owner, "POST", "/notes", {})).body.note.id as string;
    await draft(owner, keeper, `# Keeps\n\n${chip(kept)}`);
    // An empty index (as after the 048 upgrade): the first run scans everything once.
    resetReferenceCacheForTests();
    await orphan(owner, "first.txt");
    await sweepOrphanedAttachments();
    expect(referenceIndexStats.sourcesRead).toBeGreaterThanOrEqual(6); // 5 versions and the draft
    expect(binned(kept)).toBe(false);
    // The next run with candidates reads nothing; writers recorded their own content as they committed.
    await orphan(owner, "second.txt");
    await draft(owner, keeper, `# Keeps still\n\n${chip(kept)}`);
    await sweepOrphanedAttachments();
    expect(referenceIndexStats.sourcesRead).toBe(0);
    expect(binned(kept)).toBe(false);
    // The draft stops showing it: the stale source is dropped, and the file goes to the Bin.
    await draft(owner, keeper, "# Nothing now");
    await sweepOrphanedAttachments();
    expect(referenceIndexStats.sourcesRead).toBe(0);
    expect(binned(kept)).toBe(true);
  }, 30_000);

  test("files outside Attachments are never touched", async () => {
    const owner = await createUser("L2 files");
    const file = (await upload(owner, "kept.txt", "kept")).id;
    backdate(file);
    await sweepOrphanedAttachments();
    expect(binned(file)).toBe(false);
  });
});
