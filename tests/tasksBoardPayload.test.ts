import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

/**
 * The D113 measurement (WAVE_13_TASK_CARD_UX.md §7, "Board payload"): the
 * plan's worst case, 1000 live cards each with 3 assignees, 3 tags, 2 flags,
 * a due time, and a 160-character excerpt, against the same 1000 cards with
 * no Wave 13 data. Rows are inserted directly so the fixture builds fast.
 *
 * Measured in 13C (recorded in the plan's D113 note): the full board is about
 * 1.25–1.39 MB of JSON depending on display-name length, over the plan's 1 MB
 * target, so this test guards against growth past 1.5 MB instead and the
 * director decides the D113 follow-up. 17A adds four hierarchy fields to each
 * card (`parent_card_id`, `level`, `child_count`, `done_child_count`, about
 * 75 bytes a card, 1.50 MB for this fixture), so the ceiling was 1.6 MB; the
 * research plan's bound is 1.5× the v0.8 payload. The D113 trim (v0.9.0) sends assignees as
 * `assignee_ids` plus one board-level `users` map and drops the per-card `board_id` and the
 * deprecated `assignee_id`/`assignee_name`: 1.15 MB for this fixture (1.11 MB with short
 * names, from 1.52 MB), so the ceiling is 1.2 MB. Set MYNOTES_PAYLOAD_REPORT=1 to print
 * sizes (raw and gzip) and median timings, and MYNOTES_PAYLOAD_SHORT=1 for
 * short display names.
 */

const CARDS = 1000;
const CEILING_BYTES = 1_200_000;
const short = Boolean(process.env.MYNOTES_PAYLOAD_SHORT);

async function boardJson(session: Session, boardId: string) {
  const started = performance.now();
  const response = await request(`/tasks/boards/${boardId}`, {}, session);
  const text = await response.text();
  return { status: response.status, text, bytes: Buffer.byteLength(text, "utf8"), ms: performance.now() - started };
}

async function fixture(label: string, full: boolean) {
  const owner = await createUser(short ? "Asha Rao" : `${label} owner with a longer display name`);
  const members = [await createUser(short ? "Ben Ito" : `${label} member one`), await createUser(short ? "Cy Diaz" : `${label} member two`)];
  const created = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: `${label} board` }) }, owner);
  const { board, columns } = await created.json() as { board: { id: string }; columns: Array<{ id: string }> };
  await request(`/tasks/boards/${board.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: members.map((member) => member.userId) }) }, owner);
  const timestamp = new Date().toISOString();
  const tagIds = Array.from({ length: 12 }, () => crypto.randomUUID());
  const excerpt = "Plan the rollout with the team and check every dependency before the release window opens. ".repeat(2).slice(0, 159) + "…";
  db.transaction(() => {
    const insertTag = db.query("INSERT INTO board_tags (id, board_id, name, color, created_by, created_at, updated_at) VALUES (?, ?, ?, 'blue', ?, ?, ?)");
    tagIds.forEach((id, index) => insertTag.run(id, board.id, `Tag number ${index}`, owner.userId, timestamp, timestamp));
    const insertCard = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, description, description_excerpt, due_on, due_time, due_tz, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertAssignee = db.query("INSERT INTO card_assignees (card_id, user_id, assigned_by, created_at) VALUES (?, ?, ?, ?)");
    const insertTagLink = db.query("INSERT INTO card_tags (card_id, tag_id, created_at) VALUES (?, ?, ?)");
    const insertFlag = db.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)");
    for (let index = 0; index < CARDS; index += 1) {
      const id = crypto.randomUUID();
      // Due dates spread over three months, so the instants are not all the same.
      const dueOn = `2026-${String(10 + (index % 3)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`;
      insertCard.run(id, board.id, columns[index % columns.length]!.id, (index + 1) * 1024, `Card ${index}: a realistic title of some length`,
        full ? `${excerpt} and more` : "", full ? excerpt : "", full ? dueOn : null, full ? "17:30" : null, full ? "Europe/Berlin" : null, owner.userId, timestamp, timestamp);
      if (!full) continue;
      for (const user of [owner, ...members]) insertAssignee.run(id, user.userId, owner.userId, timestamp);
      for (let tag = 0; tag < 3; tag += 1) insertTagLink.run(id, tagIds[(index + tag) % tagIds.length]!, timestamp);
      // The Urgent flag became a priority (D1310).
      db.query("UPDATE cards SET priority = 'urgent' WHERE id = ?").run(id);
      insertFlag.run(id, "needs_review", timestamp);
    }
  })();
  return { owner, boardId: board.id };
}

describe("board payload for 1000 cards (D113)", () => {
  test("every Wave 13 field filled stays under the 1.2 MB regression ceiling", async () => {
    const full = await fixture("Payload full", true);
    const bare = await fixture("Payload bare", false);
    await boardJson(full.owner, full.boardId);
    await boardJson(bare.owner, bare.boardId);
    const fullRuns = [];
    const bareRuns = [];
    for (let run = 0; run < 7; run += 1) {
      fullRuns.push(await boardJson(full.owner, full.boardId));
      bareRuns.push(await boardJson(bare.owner, bare.boardId));
    }
    const last = fullRuns.at(-1)!;
    expect(last.status).toBe(200);
    const body = JSON.parse(last.text) as { cards: Array<Record<string, unknown> & { assignee_ids: string[]; tag_ids: unknown[]; description_excerpt: string }>; tags: unknown[]; users: Record<string, { display_name: string; can_read: number }> };
    expect(body.cards).toHaveLength(CARDS);
    expect(body.cards.every((card) => card.assignee_ids.length === 3 && card.tag_ids.length === 3 && card.description_excerpt.length === 160)).toBe(true);
    // The trim (D113): one users entry per assignee, and no per-card board id or deprecated fields.
    expect(Object.keys(body.users)).toHaveLength(3);
    expect(body.cards.every((card) => body.users[card.assignee_ids[0]!]?.can_read === 1)).toBe(true);
    expect(body.cards.some((card) => "board_id" in card || "assignees" in card || "assignee_id" in card || "assignee_name" in card)).toBe(false);
    expect(last.bytes).toBeLessThan(CEILING_BYTES);
    if (process.env.MYNOTES_PAYLOAD_REPORT) {
      const median = (runs: Array<{ ms: number }>) => runs.map((item) => item.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)]!;
      console.log(JSON.stringify({
        fullBytes: last.bytes, fullGzipBytes: Bun.gzipSync(last.text).length, bareBytes: bareRuns.at(-1)!.bytes,
        fullMedianMs: Math.round(median(fullRuns) * 10) / 10, bareMedianMs: Math.round(median(bareRuns) * 10) / 10
      }));
    }
  });
});
