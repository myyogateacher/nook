import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createUser, db, type Session } from "./support/harness";
import { api, makeKey, ok } from "./support/mcpClient";

const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { binnedAuditQuery } = await import("../server/mcpBinned");
const { binnedTodayLine, McpBinnedReview, restoreSummary } = await import("../src/McpBinnedReview");

beforeEach(() => resetMcpLimits());

async function publishedNote(session: Session, markdown: string) {
  const { note } = (await api(session, "POST", "/notes", {})).body as { note: { id: string } };
  expect((await api(session, "PUT", `/notes/${note.id}/draft`, { markdown, revision: 1 })).status).toBe(200);
  expect((await api(session, "POST", `/notes/${note.id}/publish`, {})).status).toBe(200);
  return note.id;
}

const deletedAt = (table: string, id: string) => (db.query(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id) as { deleted_at: string | null }).deleted_at;

describe("Review and Restore all for a key (D175)", () => {
  test("lists what the key binned, restores it all, and skips an item already restored", async () => {
    const owner = await createUser("Undo owner");
    const key = makeKey(owner, ["notes:write-draft", "tasks:write", "bin:write"], "Cleaner");
    const other = makeKey(owner, ["notes:write-draft", "bin:write"], "Other");
    const notes = [];
    for (let index = 0; index < 4; index += 1) notes.push(await publishedNote(owner, `# Undo ${index}\n\ntext`));
    const board = await api(owner, "POST", "/tasks/boards", { name: "Undo board" });
    const cardId = (await api(owner, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId: board.body.columns[0].id, title: "Undo card" })).body.card.id as string;
    for (const noteId of notes) await ok(key, "bin_note", { noteId });
    await ok(key, "bin_card", { cardId });
    // Another key's binning and a person's own delete are not this key's.
    const theirs = await publishedNote(owner, "# Other key\n\ntext");
    await ok(other, "bin_note", { noteId: theirs });
    const mine = await publishedNote(owner, "# Human\n\ntext");
    expect((await api(owner, "DELETE", `/notes/${mine}`)).status).toBe(200);

    const listed = await api(owner, "GET", `/mcp/keys/${key.id}/binned?window=1h`);
    expect(listed.status).toBe(200);
    expect(listed.body.truncated).toBe(false);
    expect(listed.body.items.map((item: { id: string }) => item.id).sort()).toEqual([...notes, cardId].sort());
    expect(listed.body.items.find((item: { id: string }) => item.id === cardId)).toMatchObject({ type: "card", title: "Undo card", restorable: true });

    const keys = (await api(owner, "GET", "/mcp/keys")).body.keys as Array<{ id: string; binnedToday: number }>;
    expect(keys.find((row) => row.id === key.id)!.binnedToday).toBe(5);
    expect(keys.find((row) => row.id === other.id)!.binnedToday).toBe(1);

    // One comes back by hand first.
    await ok(key, "restore_note", { noteId: notes[0] });
    const result = await api(owner, "POST", `/mcp/keys/${key.id}/restore-binned`, { window: "24h" });
    expect(result.status).toBe(200);
    expect(result.body.restored).toBe(4);
    expect(result.body.skipped).toEqual([{ type: "note", id: notes[0], reason: "not_in_bin" }]);
    for (const noteId of notes) expect(deletedAt("notes", noteId)).toBeNull();
    expect(deletedAt("cards", cardId)).toBeNull();
    expect(deletedAt("notes", theirs)).not.toBeNull();
    expect(deletedAt("notes", mine)).not.toBeNull();
    expect((await api(owner, "GET", `/mcp/keys/${key.id}/binned?window=7d`)).body.items).toEqual([]);
  });

  test("only the key's owner may review or restore; a bad window is 400", async () => {
    const owner = await createUser("Undo key owner");
    const stranger = await createUser("Undo stranger");
    const key = makeKey(owner, ["notes:write-draft", "bin:write"]);
    expect((await api(stranger, "GET", `/mcp/keys/${key.id}/binned`)).status).toBe(404);
    expect((await api(stranger, "POST", `/mcp/keys/${key.id}/restore-binned`, { window: "1h" })).status).toBe(404);
    expect((await api(owner, "GET", `/mcp/keys/${key.id}/binned?window=30d`)).status).toBe(400);
    expect((await api(owner, "POST", `/mcp/keys/${key.id}/restore-binned`, { window: "30d" })).status).toBe(400);
  });

  test("the Settings pieces: the key row line, the summary, and the dialog with its window Select", () => {
    expect(binnedTodayLine(0)).toBeNull();
    expect(binnedTodayLine(1)).toBe("Moved 1 item to the Bin today");
    expect(binnedTodayLine(7)).toBe("Moved 7 items to the Bin today");
    expect(restoreSummary({ restored: 4, skipped: [{}] })).toBe("Restored 4 items; 1 could not be restored");
    expect(restoreSummary({ restored: 1, skipped: [] })).toBe("Restored 1 item.");
    const markup = renderToStaticMarkup(createElement(McpBinnedReview, { keyId: crypto.randomUUID(), keyName: "Cleaner", onClose: () => undefined, onRevoke: () => undefined }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Moved to the Bin by Cleaner");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain("Last 24 hours");
    expect(markup).toContain("Revoke this key");
    expect(markup).not.toContain("<select");
  });
});

// The unindexed audit scan (D175, Q10): measured at the gate with MYNOTES_PERF=1 on 200k rows.
test.skipIf(process.env.MYNOTES_PERF !== "1")("the key binned scan answers within 500 ms over 200k audit rows", async () => {
  const owner = await createUser("Undo perf");
  const key = makeKey(owner, ["notes:write-draft", "bin:write"]);
  const insert = db.query("INSERT INTO audit_log (id, actor_id, note_id, event_type, metadata_json, created_at) VALUES (?, ?, NULL, ?, ?, ?)");
  const ids: string[] = [];
  const types = ["note.publish", "task.card_update", "event.delete", "collection.row_delete", "note.delete"];
  db.transaction(() => {
    for (let index = 0; index < 200_000; index += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      // Most rows belong to this user, the worst case for an actor-only narrowing.
      insert.run(id, owner.userId, types[index % types.length]!, JSON.stringify({ via: "mcp", keyId: index % 2 ? key.id : crypto.randomUUID() }), new Date(Date.now() - (index % 1000) * 60_000).toISOString());
    }
  })();
  try {
    const started = performance.now();
    binnedAuditQuery.all({ userId: owner.userId, keyId: key.id, since: new Date(Date.now() - 7 * 86_400_000).toISOString(), types: JSON.stringify(["note.delete", "task.card_delete", "event.delete", "collection.row_delete"]), limit: 500 });
    const elapsed = performance.now() - started;
    console.log(`Key binned audit scan over 200k rows: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(500);
  } finally {
    db.transaction(() => { for (const id of ids) db.query("DELETE FROM audit_log WHERE id = ?").run(id); })();
  }
}, 120_000);
