import { api, ApiError } from "../api";
import type { CatalogTable, ConnectionTest, DatasourceChoice, DatasourceSummary, QueryOutcome, ReportDetail, ReportSummary, SchemaSearchHit, SchemaSyncResult } from "../../shared/reports";
import type { DocServerChoice, DocState, GenerateStarted, GenerationRun } from "../../shared/reportsGenerate";

/** The Reports API (docs/plan/API_CONTRACTS.md § Analytics reports, Wave 45). */

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const listReports = (q = "") => api<{ reports: ReportSummary[] }>(`/reports${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
export const getReport = (id: string) => api<{ report: ReportDetail }>(`/reports/${id}`);
export const createReport = (title: string, datasourceId: string) => api<{ report: ReportDetail }>("/reports", json("POST", { title, datasourceId }));
export const updateReport = (id: string, patch: { title?: string; datasourceId?: string; expectedRevision: number }) => api<{ report: ReportDetail }>(`/reports/${id}`, json("PATCH", patch));
export const deleteReport = (id: string) => api<{ ok: true; purgeAfter: string }>(`/reports/${id}`, { method: "DELETE", body: "{}" });
export const datasourceChoices = () => api<{ datasources: DatasourceChoice[] }>("/reports/datasources");
export const runConsole = (id: string, sql: string, signal?: AbortSignal) => api<{ outcome: QueryOutcome }>(`/reports/${id}/console`, { ...json("POST", { sql }), signal });
export const cancelConsole = (id: string) => api<{ cancelled: boolean; queryId: string | null }>(`/reports/${id}/console/cancel`, json("POST", {}));

export type TableListItem = { table: string; comment: string; totalRows: number | null; columns: number; engine: string };
export const searchSchema = (id: string, q: string) => api<{ results: SchemaSearchHit[] }>(`/reports/${id}/schema/search?q=${encodeURIComponent(q)}`);
export const listSchemaTables = (id: string, options: { db?: string; like?: string; page?: number }) => {
  const params = new URLSearchParams();
  if (options.db) params.set("db", options.db);
  if (options.like) params.set("like", options.like);
  if (options.page) params.set("page", String(options.page));
  return api<{ tables: TableListItem[]; page: number; hasMore: boolean; databases: string[] }>(`/reports/${id}/schema/tables${params.size ? `?${params}` : ""}`);
};
export const describeSchemaTables = (id: string, tables: string[]) => api<{ tables: CatalogTable[]; missing: string[] }>(`/reports/${id}/schema/describe?tables=${encodeURIComponent(tables.join(","))}`);

// Admin: Settings → Report data sources.
export type DatasourceInput = { name: string; url: string; username: string; password?: string | null; database: string; allowlist: string[]; maxRows: number; timeoutS: number; enabled: boolean };
export const listDatasources = () => api<{ datasources: DatasourceSummary[] }>("/reports/admin/datasources");
export const createDatasource = (input: DatasourceInput) => api<{ datasource: DatasourceSummary }>("/reports/admin/datasources", json("POST", input));
export const updateDatasource = (id: string, patch: Partial<DatasourceInput> & { expectedRevision: number; removePassword?: boolean }) => api<{ datasource: DatasourceSummary }>(`/reports/admin/datasources/${id}`, json("PATCH", patch));
export const deleteDatasource = (id: string) => api<{ ok: true }>(`/reports/admin/datasources/${id}`, { method: "DELETE", body: "{}" });
export const testDatasource = (id: string) => api<{ test: ConnectionTest }>(`/reports/admin/datasources/${id}/test`, json("POST", {}));
export const syncDatasource = (id: string) => api<{ sync: SchemaSyncResult; datasource: DatasourceSummary }>(`/reports/admin/datasources/${id}/sync`, json("POST", {}));
export const previewAllowlist = (id: string, allowlist: string[]) => api<{ preview: { matched: number; total: number; databases: number; sample: string[] } }>(`/reports/admin/datasources/${id}/allowlist-preview`, json("POST", { allowlist }));

export const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
export const codeOf = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string; guard?: string }) : {};

/** Allowlist text (one pattern per line or comma-separated) as patterns. */
export const parseAllowlistText = (text: string) => [...new Set(text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];

/** A cell of a result table as text (nulls, arrays, and objects shown readably). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** "1.2 M rows", "340 rows". */
export function countLabel(value: number | null, noun = "rows") {
  if (value === null) return `? ${noun}`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} B ${noun}`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} M ${noun}`;
  if (value >= 1e4) return `${Math.round(value / 1e3)} K ${noun}`;
  return `${value.toLocaleString()} ${value === 1 ? noun.replace(/s$/, "") : noun}`;
}

// Wave 46: generation from a doc, and the doc's state.
export const docServers = () => api<{ servers: DocServerChoice[] }>("/reports/doc-servers");
export type GenerateBody = { docRef: string; serverId: string; tool?: string | null; arg?: string | null; datasourceId: string; title?: string | null };
export const generateReport = (body: GenerateBody) => api<GenerateStarted>("/reports/generate", json("POST", body));
export const regenerateReport = (id: string, body: Partial<Omit<GenerateBody, "title">> = {}) => api<GenerateStarted>(`/reports/${id}/generate`, json("POST", body));
export const cancelGeneration = (id: string) => api<{ cancelled: boolean }>(`/reports/${id}/generate/cancel`, json("POST", {}));
export const latestGeneration = (id: string) => api<{ run: GenerationRun | null }>(`/reports/${id}/generation`);
export const getDocState = (id: string) => api<{ doc: DocState }>(`/reports/${id}/doc`);
export const checkDoc = (id: string) => api<{ doc: DocState }>(`/reports/${id}/doc/check`, json("POST", {}));
