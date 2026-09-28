import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const other = await createUser(`${label} other`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId, other.userId] })).status).toBe(200);
  const card = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Discuss" })).body.card as { id: string };
  return { owner, member, other, stranger, boardId, columnId, cardId: card.id };
}

describe("card comments", () => {
  test("readers comment as themselves; the card returns its comments", async () => {
    const { owner, member, cardId, boardId } = await setup("Comment basics");
    const created = await call(member, "POST", `/cards/${cardId}/comments`, { body: "First!\nWith a line" });
    expect(created.status).toBe(201);
    expect(created.body.comment).toMatchObject({ card_id: cardId, author_id: member.userId, author_name: "Comment basics member", is_author: 1, body: "First!\nWith a line", edited_at: null });
    // The author is the session user; a spoofed author field is refused.
    expect((await call(member, "POST", `/cards/${cardId}/comments`, { body: "x", authorId: owner.userId })).status).toBe(400);
    const card = await call(owner, "GET", `/cards/${cardId}`);
    expect(card.body.comments.map((comment: { body: string; is_author: number }) => [comment.body, comment.is_author])).toEqual([["First!\nWith a line", 0]]);
    expect(card.body.hasMoreComments).toBe(false);
    const board = await call(owner, "GET", `/boards/${boardId}`);
    expect(board.body.cards[0].comment_count).toBe(1);
  });

  test("validates bodies", async () => {
    const { member, cardId } = await setup("Comment validation");
    for (const body of [{ body: "" }, { body: "   \n " }, { body: "é".repeat(8193) }, {}, { body: "ok", extra: true }]) {
      expect((await call(member, "POST", `/cards/${cardId}/comments`, body)).status).toBe(400);
    }
    expect((await call(member, "POST", `/cards/${cardId}/comments`, { body: "x".repeat(16_384) })).status).toBe(201);
  });

  test("only the author edits; the author or the board owner deletes", async () => {
    const { owner, member, other, stranger, cardId } = await setup("Comment rules");
    const comment = (await call(member, "POST", `/cards/${cardId}/comments`, { body: "Original" })).body.comment as { id: string };
    const ownerComment = (await call(owner, "POST", `/cards/${cardId}/comments`, { body: "Owner note" })).body.comment as { id: string };
    expect((await call(other, "PATCH", `/comments/${comment.id}`, { body: "Hijack" })).body.code).toBe("AUTHOR_ONLY");
    expect((await call(owner, "PATCH", `/comments/${comment.id}`, { body: "Hijack" })).status).toBe(403);
    expect((await call(stranger, "PATCH", `/comments/${comment.id}`, { body: "Hijack" })).status).toBe(404);
    const edited = await call(member, "PATCH", `/comments/${comment.id}`, { body: "Edited" });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.body).toBe("Edited");
    expect(edited.body.comment.edited_at).toBeTruthy();

    expect((await call(other, "DELETE", `/comments/${comment.id}`)).status).toBe(403);
    expect((await call(member, "DELETE", `/comments/${ownerComment.id}`)).status).toBe(403);
    expect((await call(stranger, "DELETE", `/comments/${comment.id}`)).status).toBe(404);
    expect((await call(owner, "DELETE", `/comments/${comment.id}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/comments/${ownerComment.id}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/comments/${comment.id}`)).status).toBe(404);
    expect((await call(owner, "GET", `/cards/${cardId}`)).body.comments).toEqual([]);
  });

  test("comments on a binned card or through a revoked membership are unreachable", async () => {
    const { owner, member, cardId, boardId } = await setup("Comment access");
    const comment = (await call(member, "POST", `/cards/${cardId}/comments`, { body: "Hi" })).body.comment as { id: string };
    await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "private", userIds: [] });
    expect((await call(member, "PATCH", `/comments/${comment.id}`, { body: "x" })).status).toBe(404);
    expect((await call(member, "POST", `/cards/${cardId}/comments`, { body: "x" })).status).toBe(404);
    expect((await call(member, "GET", `/cards/${cardId}/comments`)).status).toBe(404);
    await call(owner, "DELETE", `/cards/${cardId}`);
    expect((await call(owner, "DELETE", `/comments/${comment.id}`)).status).toBe(404);
    expect((await call(owner, "POST", `/cards/${cardId}/comments`, { body: "x" })).status).toBe(404);
  });

  test("comments page 50 at a time, newest page first, in chronological order", async () => {
    const { owner, cardId } = await setup("Comment pages");
    const insert = db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 120; index += 1) insert.run(crypto.randomUUID(), cardId, owner.userId, `c${index}`, new Date(base + index * 1000).toISOString());
    const first = await call(owner, "GET", `/cards/${cardId}`);
    expect(first.body.comments).toHaveLength(50);
    expect(first.body.comments[0].body).toBe("c70");
    expect(first.body.comments[49].body).toBe("c119");
    expect(first.body.hasMoreComments).toBe(true);
    const second = await call(owner, "GET", `/cards/${cardId}/comments?before=${first.body.comments[0].id}`);
    expect(second.body.comments.map((comment: { body: string }) => comment.body)).toEqual(Array.from({ length: 50 }, (_, index) => `c${index + 20}`));
    expect(second.body.hasMore).toBe(true);
    const third = await call(owner, "GET", `/cards/${cardId}/comments?before=${second.body.comments[0].id}`);
    expect(third.body.comments).toHaveLength(20);
    expect(third.body.hasMore).toBe(false);
    for (const query of ["limit=0", "limit=51", "limit=abc", "before=nope"]) expect((await call(owner, "GET", `/cards/${cardId}/comments?${query}`)).status).toBe(400);
    expect((await call(owner, "GET", `/cards/${cardId}/comments?before=${crypto.randomUUID()}`)).status).toBe(404);
  });

  test("comments posted in the same millisecond keep posting order across pages, whatever their random ids", async () => {
    const { owner, cardId } = await setup("Comment ties");
    const insert = db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)");
    const createdAt = new Date().toISOString();
    // Each later comment gets a smaller id, so an id tie-break would reverse them and page wrongly.
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort().reverse();
    ids.forEach((id, index) => insert.run(id, cardId, owner.userId, `t${index}`, createdAt));
    const bodies = (page: { body: Record<string, any> }) => page.body.comments.map((comment: { body: string }) => comment.body);
    expect(bodies(await call(owner, "GET", `/cards/${cardId}`))).toEqual(["t0", "t1", "t2"]);
    const newest = await call(owner, "GET", `/cards/${cardId}/comments?limit=2`);
    expect([bodies(newest), newest.body.hasMore]).toEqual([["t1", "t2"], true]);
    const older = await call(owner, "GET", `/cards/${cardId}/comments?limit=2&before=${ids[1]}`);
    expect([bodies(older), older.body.hasMore]).toEqual([["t0"], false]);
  });

  test("a card holds at most 500 comments", async () => {
    const { owner, member, cardId } = await setup("Comment cap");
    const insert = db.query("INSERT INTO card_comments (id, card_id, author_id, body, created_at) VALUES (?, ?, ?, 'x', ?)");
    db.transaction(() => { for (let index = 0; index < 500; index += 1) insert.run(crypto.randomUUID(), cardId, owner.userId, new Date().toISOString()); })();
    const refused = await call(member, "POST", `/cards/${cardId}/comments`, { body: "One more" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LIMIT_REACHED");
  });

  test("audits comments with ids only", async () => {
    const { member, cardId, boardId } = await setup("Comment audit");
    const comment = (await call(member, "POST", `/cards/${cardId}/comments`, { body: "Private words" })).body.comment as { id: string };
    await call(member, "PATCH", `/comments/${comment.id}`, { body: "More private words" });
    await call(member, "DELETE", `/comments/${comment.id}`);
    const events = db.query("SELECT event_type, metadata_json FROM audit_log WHERE actor_id = ? AND event_type LIKE 'task.comment_%' ORDER BY created_at, rowid").all(member.userId) as Array<{ event_type: string; metadata_json: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["task.comment_create", "task.comment_update", "task.comment_delete"]);
    for (const event of events) {
      expect(event.metadata_json).not.toContain("private");
      expect(JSON.parse(event.metadata_json)).toEqual({ boardId, cardId, commentId: comment.id });
    }
  });
});
