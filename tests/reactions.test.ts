import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { REACTION_RATE_LIMIT, reactionAggregates, resetReactionRateLimit, setReaction } from "../server/reactions/service";
import { reactionTarget, reactionTargetKinds, registerReactionTarget } from "../server/reactions/targets";
import { isReactionKey, REACTION_KEYS, REACTIONS } from "../shared/reactions";

/** WAVES_18-20_SMALL.md §3 (Wave 20, D182–D190, T150–T153). */
async function call(session: Session, method: string, path: string, body?: unknown) {
  // Reaction writes have an empty JSON body; the JSON Content-Type and CSRF rules still apply.
  const response = await request(path, method === "GET" ? {} : { method, body: body === undefined ? "" : JSON.stringify(body) }, session);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
const react = (session: Session, commentId: string, emoji: string) => call(session, "PUT", `/tasks/comments/${commentId}/reactions/${emoji}`);
const unreact = (session: Session, commentId: string, emoji: string) => call(session, "DELETE", `/tasks/comments/${commentId}/reactions/${emoji}`);
const rows = (commentId: string) => (db.query("SELECT COUNT(*) AS count FROM reactions WHERE target_id = ?").get(commentId) as { count: number }).count;

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/tasks/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const cardId = (await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Discuss" })).body.card.id as string;
  const commentId = (await call(owner, "POST", `/tasks/cards/${cardId}/comments`, { body: "Ship it?" })).body.comment.id as string;
  return { owner, member, stranger, boardId, columnId, cardId, commentId };
}

describe("reactions: the curated set and the registry", () => {
  test("twelve stable keys with glyphs; only card_comment is registered in v1", () => {
    expect(REACTION_KEYS).toEqual(["thumbs_up", "thumbs_down", "heart", "laugh", "tada", "eyes", "rocket", "check", "fire", "thinking", "pray", "sad"]);
    for (const reaction of REACTIONS) expect(reaction.key).toMatch(/^[a-z_]{1,24}$/);
    expect(new Set(REACTIONS.map((reaction) => reaction.glyph)).size).toBe(12);
    expect(isReactionKey("thumbs_up")).toBe(true);
    for (const value of ["👍", "Thumbs_up", "toString", "__proto__", "", null, 1]) expect(isReactionKey(value)).toBe(false);
    expect(reactionTargetKinds()).toEqual(["card_comment"]);
    expect(reactionTarget("message")).toBeNull();
    expect(() => registerReactionTarget({ kind: "card_comment", readable: () => null, writable: () => false })).toThrow();
    expect(() => registerReactionTarget({ kind: "Bad-Kind", readable: () => null, writable: () => false })).toThrow();
  });
});

describe("reactions on card comments", () => {
  test("PUT and DELETE are idempotent set-state and return the target's aggregates", async () => {
    const { owner, member, commentId } = await setup("React idempotent");
    const first = await react(member, commentId, "thumbs_up");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ reactions: [{ emoji: "thumbs_up", count: 1, reacted: true, names: [], more: 0 }] });
    // A double tap or a retry never flips twice.
    expect((await react(member, commentId, "thumbs_up")).body).toEqual(first.body);
    expect(rows(commentId)).toBe(1);
    const both = await react(owner, commentId, "thumbs_up");
    expect(both.body.reactions).toEqual([{ emoji: "thumbs_up", count: 2, reacted: true, names: ["React idempotent member"], more: 0 }]);
    expect((await unreact(member, commentId, "thumbs_up")).body.reactions).toEqual([{ emoji: "thumbs_up", count: 1, reacted: false, names: ["React idempotent owner"], more: 0 }]);
    const absent = await unreact(member, commentId, "thumbs_up");
    expect(absent.status).toBe(200);
    expect(absent.body.reactions[0]).toMatchObject({ count: 1, reacted: false });
    expect(rows(commentId)).toBe(1);
    // The generic path is the same operation.
    expect((await call(member, "PUT", `/reactions/card_comment/${commentId}/rocket`)).body.reactions.map((item: { emoji: string }) => item.emoji)).toEqual(["thumbs_up", "rocket"]);
    expect((await call(member, "DELETE", `/reactions/card_comment/${commentId}/rocket`)).status).toBe(200);
    expect(rows(commentId)).toBe(1);
  });

  test("validation: unknown emoji is 400, unknown kind or target is 404, JSON and CSRF rules apply", async () => {
    const { member, commentId } = await setup("React validation");
    for (const emoji of ["smile", "Thumbs_up", encodeURIComponent("👍"), "thumbs_up%20", "__proto__"]) {
      const response = await react(member, commentId, emoji);
      expect({ emoji, status: response.status, code: response.body?.code }).toEqual({ emoji, status: 400, code: "INVALID_EMOJI" });
    }
    expect((await call(member, "PUT", `/reactions/message/${commentId}/heart`)).status).toBe(404);
    expect((await call(member, "PUT", `/reactions/Card/${commentId}/heart`)).status).toBe(404);
    expect((await call(member, "PUT", `/reactions/card_comment/not-a-uuid/heart`)).status).toBe(404);
    expect((await react(member, crypto.randomUUID(), "heart")).status).toBe(404);
    const noType = await request(`/tasks/comments/${commentId}/reactions/heart`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "" }, member);
    expect(noType.status).toBe(415);
    const noCsrf = await request(`/tasks/comments/${commentId}/reactions/heart`, { method: "PUT", headers: { "X-CSRF-Token": "wrong" }, body: "" }, member);
    expect(noCsrf.status).toBe(403);
    expect(rows(commentId)).toBe(0);
  });

  test("unreadable targets are 404: a private board, a revoked member, a binned card (restored reactions reappear)", async () => {
    const { owner, member, stranger, boardId, cardId, commentId } = await setup("React access");
    expect((await react(stranger, commentId, "heart")).status).toBe(404);
    expect((await react(member, commentId, "heart")).status).toBe(200);
    // Binned: hidden and refused until restored.
    expect((await call(owner, "DELETE", `/tasks/cards/${cardId}`)).status).toBe(200);
    expect((await react(member, commentId, "eyes")).status).toBe(404);
    expect((await unreact(member, commentId, "heart")).status).toBe(404);
    expect(rows(commentId)).toBe(1);
    expect((await call(owner, "POST", `/bin/card/${cardId}/restore`, {})).status).toBe(200);
    expect((await call(owner, "GET", `/tasks/cards/${cardId}`)).body.comments[0].reactions).toEqual([{ emoji: "heart", count: 1, reacted: false, names: ["React access member"], more: 0 }]);
    // Unshared: the former member gets 404 like a stranger.
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "private", userIds: [] });
    expect((await unreact(member, commentId, "heart")).status).toBe(404);
    expect(rows(commentId)).toBe(1);
  });

  test("viewers and guests see reactions but get 403 ROLE_READ_ONLY on writes", async () => {
    const { owner, boardId, cardId, commentId } = await setup("React roles");
    const viewer = await createUser("React roles viewer");
    const guest = await createUser("React roles guest");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [viewer.userId, guest.userId] });
    await react(owner, commentId, "tada");
    for (const session of [viewer, guest]) {
      for (const path of [`/tasks/comments/${commentId}/reactions/tada`, `/reactions/card_comment/${commentId}/tada`]) {
        for (const method of ["PUT", "DELETE"]) {
          const response = await call(session, method, path);
          expect({ path, method, status: response.status, code: response.body?.code }).toEqual({ path, method, status: 403, code: "ROLE_READ_ONLY" });
        }
      }
    }
    expect((await call(viewer, "GET", `/tasks/cards/${cardId}`)).body.comments[0].reactions).toEqual([{ emoji: "tada", count: 1, reacted: false, names: ["React roles owner"], more: 0 }]);
    // Defence in depth behind the gate: the service refuses them too.
    await expect(setReaction(viewer.userId, "card_comment", commentId, "tada", true)).rejects.toMatchObject({ status: 403, code: "ROLE_READ_ONLY" });
    expect(rows(commentId)).toBe(1);
  });

  test("60 writes a minute per user; the 61st is 429 RATE_LIMITED with Retry-After", async () => {
    resetReactionRateLimit();
    const { owner, member, commentId } = await setup("React rate");
    for (let index = 0; index < REACTION_RATE_LIMIT; index += 1) {
      const response = index % 2 === 0 ? await react(member, commentId, "fire") : await unreact(member, commentId, "fire");
      expect(response.status).toBe(200);
    }
    const limited = await react(member, commentId, "fire");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Slow down a little.", code: "RATE_LIMITED" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Per user: someone else still reacts.
    expect((await react(owner, commentId, "fire")).status).toBe(200);
    resetReactionRateLimit();
    expect((await react(member, commentId, "fire")).status).toBe(200);
  });

  test("aggregates: counts, reacted, ordering by first reaction, names ≤10 with more, blocked accounts left out", async () => {
    const { owner, boardId, cardId, commentId } = await setup("React aggregates");
    const people: Session[] = [];
    for (let index = 0; index < 12; index += 1) people.push(await createUser(`React aggregates p${String(index).padStart(2, "0")}`));
    await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: people.map((person) => person.userId) });
    await react(people[0]!, commentId, "eyes");
    for (const person of people) await react(person, commentId, "heart");
    await react(owner, commentId, "heart");
    // Several writes share a millisecond: pin the times so "oldest first" is observable. Heart's first
    // reaction is earlier than eyes', so heart leads.
    const stamp = db.query("UPDATE reactions SET created_at = ? WHERE target_id = ? AND user_id = ? AND emoji = ?");
    people.forEach((person, index) => stamp.run(`2026-01-01T00:00:${String(10 + index).padStart(2, "0")}.000Z`, commentId, person.userId, "heart"));
    stamp.run("2026-01-01T00:00:30.000Z", commentId, people[0]!.userId, "eyes");
    stamp.run("2026-01-01T00:00:40.000Z", commentId, owner.userId, "heart");
    const seen = (await call(owner, "GET", `/tasks/cards/${cardId}/comments`)).body.comments[0].reactions as Array<Record<string, any>>;
    expect(seen.map((item) => item.emoji)).toEqual(["heart", "eyes"]);
    expect(seen[0]).toEqual({ emoji: "heart", count: 13, reacted: true, names: people.slice(0, 10).map((_, index) => `React aggregates p${String(index).padStart(2, "0")}`), more: 2 });
    // Blocked: kept, but not counted or named; unblocking brings them back.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), people[0]!.userId);
    const blocked = (await call(owner, "GET", `/tasks/cards/${cardId}`)).body.comments[0].reactions as Array<Record<string, any>>;
    expect(blocked.map((item) => [item.emoji, item.count])).toEqual([["heart", 12]]);
    expect(blocked[0]!.names[0]).toBe("React aggregates p01");
    expect(blocked[0]!.names).not.toContain("React aggregates p00");
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(people[0]!.userId);
    expect(((await call(owner, "GET", `/tasks/cards/${cardId}`)).body.comments[0].reactions as unknown[]).length).toBe(2);
    // Direct: an empty list is an empty map; unknown ids have no entry.
    expect(reactionAggregates("card_comment", owner.userId, []).size).toBe(0);
    expect(reactionAggregates("card_comment", owner.userId, [crypto.randomUUID()]).size).toBe(0);
  });

  test("comment payloads carry reactions from one aggregate query per page; card revision and updated_at are untouched", async () => {
    const { owner, member, cardId, commentId } = await setup("React payloads");
    const second = (await call(member, "POST", `/tasks/cards/${cardId}/comments`, { body: "Second" })).body.comment;
    expect(second.reactions).toEqual([]);
    const before = db.query("SELECT revision, updated_at FROM cards WHERE id = ?").get(cardId);
    await react(member, commentId, "check");
    await react(owner, second.id, "pray");
    expect(db.query("SELECT revision, updated_at FROM cards WHERE id = ?").get(cardId)).toEqual(before);
    const edited = await call(member, "PATCH", `/tasks/comments/${second.id}`, { body: "Second, edited" });
    expect(edited.body.comment.reactions).toEqual([{ emoji: "pray", count: 1, reacted: false, names: ["React payloads owner"], more: 0 }]);

    const original = db.query.bind(db);
    let aggregateQueries = 0;
    (db as { query: typeof db.query }).query = ((sql: string) => {
      if (sql.includes("FROM reactions")) aggregateQueries += 1;
      return original(sql);
    }) as typeof db.query;
    try {
      const page = await call(member, "GET", `/tasks/cards/${cardId}/comments`);
      expect(page.body.comments.map((comment: { reactions: Array<{ emoji: string; reacted: boolean }> }) => comment.reactions.map((item) => [item.emoji, item.reacted]))).toEqual([[["check", true]], [["pray", false]]]);
      expect(aggregateQueries).toBe(1);
    } finally {
      (db as { query: typeof db.query }).query = original;
    }
  });

  test("deleting a comment, purging a card, or purging a board leaves no reaction rows", async () => {
    const { owner, member, boardId, columnId, cardId, commentId } = await setup("React cleanup");
    await react(member, commentId, "sad");
    await react(owner, commentId, "sad");
    expect((await call(owner, "DELETE", `/tasks/comments/${commentId}`)).status).toBe(200);
    expect(rows(commentId)).toBe(0);

    const kept = (await call(owner, "POST", `/tasks/cards/${cardId}/comments`, { body: "Kept" })).body.comment.id as string;
    await react(member, kept, "laugh");
    await call(owner, "DELETE", `/tasks/cards/${cardId}`);
    expect((await call(owner, "DELETE", `/bin/card/${cardId}`)).status).toBe(200);
    expect(rows(kept)).toBe(0);

    const other = (await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title: "Other" })).body.card.id as string;
    const onBoard = (await call(owner, "POST", `/tasks/cards/${other}/comments`, { body: "On board" })).body.comment.id as string;
    await react(member, onBoard, "rocket");
    expect((await call(owner, "DELETE", `/tasks/boards/${boardId}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/bin/board/${boardId}`)).status).toBe(200);
    expect(rows(onBoard)).toBe(0);
  });
});
