import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { hydrateBoard } from "../src/tasks/tasksApi";

/** Wave 13B card fields over the REST API (WAVE_13_TASK_CARD_UX.md §7, API tests). */

type Column = { id: string; name: string; is_done: 0 | 1 };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any>, headers: response.headers };
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

describe("multiple card assignees (D102, D103)", () => {
  test("set, replace, and clear assignees; the legacy fields mirror the first one", async () => {
    const { owner, member, boardId, card } = await setup("Many");
    let patched = await call(member, "PATCH", `/cards/${card.id}`, { assigneeIds: [member.userId, owner.userId, member.userId], revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.card.revision).toBe(2);
    expect(patched.body.card.assignees).toEqual([
      { id: member.userId, display_name: "Many member", can_read: 1 },
      { id: owner.userId, display_name: "Many owner", can_read: 1 }
    ]);
    expect(patched.body.card).toMatchObject({ assignee_id: member.userId, assignee_name: "Many member" });
    expect((db.query("SELECT assignee_id FROM cards WHERE id = ?").get(card.id) as { assignee_id: string }).assignee_id).toBe(member.userId);
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ assigneesAdded: 2, assigneesRemoved: 0 });

    // The board payload sends ids plus one users map (D113 trim); the card routes keep the objects.
    const board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards[0].assignee_ids).toEqual([member.userId, owner.userId]);
    // Wave 35 (D299): the map carries each person's picture URL beside the name (null without one).
    expect(board.users[member.userId]).toEqual({ display_name: "Many member", can_read: 1, avatar_url: null });
    expect(board.cards[0]).not.toHaveProperty("assignees");
    // The client rebuilds the in-memory shape from the trimmed payload.
    expect(hydrateBoard(board).cards[0]).toMatchObject({ board_id: boardId, assignees: patched.body.card.assignees });

    // Replacing keeps the order of those who stay; the mirror follows the new first assignee.
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [owner.userId], revision: 2 });
    expect(patched.body.card.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([owner.userId]);
    expect(patched.body.card).toMatchObject({ assignee_id: owner.userId, revision: 3 });
    expect(lastAudit(owner.userId, "task.card_update")).toMatchObject({ assigneesAdded: 0, assigneesRemoved: 1 });

    patched = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [], revision: 3 });
    expect(patched.body.card).toMatchObject({ assignees: [], assignee_id: null, assignee_name: null, revision: 4 });
    expect((db.query("SELECT assignee_id FROM cards WHERE id = ?").get(card.id) as { assignee_id: string | null }).assignee_id).toBeNull();
    expect((db.query("SELECT COUNT(*) AS count FROM card_assignees WHERE card_id = ?").get(card.id) as { count: number }).count).toBe(0);
  });

  test("the legacy assigneeId maps to one assignee or none, and is refused together with assigneeIds", async () => {
    const { owner, member, card } = await setup("Legacy");
    let patched = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: owner.userId, revision: 1 });
    expect(patched.body.card.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([owner.userId]);
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: member.userId, revision: 2 });
    expect(patched.body.card.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([member.userId]);
    expect(lastAudit(owner.userId, "task.card_update")).toMatchObject({ assigneeId: member.userId, assigneesAdded: 1, assigneesRemoved: 1 });
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: null, revision: 3 });
    expect(patched.body.card).toMatchObject({ assignees: [], assignee_id: null, revision: 4 });
    const both = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: owner.userId, assigneeIds: [owner.userId], revision: 4 });
    expect(both.status).toBe(400);
    expect(JSON.stringify(both.body)).toContain("not both");
  });

  test("the legacy assigneeId is refused on a card with several assignees instead of dropping them", async () => {
    const { owner, member, card } = await setup("Several");
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [owner.userId, member.userId], revision: 1 })).status).toBe(200);
    for (const assigneeId of [member.userId, null]) {
      const refused = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId, revision: 2 });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("ASSIGNEES_MULTIPLE");
      expect(refused.body.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([owner.userId, member.userId]);
    }
    // Nothing changed, and assigneeIds still replaces the whole set.
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card).toMatchObject({ revision: 2 });
    const replaced = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [member.userId], revision: 2 });
    expect(replaced.body.card.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([member.userId]);
    // Down to one assignee, the legacy field works again.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeId: owner.userId, revision: 3 })).body.card.assignee_id).toBe(owner.userId);
  });

  test("every new assignee must be able to read the board; a former member stays until removed (T93)", async () => {
    const { owner, member, stranger, boardId, card } = await setup("Access");
    const refused = await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [member.userId, stranger.userId], revision: 1 });
    expect(refused).toMatchObject({ status: 400, body: { code: "ASSIGNEE_NOT_MEMBER" } });
    // Nothing changed: the whole patch is refused.
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card).toMatchObject({ revision: 1, assignees: [] });
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [crypto.randomUUID()], revision: 1 })).body.code).toBe("ASSIGNEE_NOT_MEMBER");
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [member.userId, owner.userId], revision: 1 })).status).toBe(200);

    // The member loses access: they stay on the card as can_read 0, and a patch that keeps them still works.
    expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    const detail = (await call(owner, "GET", `/cards/${card.id}`)).body.card;
    expect(detail.assignees).toEqual([
      { id: member.userId, display_name: "Access member", can_read: 0 },
      { id: owner.userId, display_name: "Access owner", can_read: 1 }
    ]);
    const kept = await call(owner, "PATCH", `/cards/${card.id}`, { title: "Plan it", assigneeIds: [member.userId, owner.userId], revision: 2 });
    expect(kept.status).toBe(200);
    // Re-adding them after removal is refused.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [owner.userId], revision: 3 })).status).toBe(200);
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [owner.userId, member.userId], revision: 4 })).body.code).toBe("ASSIGNEE_NOT_MEMBER");
    // A disabled user reads as a former member too, even as the owner.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), owner.userId);
    const { assigneesForCard } = await import("../server/tasks/assignees");
    expect(assigneesForCard(card.id)).toEqual([{ id: owner.userId, display_name: "Access owner", can_read: 0 }]);
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(owner.userId);
  });

  test("create takes assigneeIds; caps, CARD_CHANGED with every field, and one revision per multi-field patch", async () => {
    const { owner, member, stranger, boardId, columns } = await setup("Create");
    const created = await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Two", assigneeIds: [owner.userId, member.userId] });
    expect(created.status).toBe(201);
    expect(created.body.card.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([owner.userId, member.userId]);
    expect(created.body.card).toMatchObject({ assignee_id: owner.userId, revision: 1 });
    const cardsBefore = (db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(boardId) as { count: number }).count;
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "No", assigneeIds: [stranger.userId] })).body.code).toBe("ASSIGNEE_NOT_MEMBER");
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(boardId) as { count: number }).count).toBe(cardsBefore);

    const cardId = created.body.card.id as string;
    const many = Array.from({ length: 21 }, () => crypto.randomUUID());
    expect((await call(owner, "PATCH", `/cards/${cardId}`, { assigneeIds: many, revision: 1 })).status).toBe(400);
    expect((await call(owner, "PATCH", `/cards/${cardId}`, { assigneeIds: ["not-a-uuid"], revision: 1 })).status).toBe(400);

    const multi = await call(owner, "PATCH", `/cards/${cardId}`, { title: "Two it", dueOn: "2026-11-01", assigneeIds: [member.userId], revision: 1 });
    expect(multi.body.card).toMatchObject({ title: "Two it", due_on: "2026-11-01", revision: 2, assignee_id: member.userId });
    const stale = await call(member, "PATCH", `/cards/${cardId}`, { assigneeIds: [], revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("CARD_CHANGED");
    expect(stale.body.card).toMatchObject({ title: "Two it", due_on: "2026-11-01", revision: 2, description: "" });
    expect(stale.body.card.assignees).toEqual([{ id: member.userId, display_name: "Create member", can_read: 1 }]);
  });

  test("binned cards keep their assignees and bring them back on restore", async () => {
    const { owner, member, card } = await setup("Bin keep");
    await call(owner, "PATCH", `/cards/${card.id}`, { assigneeIds: [member.userId, owner.userId], revision: 1 });
    expect((await call(owner, "DELETE", `/cards/${card.id}`)).status).toBe(200);
    expect((db.query("SELECT COUNT(*) AS count FROM card_assignees WHERE card_id = ?").get(card.id) as { count: number }).count).toBe(2);
    const restored = await request(`/bin/card/${card.id}/restore`, { method: "POST", body: "{}" }, owner);
    expect(restored.status).toBe(200);
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card.assignees.map((assignee: { id: string }) => assignee.id)).toEqual([member.userId, owner.userId]);
  });
});

describe("the assignee picker: GET /boards/:b/readers?q= (T92)", () => {
  test("lists only readers, by display name, filtered by q and capped by limit", async () => {
    const { owner, member, stranger, boardId } = await setup("Picker");
    const all = await call(member, "GET", `/boards/${boardId}/readers`);
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ users: [{ id: member.userId, displayName: "Picker member" }, { id: owner.userId, displayName: "Picker owner" }], truncated: false });
    const found = await call(member, "GET", `/boards/${boardId}/readers?q=${encodeURIComponent("OWN")}`);
    expect(found.body).toEqual({ users: [{ id: owner.userId, displayName: "Picker owner" }], truncated: false });
    // The stranger's name matches, but they cannot read the board.
    expect((await call(member, "GET", `/boards/${boardId}/readers?q=stranger`)).body.users).toEqual([]);
    expect((await call(member, "GET", `/boards/${boardId}/readers?q=${encodeURIComponent("%")}`)).body.users).toEqual([]);
    const capped = await call(member, "GET", `/boards/${boardId}/readers?q=Picker&limit=1`);
    expect(capped.body).toEqual({ users: [{ id: member.userId, displayName: "Picker member" }], truncated: true });
    // Only ids and display names, never emails.
    expect(JSON.stringify(all.body)).not.toContain("@");
    expect((await call(stranger, "GET", `/boards/${boardId}/readers?q=Picker`)).status).toBe(404);
    for (const query of ["q=", `q=${"x".repeat(65)}`, "q=a&limit=0", "q=a&limit=51", "q=a&limit=two", "limit=5"]) {
      expect((await call(member, "GET", `/boards/${boardId}/readers?${query}`)).status).toBe(400);
    }
    // An all_users board lists every enabled user who matches.
    expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "all_users", userIds: [] })).status).toBe(200);
    expect((await call(member, "GET", `/boards/${boardId}/readers?q=Picker%20stranger`)).body.users).toEqual([{ id: stranger.userId, displayName: "Picker stranger" }]);
  });

  test("is rate limited to 60 requests a minute per user", async () => {
    const { owner, boardId } = await setup("Picker limit");
    let last = 0;
    for (let index = 0; index < 60; index += 1) last = (await call(owner, "GET", `/boards/${boardId}/readers?q=a`)).status;
    expect(last).toBe(200);
    const limited = await call(owner, "GET", `/boards/${boardId}/readers?q=a`);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("optional due time with a time zone (D100, D101, T94)", () => {
  test("set, move, and clear a due time; responses carry due_at", async () => {
    const { owner, member, boardId, columns, card } = await setup("Due time");
    let patched = await call(member, "PATCH", `/cards/${card.id}`, { dueOn: "2026-10-01", dueTime: "17:30", dueTz: "Europe/Berlin", revision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ due_on: "2026-10-01", due_time: "17:30", due_tz: "Europe/Berlin", due_at: "2026-10-01T15:30:00.000Z", revision: 2 });
    expect(lastAudit(member.userId, "task.card_update")).toMatchObject({ dueOn: "2026-10-01", dueTime: "set" });
    const board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards[0]).toMatchObject({ due_time: "17:30", due_tz: "Europe/Berlin", due_at: "2026-10-01T15:30:00.000Z" });

    // Moving the date keeps the wall time and zone.
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: "2026-10-30", revision: 2 });
    expect(patched.body.card).toMatchObject({ due_on: "2026-10-30", due_time: "17:30", due_tz: "Europe/Berlin", due_at: "2026-10-30T16:30:00.000Z" });
    // A browser alias is stored as sent.
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { dueTime: "09:00", dueTz: "Asia/Calcutta", revision: 3 });
    expect(patched.body.card).toMatchObject({ due_time: "09:00", due_tz: "Asia/Calcutta", due_at: "2026-10-30T03:30:00.000Z" });
    // Clearing only the time keeps the date.
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { dueTime: null, revision: 4 });
    expect(patched.body.card).toMatchObject({ due_on: "2026-10-30", due_time: null, due_tz: null, due_at: null });
    expect(lastAudit(owner.userId, "task.card_update")).toMatchObject({ dueTime: "cleared" });
    // Clearing the date also clears the time.
    await call(owner, "PATCH", `/cards/${card.id}`, { dueTime: "08:00", dueTz: "UTC", revision: 5 });
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: null, revision: 6 });
    expect(patched.body.card).toMatchObject({ due_on: null, due_time: null, due_tz: null, due_at: null, revision: 7 });

    const created = await call(member, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Timed", dueOn: "2026-10-01", dueTime: "23:30", dueTz: "Pacific/Kiritimati" });
    expect(created.status).toBe(201);
    expect(created.body.card).toMatchObject({ due_time: "23:30", due_tz: "Pacific/Kiritimati", due_at: "2026-10-01T09:30:00.000Z" });
  });

  test("400 for a time without a zone or date, a bad zone, 24:00, or 9:5; nothing is written", async () => {
    const { owner, boardId, columns, card } = await setup("Due time bad");
    const bodies = [
      { dueOn: "2026-10-01", dueTime: "17:00" },
      { dueTime: "17:00", dueTz: "UTC" },
      { dueOn: "2026-10-01", dueTime: "17:00", dueTz: "Mars/Olympus" },
      { dueOn: "2026-10-01", dueTime: "24:00", dueTz: "UTC" },
      { dueOn: "2026-10-01", dueTime: "9:5", dueTz: "UTC" },
      { dueOn: "2026-10-01", dueTz: "UTC" },
      { dueOn: "2026-10-01", dueTime: 1700, dueTz: "UTC" }
    ];
    for (const body of bodies) {
      expect((await call(owner, "PATCH", `/cards/${card.id}`, { ...body, revision: 1 })).status).toBe(400);
      expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Bad", ...body })).status).toBe(400);
    }
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card).toMatchObject({ revision: 1, due_on: null, due_time: null });
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(boardId) as { count: number }).count).toBe(1);
    // A timed card cannot lose its date while keeping the time.
    await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: "2026-10-01", dueTime: "10:00", dueTz: "UTC", revision: 1 });
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: null, dueTime: "10:00", dueTz: "UTC", revision: 2 })).status).toBe(400);
  });
});

describe("owner-set WIP limits (D108, T96)", () => {
  test("only the owner sets a limit of 1–1000 or null; columns carry wip_limit", async () => {
    const { owner, member, stranger, boardId, columns } = await setup("WIP set");
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.columns.map((column: { wip_limit: number | null }) => column.wip_limit)).toEqual([null, null, null]);
    expect((await call(member, "PATCH", `/columns/${columns[1].id}`, { wipLimit: 2 })).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(stranger, "PATCH", `/columns/${columns[1].id}`, { wipLimit: 2 })).status).toBe(404);
    for (const wipLimit of [0, 1001, 2.5, "2"]) expect((await call(owner, "PATCH", `/columns/${columns[1].id}`, { wipLimit })).status).toBe(400);
    const set = await call(owner, "PATCH", `/columns/${columns[1].id}`, { wipLimit: 2 });
    expect(set.status).toBe(200);
    expect(set.body.column.wip_limit).toBe(2);
    expect(lastAudit(owner.userId, "task.column_wip")).toEqual({ boardId, columnId: columns[1].id, wipLimit: 2 });
    expect((await call(member, "GET", `/boards/${boardId}`)).body.columns[1].wip_limit).toBe(2);
    expect((await call(owner, "PATCH", `/columns/${columns[1].id}`, { wipLimit: null })).body.column.wip_limit).toBeNull();
  });

  test("create and cross-column moves into a full column get 409 COLUMN_FULL; within, out, and restore still work", async () => {
    const { owner, member, boardId, columns, card } = await setup("WIP enforce");
    const [todo, doing] = columns;
    const second = (await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "Second" })).body.card as { id: string };
    // A limit below the current count is allowed.
    expect((await call(owner, "PATCH", `/columns/${todo.id}`, { wipLimit: 1 })).status).toBe(200);
    const full = await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "Third" });
    expect(full).toMatchObject({ status: 409, body: { code: "COLUMN_FULL", columnId: todo.id, wipLimit: 1, cardCount: 2 } });
    // Within the column: allowed, even over the limit.
    expect((await call(member, "POST", `/cards/${second.id}/move`, { columnId: todo.id, afterCardId: null })).status).toBe(200);
    // Out of the column: allowed.
    expect((await call(member, "POST", `/cards/${second.id}/move`, { columnId: doing.id, afterCardId: null })).status).toBe(200);
    // Back in while it is still at the limit: refused.
    expect((await call(member, "POST", `/cards/${second.id}/move`, { columnId: todo.id, afterCardId: null })).body).toMatchObject({ code: "COLUMN_FULL", cardCount: 1 });
    // Bin restore ignores the limit.
    expect((await call(member, "DELETE", `/cards/${card.id}`)).status).toBe(200);
    expect((await call(member, "POST", `/cards/${second.id}/move`, { columnId: todo.id, afterCardId: null })).status).toBe(200);
    const restored = await request(`/bin/card/${card.id}/restore`, { method: "POST", body: "{}" }, member);
    expect(restored.status).toBe(200);
    expect(((await call(owner, "GET", `/boards/${boardId}`)).body.cards as Array<{ column_id: string }>).filter((item) => item.column_id === todo.id)).toHaveLength(2);
    // Removing the limit lets cards in again.
    expect((await call(owner, "PATCH", `/columns/${todo.id}`, { wipLimit: null })).status).toBe(200);
    expect((await call(member, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "Third" })).status).toBe(201);
  });

  test("parallel creates and moves stay within the limit (board lock)", async () => {
    const { owner, member, boardId, columns, card } = await setup("WIP race");
    const [, doing] = columns;
    expect((await call(owner, "PATCH", `/columns/${doing.id}`, { wipLimit: 3 })).status).toBe(200);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, index) => call(index % 2 ? owner : member, "POST", `/boards/${boardId}/cards`, { columnId: doing.id, title: `Race ${index}` })),
      call(member, "POST", `/cards/${card.id}/move`, { columnId: doing.id, afterCardId: null })
    ]);
    expect(results.filter((result) => result.status === 409).every((result) => result.body.code === "COLUMN_FULL")).toBe(true);
    expect(results.filter((result) => result.status < 300)).toHaveLength(3);
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE column_id = ? AND deleted_at IS NULL").get(doing.id) as { count: number }).count).toBe(3);
  });
});
