import { db } from "../db";
import { listBinPurgingSoon } from "../bin";
import { readableBoard } from "../tasks/access";
import { isMuted } from "./mutes";
import { enqueueMail, mergeIds, WINDOW_MS, type Payload } from "./outbox";
import { readEmailPrefs } from "./prefs";
import type { Recipient, Resolution } from "./resolve";

/**
 * Sprint and Bin mail (docs/plan/research/2026-09-28-outbound-email.md §A.2 #20, #29), both in
 * categories that are off by default (D236, D243).
 *
 * - Sprint started or completed: board readers with at least one card assigned to them in the
 *   sprint hear about it (D235), never the actor, not for a muted board. Coalesced 10 minutes per
 *   (recipient, sprint), so a start and a completion in quick succession send the later one.
 * - Items leaving your Bin: a scan (hourly, from the mail tick) queues one mail for each person with
 *   Bin clean-up on whose Bin has items purged within 3 days, at most once a week. The list is read
 *   at send time.
 */

const DAY = 86_400_000;
export const BIN_SOON_MS = 3 * DAY;
export const BIN_MAIL_GAP_MS = 7 * DAY;

function safely(label: string, run: () => void) {
  try {
    run();
  } catch (error) {
    console.error(`Mail enqueue failed: purpose=${label} error=${error instanceof Error ? error.name : "Unknown"}`);
  }
}

type Yours = { total: number; done: number; carried: number };

/** Per assignee: their cards in the sprint, and how many are in a done column (read before a completion moves them). */
export function sprintAssignees(sprintId: string, boardId: string) {
  const rows = db.query(`SELECT ca.user_id, COUNT(*) AS total, SUM(CASE WHEN col.is_done = 1 THEN 1 ELSE 0 END) AS done
      FROM cards k JOIN card_assignees ca ON ca.card_id = k.id JOIN board_columns col ON col.id = k.column_id
      WHERE k.sprint_id = ? AND k.board_id = ? AND k.deleted_at IS NULL GROUP BY ca.user_id`).all(sprintId, boardId) as Array<{ user_id: string; total: number; done: number | null }>;
  return new Map(rows.map((row) => [row.user_id, { total: row.total, done: row.done ?? 0, carried: row.total - (row.done ?? 0) } satisfies Yours]));
}

/**
 * #20: call inside the start or completion transaction. For a completion, pass the assignees read
 * before the unfinished cards moved, and the sprint's own counts.
 */
export function mailSprint(actorId: string, boardId: string, sprintId: string, event: "started" | "completed", assignees: Map<string, Yours>, counts: { done: number; carried: number } | null = null) {
  safely("tasks.sprint", () => {
    for (const [userId, yours] of assignees) {
      if (userId === actorId || yours.total === 0 || isMuted(userId, "board", boardId)) continue;
      enqueueMail({
        userId, template: "tasks.sprint",
        payload: { boardId, sprintId, event, yours, counts, actorIds: [actorId] },
        coalesceKey: `tasks.sprint:${userId}:${sprintId}`, windowMs: WINDOW_MS.activity,
        merge: (queued: Payload, incoming: Payload) => ({ ...incoming, actorIds: mergeIds(queued.actorIds, incoming.actorIds, 10) })
      });
    }
  });
}

const names = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string")
  .map((id) => (db.query("SELECT display_name FROM users WHERE id = ?").get(id) as { display_name: string } | null)?.display_name ?? null)
  .filter((name): name is string => name !== null);

export function resolveSprint(payload: Record<string, unknown>, recipient: Recipient): Resolution {
  const boardId = typeof payload.boardId === "string" ? payload.boardId : "";
  const board = readableBoard(boardId, recipient.id);
  if (!board) return { skip: "access_lost" };
  if (isMuted(recipient.id, "board", board.id)) return { skip: "muted" };
  const sprint = db.query("SELECT name, start_on, end_on, state FROM board_sprints WHERE id = ? AND board_id = ?").get(String(payload.sprintId ?? ""), board.id) as { name: string; start_on: string | null; end_on: string | null; state: string } | null;
  if (!sprint) return { skip: "empty" };
  const event = payload.event === "completed" ? "completed" : "started";
  // A start whose sprint is no longer active (completed in the window merges; deleted is gone) says nothing.
  if (event === "started" && sprint.state !== "active") return { skip: "empty" };
  const live = db.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN col.is_done = 1 THEN 1 ELSE 0 END) AS done FROM cards k JOIN board_columns col ON col.id = k.column_id
      WHERE k.sprint_id = ? AND k.deleted_at IS NULL`).get(String(payload.sprintId)) as { total: number; done: number | null };
  const counts = (payload.counts ?? null) as { done: number; carried: number } | null;
  const yours = (payload.yours ?? { total: 0, done: 0, carried: 0 }) as Yours;
  return {
    data: {
      boardId: board.id, boardName: board.name, sprintName: sprint.name, event, actors: names(payload.actorIds),
      startOn: sprint.start_on, endOn: sprint.end_on,
      total: event === "started" ? live.total : (counts?.done ?? 0) + (counts?.carried ?? 0),
      done: event === "started" ? live.done ?? 0 : counts?.done ?? 0,
      carried: event === "started" ? 0 : counts?.carried ?? 0,
      yours: { total: Number(yours.total) || 0, done: Number(yours.done) || 0, carried: Number(yours.carried) || 0 }
    }
  };
}

// --- Bin clean-up ---------------------------------------------------------------------------

const BIN_KIND_LABELS: Record<string, string> = {
  note: "Note", document: "File", card: "Card", board: "Board", collection: "Collection", collection_row: "Row", calendar: "Calendar", event: "Event", view: "Task view"
};

let lastBinScanMs: number | null = null;
/** Test hook. */
export function resetBinScanForTests() {
  lastBinScanMs = null;
}

/**
 * Queues "items leaving your Bin" for everyone with Bin clean-up on, once a week at most. From the
 * mail tick; scans at most hourly unless `force`.
 */
export function scheduleBinExpiry(nowMs = Date.now(), force = false) {
  if (!force && lastBinScanMs !== null && nowMs >= lastBinScanMs && nowMs - lastBinScanMs < 3_600_000) return 0;
  lastBinScanMs = nowMs;
  // No row means the defaults, where Bin clean-up is off.
  const users = db.query(`SELECT p.user_id FROM email_prefs p JOIN users u ON u.id = p.user_id
      WHERE p.enabled = 1 AND json_extract(p.categories, '$.bin') = 1 AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL`).all() as Array<{ user_id: string }>;
  let queued = 0;
  for (const { user_id: userId } of users) {
    const recent = db.query("SELECT 1 FROM mail_outbox WHERE user_id = ? AND template = 'bin.expiring' AND created_at > ? LIMIT 1").get(userId, new Date(nowMs - BIN_MAIL_GAP_MS).toISOString());
    if (recent) continue;
    if (!readEmailPrefs(userId).categories.bin) continue;
    if (!listBinPurgingSoon(userId, new Date(nowMs + BIN_SOON_MS).toISOString(), 1).length) continue;
    if (enqueueMail({ userId, template: "bin.expiring", payload: {}, nowMs })) queued += 1;
  }
  return queued;
}

export function resolveBinExpiring(recipient: Recipient, nowMs: number): Resolution {
  const items = listBinPurgingSoon(recipient.id, new Date(nowMs + BIN_SOON_MS).toISOString(), 51);
  if (!items.length) return { skip: "empty" };
  return {
    data: {
      items: items.slice(0, 5).map((item) => ({ kind: BIN_KIND_LABELS[item.type] ?? "Item", title: item.title })),
      total: items.length,
      soonest: items[0]!.purge_after
    }
  };
}
