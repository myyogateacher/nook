import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { runSweep } = await import("../server/sweeper");

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
const tasks = (session: Session, method: string, path: string, body?: unknown) => call(session, method, `/tasks${path}`, body);
type Item = { type: string; id: string; title: string; board_id: string | null; board_name: string | null; can_purge: boolean; attachment: boolean; attachment_of?: string | null };
const binItems = async (session: Session, query = "") => (await call(session, "GET", `/bin${query}`)).body.items as Item[];

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const other = await createUser(`${label} other`);
  const created = await tasks(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as Array<{ id: string; name: string }>;
  expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId, other.userId] })).status).toBe(200);
  const addCard = async (title: string, columnId = columns[0]!.id, as: Session = owner) =>
    (await tasks(as, "POST", `/boards/${boardId}/cards`, { columnId, title })).body.card as { id: string };
  return { owner, member, other, boardId, columns, addCard };
}

async function attach(session: Session, cardId: string, name = "a.txt") {
  const form = new FormData();
  form.append("file", new Blob(["attached"]), name);
  const response = await request("/files?purpose=task_attachment", { method: "POST", body: form }, session);
  const document = ((await response.json()) as { document: { id: string } }).document;
  expect((await tasks(session, "POST", `/cards/${cardId}/attachments`, { documentId: document.id })).status).toBe(201);
  return document.id;
}
const documentRow = (id: string) => db.query("SELECT deleted_at, deleted_by, purpose, folder_id FROM documents WHERE id = ?").get(id) as { deleted_at: string | null; deleted_by: string | null; purpose: string; folder_id: string | null } | null;

describe("cards and boards in the Bin", () => {
  test("a binned card is listed for the board owner and its deleter only", async () => {
    const { owner, member, other, boardId, addCard } = await setup("Bin list");
    const card = await addCard("Binned by member");
    expect((await tasks(member, "DELETE", `/cards/${card.id}`)).status).toBe(200);
    const ownerItems = await binItems(owner);
    expect(ownerItems.find((item) => item.id === card.id)).toMatchObject({ type: "card", title: "Binned by member", board_id: boardId, board_name: "Bin list board", can_purge: true });
    expect((await binItems(member)).find((item) => item.id === card.id)).toMatchObject({ type: "card", can_purge: false });
    expect((await binItems(other)).some((item) => item.id === card.id)).toBe(false);
    expect((await binItems(owner, "?type=card")).map((item) => item.id)).toContain(card.id);
    expect((await binItems(owner, "?type=board")).some((item) => item.id === card.id)).toBe(false);
    // A deleter who loses access to the board no longer sees the card.
    await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [other.userId] });
    expect((await binItems(member)).some((item) => item.id === card.id)).toBe(false);
    expect((await call(member, "POST", `/bin/card/${card.id}/restore`)).status).toBe(404);
  });

  test("the deleter or the owner restores a card to its column, or the first column if it is gone", async () => {
    const { owner, member, other, boardId, columns, addCard } = await setup("Bin restore");
    const first = await addCard("Stays");
    const card = await addCard("Comes back", columns[1]!.id);
    await addCard("Later", columns[1]!.id);
    await tasks(member, "DELETE", `/cards/${card.id}`);
    expect((await call(other, "POST", `/bin/card/${card.id}/restore`)).status).toBe(404);
    const restored = await call(member, "POST", `/bin/card/${card.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ ok: true, boardId, boardName: "Bin restore board", columnId: columns[1]!.id, columnName: "Doing" });
    const board = (await tasks(owner, "GET", `/boards/${boardId}`)).body;
    // Back at the bottom of its column.
    expect(board.cards.filter((item: { column_id: string }) => item.column_id === columns[1]!.id).map((item: { title: string }) => item.title)).toEqual(["Later", "Comes back"]);
    expect((await call(member, "POST", `/bin/card/${card.id}/restore`)).body.alreadyRestored).toBe(true);

    await tasks(owner, "DELETE", `/cards/${card.id}`);
    await tasks(owner, "POST", `/cards/${(await addCard("Mover", columns[1]!.id)).id}/move`, { columnId: columns[2]!.id, afterCardId: null });
    for (const item of (await tasks(owner, "GET", `/boards/${boardId}`)).body.cards as Array<{ id: string; column_id: string }>) {
      if (item.column_id === columns[1]!.id) await tasks(owner, "DELETE", `/cards/${item.id}`);
    }
    expect((await tasks(owner, "DELETE", `/columns/${columns[1]!.id}`)).status).toBe(200);
    const moved = await call(owner, "POST", `/bin/card/${card.id}/restore`);
    expect(moved.body).toMatchObject({ ok: true, columnId: columns[0]!.id, columnName: "To do" });
    expect((await tasks(owner, "GET", `/cards/${card.id}`)).body.card.column_id).toBe(columns[0]!.id);
    expect(first.id).toBeTruthy();
  });

  test("Undo restores a card after its old neighbour, or at the bottom when the anchor is gone", async () => {
    const { owner, member, boardId, columns, addCard } = await setup("Bin undo");
    const doing = columns[1]!.id;
    const titles = async () => ((await tasks(owner, "GET", `/boards/${boardId}`)).body.cards as Array<{ column_id: string; title: string; position: number }>)
      .filter((item) => item.column_id === doing).sort((a, b) => a.position - b.position).map((item) => item.title);
    const a = await addCard("A", doing);
    const b = await addCard("B", doing);
    await addCard("C", doing);
    await tasks(member, "DELETE", `/cards/${b.id}`);
    const back = await call(member, "POST", `/bin/card/${b.id}/restore`, { columnId: doing, afterCardId: a.id });
    expect(back.body).toMatchObject({ ok: true, columnId: doing });
    expect(await titles()).toEqual(["A", "B", "C"]);

    // Top of the column.
    await tasks(member, "DELETE", `/cards/${a.id}`);
    await call(member, "POST", `/bin/card/${a.id}/restore`, { columnId: doing, afterCardId: null });
    expect(await titles()).toEqual(["A", "B", "C"]);

    // The neighbour went to the Bin meanwhile: bottom of the column.
    await tasks(member, "DELETE", `/cards/${b.id}`);
    await tasks(owner, "DELETE", `/cards/${a.id}`);
    await call(member, "POST", `/bin/card/${b.id}/restore`, { columnId: doing, afterCardId: a.id });
    expect(await titles()).toEqual(["C", "B"]);

    // A column from another board is ignored; the card returns to its own column.
    const foreign = (await tasks(owner, "POST", "/boards", { name: "Elsewhere" })).body.columns[0].id as string;
    await tasks(member, "DELETE", `/cards/${b.id}`);
    const kept = await call(member, "POST", `/bin/card/${b.id}/restore`, { columnId: foreign, afterCardId: null });
    expect(kept.body).toMatchObject({ ok: true, columnId: doing });
    expect(await titles()).toEqual(["C", "B"]);

    expect((await call(member, "POST", `/bin/card/${b.id}/restore`, { columnId: "nope" })).status).toBe(400);
  });

  test("cards on a binned board return BOARD_IN_BIN until the board is restored", async () => {
    const { owner, member, boardId, addCard } = await setup("Bin board");
    const card = await addCard("On the board");
    const binnedCard = await addCard("Binned first");
    await tasks(owner, "DELETE", `/cards/${binnedCard.id}`);
    expect((await tasks(owner, "DELETE", `/boards/${boardId}`)).status).toBe(200);
    expect((await binItems(owner)).find((item) => item.id === boardId)).toMatchObject({ type: "board", title: "Bin board board", can_purge: true });
    expect((await binItems(member)).some((item) => item.id === boardId)).toBe(false);
    expect((await call(member, "POST", `/bin/board/${boardId}/restore`)).status).toBe(404);
    const refused = await call(owner, "POST", `/bin/card/${binnedCard.id}/restore`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BOARD_IN_BIN");
    const restored = await call(owner, "POST", `/bin/board/${boardId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, boardId });
    expect((await tasks(member, "GET", `/cards/${card.id}`)).status).toBe(200);
    expect((await call(owner, "POST", `/bin/card/${binnedCard.id}/restore`)).status).toBe(200);
  });

  test("only the board owner deletes forever, and purging moves unused attachments to their uploader's Bin", async () => {
    const { owner, member, boardId, addCard } = await setup("Bin purge");
    const card = await addCard("With a file");
    const documentId = await attach(member, card.id);
    await tasks(member, "POST", `/cards/${card.id}/comments`, { body: "A comment" });
    expect((await call(owner, "DELETE", `/bin/card/${card.id}`)).body.code).toBe("NOT_IN_BIN");
    await tasks(member, "DELETE", `/cards/${card.id}`);
    // Binning keeps the link and the file.
    expect(documentRow(documentId)!.deleted_at).toBeNull();
    const forbidden = await call(member, "DELETE", `/bin/card/${card.id}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("OWNER_ONLY");
    expect((await call(owner, "DELETE", `/bin/card/${card.id}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM cards WHERE id = ?").get(card.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM card_comments WHERE card_id = ?").get(card.id)).toEqual({ count: 0 });
    // Binned by the attachment lifecycle (D395), it is recorded as removed by its uploader (U8).
    expect(documentRow(documentId)).toMatchObject({ deleted_by: member.userId });
    expect(documentRow(documentId)!.deleted_at).toBeTruthy();
    expect((await binItems(member)).find((item) => item.id === documentId)).toMatchObject({ type: "document", attachment: false, folder_name: "Attachments" });
    expect((await call(owner, "DELETE", `/bin/card/${card.id}`)).status).toBe(404);

    // Restoring the file brings it back as an ordinary Files item in Default.
    expect((await call(member, "POST", `/bin/document/${documentId}/restore`)).status).toBe(200);
    expect(documentRow(documentId)).toMatchObject({ deleted_at: null, purpose: "file" });
    expect(documentRow(documentId)!.folder_id).toBeTruthy();

    const other = await addCard("On the purged board");
    const boardFile = await attach(owner, other.id, "b.txt");
    await tasks(owner, "DELETE", `/boards/${boardId}`);
    expect((await call(owner, "DELETE", `/bin/board/${boardId}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM boards WHERE id = ?").get(boardId)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(boardId)).toEqual({ count: 0 });
    expect(documentRow(boardFile)!.deleted_at).toBeTruthy();
    const events = db.query("SELECT event_type FROM audit_log WHERE event_type IN ('task.card_purge', 'task.board_purge') AND actor_id = ?").all(owner.userId) as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["task.card_purge", "task.board_purge"]);
  });

  test("Empty Bin clears the owner's boards and the binned cards on their boards", async () => {
    const { owner, member, boardId, addCard } = await setup("Bin empty");
    const card = await addCard("Empty me");
    const second = await tasks(owner, "POST", "/boards", { name: "Second board" });
    await tasks(member, "DELETE", `/cards/${card.id}`);
    await tasks(owner, "DELETE", `/boards/${second.body.board.id}`);
    // The member's own Empty Bin does not touch cards on boards they do not own.
    await call(member, "DELETE", "/bin");
    expect(db.query("SELECT 1 FROM cards WHERE id = ?").get(card.id)).toBeTruthy();
    const emptied = await call(owner, "DELETE", "/bin");
    expect(emptied.body.purged).toBeGreaterThanOrEqual(2);
    expect(db.query("SELECT 1 FROM cards WHERE id = ?").get(card.id)).toBeNull();
    expect(db.query("SELECT 1 FROM boards WHERE id = ?").get(second.body.board.id)).toBeNull();
    expect(db.query("SELECT 1 FROM boards WHERE id = ?").get(boardId)).toBeTruthy();
  });

  test("the sweeper purges cards and boards after 30 days, and not a card restored since", async () => {
    const { owner, boardId, addCard } = await setup("Bin sweep");
    const expired = await addCard("Expired");
    const fresh = await addCard("Fresh");
    await tasks(owner, "DELETE", `/cards/${expired.id}`);
    await tasks(owner, "DELETE", `/cards/${fresh.id}`);
    const past = new Date(Date.now() - 1000).toISOString();
    db.query("UPDATE cards SET purge_after = ? WHERE id = ?").run(past, expired.id);
    await runSweep();
    expect(db.query("SELECT 1 FROM cards WHERE id = ?").get(expired.id)).toBeNull();
    expect(db.query("SELECT 1 FROM cards WHERE id = ?").get(fresh.id)).toBeTruthy();
    const other = await tasks(owner, "POST", "/boards", { name: "Old board" });
    await tasks(owner, "DELETE", `/boards/${other.body.board.id}`);
    db.query("UPDATE boards SET purge_after = ? WHERE id = ?").run(past, other.body.board.id);
    await runSweep();
    expect(db.query("SELECT 1 FROM boards WHERE id = ?").get(other.body.board.id)).toBeNull();
    expect(db.query("SELECT 1 FROM boards WHERE id = ?").get(boardId)).toBeTruthy();
  });
});

describe("restoring attachments", () => {
  test("an attachment restores into the Attachments folder, linked or not (review L1)", async () => {
    const { owner, member, addCard } = await setup("Restore attachment");
    const card = await addCard("Keeps its file");
    const linked = await attach(owner, card.id, "linked.txt");
    // Binned while still linked (deleted from Files, D409).
    expect((await request(`/files/${linked}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await request(`/files/${linked}/content`, {}, member)).status).toBe(404);
    expect((await binItems(owner)).find((item) => item.id === linked)).toMatchObject({ attachment: false, folder_name: "Attachments" });
    const restored = await call(owner, "POST", `/bin/document/${linked}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, folderName: "Attachments" });
    expect(documentRow(linked)).toMatchObject({ deleted_at: null, purpose: "file", folder_id: restored.body.folderId });
    expect((await request(`/files/${linked}/content`, {}, member)).status).toBe(200);
    // Listed in its owner's Files (the Attachments folder), never in the board member's.
    const files = (await (await request("/files", {}, owner)).json()) as { documents: Array<{ id: string }> };
    expect(files.documents.some((item) => item.id === linked)).toBe(true);
    const memberFiles = (await (await request("/files", {}, member)).json()) as { documents: Array<{ id: string }> };
    expect(memberFiles.documents.some((item) => item.id === linked)).toBe(false);

    // Unlinked: back in Attachments too (never a possibly shared Default, review L1).
    await tasks(owner, "DELETE", `/cards/${card.id}/attachments/${linked}`);
    expect(documentRow(linked)!.deleted_at).toBeTruthy();
    expect((await binItems(owner)).find((item) => item.id === linked)).toMatchObject({ attachment: false, attachment_of: null });
    const back = await call(owner, "POST", `/bin/document/${linked}/restore`);
    expect(back.body.folderName).toBe("Attachments");
    expect(documentRow(linked)).toMatchObject({ deleted_at: null, purpose: "file" });
    expect(documentRow(linked)!.folder_id).toBeTruthy();
  });
});
