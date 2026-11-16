import { registerWorkspaceModule } from "../workspaceModules";
import { db } from "../db";
import { anchorBySql } from "../keyResources";
import { page as todayPage, sectionScope } from "../today/registry";
import { SWEEP_BATCH_SIZE, type BinItem } from "../bin";
import { notify } from "../notify";
import { registerGoalRoutes } from "./routes";
import { goalsMailTemplates } from "./mail";
import type { RegisteredMailTemplate } from "../mail/registry";
import { WINDOW_MS } from "../mail/outbox";
import { goalAgentTools, goalTools } from "./mcp";
import { tasksProgressSource } from "./sources";
import { goalLevel, readableGoalSql, type GoalRow } from "./access";
import { goalHref, goalsInBin, keyResultRestored, ownerTimeZone, purgeGoal, restoreGoal, summarize, sweepAutoKrs, syncReminder } from "./service";
import { checkinDue } from "../../shared/goals";
import { HEALTH_LABEL } from "../../shared/tones";
import { WORK_KIND_ICONS, type WorkSummary } from "../../shared/workRefs";
import "../../shared/goalsActivity";

/**
 * Goals (lane GOALS, docs/plan/WORKSPACE_MODULES.md §D.3, D900–D929, T540–T549): the module entry. Every
 * registration goes through `registerWorkspaceModule` (D801); the service, routes, tools, and sources
 * live beside this file. Migrations 096–097 (server/migrations/workspace/goals.ts).
 */

const goalById = (id: string) => db.query("SELECT * FROM goals WHERE id = ?").get(id.toLowerCase()) as GoalRow | null;

const readableGoals = (ids: readonly string[], userId: string) => {
  const rows = ids.length ? db.query(`SELECT g.* FROM goals g WHERE g.id IN (SELECT value FROM json_each($ids)) AND ${readableGoalSql("g")}`).all({ ids: JSON.stringify(ids), userId }) as GoalRow[] : [];
  return new Map(summarize(rows, userId).map((goal) => [goal.id, goal]));
};

function goalSummaries(ids: readonly string[], viewer: { userId: string }) {
  const found = readableGoals(ids, viewer.userId);
  return new Map(ids.map((id): [string, WorkSummary | null] => {
    const goal = found.get(id);
    if (!goal) return [id, null];
    return [id, {
      kind: "goal", id, shortId: goal.shortId, title: goal.title, subtitle: goal.period?.name ?? goal.owner.name, href: goal.href, icon: WORK_KIND_ICONS.goal, progress: goal.progress,
      ...(goal.health !== "none" ? { status: { label: HEALTH_LABEL[goal.health], tone: goal.health === "on_track" ? "success" as const : goal.health === "at_risk" ? "warning" as const : "danger" as const } } : {}),
      ...(goal.dueOn ?? goal.period?.endsOn ? { due: goal.dueOn ?? goal.period!.endsOn } : {})
    }];
  }));
}

function keyResultSummaries(ids: readonly string[], viewer: { userId: string }) {
  const rows = ids.length ? db.query("SELECT id, goal_id, title, progress FROM key_results WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Array<{ id: string; goal_id: string; title: string; progress: number }> : [];
  const goals = readableGoals([...new Set(rows.map((row) => row.goal_id))], viewer.userId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(ids.map((id): [string, WorkSummary | null] => {
    const row = byId.get(id);
    const goal = row ? goals.get(row.goal_id) : undefined;
    return [id, row && goal ? { kind: "key_result", id, title: row.title, subtitle: goal.title, href: goal.href, icon: WORK_KIND_ICONS.key_result, progress: row.progress } : null];
  }));
}

const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null, can_purge: true } as const;

registerWorkspaceModule({
  id: "goals",
  routes: registerGoalRoutes,
  mailTemplates: goalsMailTemplates as unknown as Record<string, RegisteredMailTemplate<never>>,
  mcpTools: goalTools,
  agentTools: goalAgentTools,
  accessContainer: { kind: "goal", table: "goals", nameColumn: "title", audienceLevels: ["view", "comment", "edit"] },
  itemKinds: [{ kind: "key_result", anchors: anchorBySql("goal", "SELECT goal_id AS anchor FROM key_results WHERE id = ?") }],
  workKinds: [
    {
      kind: "goal", itemKind: "goal", scopes: { read: "goals:read", write: "goals:write" },
      lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? (db.query("SELECT id FROM goals WHERE short_id = ?").get(ref.ref) as { id: string } | null)?.id ?? null : null,
      level: (id, viewer) => goalLevel(id, viewer.userId),
      resolve: goalSummaries
    },
    {
      kind: "key_result", itemKind: "key_result", scopes: { read: "goals:read", write: "goals:write" },
      level: (id, viewer) => { const row = db.query("SELECT goal_id FROM key_results WHERE id = ?").get(id) as { goal_id: string } | null; return row ? goalLevel(row.goal_id, viewer.userId) : "none"; },
      resolve: keyResultSummaries
    }
  ],
  binProviders: [{
    type: "goal",
    provider: {
      list: (userId) => goalsInBin(userId).map((row): BinItem => ({ type: "goal" as never, id: row.id, title: row.title, folder_id: null, folder_name: "Goals", deleted_at: row.deleted_at, purge_after: row.purge_after, purging: row.purge_started_at !== null, ...providedDefaults, href: goalHref(row) }) as BinItem),
      restore: async (id, userId) => {
        // D1385: restoreGoal takes the person first; the arguments were swapped, so every goal restore was NOT_FOUND.
        const outcome = restoreGoal(userId, id);
        if (outcome === "not_found") return { status: "not_found" };
        if (outcome === "purging") return { status: "purging" };
        if (outcome === "already") return { status: "already_restored", folderId: null, folderName: "Goals" };
        return { status: "restored", folderId: null, folderName: "Goals", visibility: outcome.visibility };
      },
      purge: async (id, userId) => {
        const row = db.query("SELECT deleted_at FROM goals WHERE id = ? AND owner_id = ?").get(id, userId) as { deleted_at: string | null } | null;
        if (!row) return "not_found";
        if (row.deleted_at === null) return "live";
        return purgeGoal(id, userId, "user") ? "purged" : "not_found";
      },
      sweep: async (cutoff) => {
        const due = db.query("SELECT id FROM goals WHERE deleted_at IS NOT NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
        let purged = 0;
        for (const { id } of due) if (purgeGoal(id, null, "retention")) purged += 1;
        return { purged, pending: 0 };
      },
      empty: async (userId) => {
        const ids = db.query("SELECT id FROM goals WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>;
        let purged = 0;
        for (const { id } of ids) if (purgeGoal(id, userId, "user")) purged += 1;
        return { purged, pending: 0 };
      }
    }
  }],
  todayProviders: [
    {
      name: "goalsCheckin", provider: { href: "/goals?view=mine", mcpScope: "goals:read",
      load: (context) => {
        const filter = sectionScope(context, "goals:read", { goal: "g.id" });
        const rows = db.query(`SELECT g.* FROM goals g WHERE g.state = 'active' AND g.checkin_cadence <> 'none' AND ${readableGoalSql("g")} AND ${filter.sql}
          AND (g.owner_id = $userId OR EXISTS (SELECT 1 FROM goal_contributors c WHERE c.goal_id = g.id AND c.user_id = $userId))
          ORDER BY COALESCE(g.last_checkin_at, g.created_at) LIMIT 60`).all({ userId: context.userId, ...filter.params }) as GoalRow[];
        const due = rows.filter((row) => checkinDue(row.checkin_cadence, row.last_checkin_at, row.created_at, context.now.getTime()));
        return todayPage(summarize(due.slice(0, 11), context.userId).map((goal) => ({ id: goal.id, title: goal.title, href: goal.href, progress: goal.progress, health: goal.health, lastCheckinAt: goal.lastCheckinAt })));
      } }
    },
    {
      name: "goalsAtRisk", provider: { href: "/goals", mcpScope: "goals:read",
      load: (context) => {
        const filter = sectionScope(context, "goals:read", { goal: "g.id" });
        const rows = db.query(`SELECT g.* FROM goals g WHERE g.state = 'active' AND g.health IN ('at_risk','off_track') AND ${readableGoalSql("g")} AND ${filter.sql}
          AND (g.owner_id = $userId OR EXISTS (SELECT 1 FROM goal_contributors c WHERE c.goal_id = g.id AND c.user_id = $userId) OR g.parent_id IN (SELECT p.id FROM goals p WHERE p.owner_id = $userId))
          ORDER BY g.health = 'off_track' DESC, g.updated_at DESC LIMIT 11`).all({ userId: context.userId, ...filter.params }) as GoalRow[];
        return todayPage(summarize(rows, context.userId).map((goal) => ({ id: goal.id, title: goal.title, href: goal.href, progress: goal.progress, health: goal.health })));
      } }
    }
  ],
  searchScopes: [{
    scope: "goals", label: "Goals", module: "goals",
    search: ({ userId, q, limit }) => {
      const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8).map((term) => `"${term.replace(/"/g, "")}"*`).join(" ");
      if (!terms) return { results: [], truncated: false };
      const rows = db.query(`SELECT g.id, g.title, g.short_id, g.updated_at, snippet(goals_fts, 2, '', '', '…', 12) AS snippet FROM goals_fts f JOIN goals g ON g.id = f.goal_id
        WHERE goals_fts MATCH $terms AND ${readableGoalSql("g")} ORDER BY rank LIMIT $limit`).all({ terms, userId, limit: limit + 1 }) as Array<{ id: string; title: string; short_id: string; updated_at: string; snippet: string }>;
      return {
        results: rows.slice(0, limit).map((row) => ({ kind: "goal" as const, id: row.id, title: row.title, snippet: row.snippet.trim() || undefined, href: goalHref(row), updatedAt: row.updated_at })),
        truncated: rows.length > limit
      };
    }
  }],
  datasets: [
    {
      id: "goals.key_results", module: "goals", label: "Key results", readScope: "goals:read",
      description: "Key results of goals you can open: goal, period, owner, team, health, progress, current and target.",
      from: "key_results k JOIN goals g ON g.id = k.goal_id LEFT JOIN goal_periods p ON p.id = g.period_id LEFT JOIN users o ON o.id = g.owner_id LEFT JOIN user_groups t ON t.id = g.group_id",
      scope: () => ({ sql: readableGoalSql("g") }), timeColumn: "updated_at",
      columns: [
        { name: "goal", sql: "g.title", type: "string", label: "Goal", dimension: true },
        { name: "key_result", sql: "k.title", type: "string", label: "Key result", dimension: true },
        { name: "period", sql: "p.name", type: "string", label: "Period", dimension: true },
        { name: "owner", sql: "o.display_name", type: "string", label: "Owner", dimension: true },
        { name: "team", sql: "t.name", type: "string", label: "Team", dimension: true },
        { name: "health", sql: "g.health", type: "string", label: "Health", dimension: true },
        { name: "state", sql: "g.state", type: "string", label: "State", dimension: true },
        { name: "source", sql: "k.source_kind", type: "string", label: "Source", dimension: true },
        { name: "progress", sql: "k.progress", type: "number", label: "Progress", measures: ["avg", "min", "max"] },
        { name: "goal_progress", sql: "g.progress", type: "number", label: "Goal progress", measures: ["avg", "min", "max"] },
        { name: "current", sql: "k.current_value", type: "number", label: "Current", measures: ["sum", "avg", "min", "max"] },
        { name: "target", sql: "k.target_value", type: "number", label: "Target", measures: ["sum", "avg", "min", "max"] },
        { name: "goal_id", sql: "g.id", type: "string", label: "Goal id", measures: ["count_distinct"] },
        { name: "updated_at", sql: "k.updated_at", type: "datetime", label: "Updated", dimension: true }
      ]
    },
    {
      id: "goals.kr_values", module: "goals", label: "Key result history", readScope: "goals:read",
      description: "Every recorded value of key results of goals you can open, over time (check-ins, edits, automatic updates).",
      from: "kr_values v JOIN key_results k ON k.id = v.kr_id JOIN goals g ON g.id = k.goal_id LEFT JOIN goal_periods p ON p.id = g.period_id",
      scope: () => ({ sql: readableGoalSql("g") }), timeColumn: "at",
      columns: [
        { name: "goal", sql: "g.title", type: "string", label: "Goal", dimension: true },
        { name: "key_result", sql: "k.title", type: "string", label: "Key result", dimension: true },
        { name: "period", sql: "p.name", type: "string", label: "Period", dimension: true },
        { name: "source", sql: "v.source", type: "string", label: "How", dimension: true },
        { name: "value", sql: "v.value", type: "number", label: "Value", measures: ["avg", "min", "max", "sum"] },
        { name: "progress", sql: "v.progress", type: "number", label: "Progress", measures: ["avg", "min", "max"] },
        { name: "at", sql: "v.at", type: "datetime", label: "When", dimension: true }
      ]
    },
    {
      id: "goals.checkins", module: "goals", label: "Goal check-ins", readScope: "goals:read",
      description: "Check-ins on goals you can open: goal, author, health, confidence, progress, and when.",
      from: "goal_checkins c JOIN goals g ON g.id = c.goal_id LEFT JOIN users a ON a.id = c.author_id LEFT JOIN goal_periods p ON p.id = g.period_id",
      scope: () => ({ sql: readableGoalSql("g") }), timeColumn: "created_at",
      columns: [
        { name: "goal", sql: "g.title", type: "string", label: "Goal", dimension: true },
        { name: "author", sql: "COALESCE(a.display_name, 'Former member')", type: "string", label: "Author", dimension: true },
        { name: "period", sql: "p.name", type: "string", label: "Period", dimension: true },
        { name: "health", sql: "c.health", type: "string", label: "Health", dimension: true },
        { name: "confidence", sql: "c.confidence", type: "number", label: "Confidence", measures: ["avg", "min", "max"] },
        { name: "progress", sql: "c.progress", type: "number", label: "Progress", measures: ["avg", "min", "max"] },
        { name: "goal_id", sql: "g.id", type: "string", label: "Goal id", measures: ["count_distinct"] },
        { name: "created_at", sql: "c.created_at", type: "datetime", label: "When", dimension: true }
      ]
    }
  ],
  scheduleHandlers: {
    "goals.checkin_reminder": {
      skipIfLateMs: 12 * 3_600_000,
      run: (schedule, fireAt) => {
        const goal = goalById(schedule.owner.id);
        if (!goal || goal.deleted_at !== null || goal.state !== "active") return;
        // The owner's zone moved since the schedule was armed (or it predates per-owner zones): re-arm it
        // there; this occurrence still runs (the dispatcher's advance reads the re-armed rule, D1055).
        if (schedule.tz !== ownerTimeZone(goal.owner_id)) syncReminder(goal);
        // A day's grace: a goal checked in on Saturday is not reminded on Monday of a weekly cadence.
        if (!checkinDue(goal.checkin_cadence, goal.last_checkin_at, goal.created_at, Date.parse(fireAt) + 86_400_000)) return;
        const contributors = (db.query("SELECT user_id FROM goal_contributors WHERE goal_id = ?").all(goal.id) as Array<{ user_id: string }>).map((row) => row.user_id);
        notify({ userIds: [goal.owner_id, ...contributors].filter((id) => goalLevel(goal.id, id) !== "none"), module: "goals", topic: "goals.checkin_due", title: `Check in on ${goal.title}`,
          body: goal.last_checkin_at ? "It's time for this goal's check-in." : "This goal has no check-in yet.", href: goalHref(goal), item: { kind: "goal", id: goal.id }, dedupeKey: `goal-checkin:${goal.id}`,
          email: { template: "goals.update", payload: { topic: "goals.checkin_due", kind: "goal", id: goal.id, at: fireAt }, coalesceKey: `goals.checkin:${goal.id}`, windowMs: WINDOW_MS.activity } });
      }
    },
    "goals.sweep": { skipIfLateMs: 10 * 60_000, run: async () => { await sweepAutoKrs(); } },
    "goals.period_end": {
      run: (schedule) => {
        const period = db.query("SELECT id, name, ends_on, archived_at FROM goal_periods WHERE id = ?").get(schedule.owner.id) as { id: string; name: string; ends_on: string; archived_at: string | null } | null;
        if (!period || period.archived_at) return;
        const owners = (db.query("SELECT DISTINCT owner_id FROM goals WHERE period_id = ? AND deleted_at IS NULL AND state IN ('draft','active')").all(period.id) as Array<{ owner_id: string }>).map((row) => row.owner_id);
        if (owners.length) notify({ userIds: owners, module: "goals", topic: "goals.period_ending", title: `${period.name} ends in 7 days`, body: "Check in on your goals and close them, or carry them over.", href: "/goals", dedupeKey: `goal-period:${period.id}` });
      }
    }
  },
  progressSources: [{ kind: "tasks", source: tasksProgressSource as never }],
  undoKinds: { key_result: { restored: (rows) => keyResultRestored(rows) } },
  digestSections: [{
    id: "goals.checkin", label: "Goals needing a check-in", module: "goals",
    rows: (recipient, context) => {
      const rows = db.query(`SELECT g.* FROM goals g WHERE g.state = 'active' AND g.checkin_cadence <> 'none' AND g.deleted_at IS NULL
        AND (g.owner_id = $userId OR EXISTS (SELECT 1 FROM goal_contributors c WHERE c.goal_id = g.id AND c.user_id = $userId)) ORDER BY COALESCE(g.last_checkin_at, g.created_at) LIMIT 60`).all({ userId: recipient.id }) as GoalRow[];
      const due = rows.filter((row) => checkinDue(row.checkin_cadence, row.last_checkin_at, row.created_at, context.nowMs));
      return { rows: due.slice(0, 20).map((row) => ({ title: row.title, meta: `${Math.round(row.progress * 100)}%`, href: goalHref(row) })), total: due.length };
    }
  }]
});
