import { config } from "../config";
import { audit, db, now } from "../db";
import { checkSavedEndpoint, EgressError } from "../agents/egress";
import { openSecret, sealSecret } from "../agents/secrets";
import { REPORT_LIMITS, type ConnectionTest, type DatasourceChoice, type DatasourceSummary } from "../../shared/reports";
import { normalizeAllowlist, tableAllowed } from "./allowlist";
import { chQuery, ChError, queryIdFor, type ChTarget } from "./clickhouse";
import { datasourceNotFound, ReportError } from "./errors";

/**
 * Report data sources (plan wave 45, D413, D415, T358, T360): admin-configured ClickHouse endpoints.
 * Admins create, edit, test, and delete them (Settings → Report data sources); authors only see the
 * enabled ones' names when they pick one for a report. The password is write-only: sealed under
 * AGENT_SECRETS_KEY with the AAD of its row (`datasource`), and the API returns only `hasPassword`.
 * The URL passes the same save-time rules as a model provider's (https, or http only for hosts in
 * AGENT_ALLOWED_PRIVATE_HOSTS; no credentials, query, or fragment in it).
 */

export type DatasourceRow = {
  id: string; name: string; kind: "clickhouse"; url: string; username: string; password_ct: string | null; database: string; allowlist_json: string;
  max_rows: number; timeout_s: number; enabled: number; schema_synced_at: string | null; schema_table_count: number; schema_truncated: number;
  schema_error: string | null; revision: number; created_by: string | null; created_at: string; updated_at: string;
};

export type DatasourceInput = {
  name: string; url: string; username: string; password?: string | null; database?: string; allowlist?: string[]; maxRows?: number; timeoutS?: number; enabled?: boolean;
};
export type DatasourcePatch = Partial<DatasourceInput> & { expectedRevision: number; removePassword?: boolean };

export const DATABASE_NAME = /^[A-Za-z0-9_]{1,128}$/;

export function datasourceRow(id: string): DatasourceRow {
  const row = db.query("SELECT * FROM report_datasources WHERE id = ?").get(id) as DatasourceRow | null;
  if (!row) throw datasourceNotFound();
  return row;
}

export function allowlistOf(row: Pick<DatasourceRow, "allowlist_json">): string[] {
  try {
    const value: unknown = JSON.parse(row.allowlist_json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function datasourceSummary(row: DatasourceRow): DatasourceSummary {
  return {
    id: row.id, name: row.name, kind: row.kind, url: row.url, username: row.username, database: row.database, allowlist: allowlistOf(row),
    maxRows: row.max_rows, timeoutS: row.timeout_s, enabled: row.enabled === 1, hasPassword: row.password_ct !== null,
    schema: { syncedAt: row.schema_synced_at, tables: row.schema_table_count, error: row.schema_error, truncated: row.schema_truncated === 1 },
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export const listDatasources = (): DatasourceSummary[] => (db.query("SELECT * FROM report_datasources ORDER BY name COLLATE NOCASE").all() as DatasourceRow[]).map(datasourceSummary);

/** What an author may pick: enabled data sources, names only. */
export const datasourceChoices = (): DatasourceChoice[] => db.query("SELECT id, name, database FROM report_datasources WHERE enabled = 1 ORDER BY name COLLATE NOCASE").all() as DatasourceChoice[];

function requireKey() {
  if (!config.agents.key) throw new ReportError(503, "NOT_CONFIGURED", "Set AGENT_SECRETS_KEY on the server to store data source passwords (see docs/OPERATIONS.md)");
}

function checkUrl(value: string): string {
  try {
    const url = checkSavedEndpoint(value);
    if (url.search) throw new ReportError(400, "INVALID_URL", "Leave the query string out of the URL; Nook sends the database and settings itself");
    return url.toString();
  } catch (error) {
    if (error instanceof EgressError) throw new ReportError(400, "INVALID_URL", error.message);
    throw error;
  }
}

function checkDatabase(value: string) {
  if (!DATABASE_NAME.test(value)) throw new ReportError(400, "INVALID_DATABASE", "The database is letters, digits, and _ only");
  if (/^(system|information_schema)$/i.test(value)) throw new ReportError(400, "INVALID_DATABASE", "Reports never use the system database as their default");
  return value;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(value)));

export function createDatasource(actorId: string, input: DatasourceInput): DatasourceSummary {
  if (input.password) requireKey();
  const id = crypto.randomUUID();
  const at = now();
  const url = checkUrl(input.url);
  const database = checkDatabase(input.database ?? "default");
  const allowlist = normalizeAllowlist(input.allowlist ?? []);
  if (allowlist.length > REPORT_LIMITS.allowlistPatterns) throw new ReportError(400, "INVALID_ALLOWLIST", `At most ${REPORT_LIMITS.allowlistPatterns} patterns`);
  if (db.query("SELECT 1 FROM report_datasources WHERE name = ? COLLATE NOCASE").get(input.name)) throw new ReportError(409, "NAME_TAKEN", "Another data source has this name");
  db.query(`INSERT INTO report_datasources (id, name, kind, url, username, password_ct, database, allowlist_json, max_rows, timeout_s, enabled, created_by, created_at, updated_at)
    VALUES (?, ?, 'clickhouse', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.name, url, input.username, input.password ? sealSecret("datasource", id, input.password) : null, database, JSON.stringify(allowlist),
    clamp(input.maxRows ?? REPORT_LIMITS.maxRowsDefault, 1, REPORT_LIMITS.maxRowsCeiling), clamp(input.timeoutS ?? REPORT_LIMITS.timeoutDefaultS, 1, REPORT_LIMITS.timeoutCeilingS),
    input.enabled === false ? 0 : 1, actorId, at, at
  );
  // Never the password, the URL, or the allowlist: the name and id only.
  audit(actorId, null, "reports.datasource.create", { id, name: input.name });
  return datasourceSummary(datasourceRow(id));
}

/** The fields whose change makes the cached schema stale (the caller re-syncs). */
export const SCHEMA_FIELDS = ["url", "username", "password", "database", "allowlist", "removePassword"] as const;

export function updateDatasource(actorId: string, id: string, patch: DatasourcePatch): DatasourceSummary {
  const row = datasourceRow(id);
  if (row.revision !== patch.expectedRevision) throw new ReportError(409, "REVISION_CONFLICT", "Someone changed this data source; reload it", { revision: row.revision });
  if (patch.password) requireKey();
  if (patch.name !== undefined && patch.name.toLowerCase() !== row.name.toLowerCase() && db.query("SELECT 1 FROM report_datasources WHERE name = ? COLLATE NOCASE AND id <> ?").get(patch.name, id)) {
    throw new ReportError(409, "NAME_TAKEN", "Another data source has this name");
  }
  const allowlist = patch.allowlist === undefined ? null : normalizeAllowlist(patch.allowlist);
  if (allowlist && allowlist.length > REPORT_LIMITS.allowlistPatterns) throw new ReportError(400, "INVALID_ALLOWLIST", `At most ${REPORT_LIMITS.allowlistPatterns} patterns`);
  // Review L3: a password goes only to the host it was entered for. A new host clears it unless a new
  // password comes with the change; the admin enters it again.
  const nextUrl = patch.url === undefined ? row.url : checkUrl(patch.url);
  const hostChanged = new URL(nextUrl).host !== new URL(row.url).host;
  const password = patch.removePassword ? null : patch.password ? sealSecret("datasource", id, patch.password) : hostChanged ? null : row.password_ct;
  db.query(`UPDATE report_datasources SET name = ?, url = ?, username = ?, password_ct = ?, database = ?, allowlist_json = ?, max_rows = ?, timeout_s = ?, enabled = ?,
    revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(
    patch.name ?? row.name, nextUrl, patch.username ?? row.username, password,
    patch.database === undefined ? row.database : checkDatabase(patch.database), allowlist ? JSON.stringify(allowlist) : row.allowlist_json,
    patch.maxRows === undefined ? row.max_rows : clamp(patch.maxRows, 1, REPORT_LIMITS.maxRowsCeiling),
    patch.timeoutS === undefined ? row.timeout_s : clamp(patch.timeoutS, 1, REPORT_LIMITS.timeoutCeilingS),
    patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0, now(), id, row.revision
  );
  audit(actorId, null, "reports.datasource.update", { id, fields: Object.keys(patch).filter((field) => field !== "expectedRevision" && field !== "password").concat(patch.password ? ["password"] : []) });
  return datasourceSummary(datasourceRow(id));
}

/** Deleting keeps the reports that used it (their data source becomes none) and drops its cached schema. */
export function deleteDatasource(actorId: string, id: string) {
  const row = datasourceRow(id);
  db.query("DELETE FROM report_datasources WHERE id = ?").run(id);
  audit(actorId, null, "reports.datasource.delete", { id, name: row.name });
}

/** The connection a query uses, with the password opened for this call only. */
export function datasourceTarget(row: DatasourceRow): ChTarget {
  let password: string | null = null;
  if (row.password_ct) {
    try {
      password = openSecret("datasource", row.id, row.password_ct);
    } catch {
      throw new ReportError(503, "NOT_CONFIGURED", "The data source password cannot be opened with this server's AGENT_SECRETS_KEY; an admin re-enters it");
    }
  }
  return { url: row.url, username: row.username, password, database: row.database, timeoutS: row.timeout_s, maxRows: row.max_rows };
}

/** An enabled data source for running queries (authors), or 404 / 409. */
export function usableDatasource(id: string | null): DatasourceRow {
  if (!id) throw new ReportError(409, "NO_DATASOURCE", "Pick a data source for this report");
  const row = datasourceRow(id);
  if (row.enabled !== 1) throw new ReportError(409, "DATASOURCE_DISABLED", "An admin turned this data source off");
  return row;
}

const WRITE_PRIVILEGES = /\b(ALL|INSERT|ALTER|CREATE|DROP|TRUNCATE|OPTIMIZE|RENAME|SYSTEM|KILL|BACKUP|UNDROP|DELETE|UPDATE|ACCESS MANAGEMENT|ROLE ADMIN)\b/i;

/** The grants in SHOW GRANTS output that let a user change something. */
export function writeGrantsOf(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const privileges = /^GRANT\s+(.*?)\s+ON\s+/i.exec(line)?.[1];
    return privileges !== undefined && WRITE_PRIVILEGES.test(privileges);
  });
}

/**
 * Test connection (plan wave 45): the server version, the user, its profile `readonly`, and its write
 * grants, with a warning when the user can write, when its profile refuses Nook's per-query limits,
 * or when no table is allowlisted. Never throws for ClickHouse errors; they are `error`.
 */
export async function testConnection(id: string): Promise<ConnectionTest> {
  const row = datasourceRow(id);
  const started = Date.now();
  const result: ConnectionTest = { ok: false, version: null, user: null, readonly: null, writeGrants: [], warnings: [], error: null, ms: 0 };
  try {
    const target = datasourceTarget(row);
    const profile = await chQuery(target, "SELECT version(), currentUser(), toUInt8OrNull(getSetting('readonly'))", { queryId: queryIdFor("test", crypto.randomUUID().slice(0, 8)), profileSettings: true });
    const first = profile.rows[0] ?? [];
    result.version = typeof first[0] === "string" ? first[0] : null;
    result.user = typeof first[1] === "string" ? first[1] : null;
    result.readonly = typeof first[2] === "number" ? first[2] : first[2] === null || first[2] === undefined ? null : Number(first[2]);
    try {
      const grants = await chQuery(target, "SHOW GRANTS", { queryId: queryIdFor("test", "grants", crypto.randomUUID().slice(0, 8)), profileSettings: true });
      result.writeGrants = writeGrantsOf(grants.rows.map((line) => String(line[0] ?? ""))).map((line) => line.slice(0, 200));
      if (grants.rows.some((line) => /^GRANT\s+[A-Za-z0-9_,\s`"]+\s+TO\s+/i.test(String(line[0] ?? "")) && !/\sON\s/i.test(String(line[0] ?? "")))) {
        result.warnings.push("This user has roles; check that none of them can change data.");
      }
    } catch {
      result.warnings.push("Nook could not read this user's grants (SHOW GRANTS); check that it can only SELECT.");
    }
    if (result.writeGrants.length) result.warnings.push("This user can change data. Use a read-only user that can only SELECT the allowed tables: Nook's own checks are not the boundary.");
    else if (result.readonly === 0 && !result.writeGrants.length) result.warnings.push("This user's profile is not read-only (readonly=0). Nook sends readonly=2 with every query; a read-only profile is safer.");
    try {
      await chQuery(target, "SELECT 1", { queryId: queryIdFor("test", "limits", crypto.randomUUID().slice(0, 8)) });
    } catch (error) {
      if (error instanceof ChError && (error.chCode === 164 || error.chName === "READONLY")) result.warnings.push("This user's profile has readonly=1, which refuses the limits Nook sends with every query. Set readonly=2 in its profile.");
      else throw error;
    }
    if (!allowlistOf(row).length) result.warnings.push("No table is allowlisted yet, so reports can read nothing.");
    result.ok = true;
  } catch (error) {
    result.error = error instanceof ChError || error instanceof ReportError ? error.message : "The data source could not be reached";
  }
  result.ms = Date.now() - started;
  return result;
}

const tableListCache = new Map<string, { at: number; tables: Array<{ db: string; name: string }> }>();
const TABLE_LIST_TTL_MS = 60_000;

/** Every table ClickHouse lists for this user (outside system databases), cached for a minute, for the allowlist preview. */
async function allTables(row: DatasourceRow): Promise<Array<{ db: string; name: string }>> {
  const cached = tableListCache.get(row.id);
  if (cached && Date.now() - cached.at < TABLE_LIST_TTL_MS && cached.at >= Date.parse(row.updated_at)) return cached.tables;
  const result = await chQuery(datasourceTarget(row), "SELECT database, name FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary ORDER BY database, name",
    { queryId: queryIdFor("allowlist", crypto.randomUUID().slice(0, 8)), maxResultRows: REPORT_LIMITS.catalogTables * 5, responseBytes: 32 * 1024 * 1024 });
  const tables = result.rows.map((line) => ({ db: String(line[0]), name: String(line[1]) }));
  tableListCache.set(row.id, { at: Date.now(), tables });
  return tables;
}

/**
 * The allowlist preview (the admin's live match count): how many tables the patterns match, of how
 * many ClickHouse lists, and the first 20 names. Patterns are validated first (400 INVALID_ALLOWLIST).
 */
export async function previewAllowlist(id: string, raw: readonly string[]): Promise<{ matched: number; total: number; databases: number; sample: string[] }> {
  const row = datasourceRow(id);
  const patterns = normalizeAllowlist(raw);
  const tables = await allTables(row);
  const matched = tables.filter((table) => tableAllowed(patterns, table.db, table.name));
  return { matched: matched.length, total: tables.length, databases: new Set(matched.map((table) => table.db)).size, sample: matched.slice(0, 20).map((table) => `${table.db}.${table.name}`) };
}


/** Test hook. */
export function clearTableListCacheForTests() {
  tableListCache.clear();
}
