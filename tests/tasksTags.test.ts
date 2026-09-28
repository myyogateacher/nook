import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { nextTagColor, TAG_AUTO_COLORS } from "../server/tasks/tags";

test("a tag without a colour takes the next unused palette colour, cycling by the board's tag count", () => {
  expect(TAG_AUTO_COLORS).not.toContain("gray");
  expect(nextTagColor([])).toBe("red");
  expect(nextTagColor(["red"])).toBe("orange");
  expect(nextTagColor(["gray", "gray"])).toBe("yellow");
  // The slot's colour is taken: the next free one after it.
  expect(nextTagColor(["orange", "red"])).toBe("yellow");
  expect(nextTagColor(["yellow", "green", "red"])).toBe("teal");
  // Every colour taken: the slot's colour, so the board keeps cycling.
  expect(nextTagColor([...TAG_AUTO_COLORS])).toBe("red");
  expect(nextTagColor([...TAG_AUTO_COLORS, "gray"])).toBe("orange");
});

/** Wave 13C board tags and card flags over the REST API (WAVE_13_TASK_CARD_UX.md D109, D110, T101, §7). */

type Column = { id: string; name: string };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const card = (await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Plan" })).body.card as { id: string; revision: number };
  return { owner, member, stranger, boardId, columns, card };
}

const lastAudit = (userId: string, event: string) => {
  const row = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY rowid DESC LIMIT 1").get(userId, event) as { metadata_json: string } | null;
  return row ? JSON.parse(row.metadata_json) as Record<string, unknown> : null;
};

describe("board tags (D109, T101)", () => {
  test("any reader creates a tag; names are unique ignoring case; the board lists tags with card counts", async () => {
    const { owner, member, stranger, boardId } = await setup("Tags");
    const created = await call(member, "POST", `/boards/${boardId}/tags`, { name: " Backend ", color: "blue" });
    expect(created.status).toBe(201);
    expect(created.body.tag).toMatchObject({ board_id: boardId, name: "Backend", color: "blue", card_count: 0 });
    expect(lastAudit(member.userId, "task.tag_create")).toEqual({ boardId, tagId: created.body.tag.id });
    const defaulted = await call(owner, "POST", `/boards/${boardId}/tags`, { name: "api" });
    // No colour chosen: the next one the board does not use yet, never grey (blue is taken).
    expect(defaulted.body.tag.color).toBe("orange");
    expect((await call(member, "POST", `/boards/${boardId}/tags`, { name: "web" })).body.tag.color).toBe("yellow");

    const clash = await call(owner, "POST", `/boards/${boardId}/tags`, { name: "BACKEND", color: "red" });
    expect(clash).toMatchObject({ status: 409, body: { code: "TAG_EXISTS", tag: { id: created.body.tag.id, name: "Backend", color: "blue" } } });
    // Non-ASCII case folding is caught by the service even though the NOCASE index is ASCII only.
    await call(owner, "POST", `/boards/${boardId}/tags`, { name: "Äpfel" });
    expect((await call(owner, "POST", `/boards/${boardId}/tags`, { name: "äpfel" })).body.code).toBe("TAG_EXISTS");

    for (const body of [{ name: "" }, { name: "x".repeat(41) }, { name: "bad‮name" }, { name: "ok", color: "black" }, { name: "ok", extra: 1 }]) {
      expect((await call(owner, "POST", `/boards/${boardId}/tags`, body)).status).toBe(400);
    }
    expect((await call(stranger, "POST", `/boards/${boardId}/tags`, { name: "Nope" })).status).toBe(404);

    const board = (await call(member, "GET", `/boards/${boardId}`)).body;
    expect(board.tags.map((tag: { name: string }) => tag.name)).toEqual(["api", "Backend", "web", "Äpfel"]);
    expect(board.cards[0]).toMatchObject({ tag_ids: [], flags: [] });
  });

  test("only the owner renames, recolours, or deletes; deleting unlinks the tag from every card", async () => {
    const { owner, member, stranger, boardId, columns, card } = await setup("Tag admin");
    const backend = (await call(member, "POST", `/boards/${boardId}/tags`, { name: "Backend" })).body.tag;
    const other = (await call(member, "POST", `/boards/${boardId}/tags`, { name: "Other" })).body.tag;
    expect((await call(member, "PATCH", `/tags/${backend.id}`, { name: "Server" })).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(member, "DELETE", `/tags/${backend.id}`)).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(stranger, "PATCH", `/tags/${backend.id}`, { name: "Server" })).status).toBe(404);
    expect((await call(stranger, "DELETE", `/tags/${backend.id}`)).status).toBe(404);
    expect((await call(owner, "PATCH", `/tags/${crypto.randomUUID()}`, { name: "Server" })).status).toBe(404);
    expect((await call(owner, "PATCH", `/tags/${backend.id}`, {})).status).toBe(400);
    expect((await call(owner, "PATCH", `/tags/${backend.id}`, { name: "other" })).body).toMatchObject({ code: "TAG_EXISTS", tag: { id: other.id } });
    // Renaming to a different case of its own name is fine.
    expect((await call(owner, "PATCH", `/tags/${backend.id}`, { name: "BACKEND" })).body.tag.name).toBe("BACKEND");
    const renamed = await call(owner, "PATCH", `/tags/${backend.id}`, { name: "Server", color: "green" });
    expect(renamed.body.tag).toMatchObject({ id: backend.id, name: "Server", color: "green" });
    expect(lastAudit(owner.userId, "task.tag_update")).toEqual({ boardId, tagId: backend.id, renamed: true, color: "green" });

    const second = (await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Second", tagIds: [backend.id, other.id] })).body.card;
    expect(second.tag_ids).toEqual([backend.id, other.id]);
    await call(member, "PATCH", `/cards/${card.id}`, { tagIds: [backend.id], revision: 1 });
    // A binned card's link counts toward removedFrom but not toward card_count.
    await call(member, "DELETE", `/cards/${second.id}`);
    expect((await call(member, "GET", `/boards/${boardId}`)).body.tags.find((tag: { id: string }) => tag.id === backend.id).card_count).toBe(1);

    const deleted = await call(owner, "DELETE", `/tags/${backend.id}`);
    expect(deleted.body).toEqual({ ok: true, removedFrom: 2 });
    expect(lastAudit(owner.userId, "task.tag_delete")).toEqual({ boardId, tagId: backend.id, removedFrom: 2 });
    const detail = (await call(member, "GET", `/cards/${card.id}`)).body.card;
    // Deleting a tag is not a card edit: the revision stays.
    expect(detail).toMatchObject({ tag_ids: [], revision: 2 });
    // Restore keeps the tags that still exist.
    expect((await request(`/bin/card/${second.id}/restore`, { method: "POST", body: "{}" }, member)).status).toBe(200);
    expect((await call(member, "GET", `/cards/${second.id}`)).body.card.tag_ids).toEqual([other.id]);
    expect((await call(owner, "DELETE", `/tags/${backend.id}`)).status).toBe(404);
  });

  test("a card's tag set goes through PATCH with the revision; foreign tags are 404 even for a reader of both boards", async () => {
    const { owner, member, boardId, columns, card } = await setup("Tag set");
    const tags = await Promise.all(["One", "Two", "Three"].map(async (name) => (await call(member, "POST", `/boards/${boardId}/tags`, { name })).body.tag.id as string));
    const otherBoard = await call(owner, "POST", "/boards", { name: "Tag set other" });
    const foreign = (await call(owner, "POST", `/boards/${otherBoard.body.board.id}/tags`, { name: "Foreign" })).body.tag.id as string;

    let patched = await call(member, "PATCH", `/cards/${card.id}`, { tagIds: [tags[1], tags[0], tags[1].toUpperCase()], revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ tag_ids: [tags[1], tags[0]], revision: 2 });
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ tagsAdded: 2, tagsRemoved: 0 });
    // Replacing keeps the order of those that stay.
    patched = await call(member, "PATCH", `/cards/${card.id}`, { tagIds: [tags[2], tags[0]], revision: 2 });
    expect(patched.body.card.tag_ids).toEqual([tags[0], tags[2]]);
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ tagsAdded: 1, tagsRemoved: 1 });
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.cards[0].tag_ids).toEqual([tags[0], tags[2]]);

    // The owner reads both boards, yet another board's tag looks missing, and nothing changes.
    const foreignPatch = await call(owner, "PATCH", `/cards/${card.id}`, { title: "Changed", tagIds: [tags[0], foreign], revision: 3 });
    expect(foreignPatch).toMatchObject({ status: 404, body: { error: "Tag not found" } });
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "No", tagIds: [foreign] })).status).toBe(404);
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "No", tagIds: [crypto.randomUUID()] })).status).toBe(404);
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card).toMatchObject({ title: "Plan", revision: 3 });
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(boardId) as { count: number }).count).toBe(1);

    const stale = await call(owner, "PATCH", `/cards/${card.id}`, { tagIds: [], revision: 2 });
    expect(stale).toMatchObject({ status: 409, body: { code: "CARD_CHANGED", card: { tag_ids: [tags[0], tags[2]], flags: [] } } });
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { tagIds: [], revision: 3 });
    expect(patched.body.card).toMatchObject({ tag_ids: [], revision: 4 });
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { tagIds: ["nope"], revision: 4 })).status).toBe(400);
  });

  test("caps: 10 tags per card and 100 per board", async () => {
    const { owner, member, boardId, card } = await setup("Tag caps");
    const ids: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const created = await call(index % 2 ? member : owner, "POST", `/boards/${boardId}/tags`, { name: `Tag ${index}` });
      expect(created.status).toBe(201);
      ids.push(created.body.tag.id);
    }
    expect((await call(member, "POST", `/boards/${boardId}/tags`, { name: "One more" })).body.code).toBe("LIMIT_REACHED");
    // An existing name still answers TAG_EXISTS at the cap, so a picker can reuse it.
    expect((await call(member, "POST", `/boards/${boardId}/tags`, { name: "tag 5" })).body.code).toBe("TAG_EXISTS");
    const eleven = await call(member, "PATCH", `/cards/${card.id}`, { tagIds: ids.slice(0, 11), revision: 1 });
    expect(eleven.status).toBe(400);
    expect(JSON.stringify(eleven.body)).toContain("up to 10 tags");
    expect((await call(member, "PATCH", `/cards/${card.id}`, { tagIds: ids.slice(0, 21), revision: 1 })).status).toBe(400);
    expect((await call(member, "PATCH", `/cards/${card.id}`, { tagIds: ids.slice(0, 10), revision: 1 })).body.card.tag_ids).toHaveLength(10);
  });
});

describe("card flags (D110)", () => {
  test("flags accept only the fixed set, once each, and come back in the fixed order", async () => {
    const { owner, member, boardId, columns, card } = await setup("Flags");
    let patched = await call(member, "PATCH", `/cards/${card.id}`, { flags: ["on_hold", "urgent"], revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ flags: ["urgent", "on_hold"], revision: 2 });
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ flags: ["on_hold", "urgent"] });
    for (const flags of [["urgent", "urgent"], ["important"], "urgent", ["urgent", "blocked", "needs_review", "on_hold", "urgent"]]) {
      expect((await call(member, "PATCH", `/cards/${card.id}`, { flags, revision: 2 })).status).toBe(400);
    }
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { flags: ["needs_review", "blocked", "urgent"], revision: 2 });
    expect(patched.body.card.flags).toEqual(["urgent", "blocked", "needs_review"]);
    const board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards[0].flags).toEqual(["urgent", "blocked", "needs_review"]);
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { flags: [], revision: 3 });
    expect(patched.body.card).toMatchObject({ flags: [], revision: 4 });

    const created = await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Flagged", flags: ["blocked"] });
    expect(created.body.card.flags).toEqual(["blocked"]);
    expect(lastAudit(member.userId, "task.card_create")).toMatchObject({ flags: ["blocked"] });
  });

  test("one patch of tags, flags, and title raises the revision by exactly 1; binned cards keep both", async () => {
    const { member, boardId, card } = await setup("Flags multi");
    const tag = (await call(member, "POST", `/boards/${boardId}/tags`, { name: "Mixed" })).body.tag.id as string;
    const patched = await call(member, "PATCH", `/cards/${card.id}`, { title: "Plan it", tagIds: [tag], flags: ["urgent"], revision: 1 });
    expect(patched.body.card).toMatchObject({ title: "Plan it", tag_ids: [tag], flags: ["urgent"], revision: 2 });
    expect((await call(member, "DELETE", `/cards/${card.id}`)).status).toBe(200);
    expect((await request(`/bin/card/${card.id}/restore`, { method: "POST", body: "{}" }, member)).status).toBe(200);
    expect((await call(member, "GET", `/cards/${card.id}`)).body.card).toMatchObject({ tag_ids: [tag], flags: ["urgent"] });
  });
});
