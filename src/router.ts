// Pure URL routing for the SPA. No DOM access, so it can be unit tested directly.
import { formatBoardSearch, isDefaultBoardQuery, parseBoardSearch, type BoardQuery } from "./tasks/boardUrl";
import { formatHomeSearch, NEW_VIEW, parseMyWorkSearch, parseViewSearch, type TasksHome } from "./tasks/home/homeUrl";
import { appName } from "./appName";

/** Lane I: the Reports home's view: Unfiled, Shared with me, Favorites (phase 1), or one of the person's folders (its id). */
export type ReportsFolderView = "unfiled" | "shared" | "favorites" | (string & {});

/**
 * Report organization phase 1: the Reports list's filters in its URL query (?owner=&status=&datasource=&schedule=),
 * so Back and Forward restore them. `owner` is `me` or a person's id; `status` one or more statuses,
 * comma-separated; `schedule` `on` or `off`. Anything malformed is dropped.
 */
export type ReportsFilter = { owner?: string; status?: string[]; datasource?: string; schedule?: "on" | "off" };
export const REPORTS_FILTER_STATUSES = ["draft", "ready", "stale", "error"] as const;

export function parseReportsFilter(search: string): ReportsFilter | undefined {
  const params = new URLSearchParams(search);
  const filter: ReportsFilter = {};
  const owner = params.get("owner");
  const status = params.get("status");
  const datasource = params.get("datasource");
  const schedule = params.get("schedule");
  if (owner && (owner === "me" || isRouteId(owner))) filter.owner = owner.toLowerCase();
  if (status) {
    const statuses = [...new Set(status.split(","))].filter((value) => (REPORTS_FILTER_STATUSES as readonly string[]).includes(value));
    if (statuses.length) filter.status = REPORTS_FILTER_STATUSES.filter((value) => statuses.includes(value));
  }
  if (datasource && isRouteId(datasource)) filter.datasource = datasource.toLowerCase();
  if (schedule === "on" || schedule === "off") filter.schedule = schedule;
  return Object.keys(filter).length ? filter : undefined;
}

export function formatReportsFilter(filter: ReportsFilter | undefined) {
  if (!filter) return "";
  const params = new URLSearchParams();
  if (filter.owner && (filter.owner === "me" || isRouteId(filter.owner))) params.set("owner", filter.owner.toLowerCase());
  const statuses = REPORTS_FILTER_STATUSES.filter((value) => filter.status?.includes(value));
  if (statuses.length) params.set("status", statuses.join(","));
  if (filter.datasource && isRouteId(filter.datasource)) params.set("datasource", filter.datasource.toLowerCase());
  if (filter.schedule === "on" || filter.schedule === "off") params.set("schedule", filter.schedule);
  const text = params.toString().replace(/%2C/g, ",");
  return text ? `?${text}` : "";
}

export type Route =
  | { app: "home" }
  | { app: "notes"; folder: "all" | "shared" | string; noteId: string | null }
  | { app: "files"; folder: "all" | "shared" | string; documentId: string | null }
  // `query` (D112): a board's view, grouping, sort, and filters, carried in the URL query. It is
  // left out when it is the default, and never set without a board. `full` (13D): the card as a page.
  // `home` (17C): without a board, the My work and Views segments of the Tasks home (/tasks is Boards).
  // `sprints`: the board's Sprints sheet (/tasks/:boardId/sprints), over the board in its view.
  | { app: "tasks"; boardId: string | null; cardId: string | null; full?: true; query?: BoardQuery; home?: TasksHome; sprints?: true }
  | { app: "collections"; collectionId: string | null; viewId: string | null; rowId: string | null }
  | { app: "calendar"; view: "agenda" | "month"; month: string | null; eventId: string | null }
  | { app: "notifications" }
  // Wave 38: the Bin lives in the Settings hub. Its canonical URL is /settings/bin; the old /bin
  // still parses to the same route and is rewritten in place.
  | { app: "bin" }
  // `invites` (Wave 18): the admin Invites panel at /team/invites, in the detail pane. Never with a user.
  // `email` (Wave 28): the admin Email log at /team/email, the same way.
  // `keys` and `policies` (Wave 31): Team → Keys at /team/keys and Team → Policies at /team/policies, the same way.
  // `groups` (Wave 32): Team → Groups at /team/groups, and one group at /team/groups/:groupId.
  // Wave 33: a member's access page at /team/:userId/access (`access` with a userId), Team → Templates
  // at /team/templates, and Team → Access activity at /team/activity.
  // Wave 36: Team → Integrations at /team/integrations, and one integration at /team/integrations/:integrationId.
  // Wave 37: Team lives in the Settings hub. Its canonical URLs are /settings/team/members,
  // /settings/team/members/:userId(/access), and /settings/team/<section>(/:id); every old /team/…
  // URL still parses to the same route and is rewritten in place to the canonical one.
  | { app: "team"; userId: string | null; invites?: true; email?: true; keys?: true; policies?: true; groups?: true; groupId?: string; access?: true; templates?: true; activity?: true; integrations?: true; integrationId?: string }
  // The agent inbox (Wave 21): pending at /inbox, resolved at /inbox/history, one proposal at
  // /inbox/p/:id (or /inbox/history/p/:id, so the list beside it on desktop stays History).
  // Routines (Wave 22) at /inbox/routines; the routine editor is a sheet on that entry.
  | { app: "inbox"; view: "pending" | "history" | "routines"; proposalId: string | null }
  // Whiteboards (Wave 23, §10.1): /whiteboards, /whiteboards/shared, /whiteboards/folder/:id, and
  // one board at /whiteboards/:id (the canvas, a history entry of its own).
  | { app: "whiteboards"; folder: "all" | "shared" | string; boardId: string | null }
  // The Vault (Wave 25, vault plan §10): the list at /vault, one vault at /vault/:vaultId (the grid on
  // desktop, its first environment's cards on phones), one environment at /vault/:vaultId/env/:envId,
  // and one secret at /vault/:vaultId/secrets/:secretId (its values stacked per environment).
  // Wave 26: who has access at /vault/:vaultId/access, and its Activity at /vault/:vaultId/activity.
  | { app: "vault"; vaultId: string | null; envId: string | null; secretId: string | null; page: "access" | "activity" | null }
  // Agent chat (Wave 40, plan §13.1): the list at /chat (desktop: the list beside an empty state),
  // a new chat at /chat/new (optionally `?agent=<id>` preselects the agent), and one chat at /chat/:chatId.
  // Wave 42 (AC-C, plan §13.3): the Audit log at /chat/audit, and one run at /chat/audit/:runId.
  // Its filters ride in the query (QA L4): ?key=&agent=&status=&from=&to=, on the list and on a run opened from it.
  | { app: "chat"; chatId: string | null; newChat?: true; agentId?: string; audit?: true; runId?: string; auditFilter?: AuditQuery }
  // Analytics reports (Wave 45): the list at /reports and one report at /reports/:reportId. Its sheets
  // (the Schema browser, a new report) are history layers on that entry, not URLs.
  // Lane I: the list's folder: /reports/folder/:folderId, /reports/unfiled, /reports/shared (none: All).
  // Phase 1: /reports/favorites, and the list's filters in its query (`filter`, never on a report).
  | { app: "reports"; reportId: string | null; folder?: ReportsFolderView; filter?: ReportsFilter }
  // The Settings hub (Wave 37): a page at /settings (the section list on phones), and one account
  // section at /settings/:section. Team sections are `team` routes under /settings/team/… (above).
  // Wave 40: Settings → Agents has an editor below it at /settings/agents/:agentId (or /settings/agents/new).
  // Wave 44 (AC-E): Settings → Knowledge has a page per base below it at /settings/knowledge/:kbId.
  // Settings → AI is tabbed: /settings/ai/providers, /settings/ai/tools, /settings/ai/policy (`aiTab`).
  // API keys too: /settings/keys/general, /settings/keys/vault, /settings/keys/agents (`keysTab`).
  | { app: "settings"; section: SettingsSection | null; agentId?: string; aiTab?: AiTab; keysTab?: KeysTab; kbId?: string };

/** The Audit log's filters in its URL (Wave 42 QA L4); anything malformed is dropped. */
export type AuditQuery = { key?: string; agent?: string; status?: string; from?: string; to?: string };
export const AUDIT_STATUSES = ["ok", "failed", "cancelled", "step_limit", "running"] as const;
const AUDIT_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseAuditQuery(search: string): AuditQuery | undefined {
  const params = new URLSearchParams(search);
  const query: AuditQuery = {};
  const key = params.get("key");
  const agent = params.get("agent");
  const status = params.get("status");
  const from = params.get("from");
  const to = params.get("to");
  if (key && isRouteId(key)) query.key = key.toLowerCase();
  if (agent && isRouteId(agent)) query.agent = agent.toLowerCase();
  if (status && (AUDIT_STATUSES as readonly string[]).includes(status)) query.status = status;
  if (from && AUDIT_DAY.test(from)) query.from = from;
  if (to && AUDIT_DAY.test(to)) query.to = to;
  return Object.keys(query).length ? query : undefined;
}

export function formatAuditQuery(query: AuditQuery | undefined) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const name of ["key", "agent", "status", "from", "to"] as const) {
    const value = query[name];
    if (value) params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRouteId(value: string) {
  return idPattern.test(value);
}

function parseCollection(segments: string[]): { folder: string; itemId: string | null } {
  // Server ids are lowercase; normalise so a pasted uppercase link still matches.
  const rest = segments.map((segment) => isRouteId(segment) ? segment.toLowerCase() : segment);
  const [first, second] = rest;
  if (first === undefined) return { folder: "all", itemId: null };
  if (first === "shared" && rest.length === 1) return { folder: "shared", itemId: null };
  if (first === "folder") return { folder: second !== undefined && rest.length === 2 && isRouteId(second) ? second : "all", itemId: null };
  if (rest.length === 1 && isRouteId(first)) return { folder: "all", itemId: first };
  return { folder: "all", itemId: null };
}

// /tasks, /tasks/:boardId, /tasks/:boardId/sprints (the Sprints sheet), /tasks/:boardId/card/:cardId,
// and /tasks/:boardId/card/:cardId/full (the card as a page, 13D). Anything malformed after a valid board id still opens that board; a
// malformed board id opens the board list. The query (view, filters) belongs to the board: it is
// kept on its cards' URLs too, so closing a card returns to the same view (D112).
function parseTasks(segments: string[], search: string): Route {
  const [board, kind, card, view] = segments;
  const home = parseTasksHome(segments, search);
  if (home) return { app: "tasks", boardId: null, cardId: null, home };
  if (board === undefined || !isRouteId(board)) return { app: "tasks", boardId: null, cardId: null };
  const boardId = board.toLowerCase();
  const full = segments.length === 4 && view === "full";
  const cardId = (segments.length === 3 || full) && kind === "card" && card !== undefined && isRouteId(card) ? card.toLowerCase() : null;
  const query = parseBoardSearch(search);
  const sprints = segments.length === 2 && kind === "sprints";
  const route: Route = cardId && full ? { app: "tasks", boardId, cardId, full: true } : sprints ? { app: "tasks", boardId, cardId: null, sprints: true } : { app: "tasks", boardId, cardId };
  return isDefaultBoardQuery(query) ? route : { ...route, query };
}

// The Tasks home segments (17C): /tasks/my, /tasks/views, /tasks/views/new, and /tasks/views/:id,
// each with its query. Anything malformed after `views` opens the views list; after `my`, My work.
function parseTasksHome(segments: string[], search: string): TasksHome | null {
  const [section, id] = segments;
  if (section === "my") {
    const query = parseMyWorkSearch(search);
    return formatHomeSearch({ section: "my", query }) ? { section: "my", query } : { section: "my" };
  }
  if (section !== "views") return null;
  if (segments.length !== 2 || id === undefined || !(id === NEW_VIEW || isRouteId(id))) return { section: "views" };
  const query = parseViewSearch(search);
  const viewId = id.toLowerCase();
  return query ? { section: "view", viewId, query } : { section: "view", viewId };
}

// /collections, /collections/:c, /collections/:c/view/:v, and /collections/:c/row/:r. Anything
// malformed after a valid collection id still opens that collection.
function parseCollections(segments: string[]): Route {
  const [collection, kind, item] = segments;
  const none = { app: "collections" as const, collectionId: null, viewId: null, rowId: null };
  if (collection === undefined || !isRouteId(collection)) return none;
  const collectionId = collection.toLowerCase();
  const itemId = segments.length === 3 && item !== undefined && isRouteId(item) ? item.toLowerCase() : null;
  return { ...none, collectionId, viewId: kind === "view" ? itemId : null, rowId: kind === "row" ? itemId : null };
}

const monthPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A `yyyy-mm` month between 1900 and 2200. */
export function isRouteMonth(value: string) {
  const match = monthPattern.exec(value);
  return match !== null && Number(match[1]) >= 1900 && Number(match[1]) <= 2200;
}

// /calendar (agenda), /calendar/month/:yyyy-mm, and /calendar/event/:eventId. A malformed month opens
// the month view at the current month (the app fills it in); anything else malformed opens the agenda.
function parseCalendar(segments: string[]): Route {
  const [kind, value] = segments;
  if (kind === "month" && segments.length <= 2) return { app: "calendar", view: "month", month: value !== undefined && isRouteMonth(value) ? value : null, eventId: null };
  if (kind === "event" && segments.length === 2 && value !== undefined && isRouteId(value)) return { app: "calendar", view: "agenda", month: null, eventId: value.toLowerCase() };
  return { app: "calendar", view: "agenda", month: null, eventId: null };
}

/**
 * A location's route. `search` is the location's query (`location.search`): only Tasks reads it
 * (D112), and every Tasks caller must pass it, or a reload or Back drops the board's view and
 * filters (`tests/routerSearch.test.ts` checks the call sites). A `pathname` that still carries
 * its own `?query` (an in-app href) is split first.
 */
export function parseRoute(pathname: string, search = ""): Route {
  const mark = pathname.indexOf("?");
  if (mark >= 0) {
    if (!search) search = pathname.slice(mark);
    pathname = pathname.slice(0, mark);
  }
  const segments = pathname.split("/").filter(Boolean);
  const [app, ...rest] = segments;
  if (app === "notes") {
    const { folder, itemId } = parseCollection(rest);
    return { app: "notes", folder, noteId: itemId };
  }
  if (app === "files") {
    const { folder, itemId } = parseCollection(rest);
    return { app: "files", folder, documentId: itemId };
  }
  if (app === "tasks") return parseTasks(rest, search);
  if (app === "collections") return parseCollections(rest);
  if (app === "calendar") return parseCalendar(rest);
  if (app === "notifications" && rest.length === 0) return { app: "notifications" };
  if (app === "bin" && rest.length === 0) return { app: "bin" };
  if (app === "team") return parseTeam(rest, false);
  if (app === "settings") return parseSettings(rest);
  if (app === "inbox") return parseInbox(rest);
  if (app === "whiteboards") {
    const { folder, itemId } = parseCollection(rest);
    return { app: "whiteboards", folder, boardId: itemId };
  }
  if (app === "vault") return parseVault(rest);
  if (app === "chat") return parseChat(rest, search);
  if (app === "reports") {
    const [reportId, folderId] = rest;
    if (rest.length === 1 && reportId !== undefined && isRouteId(reportId)) return { app: "reports", reportId: reportId.toLowerCase() };
    const filter = parseReportsFilter(search);
    const list = (folder?: ReportsFolderView): Route => ({ app: "reports", reportId: null, ...(folder ? { folder } : {}), ...(filter ? { filter } : {}) });
    if (rest.length === 1 && (reportId === "unfiled" || reportId === "shared" || reportId === "favorites")) return list(reportId);
    if (rest.length === 2 && reportId === "folder" && folderId !== undefined && isRouteId(folderId)) return list(folderId.toLowerCase());
    return list();
  }
  return { app: "home" };
}

export const NEW_AGENT = "new";

// /chat, /chat/new (with ?agent=<id>), /chat/:chatId, /chat/audit, and /chat/audit/:runId. Anything malformed opens the list.
function parseChat(segments: string[], search: string): Route {
  const [first] = segments;
  if (first === "audit") {
    const runId = segments[1];
    const filter = parseAuditQuery(search);
    const list: Route = filter ? { app: "chat", chatId: null, audit: true, auditFilter: filter } : { app: "chat", chatId: null, audit: true };
    if (segments.length === 1) return list;
    return segments.length === 2 && runId && isRouteId(runId) ? { ...list, runId: runId.toLowerCase() } : list;
  }
  if (first === undefined || segments.length !== 1) return { app: "chat", chatId: null };
  if (first === "new") {
    const agent = new URLSearchParams(search).get("agent");
    return agent && isRouteId(agent) ? { app: "chat", chatId: null, newChat: true, agentId: agent.toLowerCase() } : { app: "chat", chatId: null, newChat: true };
  }
  return isRouteId(first) ? { app: "chat", chatId: first.toLowerCase() } : { app: "chat", chatId: null };
}

/**
 * Team sections, shared by the canonical /settings/team/… URLs (`hub`) and the old /team/… aliases.
 * The hub names the member list `members` (/settings/team/members/:userId); the old scheme put the
 * member id right after /team (D167: named sections are matched before the id rule). Anything
 * malformed opens the member list.
 */
function parseTeam(rest: string[], hub: boolean): Route {
  const list = { app: "team" as const, userId: null };
  const [first, second, third] = rest;
  if (first === undefined) return list;
  if (hub && first === "members") {
    if (rest.length === 1 || second === undefined || !isRouteId(second)) return list;
    if (rest.length === 2) return { app: "team", userId: second.toLowerCase() };
    return rest.length === 3 && third === "access" ? { app: "team", userId: second.toLowerCase(), access: true } : list;
  }
  if (rest.length === 1 && first === "invites") return { ...list, invites: true };
  if (rest.length === 1 && first === "email") return { ...list, email: true };
  if (rest.length === 1 && first === "keys") return { ...list, keys: true };
  if (rest.length === 1 && first === "policies") return { ...list, policies: true };
  if (first === "groups" && rest.length <= 2) {
    return rest.length === 2 && isRouteId(second!) ? { ...list, groups: true, groupId: second!.toLowerCase() } : { ...list, groups: true };
  }
  if (first === "integrations" && rest.length <= 2) {
    return rest.length === 2 && isRouteId(second!) ? { ...list, integrations: true, integrationId: second!.toLowerCase() } : { ...list, integrations: true };
  }
  if (rest.length === 1 && first === "templates") return { ...list, templates: true };
  if (rest.length === 1 && first === "activity") return { ...list, activity: true };
  if (hub) return list;
  if (rest.length === 2 && second === "access" && isRouteId(first)) return { app: "team", userId: first.toLowerCase(), access: true };
  return { app: "team", userId: rest.length === 1 && isRouteId(first) ? first.toLowerCase() : null };
}

/**
 * The Settings hub (Wave 37): /settings (the section list), /settings/:section (an account section;
 * the old /settings/mcp opens API keys), /settings/bin (the Bin, Wave 38), and /settings/team/…
 * (Team sections). An unknown section opens the list.
 */
function parseSettings(rest: string[]): Route {
  if (rest[0] === "team") return parseTeam(rest.slice(1), true);
  // Wave 40: the agent editor, /settings/agents/:agentId or /settings/agents/new.
  if (rest[0] === "agents" && rest.length === 2 && rest[1] !== undefined && (rest[1] === NEW_AGENT || isRouteId(rest[1]))) return { app: "settings", section: "agents", agentId: rest[1].toLowerCase() };
  // Wave 44 (AC-E): one knowledge base's page, /settings/knowledge/:kbId.
  if (rest[0] === "knowledge" && rest.length === 2 && rest[1] !== undefined && isRouteId(rest[1])) return { app: "settings", section: "knowledge", kbId: rest[1].toLowerCase() };
  if (rest.length === 1 && rest[0] === "bin") return { app: "bin" };
  // Settings → AI's tabs. An unknown or malformed tab opens bare AI, which then opens its first tab.
  if (rest[0] === "ai" && rest.length >= 2) return rest.length === 2 && isAiTab(rest[1]) ? { app: "settings", section: "ai", aiTab: rest[1] } : { app: "settings", section: "ai" };
  // API keys' tabs (and the old /settings/mcp/:tab), the same way: bare API keys then opens General.
  if (rest.length >= 2 && settingsSectionForSlug(rest[0]!) === "mcp") return rest.length === 2 && isKeysTab(rest[1]) ? { app: "settings", section: "mcp", keysTab: rest[1] } : { app: "settings", section: "mcp" };
  const section = rest.length === 1 ? settingsSectionForSlug(rest[0]!) : null;
  return { app: "settings", section };
}

// /vault, /vault/:v, /vault/:v/env/:e, /vault/:v/secrets/:s, /vault/:v/access, and /vault/:v/activity.
// Anything malformed after a valid vault id opens that vault; a malformed vault id opens the list.
function parseVault(segments: string[]): Route {
  const none = { app: "vault" as const, vaultId: null, envId: null, secretId: null, page: null };
  const [vault, kind, item] = segments;
  if (vault === undefined || !isRouteId(vault)) return none;
  const vaultId = vault.toLowerCase();
  if (segments.length === 2 && (kind === "access" || kind === "activity")) return { ...none, vaultId, page: kind };
  const itemId = segments.length === 3 && item !== undefined && isRouteId(item) ? item.toLowerCase() : null;
  return { ...none, vaultId, envId: kind === "env" ? itemId : null, secretId: kind === "secrets" ? itemId : null };
}

// /inbox, /inbox/history, /inbox/p/:id, /inbox/history/p/:id, and /inbox/routines. Anything malformed opens the list it names.
function parseInbox(segments: string[]): Route {
  if (segments[0] === "routines") return { app: "inbox", view: "routines", proposalId: null };
  const history = segments[0] === "history";
  const [kind, id] = history ? segments.slice(1) : segments;
  const proposalId = kind === "p" && id !== undefined && isRouteId(id) && segments.length === (history ? 3 : 2) ? id.toLowerCase() : null;
  return { app: "inbox", view: history ? "history" : "pending", proposalId };
}

function formatCollection(base: string, folder: string, itemId: string | null) {
  if (itemId && isRouteId(itemId)) return `${base}/${itemId.toLowerCase()}`;
  if (folder === "shared") return `${base}/shared`;
  if (folder !== "all" && isRouteId(folder)) return `${base}/folder/${folder.toLowerCase()}`;
  return base;
}

// An open item wins over its folder: the folder is derived from the item when the URL is parsed.
export function formatRoute(route: Route): string {
  if (route.app === "notes") return formatCollection("/notes", route.folder, route.noteId);
  if (route.app === "files") return formatCollection("/files", route.folder, route.documentId);
  if (route.app === "tasks") {
    if (!route.boardId && route.home) return formatTasksHome(route.home);
    if (!route.boardId || !isRouteId(route.boardId)) return "/tasks";
    const board = `/tasks/${route.boardId.toLowerCase()}`;
    const search = route.query ? formatBoardSearch(route.query) : "";
    if (!route.cardId || !isRouteId(route.cardId)) return `${board}${route.sprints ? "/sprints" : ""}${search}`;
    return `${board}/card/${route.cardId.toLowerCase()}${route.full ? "/full" : ""}${search}`;
  }
  if (route.app === "collections") {
    if (!route.collectionId || !isRouteId(route.collectionId)) return "/collections";
    const collection = `/collections/${route.collectionId.toLowerCase()}`;
    // A row wins over a view: the row panel is the deeper entry.
    if (route.rowId && isRouteId(route.rowId)) return `${collection}/row/${route.rowId.toLowerCase()}`;
    return route.viewId && isRouteId(route.viewId) ? `${collection}/view/${route.viewId.toLowerCase()}` : collection;
  }
  if (route.app === "calendar") {
    if (route.eventId && isRouteId(route.eventId)) return `/calendar/event/${route.eventId.toLowerCase()}`;
    if (route.view === "month") return route.month && isRouteMonth(route.month) ? `/calendar/month/${route.month}` : "/calendar/month";
    return "/calendar";
  }
  if (route.app === "notifications") return "/notifications";
  if (route.app === "bin") return "/settings/bin";
  if (route.app === "team") return formatTeam(route);
  if (route.app === "settings") {
    if (route.section === "agents" && route.agentId && (route.agentId === NEW_AGENT || isRouteId(route.agentId))) return `${settingsPath("agents")}/${route.agentId.toLowerCase()}`;
    if (route.section === "knowledge" && route.kbId && isRouteId(route.kbId)) return `${settingsPath("knowledge")}/${route.kbId.toLowerCase()}`;
    if (route.section === "ai" && isAiTab(route.aiTab)) return aiTabPath(route.aiTab);
    if (route.section === "mcp" && isKeysTab(route.keysTab)) return keysTabPath(route.keysTab);
    return route.section && SETTINGS_SECTIONS.includes(route.section) ? settingsPath(route.section) : "/settings";
  }
  if (route.app === "chat") {
    if (route.audit) return `${route.runId && isRouteId(route.runId) ? `/chat/audit/${route.runId.toLowerCase()}` : "/chat/audit"}${formatAuditQuery(route.auditFilter)}`;
    if (route.chatId && isRouteId(route.chatId)) return `/chat/${route.chatId.toLowerCase()}`;
    if (route.newChat) return route.agentId && isRouteId(route.agentId) ? `/chat/new?agent=${route.agentId.toLowerCase()}` : "/chat/new";
    return "/chat";
  }
  if (route.app === "whiteboards") return formatCollection("/whiteboards", route.folder, route.boardId);
  if (route.app === "reports") {
    if (route.reportId && isRouteId(route.reportId)) return `/reports/${route.reportId.toLowerCase()}`;
    const query = formatReportsFilter(route.filter);
    if (route.folder === "unfiled" || route.folder === "shared" || route.folder === "favorites") return `/reports/${route.folder}${query}`;
    return `${route.folder && isRouteId(route.folder) ? `/reports/folder/${route.folder.toLowerCase()}` : "/reports"}${query}`;
  }
  if (route.app === "vault") {
    if (!route.vaultId || !isRouteId(route.vaultId)) return "/vault";
    const vault = `/vault/${route.vaultId.toLowerCase()}`;
    // A secret wins over an environment: the detail is the deeper entry.
    if (route.secretId && isRouteId(route.secretId)) return `${vault}/secrets/${route.secretId.toLowerCase()}`;
    if (route.page === "access" || route.page === "activity") return `${vault}/${route.page}`;
    return route.envId && isRouteId(route.envId) ? `${vault}/env/${route.envId.toLowerCase()}` : vault;
  }
  if (route.app === "inbox") {
    if (route.view === "routines") return "/inbox/routines";
    const base = route.view === "history" ? "/inbox/history" : "/inbox";
    return route.proposalId && isRouteId(route.proposalId) ? `${base}/p/${route.proposalId.toLowerCase()}` : base;
  }
  return "/";
}

/** The canonical Team URL (Wave 37): always under /settings/team. */
function formatTeam(route: Extract<Route, { app: "team" }>) {
  const base = "/settings/team";
  if (route.userId && isRouteId(route.userId)) return `${base}/members/${route.userId.toLowerCase()}${route.access ? "/access" : ""}`;
  if (route.templates) return `${base}/templates`;
  if (route.activity) return `${base}/activity`;
  if (route.invites) return `${base}/invites`;
  if (route.email) return `${base}/email`;
  if (route.keys) return `${base}/keys`;
  if (route.policies) return `${base}/policies`;
  if (route.groups) return route.groupId && isRouteId(route.groupId) ? `${base}/groups/${route.groupId.toLowerCase()}` : `${base}/groups`;
  if (route.integrations) return route.integrationId && isRouteId(route.integrationId) ? `${base}/integrations/${route.integrationId.toLowerCase()}` : `${base}/integrations`;
  return `${base}/members`;
}

function formatTasksHome(home: TasksHome) {
  if (home.section === "my") return `/tasks/my${formatHomeSearch(home)}`;
  if (home.section === "view" && (home.viewId === NEW_VIEW || isRouteId(home.viewId))) return `/tasks/views/${home.viewId.toLowerCase()}${formatHomeSearch(home)}`;
  return "/tasks/views";
}

/**
 * Settings sections (Wave 28 deep links, Wave 37 hub): `/settings/:section` is an account section of
 * the Settings page, a route like any other (`{ app: "settings" }`), so Back and Forward move between
 * sections and back to the page Settings was opened from.
 */
// `access` (Wave 33): Settings → My access, read-only, every role but guest.
// `agents` and `ai` (Wave 40): Settings → Agents (every role that chats) and Settings → AI (admins: providers and policy).
// `knowledge` (Wave 44, AC-E): Settings → Knowledge (every role that chats).
// `datasources` (Wave 45): Settings → Report data sources (admins).
export const SETTINGS_SECTIONS = ["security", "modules", "mcp", "access", "notifications", "agents", "knowledge", "ai", "datasources", "about"] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

/** Settings → AI's tabs, in tab order; each is its own URL under /settings/ai. */
export const AI_TABS = ["providers", "tools", "policy"] as const;
export type AiTab = typeof AI_TABS[number];
export const isAiTab = (value: unknown): value is AiTab => typeof value === "string" && (AI_TABS as readonly string[]).includes(value);
/** Settings → AI's tab labels (also the tab's part of its document title). */
export const AI_TAB_LABELS: Record<AiTab, string> = { providers: "Model providers", tools: "Tool servers", policy: "Chat policy" };
/** The URL of one Settings → AI tab. */
export const aiTabPath = (tab: AiTab) => `${settingsPath("ai")}/${tab}`;

/**
 * The URL slug of each section. API keys (section id "mcp" since Wave 8) lives at `/settings/keys`
 * (C3); the old `/settings/mcp` still opens it and is rewritten in place (no extra history entry).
 */
const SETTINGS_SLUGS: Record<SettingsSection, string> = { security: "security", modules: "modules", mcp: "keys", access: "access", notifications: "notifications", agents: "agents", knowledge: "knowledge", ai: "ai", datasources: "datasources", about: "about" };
const LEGACY_SETTINGS_SLUGS: Record<string, SettingsSection> = { mcp: "mcp" };

function settingsSectionForSlug(slug: string): SettingsSection | null {
  return (Object.keys(SETTINGS_SLUGS) as SettingsSection[]).find((section) => SETTINGS_SLUGS[section] === slug) ?? (Object.hasOwn(LEGACY_SETTINGS_SLUGS, slug) ? LEGACY_SETTINGS_SLUGS[slug]! : null);
}

/** The account section a `/settings/:section` path names, or null (the list, Team, or anything else). */
export function parseSettingsPath(pathname: string): SettingsSection | null {
  const match = /^\/settings\/([a-z]+)\/?$/.exec(pathname);
  return match ? settingsSectionForSlug(match[1]!) : null;
}

export const settingsPath = (section: SettingsSection) => `/settings/${SETTINGS_SLUGS[section]}`;

/** True when `pathname` is a Settings URL that is not the section's canonical one (`/settings/mcp`, a trailing slash). */
export function isLegacySettingsPath(pathname: string) {
  const section = parseSettingsPath(pathname);
  return section !== null && pathname !== settingsPath(section);
}

export const SETTINGS_SECTION_NAMES: Record<SettingsSection, string> = { security: "Security", modules: "Modules", mcp: "API keys", access: "My access", notifications: "Notifications", agents: "Agents", knowledge: "Knowledge", ai: "AI", datasources: "Report data sources", about: "About" };

/**
 * The tabs of Settings → API keys: general keys, vault keys (`nkv_`), and keys that only run agents.
 * Each is a URL, /settings/keys/:tab; /settings/keys (and the old /settings/mcp) opens General in place.
 */
export const KEYS_TABS = ["general", "vault", "agents"] as const;
export type KeysTab = typeof KEYS_TABS[number];
export const isKeysTab = (value: unknown): value is KeysTab => typeof value === "string" && (KEYS_TABS as readonly string[]).includes(value);
export const KEYS_TAB_LABELS: Record<KeysTab, string> = { general: "General", vault: "Vault", agents: "Agents" };
export const keysTabPath = (tab: KeysTab) => `${settingsPath("mcp")}/${tab}`;
/** The route of one API keys tab. */
export const keysTabRoute = (tab: KeysTab): Route => ({ app: "settings", section: "mcp", keysTab: tab });

/**
 * The document title on an account section: "Settings · Notifications · Nook"; on an API keys tab,
 * "Settings · API keys · Vault · Nook"; on a Settings → AI tab (v0.31 follow-up), "Settings · AI · Model providers · Nook".
 */
export const settingsDocumentTitle = (section: SettingsSection, keysTab?: KeysTab, aiTab?: AiTab) =>
  hubDocumentTitle(section === "mcp" && keysTab ? `${SETTINGS_SECTION_NAMES.mcp} · ${KEYS_TAB_LABELS[keysTab]}`
    : section === "ai" && aiTab ? `${SETTINGS_SECTION_NAMES.ai} · ${AI_TAB_LABELS[aiTab]}`
    : SETTINGS_SECTION_NAMES[section]);

/** The document title on a Settings hub screen (Wave 37): "Settings · Members · Nook", or "Settings · Nook" on the list. */
export const hubDocumentTitle = (name: string | null) => name ? `Settings · ${name} · ${appName()}` : `Settings · ${appName()}`;

/** A location's route, with its query (the one way DOM callers should parse the current URL). */
export const routeFromLocation = (location: { pathname: string; search: string }) => parseRoute(location.pathname, location.search);

/**
 * The part of a location `formatRoute` produces, to compare against it: the path, plus the query
 * on Tasks URLs (the only app whose URLs carry one).
 */
const REPORTS_LIST_PATH = /^\/reports(\/(unfiled|shared|favorites|folder\/[^/]+))?\/?$/;

export function locationUrl(location: { pathname: string; search: string }) {
  // Tasks URLs carry the board query; /chat/new carries the preselected agent (Wave 40); the Audit log its filters (Wave 42);
  // the Reports list its filters (report organization phase 1).
  return /^\/tasks(\/|$)/.test(location.pathname) || location.pathname === "/chat/new" || /^\/chat\/audit(\/|$)/.test(location.pathname) || REPORTS_LIST_PATH.test(location.pathname)
    ? `${location.pathname}${location.search}` : location.pathname;
}

export function sameRoute(left: Route, right: Route) {
  return formatRoute(left) === formatRoute(right);
}
