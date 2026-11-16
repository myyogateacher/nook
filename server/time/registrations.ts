import { z } from "zod";
import { audit, db, now } from "../db";
import { readableContainerSql } from "../access/workspaceItems";
import { anchorBySql } from "../keyResources";
import { each, type WorkKindAdapter } from "../links/adapters";
import { SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinProvider, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { withResourceLock } from "../storage";
import { page, type TodayProvider } from "../today/registry";
import { NO_FILTER } from "../keyResources";
import { notify } from "../notify";
import { McpToolError, type McpKeyContext } from "../mcpToolKit";
import type { DatasetColumnDef, DatasetDef } from "../datasets/registry";
import type { SearchScopeDef } from "../searchRegistry";
import type { ScheduleHandler } from "../schedules/service";
import type { ProgressSource } from "../goalsProgress";
import type { KindDef } from "../inbox/kinds";
import { formatDuration } from "../../shared/duration";
import { addDays, zonedToUtc } from "../../shared/calendarRecurrence";
import { WORK_KIND_ICONS } from "../../shared/workRefs";
import { localDate } from "../../shared/time";
import { atLeast, HIDDEN_PROJECT_LABEL, hiddenProjectSql, moneyVisibleSql, PROJECT_JOIN, projectLevel, projectRow, visibleEntrySql } from "./access";
import { entrySeconds, entryView, projectHref, runningEntry, type EntryRow } from "./service";
import { todayTotals } from "./reports";
import { timeTools } from "./mcpTools";

/**
 * Time's registrations with the foundation registries (lane TIME, §B.1): work kinds, key-grant
 * anchors, the Bin, Today, search, the `time.entries` dataset, schedules (long timer, daily reminder),
 * the Goals progress source `time` (C8), and the `time_log` proposal kind. Each reads through the
 * same visibility rules as the app (D872, D873).
 */

// ---------------------------------------------------------------------------
// Work kinds and anchors

export const timeEntryAnchors = anchorBySql("time_project", "SELECT project_id AS anchor FROM time_entries WHERE id = ?");

export const workKinds: WorkKindAdapter[] = [
  {
    kind: "time_project", itemKind: "time_project", scopes: { read: "time:read", write: "time:write" },
    lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? (db.query("SELECT id FROM time_projects WHERE short_id = ?").get(ref.ref) as { id: string } | null)?.id ?? null : null,
    level: (id, viewer) => projectLevel(id, viewer.userId),
    resolve: each((id, viewer) => {
      const row = projectRow(id);
      if (!row || row.deleted_at !== null || projectLevel(row.id, viewer.userId) === "none") return null;
      return { kind: "time_project", id: row.id, shortId: row.short_id, title: row.name, ...(row.code ? { subtitle: row.code } : {}), href: projectHref(row), icon: WORK_KIND_ICONS.time_project };
    })
  },
  {
    kind: "time_entry", itemKind: "time_entry", scopes: { read: "time:read", write: "time:write" },
    level: (id, viewer) => {
      const entry = db.query("SELECT user_id, project_id, locked_at FROM time_entries WHERE id = ?").get(id) as { user_id: string; project_id: string | null; locked_at: string | null } | null;
      if (!entry || !entryView(id, viewer.userId)) return "none";
      if (entry.project_id && atLeast(projectLevel(entry.project_id, viewer.userId), "manage")) return "manage";
      return entry.user_id === viewer.userId ? (entry.locked_at ? "view" : "owner") : "view";
    },
    resolve: each((id, viewer) => {
      const entry = entryView(id, viewer.userId);
      if (!entry) return null;
      return {
        kind: "time_entry", id, title: entry.description || (entry.target && !("hidden" in entry.target) ? entry.target.title : "") || "Time entry",
        subtitle: `${formatDuration(entry.durationS)} · ${entry.user.name}${entry.project ? ` · ${entry.project.name}` : ""}`,
        href: `/time?entry=${id}`, icon: WORK_KIND_ICONS.time_entry, ...(entry.running ? { status: { label: "Running", tone: "info" as const } } : {})
      };
    })
  }
];

// ---------------------------------------------------------------------------
// The Bin: time projects (the owner restores and purges; entries stay, T533)

const binDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
type Binned = { id: string; owner_id: string; name: string; short_id: string; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null; visibility: "private" | "selected" | "all_users" };

function purgeProject(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE time_projects SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM time_projects WHERE id = ?").run(id);
    audit(options.actorId, null, "time.project_purge", { projectId: id, reason: options.reason });
    return "purged";
  })();
}

async function sweepProjects(cutoff: string): Promise<BinSweepCounts> {
  const resumed = db.query("SELECT id FROM time_projects WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
  const due = db.query("SELECT id FROM time_projects WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
    for (const { id } of items) {
      const outcome = await withResourceLock(`time_project:${id}`, async () => purgeProject(id, { reason, actorId: null, dueBy: cutoff }));
      if (outcome === "purged") counts.purged += 1;
    }
  }
  return counts;
}

const binSelect = "SELECT id, owner_id, name, short_id, deleted_at, purge_after, purge_started_at, visibility FROM time_projects";

export const projectBin: BinProvider = {
  list(userId) {
    const rows = db.query(`${binSelect} WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500`).all(userId) as Binned[];
    return rows.map((row): BinItem => ({ type: "time_project", id: row.id, title: row.name, folder_id: null, folder_name: "Time", deleted_at: row.deleted_at!, purge_after: row.purge_after!, purging: row.purge_started_at !== null, ...binDefaults, can_purge: true, href: projectHref(row) }));
  },
  restore(id, userId) {
    return withResourceLock(`time_project:${id}`, async (): Promise<RestoreOutcome> => {
      const row = db.query(`${binSelect} WHERE id = ?`).get(id) as Binned | null;
      if (!row || row.owner_id !== userId) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: null, folderName: "Time" };
      // A board linked to a live project meanwhile keeps that link; this one comes back unlinked.
      const boardTaken = db.query("SELECT 1 FROM time_projects WHERE board_id = (SELECT board_id FROM time_projects WHERE id = ?) AND deleted_at IS NULL AND id <> ?").get(id, id);
      db.query(`UPDATE time_projects SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, ${boardTaken ? "board_id = NULL, " : ""}updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NOT NULL`).run(now(), id);
      audit(userId, null, "time.project_restore", { projectId: id });
      return { status: "restored", folderId: null, folderName: "Time", visibility: row.visibility };
    });
  },
  purge(id, userId) {
    return withResourceLock(`time_project:${id}`, async () => {
      const row = db.query(`${binSelect} WHERE id = ?`).get(id) as Binned | null;
      if (!row || row.owner_id !== userId) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeProject(id, { reason: "user", actorId: userId });
    });
  },
  sweep: sweepProjects,
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const { id } of db.query("SELECT id FROM time_projects WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>) {
      if (await withResourceLock(`time_project:${id}`, async () => purgeProject(id, { reason: "user", actorId: userId })) === "purged") counts.purged += 1;
    }
    return counts;
  }
};

// ---------------------------------------------------------------------------
// Today: today's total and the running timer (§B.11 `timeToday`)

export const todayProvider: TodayProvider = {
  href: "/time", mcpScope: "time:read",
  load: (context) => {
    const totals = todayTotals(context.userId, context.tz);
    const running = runningEntry(context.userId);
    const view = running ? entryView(running.id, context.userId) : null;
    return page([{ id: `today:${totals.date}`, date: totals.date, seconds: totals.seconds, entries: totals.entries, running: view ? { id: view.id, description: view.description, startedAt: view.startedAt, project: view.project?.name ?? null, target: view.target && !("hidden" in view.target) ? { key: view.target.key ?? null, title: view.target.title } : null } : null }]);
  }
};

// ---------------------------------------------------------------------------
// Search: entry descriptions (visible ones, T536) and projects

const ftsQuery = (q: string) => q.replace(/["*^():]/g, " ").split(/\s+/).filter(Boolean).slice(0, 8).map((word) => `"${word}"*`).join(" ");

export const searchScope: SearchScopeDef = {
  scope: "time", label: "Time", module: "time", roles: ["admin", "member", "viewer", "guest"],
  search: ({ userId, q, limit }) => {
    const match = ftsQuery(q);
    const projects = db.query(`SELECT p.id, p.name, p.short_id, p.code FROM time_projects p WHERE ${readableContainerSql("time_project", "p")} AND instr(lower(p.name), lower($q)) > 0 ORDER BY p.name LIMIT $limit`)
      .all({ userId, q: q.slice(0, 120), limit: limit + 1 }) as Array<{ id: string; name: string; short_id: string; code: string | null }>;
    const entries = match ? db.query(`SELECT e.id, e.description, e.started_at, e.duration_s FROM time_entry_fts f JOIN time_entries e ON e.id = f.entry_id LEFT JOIN time_projects p ON p.id = e.project_id
        WHERE time_entry_fts MATCH $match AND ${visibleEntrySql()} ORDER BY e.started_at DESC LIMIT $limit`)
      .all({ userId, match, limit: limit + 1 }) as Array<{ id: string; description: string; started_at: string; duration_s: number | null }> : [];
    const results = [
      ...projects.map((row) => ({ kind: "time_project" as const, id: row.id, title: row.name, snippet: row.code ?? "Time project", href: projectHref(row) })),
      ...entries.map((row) => ({ kind: "time_entry" as const, id: row.id, title: row.description, snippet: `${row.started_at.slice(0, 10)} · ${formatDuration(entrySeconds(row))}`, href: `/time?entry=${row.id}`, updatedAt: row.started_at }))
    ];
    return { results: results.slice(0, limit), truncated: results.length > limit };
  }
};

// ---------------------------------------------------------------------------
// Dataset `time.entries` (§B.10): money columns null where the viewer may not see money (T530)

/**
 * A column whose SQL is built when a query runs: the access predicate needs the `time_project` container
 * registered, which happens after this module loads (built at load, it read as "0": every project hidden).
 */
const queryTimeColumn = (column: Omit<DatasetColumnDef, "sql">, sql: () => string): DatasetColumnDef =>
  Object.defineProperty({ ...column }, "sql", { get: sql, enumerable: true }) as DatasetColumnDef;
const HIDDEN_LABEL_SQL = `'${HIDDEN_PROJECT_LABEL.replace("'", "''")}'`;

export const timeDataset: DatasetDef = {
  id: "time.entries", module: "time", label: "Time entries",
  description: "Finished time entries you can see: person, project, client, work item, day, seconds, billable, and amounts where you may see money.",
  readScope: "time:read", roles: ["admin", "member", "viewer", "guest"],
  from: `${PROJECT_JOIN} LEFT JOIN users u ON u.id = e.user_id LEFT JOIN companies co ON co.id = p.company_id`,
  scope: () => ({ sql: `e.ended_at IS NOT NULL AND ${visibleEntrySql()}` }),
  timeColumn: "started_at",
  columns: [
    { name: "person", sql: "COALESCE(u.display_name, 'Former member')", type: "string", label: "Person", dimension: true },
    { name: "person_id", sql: "e.user_id", type: "string", label: "Person id", dimension: true, measures: ["count_distinct"] },
    // A project the viewer cannot open (a card reader's view of someone's entry) shows no name, id, or client (TG4, D1143).
    queryTimeColumn({ name: "project", type: "string", label: "Project", dimension: true }, () => `CASE WHEN ${hiddenProjectSql()} THEN ${HIDDEN_LABEL_SQL} ELSE COALESCE(CASE WHEN p.deleted_at IS NULL THEN p.name END, 'No project') END`),
    queryTimeColumn({ name: "project_id", type: "string", label: "Project id", dimension: true }, () => `CASE WHEN ${hiddenProjectSql()} THEN NULL ELSE e.project_id END`),
    queryTimeColumn({ name: "client", type: "string", label: "Client", dimension: true }, () => `CASE WHEN ${hiddenProjectSql()} THEN 'No client' ELSE COALESCE(co.name, 'No client') END`),
    { name: "target_kind", sql: "e.target_kind", type: "string", label: "Work item kind", dimension: true },
    { name: "target_id", sql: "e.target_id", type: "string", label: "Work item", dimension: true, measures: ["count_distinct"] },
    { name: "billable", sql: "e.billable", type: "bool", label: "Billable", dimension: true },
    { name: "source", sql: "e.source", type: "string", label: "Source", dimension: true },
    { name: "started_at", sql: "e.started_at", type: "datetime", label: "Started", dimension: true, measures: ["min", "max"] },
    { name: "seconds", sql: "e.duration_s", type: "duration", label: "Time", measures: ["sum", "avg", "min", "max"] },
    { name: "hours", sql: "(e.duration_s / 3600.0)", type: "number", label: "Hours", measures: ["sum", "avg"] },
    { name: "billable_seconds", sql: "(CASE WHEN e.billable = 1 THEN e.duration_s ELSE 0 END)", type: "duration", label: "Billable time", measures: ["sum"] },
    // Per query too: built at load, the managers' half of the money predicate read as "0" (D1150).
    queryTimeColumn({ name: "amount_minor", type: "money", label: "Amount (minor units)", measures: ["sum", "avg"] }, () => `(CASE WHEN e.billable = 1 AND e.rate_minor IS NOT NULL AND ${moneyVisibleSql()} THEN CAST(ROUND(e.rate_minor * e.duration_s / 3600.0) AS INTEGER) END)`),
    queryTimeColumn({ name: "currency", type: "string", label: "Currency", dimension: true }, () => `(CASE WHEN ${moneyVisibleSql()} THEN e.currency END)`)
  ]
};

// ---------------------------------------------------------------------------
// Schedules: the long-running timer alert and the "nothing logged today" reminder (D885)

export const scheduleHandlers: Record<string, ScheduleHandler> = {
  "time.long_timer": {
    skipIfLateMs: 6 * 3_600_000,
    run: (schedule) => {
      const entry = db.query("SELECT * FROM time_entries WHERE id = ? AND ended_at IS NULL").get(schedule.owner.id) as EntryRow | null;
      if (!entry) return;
      const hours = Number(schedule.payload.hours ?? 8);
      notify({
        userIds: [entry.user_id], module: "time", topic: "time.long_timer", includeActor: true,
        title: `Your timer has been running for ${hours} hours`, body: entry.description ? `“${entry.description.slice(0, 120)}” is still running. Stop it if you forgot.` : "Stop it if you forgot.",
        href: "/time", item: { kind: "time_entry", id: entry.id }, dedupeKey: `time.long_timer:${entry.id}`
      });
    }
  },
  "time.daily_reminder": {
    skipIfLateMs: 3 * 3_600_000,
    run: (schedule, fireAt) => {
      const userId = schedule.owner.id;
      const date = localDate(fireAt, schedule.tz);
      const from = new Date(zonedToUtc(`${date}T00:00`, schedule.tz)).toISOString();
      const to = new Date(zonedToUtc(`${addDays(date, 1)}T00:00`, schedule.tz)).toISOString();
      if (db.query("SELECT 1 FROM time_entries WHERE user_id = ? AND started_at >= ? AND started_at < ?").get(userId, from, to)) return;
      notify({ userIds: [userId], module: "time", topic: "time.reminder", includeActor: true, title: "You have no time logged today", body: "Log what you worked on before you forget.", href: "/time", dedupeKey: `time.reminder:${date}` });
    }
  }
};

// ---------------------------------------------------------------------------
// Goals progress source `time` (C8): hours in the key result's period, read as its owner

const progressConfig = z.object({
  projectId: z.string().max(64).optional(),
  boardId: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  userIds: z.array(z.string().uuid()).max(50).optional(),
  billableOnly: z.boolean().optional()
}).strict();
type ProgressConfig = z.infer<typeof progressConfig>;

export const progressSource: Omit<ProgressSource<ProgressConfig>, "kind"> = {
  label: "Hours logged", module: "time", configSchema: progressConfig,
  describe: (config, context) => {
    const project = config.projectId ? projectRow(config.projectId) : null;
    const name = project && projectLevel(project.id, context.viewerId) !== "none" ? project.name : config.projectId ? "a project" : null;
    return `Hours logged${name ? ` on ${name}` : ""}${config.tag ? ` tagged ${config.tag}` : ""}${config.billableOnly ? " (billable)" : ""}`;
  },
  compute: (config, context) => {
    if (config.projectId && projectLevel(config.projectId, context.ownerId) === "none") return null;
    const where = [visibleEntrySql(), "e.ended_at IS NOT NULL"];
    const params: Record<string, string | number> = { userId: context.ownerId };
    if (config.projectId) { where.push("e.project_id = $projectId"); params.projectId = projectRow(config.projectId)?.id ?? "-"; }
    if (config.boardId) { where.push("e.target_kind = 'card' AND e.target_id IN (SELECT id FROM cards WHERE board_id = $boardId)"); params.boardId = config.boardId.toLowerCase(); }
    if (config.tag) { where.push("EXISTS (SELECT 1 FROM json_each(e.tags_json) t WHERE t.value = $tag COLLATE NOCASE)"); params.tag = config.tag; }
    if (config.userIds?.length) { where.push("e.user_id IN (SELECT value FROM json_each($users))"); params.users = JSON.stringify(config.userIds.map((id) => id.toLowerCase())); }
    if (config.billableOnly) where.push("e.billable = 1");
    if (context.period) {
      where.push("e.started_at >= $from AND e.started_at < $to");
      params.from = new Date(zonedToUtc(`${context.period.start}T00:00`, context.tz)).toISOString();
      params.to = new Date(zonedToUtc(`${addDays(context.period.end, 1)}T00:00`, context.tz)).toISOString();
    }
    const row = db.query(`SELECT COALESCE(SUM(e.duration_s), 0) AS seconds FROM ${PROJECT_JOIN} WHERE ${where.join(" AND ")}`).get(params) as { seconds: number };
    return { value: Math.round((row.seconds / 3600) * 100) / 100, detail: formatDuration(row.seconds) };
  }
};

// ---------------------------------------------------------------------------
// Inbox proposals: `time_log` (an agent's log_time waits for the person's approval)

const logTool = () => timeTools.find((tool) => tool.name === "log_time")!;

function parsedLog(payload: unknown): Record<string, unknown> {
  const result = logTool().inputSchema.safeParse(payload ?? {});
  if (!result.success) throw new McpToolError("INVALID", "Invalid payload", { details: result.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`) });
  return result.data as Record<string, unknown>;
}

const approverKey = (approverId: string, keyId: string | null, keyName: string): McpKeyContext => {
  if (!keyId) throw new McpToolError("NOT_FOUND", "The key that suggested this change no longer exists");
  if (db.query("SELECT 1 FROM mcp_api_keys WHERE id = ? AND revoked_at IS NOT NULL").get(keyId)) throw new McpToolError("NOT_FOUND", "The key that suggested this change was revoked");
  return { keyId, userId: approverId, name: keyName, scopes: [], person: true };
};

export const timeLogProposal: KindDef & { tool: string } = {
  tool: "log_time", scope: "time:read", label: "Log time",
  target: { field: "projectId", kind: "time_project" },
  submit: async (key, payload) => {
    const data = parsedLog(payload);
    const projectId = typeof data.projectId === "string" ? data.projectId.toLowerCase() : null;
    if (projectId) {
      const project = projectRow(projectId);
      if (!project || project.deleted_at !== null || projectLevel(project.id, key.userId) === "none") throw new McpToolError("NOT_FOUND", "Project not found");
      return { targetType: "time_project", targetId: project.id, payload: { ...data, projectId: project.id } };
    }
    return { targetType: "time_entry", targetId: key.userId, payload: data };
  },
  apply: async (approverId, proposal) => {
    const result = await logTool().handler(parsedLog(proposal.payload), approverKey(approverId, proposal.key_id, proposal.key_name)) as { entry: { id: string } };
    return { type: "time_entry", id: result.entry.id, href: `/time?entry=${result.entry.id}` };
  },
  preview: (viewerId, proposal) => {
    const payload = proposal.payload;
    const project = typeof payload.projectId === "string" ? projectRow(payload.projectId) : null;
    if (project && projectLevel(project.id, viewerId) === "none") return { restricted: true };
    const fields = [
      { name: "Duration", before: null, after: payload.duration !== undefined ? String(payload.duration) : payload.endedAt ? `${String(payload.startedAt)} – ${String(payload.endedAt)}` : null },
      ...(payload.description ? [{ name: "Description", before: null, after: String(payload.description) }] : []),
      ...(project ? [{ name: "Project", before: null, after: project.name }] : []),
      ...(payload.target ? [{ name: "Work item", before: null, after: String(payload.target) }] : []),
      ...(payload.startedAt ? [{ name: "Started", before: null, after: String(payload.startedAt) }] : []),
      ...(payload.billable !== undefined ? [{ name: "Billable", before: null, after: payload.billable ? "Yes" : "No" }] : [])
    ];
    return { fields };
  },
  targetLabel: (viewerId, proposal) => {
    const project = typeof proposal.payload.projectId === "string" ? projectRow(proposal.payload.projectId) : null;
    return project && projectLevel(project.id, viewerId) !== "none" ? project.name : "Your time";
  },
  digest: (payload) => `Log ${payload.duration !== undefined ? String(payload.duration) : "time"}${payload.description ? `: ${String(payload.description).slice(0, 60)}` : ""}`,
  targetHref: (proposal) => {
    const project = typeof proposal.payload.projectId === "string" ? projectRow(proposal.payload.projectId) : null;
    return project ? projectHref(project) : "/time";
  }
};

export { NO_FILTER };
