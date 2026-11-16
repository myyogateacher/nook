import { audit, db, now } from "../db";
import { readableContainerSql, setItemMember } from "../access/workspaceItems";
import { purgeAfterFrom } from "../bin";
import { readableBoard, boardLevel } from "../tasks/access";
import { ensureClientsBook, readableBookIds } from "../people/contacts";
import { recordItemActivity, registerActivityKinds } from "../activity/service";
import { notify } from "../notify";
import { WINDOW_MS } from "../mail/outbox";
import { readWorkspaceSettings } from "../workspaceSettings";
import { newShortId } from "../../shared/friendlyUrls";
import { isCurrency } from "../../shared/money";
import { localDate, PROJECT_COLORS, weekDays, type ProjectColor, type TimeProject } from "../../shared/time";
import { atLeast, canLogOn, projectLevel, projectRow, projectSettings, roleOf, type ProjectRow } from "./access";
import { managersOf, projectHref, projectUsage, TimeError, notFound } from "./service";
import { LEVEL_RANK } from "../access/levels";

/**
 * Time projects, clients, member rates, and week approvals (lane TIME, §D.2, D873–D876):
 *
 * - A project is a sharing container (`time_project`): its owner, people and groups in the generic
 *   member tables, or everyone signed in. `edit` logs time and sees every entry; `manage` also sees
 *   rates and money and approves weeks (D873, D874).
 * - Its client is a company (088): any company in a book the person can read, or a new one in their
 *   own hidden "Clients" book (D807), so Time never needs the Contacts app. The client's name is
 *   part of the project and shown to every project reader (D883).
 * - Linking a board makes the project the default for time on that board's cards (D876): one live
 *   project per board, and only someone who can edit the board links it.
 */

registerActivityKinds("time", {
  time_project_created: { shape: "event", coalesce: false },
  time_project_changed: { shape: "change", coalesce: true },
  time_week_submitted: { shape: "event", coalesce: false },
  time_week_approved: { shape: "event", coalesce: false },
  time_week_rejected: { shape: "event", coalesce: false },
  time_week_unlocked: { shape: "event", coalesce: false }
});

const invalid = (message: string, code = "INVALID") => new TimeError(400, code, message);
const colorOf = (value: string): ProjectColor => (PROJECT_COLORS as readonly string[]).includes(value) ? value as ProjectColor : "amber";

type ProjectViewRow = ProjectRow & { client_name: string | null; board_name: string | null; owner_name: string | null };

const projectSelect = `SELECT p.*, co.name AS client_name, b.name AS board_name, u.display_name AS owner_name
  FROM time_projects p LEFT JOIN companies co ON co.id = p.company_id AND co.deleted_at IS NULL LEFT JOIN boards b ON b.id = p.board_id AND b.deleted_at IS NULL LEFT JOIN users u ON u.id = p.owner_id`;

export function toProject(row: ProjectViewRow, viewerId: string, options: { usage?: boolean } = {}): TimeProject {
  const level = projectLevel(row.id, viewerId);
  const effective = level === "none" ? "view" : level;
  const canSeeRates = atLeast(level, "manage");
  const usage = options.usage ? projectUsage(row) : null;
  return {
    id: row.id, shortId: row.short_id, name: row.name, code: row.code, color: colorOf(row.color),
    client: row.company_id && row.client_name ? { id: row.company_id, name: row.client_name } : null,
    board: row.board_id && row.board_name && readableBoard(row.board_id, viewerId) ? { id: row.board_id, name: row.board_name } : null,
    billableDefault: row.billable_default === 1,
    currency: row.currency,
    rateMinor: canSeeRates ? row.rate_minor : null,
    budget: { kind: row.budget_kind, value: row.budget_kind === "money" && !canSeeRates ? null : row.budget_value, period: row.budget_period },
    ...(usage ? { used: { seconds: usage.seconds, amountMinor: canSeeRates ? usage.amountMinor : null } } : {}),
    settings: projectSettings(row),
    archived: row.archived_at !== null,
    owner: { id: row.owner_id, name: row.owner_name ?? "Former member" },
    level: effective as TimeProject["level"],
    canSeeRates,
    canLog: canLogOn(row.id, viewerId),
    revision: row.revision,
    visibility: row.visibility
  };
}

export function projectView(ref: string, viewerId: string, options: { usage?: boolean } = { usage: true }): TimeProject | null {
  const row = projectRow(ref);
  if (!row || row.deleted_at !== null || projectLevel(row.id, viewerId) === "none") return null;
  const view = db.query(`${projectSelect} WHERE p.id = ?`).get(row.id) as ProjectViewRow;
  return toProject(view, viewerId, options);
}

/** Readable projects, archived last (or only with `archived`), by name. `extra` narrows by a key's reach. */
export function listProjects(viewerId: string, options: { archived?: boolean; q?: string; loggable?: boolean; limit?: number; extra?: { sql: string; params: Record<string, string> } } = {}): TimeProject[] {
  const params: Record<string, string | number> = { userId: viewerId, limit: Math.min(options.limit ?? 500, 500) };
  const where = [readableContainerSql("time_project", "p")];
  if (options.archived === false) where.push("p.archived_at IS NULL");
  if (options.q?.trim()) { where.push("(instr(lower(p.name), lower($q)) > 0 OR instr(lower(IFNULL(p.code, '')), lower($q)) > 0 OR instr(lower(IFNULL(co.name, '')), lower($q)) > 0)"); params.q = options.q.trim().slice(0, 120); }
  if (options.extra) { where.push(`(${options.extra.sql})`); Object.assign(params, options.extra.params); }
  const rows = db.query(`${projectSelect} WHERE ${where.join(" AND ")} ORDER BY (p.archived_at IS NOT NULL), p.name COLLATE NOCASE, p.id LIMIT $limit`).all(params) as ProjectViewRow[];
  const projects = rows.map((row) => toProject(row, viewerId, { usage: true }));
  return options.loggable ? projects.filter((project) => project.canLog && !project.archived) : projects;
}

export type ProjectInput = {
  name?: string;
  code?: string | null;
  color?: string;
  clientId?: string | null;
  /** A new client by name (a company in the person's own Clients book). */
  newClient?: string | null;
  boardId?: string | null;
  billableDefault?: boolean;
  rateMinor?: number | null;
  currency?: string;
  budget?: { kind: "none" | "hours" | "money"; value?: number | null; period?: "total" | "monthly" };
  settings?: { privateEntries?: boolean; requireDescription?: boolean };
  archived?: boolean;
  visibility?: "private" | "all_users";
  /** People to add as members at creation (level edit). */
  memberIds?: string[];
  expectedRevision?: number;
};

function requireMember(userId: string) {
  const role = roleOf(userId);
  if (role !== "admin" && role !== "member") throw new TimeError(403, "READ_ONLY", "Only members and admins create and change projects");
}

function readableCompany(companyId: string, userId: string): string {
  const books = readableBookIds(userId);
  const row = db.query(`SELECT id, book_id FROM companies WHERE (id = ? OR short_id = ?) AND deleted_at IS NULL`).get(companyId.toLowerCase(), companyId.toLowerCase()) as { id: string; book_id: string } | null;
  if (!row || !books.includes(row.book_id)) throw notFound("Client");
  return row.id;
}

/** A new client (company) in the person's own hidden Clients book (D807), or the one already there by that name. */
export function createClient(name: string, userId: string): { id: string; name: string } {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > 200) throw invalid("A client needs a name of at most 200 characters");
  return db.transaction(() => {
    const bookId = ensureClientsBook(userId);
    const existing = db.query("SELECT id, name FROM companies WHERE book_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL").get(bookId, clean) as { id: string; name: string } | null;
    if (existing) return existing;
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query(`INSERT INTO companies (id, short_id, book_id, name, owner_id, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`)
      .run(id, newShortId(), bookId, clean, userId, userId, timestamp, timestamp);
    audit(userId, null, "time.client_create", { companyId: id });
    return { id, name: clean };
  })();
}

/** Clients the person can pick: companies in books they can read (their Clients book included), by name. */
export function listClients(userId: string, q = ""): Array<{ id: string; name: string; domain: string | null; projects: number }> {
  const books = readableBookIds(userId);
  if (!books.length) return [];
  return db.query(`SELECT co.id, co.name, co.domain, (SELECT COUNT(*) FROM time_projects tp WHERE tp.company_id = co.id AND tp.deleted_at IS NULL) AS projects
    FROM companies co WHERE co.deleted_at IS NULL AND co.book_id IN (SELECT value FROM json_each($books)) AND ($q = '' OR instr(lower(co.name), lower($q)) > 0)
    ORDER BY co.name COLLATE NOCASE LIMIT 200`).all({ books: JSON.stringify(books), q: q.trim().slice(0, 100) }) as Array<{ id: string; name: string; domain: string | null; projects: number }>;
}

function linkableBoard(boardId: string, userId: string, projectId: string | null): string {
  const board = readableBoard(boardId.toLowerCase(), userId);
  if (!board) throw notFound("Board");
  if (LEVEL_RANK[boardLevel(board, userId)] < LEVEL_RANK.edit) throw new TimeError(403, "READ_ONLY", "Link a board you can edit");
  const taken = db.query("SELECT id, name FROM time_projects WHERE board_id = ? AND deleted_at IS NULL AND id IS NOT ?").get(board.id, projectId) as { id: string; name: string } | null;
  if (taken) throw new TimeError(409, "BOARD_LINKED", `That board is already linked to ${projectLevel(taken.id, userId) === "none" ? "another project" : taken.name}`);
  return board.id;
}

function cleanCode(code: string | null | undefined) {
  if (code === undefined || code === null) return code ?? null;
  const value = code.trim().toUpperCase();
  if (!value) return null;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(value)) throw invalid("A code is up to 12 letters, digits, - or _");
  return value;
}

function budgetOf(input: ProjectInput["budget"], current?: ProjectRow) {
  const kind = input?.kind ?? current?.budget_kind ?? "none";
  const value = kind === "none" ? null : input?.value !== undefined ? input.value : current?.budget_value ?? null;
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw invalid("A budget is a whole number: hours, or money in minor units");
  if (kind !== "none" && value === null) throw invalid("Give the budget's amount");
  return { kind, value, period: input?.period ?? current?.budget_period ?? "total" };
}

export function createProject(userId: string, input: ProjectInput): TimeProject {
  requireMember(userId);
  const name = input.name?.trim() ?? "";
  if (!name || name.length > 120) throw invalid("A project needs a name of at most 120 characters");
  return db.transaction(() => {
    const id = crypto.randomUUID();
    const currency = input.currency ?? readWorkspaceSettings().defaultCurrency;
    if (!isCurrency(currency)) throw invalid("Unknown currency");
    const clientId = input.newClient ? createClient(input.newClient, userId).id : input.clientId ? readableCompany(input.clientId, userId) : null;
    const boardId = input.boardId ? linkableBoard(input.boardId, userId, null) : null;
    const budget = budgetOf(input.budget);
    if (input.rateMinor !== undefined && input.rateMinor !== null && (!Number.isSafeInteger(input.rateMinor) || input.rateMinor < 0)) throw invalid("A rate is a whole number of minor units");
    const settings = { privateEntries: input.settings?.privateEntries === true, requireDescription: input.settings?.requireDescription === true };
    const timestamp = now();
    db.query(`INSERT INTO time_projects (id, short_id, owner_id, name, code, color, company_id, board_id, billable_default, rate_minor, currency, budget_kind, budget_value, budget_period, settings_json, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, newShortId(), userId, name, cleanCode(input.code), colorOf(input.color ?? "amber"), clientId, boardId,
      input.billableDefault === false ? 0 : 1, input.rateMinor ?? null, currency, budget.kind, budget.value, budget.period, JSON.stringify(settings),
      input.memberIds?.length ? "selected" : input.visibility ?? "private", timestamp, timestamp);
    for (const memberId of input.memberIds ?? []) {
      if (memberId === userId) continue;
      if (!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(memberId)) throw notFound("Person");
      setItemMember("time_project", id, memberId, "edit", userId);
    }
    recordItemActivity({ itemKind: "time_project", itemId: id, actorId: userId, kind: "time_project_created" });
    audit(userId, null, "time.project_create", { projectId: id, clientId, boardId });
    return projectView(id, userId)!;
  })();
}

export function updateProject(userId: string, ref: string, input: ProjectInput): TimeProject {
  requireMember(userId);
  return db.transaction(() => {
    const row = projectRow(ref);
    if (!row || row.deleted_at !== null) throw notFound("Project");
    const level = projectLevel(row.id, userId);
    if (level === "none") throw notFound("Project");
    if (!atLeast(level, "manage")) throw new TimeError(403, "READ_ONLY", "Only the project's managers change it");
    if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) throw new TimeError(409, "PROJECT_CHANGED", "This project changed since you opened it", { project: projectView(row.id, userId) });
    const name = input.name !== undefined ? input.name.trim() : row.name;
    if (!name || name.length > 120) throw invalid("A project needs a name of at most 120 characters");
    const clientId = input.newClient ? createClient(input.newClient, userId).id : input.clientId !== undefined ? (input.clientId ? (input.clientId === row.company_id ? row.company_id : readableCompany(input.clientId, userId)) : null) : row.company_id;
    const boardId = input.boardId !== undefined ? (input.boardId ? (input.boardId.toLowerCase() === row.board_id ? row.board_id : linkableBoard(input.boardId, userId, row.id)) : null) : row.board_id;
    const currency = input.currency ?? row.currency;
    if (!isCurrency(currency)) throw invalid("Unknown currency");
    if (input.rateMinor !== undefined && input.rateMinor !== null && (!Number.isSafeInteger(input.rateMinor) || input.rateMinor < 0)) throw invalid("A rate is a whole number of minor units");
    const budget = input.budget ? budgetOf(input.budget, row) : { kind: row.budget_kind, value: row.budget_value, period: row.budget_period };
    const settings = { ...projectSettings(row), ...(input.settings ?? {}) };
    const archivedAt = input.archived === undefined ? row.archived_at : input.archived ? row.archived_at ?? now() : null;
    db.query(`UPDATE time_projects SET name = ?, code = ?, color = ?, company_id = ?, board_id = ?, billable_default = ?, rate_minor = ?, currency = ?, budget_kind = ?, budget_value = ?,
      budget_period = ?, settings_json = ?, archived_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`).run(name, input.code !== undefined ? cleanCode(input.code) : row.code,
      input.color ? colorOf(input.color) : row.color, clientId, boardId, input.billableDefault === undefined ? row.billable_default : input.billableDefault ? 1 : 0,
      input.rateMinor !== undefined ? input.rateMinor : row.rate_minor, currency, budget.kind, budget.value, budget.period, JSON.stringify(settings), archivedAt, now(), row.id);
    // A changed budget alerts afresh when usage next crosses 80% or 100% of it (D1142).
    if (budget.kind !== row.budget_kind || budget.value !== row.budget_value || budget.period !== row.budget_period) db.query("UPDATE time_projects SET budget_alerted = NULL WHERE id = ?").run(row.id);
    if (input.rateMinor !== undefined && input.rateMinor !== row.rate_minor) audit(userId, null, "time.rate_change", { projectId: row.id });
    if (name !== row.name) recordItemActivity({ itemKind: "time_project", itemId: row.id, actorId: userId, kind: "time_project_changed", payload: { from: { label: row.name }, to: { label: name } } });
    audit(userId, null, "time.project_update", { projectId: row.id, fields: Object.keys(input).filter((key) => key !== "expectedRevision") });
    return projectView(row.id, userId)!;
  })();
}

/** To the Bin (the owner only); its entries stay and keep it until purge (T533). */
export function binProject(userId: string, ref: string) {
  const row = projectRow(ref);
  if (!row || row.deleted_at !== null || projectLevel(row.id, userId) === "none") throw notFound("Project");
  if (row.owner_id !== userId) throw new TimeError(403, "OWNER_ONLY", "Only the project's owner moves it to the Bin");
  const deletedAt = new Date();
  db.query("UPDATE time_projects SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL")
    .run(deletedAt.toISOString(), userId, purgeAfterFrom(deletedAt), deletedAt.toISOString(), row.id);
  audit(userId, null, "time.project_delete", { projectId: row.id });
  return { binned: true, purgeAfter: purgeAfterFrom(deletedAt) };
}

// ---------------------------------------------------------------------------
// Member rates (managers only, D873)

export function projectRates(userId: string, ref: string) {
  const row = projectRow(ref);
  if (!row || row.deleted_at !== null || projectLevel(row.id, userId) === "none") throw notFound("Project");
  if (!atLeast(projectLevel(row.id, userId), "manage")) throw new TimeError(403, "READ_ONLY", "Only the project's managers see rates");
  const members = db.query(`SELECT u.id, u.display_name AS name, im.level, r.rate_minor FROM users u
      LEFT JOIN item_members im ON im.item_kind = 'time_project' AND im.item_id = $project AND im.user_id = u.id
      LEFT JOIN time_member_rates r ON r.project_id = $project AND r.user_id = u.id
    WHERE u.id = $owner OR im.user_id IS NOT NULL OR r.user_id IS NOT NULL OR u.id IN (SELECT DISTINCT user_id FROM time_entries WHERE project_id = $project)
    ORDER BY u.display_name COLLATE NOCASE`).all({ project: row.id, owner: row.owner_id }) as Array<{ id: string; name: string; level: string | null; rate_minor: number | null }>;
  return { currency: row.currency, projectRateMinor: row.rate_minor, members: members.map((member) => ({ id: member.id, name: member.name, level: member.id === row.owner_id ? "owner" : member.level, rateMinor: member.rate_minor })) };
}

export function setMemberRate(userId: string, ref: string, memberId: string, rateMinor: number | null) {
  const row = projectRow(ref);
  if (!row || row.deleted_at !== null || projectLevel(row.id, userId) === "none") throw notFound("Project");
  if (!atLeast(projectLevel(row.id, userId), "manage")) throw new TimeError(403, "READ_ONLY", "Only the project's managers set rates");
  if (rateMinor !== null && (!Number.isSafeInteger(rateMinor) || rateMinor < 0)) throw invalid("A rate is a whole number of minor units");
  if (!db.query("SELECT 1 FROM users WHERE id = ?").get(memberId)) throw notFound("Person");
  if (rateMinor === null) db.query("DELETE FROM time_member_rates WHERE project_id = ? AND user_id = ?").run(row.id, memberId);
  else db.query(`INSERT INTO time_member_rates (project_id, user_id, rate_minor, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET rate_minor = excluded.rate_minor, updated_at = excluded.updated_at`)
    .run(row.id, memberId, rateMinor, now());
  audit(userId, null, "time.rate_change", { projectId: row.id, memberId });
  return projectRates(userId, row.id);
}

// ---------------------------------------------------------------------------
// Week approvals (D874)

export type ApprovalRow = { id: string; project_id: string; user_id: string; week_start: string; status: "submitted" | "approved" | "rejected"; note: string | null; decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string };

const weekEnd = (weekStart: string) => weekDays(weekStart)[6]!;

/** A person's finished entries of a week on a project, by each entry's local day (the rule approval locks by). */
function weekEntries(projectId: string, userId: string, weekStart: string, tz: string) {
  const rows = db.query("SELECT id, started_at, tz, duration_s FROM time_entries WHERE project_id = ? AND user_id = ? AND ended_at IS NOT NULL AND started_at >= ? AND started_at < ?")
    .all(projectId, userId, new Date(Date.parse(`${weekStart}T00:00:00Z`) - 2 * 86_400_000).toISOString(), new Date(Date.parse(`${weekEnd(weekStart)}T00:00:00Z`) + 3 * 86_400_000).toISOString()) as Array<{ id: string; started_at: string; tz: string; duration_s: number | null }>;
  const days = new Set(weekDays(weekStart));
  return rows.filter((row) => days.has(localDate(row.started_at, row.tz || tz)));
}

function weekEntryIds(projectId: string, userId: string, weekStart: string, tz: string) {
  return weekEntries(projectId, userId, weekStart, tz).map((row) => row.id);
}

const userTz = (userId: string) => (db.query("SELECT tz FROM time_user_settings WHERE user_id = ?").get(userId) as { tz: string } | null)?.tz ?? "UTC";

export function submitWeek(userId: string, projectRef: string, weekStart: string, note?: string | null) {
  const project = projectRow(projectRef);
  if (!project || project.deleted_at !== null || !canLogOn(project.id, userId)) throw notFound("Project");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw invalid("weekStart is a date");
  return db.transaction(() => {
    const existing = db.query("SELECT * FROM time_approvals WHERE project_id = ? AND user_id = ? AND week_start = ?").get(project.id, userId, weekStart) as ApprovalRow | null;
    if (existing?.status === "approved") throw new TimeError(409, "WEEK_LOCKED", "This week is already approved");
    const timestamp = now();
    if (existing) db.query("UPDATE time_approvals SET status = 'submitted', note = ?, decided_by = NULL, decided_at = NULL, updated_at = ? WHERE id = ?").run(note ?? null, timestamp, existing.id);
    else db.query("INSERT INTO time_approvals (id, project_id, user_id, week_start, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?)").run(Bun.randomUUIDv7(), project.id, userId, weekStart, note ?? null, timestamp, timestamp);
    const author = (db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | null)?.display_name ?? "Someone";
    notify({ userIds: managersOf(project), module: "time", topic: "time.approval", title: `${author} submitted the week of ${weekStart}`, body: `Time on ${project.name} is waiting for approval.`,
      href: `${projectHref(project)}?tab=approvals`, item: { kind: "time_project", id: project.id }, actor: userId, dedupeKey: `time.approval:${project.id}:${userId}:${weekStart}`,
      email: { template: "time.update", payload: { topic: "time.approval", kind: "time_project", id: project.id, actorId: userId, weekStart }, coalesceKey: `time.approval:${project.id}:${userId}:${weekStart}`, windowMs: WINDOW_MS.activity } });
    recordItemActivity({ itemKind: "time_project", itemId: project.id, actorId: userId, kind: "time_week_submitted", payload: { extra: { weekStart } } });
    audit(userId, null, "time.approval_submit", { projectId: project.id, weekStart });
    return db.query("SELECT * FROM time_approvals WHERE project_id = ? AND user_id = ? AND week_start = ?").get(project.id, userId, weekStart) as ApprovalRow;
  })();
}

/** Approve (locks the person's entries of that week on the project), reject, or unlock (managers, audited). */
export function decideWeek(managerId: string, approvalId: string, decision: "approve" | "reject" | "unlock", note?: string | null) {
  return db.transaction(() => {
    const approval = db.query("SELECT * FROM time_approvals WHERE id = ?").get(approvalId) as ApprovalRow | null;
    if (!approval) throw notFound("Approval");
    const project = projectRow(approval.project_id);
    if (!project || project.deleted_at !== null || projectLevel(project.id, managerId) === "none") throw notFound("Approval");
    if (!atLeast(projectLevel(project.id, managerId), "manage")) throw new TimeError(403, "READ_ONLY", "Only the project's managers approve weeks");
    const timestamp = now();
    const ids = weekEntryIds(project.id, approval.user_id, approval.week_start, userTz(approval.user_id));
    if (decision === "approve") {
      db.query("UPDATE time_approvals SET status = 'approved', note = COALESCE(?, note), decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(note ?? null, managerId, timestamp, timestamp, approval.id);
      for (const id of ids) db.query("UPDATE time_entries SET locked_at = ?, locked_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND locked_at IS NULL").run(timestamp, managerId, timestamp, id);
    } else if (decision === "reject") {
      db.query("UPDATE time_approvals SET status = 'rejected', note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(note ?? null, managerId, timestamp, timestamp, approval.id);
      for (const id of ids) db.query("UPDATE time_entries SET locked_at = NULL, locked_by = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND locked_at IS NOT NULL").run(timestamp, id);
    } else {
      db.query("DELETE FROM time_approvals WHERE id = ?").run(approval.id);
      for (const id of ids) db.query("UPDATE time_entries SET locked_at = NULL, locked_by = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND locked_at IS NOT NULL").run(timestamp, id);
    }
    const words = { approve: "approved", reject: "returned", unlock: "unlocked" } as const;
    notify({ userIds: [approval.user_id], module: "time", topic: "time.approval_decided", title: `Your week of ${approval.week_start} was ${words[decision]}`,
      body: `${project.name}${note ? `: ${note.slice(0, 200)}` : ""}`, href: `/time/timesheet?week=${approval.week_start}`, item: { kind: "time_project", id: project.id }, actor: managerId,
      email: { template: "time.update", payload: { topic: "time.approval_decided", kind: "time_project", id: project.id, actorId: managerId, weekStart: approval.week_start, decision }, coalesceKey: `time.decided:${approval.id}`, windowMs: WINDOW_MS.activity } });
    recordItemActivity({ itemKind: "time_project", itemId: project.id, actorId: managerId, kind: decision === "approve" ? "time_week_approved" : decision === "reject" ? "time_week_rejected" : "time_week_unlocked", payload: { extra: { weekStart: approval.week_start } } });
    audit(managerId, null, `time.approval_${decision}`, { projectId: project.id, approvalId: approval.id, memberId: approval.user_id, entries: ids.length });
    return { status: decision === "unlock" ? null : decision === "approve" ? "approved" : "rejected", entries: ids.length };
  })();
}

/** Approvals the viewer manages (pending first) or their own. */
export function listApprovals(userId: string, options: { projectId?: string; mine?: boolean; status?: string } = {}) {
  const params: Record<string, string> = { userId };
  const where = options.mine ? ["a.user_id = $userId"] : [readableContainerSql("time_project", "p", { minLevel: "manage" })];
  if (options.projectId) { where.push("a.project_id = $projectId"); params.projectId = projectRow(options.projectId)?.id ?? "-"; }
  if (options.status) { where.push("a.status = $status"); params.status = options.status; }
  const rows = db.query(`SELECT a.*, p.name AS project_name, u.display_name AS user_name
    FROM time_approvals a JOIN time_projects p ON p.id = a.project_id LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where.join(" AND ")} ORDER BY (a.status = 'submitted') DESC, a.week_start DESC LIMIT 200`).all(params) as Array<ApprovalRow & { project_name: string; user_name: string | null }>;
  // The week's total counts the entries approving would lock: each entry's local day, not UTC bounds (TG7, D1146).
  const seconds = (row: ApprovalRow) => weekEntries(row.project_id, row.user_id, row.week_start, userTz(row.user_id)).reduce((sum, entry) => sum + (entry.duration_s ?? 0), 0);
  return rows.map((row) => ({ id: row.id, project: { id: row.project_id, name: row.project_name }, user: { id: row.user_id, name: row.user_name ?? "Former member" }, weekStart: row.week_start, status: row.status, note: row.note, seconds: seconds(row), decidedAt: row.decided_at }));
}

export { canLogOn };
