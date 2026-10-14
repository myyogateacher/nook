import { logger, shortId } from "../log";
import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { REPORT_LIMITS } from "../../shared/reports";
import type { DocServerChoice, DocState, DocToolChoice } from "../../shared/reportsGenerate";
import { describeMcpError, McpClientError, type McpSession } from "../agents/mcpClient";
import { AgentError } from "../agents/status";
import { serverAvailableTo, serverRowOrNull, sessionFor, toolsWithPolicies, type StoredTool, type ToolServerRow } from "../agents/toolServers";
import { ownedReport } from "./access";
import { ReportError } from "./errors";
import { checkBrowseTools, pageInfos, recheckPages, serverBrowseSource, storedBrowseTools, type BrowseSource } from "./docBrowse";
import { fetchNookDoc, NOOK_SOURCE_ID, nookBrowseSource, nookCatalog, nookChoice, nookSourceName, nookToolOf } from "./nookSource";

/**
 * The doc a report is built from (plan wave 46, D424, T368): fetched deterministically through an
 * admin-configured tool server **before** any model call, so the model never chooses what is read.
 *
 * - The tool: the person picks a tool server; Nook picks its `fetch`, `get_document`, or
 *   `read_document` tool (in that order) whose input schema takes `id` or `url`. The person may name
 *   another tool and argument. A schema with a `resource` property is Outline's convention
 *   (`fetch {resource: "document", id: <url or urlId>}`), so `resource: "document"` is sent too.
 * - Errors: `MCP_AUTH` (the server refused its credential; the UI says "reconnect") and `DOC_FETCH`
 *   (anything else: unreachable, an error result, an empty doc, a tool an admin turned off).
 * - Snapshots: the doc's markdown (at most 512 KiB, cut on a character boundary) is stored in
 *   `report_doc_snapshots` by SHA-256, and a new row is written only when the hash differs from the
 *   report's newest snapshot. A run records the snapshot it used (`report_runs.doc_snapshot_id`).
 * - "Doc changed — regenerate?": the newest snapshot's hash is not the hash the report was last
 *   generated from (`reports.doc_hash`). "Check doc" fetches again and answers that state.
 *
 * The doc is untrusted: generate.ts wraps it as `<document>` data for the model, and nothing here
 * runs or follows anything in it. Its text never reaches the audit log (ids, hashes, and sizes only).
 */

/** Tool names auto-picked, in order of preference. */
export const DOC_TOOL_NAMES = ["fetch", "get_document", "read_document"] as const;
/** Arguments that take the doc's link or id, in order of preference. */
const REF_ARGS = ["id", "url"] as const;
/** Snapshots kept per report besides the ones a run names. */
export const SNAPSHOTS_KEPT = 20;

export type { DocServerChoice, DocState, DocToolChoice };
export type FetchedDoc = { title: string | null; markdown: string; sha256: string; bytes: number; truncated: boolean };

/** The property names of a tool's input schema. */
export function schemaArgs(tool: Pick<StoredTool, "inputSchema">): string[] {
  const properties = (tool.inputSchema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties) ? Object.keys(properties as Record<string, unknown>).slice(0, 50) : [];
}

/**
 * The doc tool of a server: the person's override (`tool`, and `arg` when given), else the first of
 * `fetch`, `get_document`, `read_document` whose schema takes `id` or `url`. Null when none fits.
 */
export function pickDocTool(tools: readonly StoredTool[], override: { tool?: string | null; arg?: string | null } = {}): DocToolChoice | null {
  const choose = (tool: StoredTool, arg?: string | null): DocToolChoice | null => {
    const args = schemaArgs(tool);
    const ref = arg?.trim() || REF_ARGS.find((name) => args.includes(name)) || null;
    if (!ref) return null;
    return { tool: tool.name, arg: ref, outline: args.includes("resource") && ref !== "resource" };
  };
  if (override.tool?.trim()) {
    const tool = tools.find((item) => item.name === override.tool!.trim());
    return tool ? choose(tool, override.arg ?? (schemaArgs(tool).length ? null : "id")) : null;
  }
  for (const name of DOC_TOOL_NAMES) {
    const tool = tools.find((item) => item.name.toLowerCase() === name);
    const choice = tool ? choose(tool, override.arg) : null;
    if (choice) return choice;
  }
  return null;
}

/** The arguments one doc fetch sends. */
export const docToolArgs = (choice: DocToolChoice, ref: string): Record<string, unknown> => ({ ...(choice.outline ? { resource: "document" } : {}), [choice.arg]: ref });

/**
 * Doc-fetcher-like tools that policy keeps out: `fetch`, `get_document`, or `read_document` taking
 * `id` or `url` whose effective policy is not `auto` (the dialog says an admin must allow it).
 */
export function docToolCandidates(all: ReturnType<typeof toolsWithPolicies>): DocServerChoice["candidates"] {
  return all
    .filter((tool) => tool.policy !== "auto" && (DOC_TOOL_NAMES as readonly string[]).includes(tool.name.toLowerCase()) && schemaArgs(tool).some((arg) => (REF_ARGS as readonly string[]).includes(arg)))
    .map((tool) => ({ name: tool.name, args: schemaArgs(tool), policy: tool.policy }));
}

/**
 * The tool servers a person may read a doc through: enabled ones open to them, whether they were
 * synced, their read-only tools and the auto-pick, the doc tools policy excludes (`candidates`), and
 * every synced tool's name (the dialog lists them when there is no candidate).
 */
export function docServerChoices(role: string): DocServerChoice[] {
  const rows = db.query("SELECT * FROM agent_tool_servers WHERE enabled = 1 ORDER BY name COLLATE NOCASE").all() as ToolServerRow[];
  // B4: Nook itself comes first; it is always there, synced, and needs no admin.
  return [nookChoice(), ...rows.filter((row) => serverAvailableTo(row, role)).map((row): DocServerChoice => {
    const all = toolsWithPolicies(row);
    const tools = readOnlyTools(row, all);
    return {
      id: row.id, name: row.name, status: row.status, synced: row.tools_synced_at !== null,
      tools: tools.map((tool) => ({ name: tool.name, title: tool.title, args: schemaArgs(tool) })), pick: pickDocTool(tools),
      candidates: docToolCandidates(all), toolNames: all.map((tool) => tool.name).slice(0, 100), host: hostOf(row.url)
    };
  })];
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const fetchError = (message: string) => new ReportError(502, "DOC_FETCH", message);

/** The tool server a person reads a doc through (404 when missing or not theirs to use; DOC_FETCH when off). */
export function docServerFor(serverId: string, role: string): ToolServerRow {
  const row = serverRowOrNull(serverId);
  if (!row || !serverAvailableTo(row, role)) throw new ReportError(404, "NOT_FOUND", "Tool server not found");
  if (row.enabled !== 1) throw fetchError("That tool server is turned off; ask an admin to turn it on");
  return row;
}

/** The tools a doc may be read with: those whose effective policy is `auto` (never `confirm` or `off`). */
export function readOnlyTools(row: ToolServerRow, all = toolsWithPolicies(row)): StoredTool[] {
  return all.filter((tool) => tool.policy === "auto").map(({ policy: _policy, ...tool }) => tool);
}

/** The tool to call on a server, or DOC_FETCH naming what is missing (DOC_TOOL_REFUSED for a tool that is not read-only). */
export function docToolOf(row: ToolServerRow, override: { tool?: string | null; arg?: string | null }): DocToolChoice {
  // Review M2: only tools whose effective policy is `auto` (read-only by the server's word, or an
  // admin's explicit auto) may read a doc; an override naming any other tool is refused, never called.
  const all = toolsWithPolicies(row);
  if (override.tool?.trim()) {
    const named = all.find((tool) => tool.name === override.tool!.trim());
    if (named && named.policy !== "auto") throw new ReportError(400, "DOC_TOOL_REFUSED", `${named.name} on ${row.name} is not a read-only tool Nook may call without asking; choose a read-only tool`);
  }
  const tools = readOnlyTools(row, all);
  const choice = pickDocTool(tools, override);
  if (!choice) {
    throw fetchError(override.tool ? `${row.name} has no tool named ${override.tool.slice(0, 128)}` : `${row.name} has no fetch, get_document, or read_document tool that takes an id or url; name the tool to use`);
  }
  return choice;
}

/** UTF-8 bytes of `text` cut to `max` on a character boundary. */
export function cutBytes(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false };
  let value = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  if (value.endsWith("�")) value = value.slice(0, -1);
  return { text: value, truncated: true };
}

const stringOf = (value: unknown) => typeof value === "string" ? value : null;

/**
 * A tool result as a doc: Outline-shaped JSON (`{title, text}`, `{data: {title, text}}`, or
 * `{document: {…}}`, with `markdown` or `content` for the text) or plain markdown, whose first `# `
 * heading is the title.
 */
export function docFromText(raw: string): { title: string | null; markdown: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const candidate of [parsed, parsed.data, parsed.document, (parsed.data as Record<string, unknown> | undefined)?.document]) {
        if (!candidate || typeof candidate !== "object") continue;
        const record = candidate as Record<string, unknown>;
        const text = stringOf(record.text) ?? stringOf(record.markdown) ?? stringOf(record.content);
        if (text !== null) return { title: stringOf(record.title)?.trim().slice(0, 500) || headingOf(text), markdown: text };
      }
    } catch {
      // Not JSON after all: plain text.
    }
  }
  return { title: headingOf(raw), markdown: raw };
}

const headingOf = (markdown: string) => /^#\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500) || null;

export const sha256Of = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Test hook: the session a fetch uses (tests hand in a session over a fake transport). */
export const docSessions = { sessionFor: (row: ToolServerRow): McpSession => sessionFor(row) };

/** Reads the doc: one tool call, no model. */
export async function fetchDoc(row: ToolServerRow, choice: DocToolChoice, ref: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDoc> {
  const started = performance.now();
  try {
    const doc = await fetchDocText(row, choice, ref, options);
    logger("reports").info("Doc fetched", { server: shortId(row.id), tool: choice.tool, bytes: doc.bytes, hash: doc.sha256.slice(0, 12), truncated: doc.truncated || undefined, ms: Math.round(performance.now() - started) });
    return doc;
  } catch (error) {
    logger("reports").warn("Doc fetch failed", { server: shortId(row.id), tool: choice.tool, code: (error as { code?: string }).code, ms: Math.round(performance.now() - started) });
    throw error;
  }
}

async function fetchDocText(row: ToolServerRow, choice: DocToolChoice, ref: string, options: { signal?: AbortSignal }): Promise<FetchedDoc> {
  let text: string;
  try {
    const outcome = await docSessions.sessionFor(row).callTool(choice.tool, docToolArgs(choice, ref), options.signal);
    if (outcome.isError) throw fetchError(`${row.name} could not read that document${outcome.text.trim() ? `: ${outcome.text.replace(/[^A-Za-z0-9 .,:;()'/_-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}` : ""}`);
    text = outcome.text;
  } catch (error) {
    if (error instanceof ReportError) throw error;
    if (error instanceof McpClientError && error.code === "MCP_AUTH") {
      throw new ReportError(502, "MCP_AUTH", `${row.name} refused Nook's credential; an admin needs to reconnect it in Settings → AI → Tool servers`, { reconnect: true, serverId: row.id });
    }
    if (error instanceof AgentError) throw fetchError(error.message);
    throw fetchError(`${row.name} could not be reached: ${describeMcpError(error).message}`);
  }
  const doc = docFromText(text);
  if (!doc.markdown.trim()) throw fetchError("The document is empty");
  const cut = cutBytes(doc.markdown, REPORT_LIMITS.docBytes);
  return { title: doc.title, markdown: cut.text, sha256: sha256Of(cut.text), bytes: Buffer.byteLength(cut.text, "utf8"), truncated: cut.truncated };
}

/**
 * Stores the doc as the report's newest snapshot unless the newest already has its hash; prunes old
 * snapshots no run names (keeping 20). Returns the snapshot id and whether a row was written.
 */
export function recordSnapshot(reportId: string, doc: FetchedDoc): { id: string; sha256: string; changed: boolean } {
  return db.transaction(() => {
    const latest = db.query("SELECT id, sha256 FROM report_doc_snapshots WHERE report_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1").get(reportId) as { id: string; sha256: string } | null;
    if (latest?.sha256 === doc.sha256) return { id: latest.id, sha256: doc.sha256, changed: false };
    const id = crypto.randomUUID();
    db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, reportId, doc.sha256, doc.title, doc.markdown, now());
    db.query(`DELETE FROM report_doc_snapshots WHERE report_id = $reportId
      AND id NOT IN (SELECT id FROM report_doc_snapshots WHERE report_id = $reportId ORDER BY fetched_at DESC, rowid DESC LIMIT ${SNAPSHOTS_KEPT})
      AND id NOT IN (SELECT doc_snapshot_id FROM report_runs WHERE report_id = $reportId AND doc_snapshot_id IS NOT NULL)`).run({ reportId });
    return { id, sha256: doc.sha256, changed: true };
  })();
}

/** A stored snapshot's markdown and title (the generation prompt). */
export function snapshotOf(id: string): { id: string; sha256: string; title: string | null; markdown: string } | null {
  return db.query("SELECT id, sha256, title, markdown FROM report_doc_snapshots WHERE id = ?").get(id) as { id: string; sha256: string; title: string | null; markdown: string } | null;
}

type DocRow = { doc_server_id: string | null; doc_tool: string | null; doc_arg: string | null; doc_ref: string | null; doc_hash: string | null; doc_browse_tools: string; doc_source: string };
const DOC_COLUMNS = "doc_server_id, doc_tool, doc_arg, doc_ref, doc_hash, doc_browse_tools, doc_source";

/** B4: the doc in Nook itself, read as `ownerId` with their live access, as a FetchedDoc. */
export async function fetchNookFetched(ownerId: string, ref: string): Promise<FetchedDoc & { tool: string }> {
  const read = await fetchNookDoc(ownerId, ref);
  if (!read.markdown.trim()) throw fetchError("The document is empty");
  const cut = cutBytes(read.markdown, REPORT_LIMITS.docBytes);
  return { title: read.title, markdown: cut.text, sha256: sha256Of(cut.text), bytes: Buffer.byteLength(cut.text, "utf8"), truncated: cut.truncated, tool: nookToolOf(read.kind) };
}

/** B3/B4: the browse source of a report's doc for its owner (Nook, or its tool server), or null without one. */
export function browseSourceOf(row: { doc_source?: string | null; doc_server_id: string | null }, owner: { id: string; role: string }): BrowseSource | null {
  if (row.doc_source === NOOK_SOURCE_ID) return nookBrowseSource(owner.id);
  return row.doc_server_id ? serverBrowseSource(row.doc_server_id, owner.role) : null;
}

/** The report's doc, its newest snapshot, and whether the doc changed since the report was generated. */
export function docState(reportId: string, userId: string): DocState {
  // The doc (its link, server, and snapshots) is the owner's; readers of a shared report never see it (wave 48, D456).
  ownedReport(reportId, userId);
  const row = db.query(`SELECT ${DOC_COLUMNS} FROM reports WHERE id = ?`).get(reportId) as DocRow;
  const latest = db.query("SELECT id, sha256, title, length(CAST(markdown AS BLOB)) AS bytes, fetched_at FROM report_doc_snapshots WHERE report_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1")
    .get(reportId) as { id: string; sha256: string; title: string | null; bytes: number; fetched_at: string } | null;
  const nook = row.doc_source === NOOK_SOURCE_ID;
  const serverName = nook ? nookSourceName() : row.doc_server_id ? (db.query("SELECT name FROM agent_tool_servers WHERE id = ?").get(row.doc_server_id) as { name: string } | null)?.name ?? null : null;
  const mainChanged = Boolean(latest && row.doc_hash && latest.sha256 !== row.doc_hash);
  // B3: the linked pages of the current spec's runs; one that changed since its run read it is "Doc changed" too.
  const pages = pageInfos(reportId);
  return {
    doc: row.doc_ref || row.doc_server_id || nook ? { serverId: nook ? NOOK_SOURCE_ID : row.doc_server_id, serverName, tool: row.doc_tool, arg: row.doc_arg, ref: row.doc_ref, hash: row.doc_hash, browseTools: storedBrowseTools(row.doc_browse_tools) } : null,
    latest: latest ? { id: latest.id, sha256: latest.sha256, title: latest.title, bytes: latest.bytes, fetchedAt: latest.fetched_at } : null,
    changed: mainChanged || pages.some((page) => page.changed),
    mainChanged,
    pages
  };
}

/** "Check doc": fetches the report's doc again and stores a snapshot when it changed; then reads its linked pages again (B3). */
export async function checkDoc(actor: { userId: string; role: string }, reportId: string, signal?: AbortSignal): Promise<DocState> {
  // Review M3: Check doc writes a snapshot, so it is the owner's (wave 48's viewers only read the state).
  ownedReport(reportId, actor.userId);
  const row = db.query(`SELECT ${DOC_COLUMNS} FROM reports WHERE id = ?`).get(reportId) as DocRow;
  if (row.doc_source === NOOK_SOURCE_ID && row.doc_ref) {
    // B4: the doc in Nook, read again with the owner's live access.
    const doc = await fetchNookFetched(actor.userId, row.doc_ref);
    const snapshot = recordSnapshot(reportId, doc);
    const pages = await recheckPages(reportId, { id: actor.userId, role: actor.role }, signal);
    audit(actor.userId, null, "reports.doc.check", { reportId, serverId: NOOK_SOURCE_ID, tool: doc.tool, sha256: doc.sha256, bytes: doc.bytes, changed: snapshot.changed, pages: pages.checked, pagesFailed: pages.failed, pagesChanged: pages.changed });
    return docState(reportId, actor.userId);
  }
  if (!row.doc_server_id || !row.doc_ref) throw new ReportError(400, "INVALID", "This report has no doc to check");
  const server = docServerFor(row.doc_server_id, actor.role);
  const choice = docToolOf(server, { tool: row.doc_tool, arg: row.doc_arg });
  const doc = await fetchDoc(server, choice, row.doc_ref, { signal });
  const snapshot = recordSnapshot(reportId, doc);
  const pages = await recheckPages(reportId, { id: actor.userId, role: actor.role }, signal);
  audit(actor.userId, null, "reports.doc.check", { reportId, serverId: server.id, tool: choice.tool, sha256: doc.sha256, bytes: doc.bytes, changed: snapshot.changed, pages: pages.checked, pagesFailed: pages.failed, pagesChanged: pages.changed });
  return docState(reportId, actor.userId);
}

/**
 * "Doc settings" (B3): the tools the AI may use to read more docs, for the report's doc server. Each
 * must be one of its tools with policy Auto (DOC_TOOL_REFUSED otherwise). The owner's only.
 */
export function setBrowseTools(actor: { userId: string; role: string }, reportId: string, tools: string[]): DocState {
  ownedReport(reportId, actor.userId);
  const row = db.query(`SELECT ${DOC_COLUMNS} FROM reports WHERE id = ?`).get(reportId) as DocRow;
  if (row.doc_source === NOOK_SOURCE_ID) {
    const names = checkBrowseTools(nookCatalog(), tools, nookSourceName());
    db.query("UPDATE reports SET doc_browse_tools = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(names), now(), reportId);
    audit(actor.userId, null, "reports.doc.browse_tools", { reportId, serverId: NOOK_SOURCE_ID, count: names.length });
    return docState(reportId, actor.userId);
  }
  if (!row.doc_server_id) throw new ReportError(400, "INVALID", "This report has no doc server; generate it from a doc first");
  const server = docServerFor(row.doc_server_id, actor.role);
  const source = serverBrowseSource(server.id, actor.role);
  const names = checkBrowseTools(source.tools(), tools, server.name);
  db.query("UPDATE reports SET doc_browse_tools = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(names), now(), reportId);
  audit(actor.userId, null, "reports.doc.browse_tools", { reportId, serverId: server.id, count: names.length });
  return docState(reportId, actor.userId);
}
