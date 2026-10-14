/**
 * The report Versions panel (lane J, 2026-10-14): the history row as the panel shows it, and the
 * structured diff between two versions' specs (blocks, queries with a line diff of their SQL, markdown
 * as a text diff, sections). The server computes diffs (GET …/versions/diff, MCP
 * get_report_version_diff) so the client never downloads whole specs for a long history. Pure: no
 * server or client imports.
 */
import type { ReportBlock, ReportSection, ReportSpec } from "./reports";
import type { ReportVersion } from "./reportsEdit";
import type { QueryResultView } from "./reportsView";

/** One row of the Versions panel. Fields marked "owner" are null for anyone else (D459, lane J access). */
export type VersionHistoryItem = ReportVersion & {
  /** A `generate` version that is not the report's first generation. */
  regenerated: boolean;
  /** Who asked (the instruction's author), for an applied instruction. */
  askedByName: string | null;
  /** The instruction was applied by the auto-apply switch. */
  autoApplied: boolean;
  /** The instruction's text: the owner's, or the caller's own instruction; null otherwise. */
  instructionText: string | null;
  /** owner: the run that made it (opens Runs at it) and its model. */
  runId: string | null;
  model: string | null;
  /** owner: what changed against the version before, e.g. "+2 charts, 1 query changed". */
  changeSummary: string | null;
};

/** GET /api/reports/:id/versions/:n (the owner): the spec and the results stored for it. */
export type VersionSnapshot = {
  version: VersionHistoryItem;
  spec: ReportSpec;
  /** Per query: the newest stored good result of exactly that SQL from while the version was current (or before). */
  results: QueryResultView[];
};

export type DiffLine = { op: "same" | "add" | "del"; text: string };
export type FieldChange = { field: string; before: string | null; after: string | null };
export type BlockDiff = {
  blockId: string;
  change: "added" | "removed" | "moved" | "changed";
  type: ReportBlock["type"];
  title: string;
  /** Changed fields (kind, title, intent, width, section, mapping, …); for added and removed, the block's own. */
  fields: FieldChange[];
  /** Markdown blocks: the text as a line diff. */
  text?: DiffLine[];
  /** Markdown blocks: the text changed (set even when the lines are left out). */
  textChanged?: boolean;
  /** Moved: its position before and after (1-based). */
  position?: { before: number; after: number };
};
export type QueryDiff = { key: string; change: "added" | "removed" | "changed"; lines: DiffLine[]; purpose?: FieldChange };
export type SectionDiff = { id: string; change: "added" | "removed" | "changed" | "moved"; title: string; fields: FieldChange[] };
export type VersionDiff = {
  from: number;
  to: number;
  summary: string;
  blocks: BlockDiff[];
  queries: QueryDiff[];
  sections: SectionDiff[];
  /** Some diff lines or entries were cut at the caps. */
  truncated: boolean;
};

export const DIFF_LIMITS = { lines: 600, entries: 120, value: 240 } as const;

// ------------------------------------------------------------------------------------- labels

/** The source in plain words: "Generated from the doc", "Regenerated", "Applied a change", "Edited by hand", "Restored v3". */
export function versionSourceLabel(item: Pick<VersionHistoryItem, "source" | "regenerated" | "restoredFrom">): string {
  switch (item.source) {
    case "generate": return item.regenerated ? "Regenerated" : "Generated from the doc";
    case "edit": return "Applied a change";
    case "manual": return "Edited by hand";
    case "restore": return item.restoredFrom ? `Restored v${item.restoredFrom}` : "Restored";
    default: return "First saved version";
  }
}

/** Who made it: "Asked by Ravi · applied by Pankaj", "Asked and applied by Pankaj", or the author. */
export function versionWhoLabel(item: Pick<VersionHistoryItem, "source" | "askedByName" | "createdByName" | "autoApplied">): string {
  const by = item.createdByName ?? "Someone";
  if (item.source === "edit" && item.askedByName) {
    const applied = item.autoApplied ? "applied automatically" : `applied by ${by}`;
    return item.askedByName === item.createdByName && !item.autoApplied ? `Asked and applied by ${by}` : `Asked by ${item.askedByName} · ${applied}`;
  }
  return `By ${by}`;
}

// --------------------------------------------------------------------------------------- diff

/** JSON with sorted keys, so field order never reads as a change. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Nook's own fields and the ones shown separately are not compared field by field. */
const SKIPPED = new Set(["id", "provenance", "autoFixes", "legacy", "markdown"]);
/** The order fields are listed in: what people look for first. */
const FIELD_ORDER = ["type", "kind", "title", "label", "intent", "width", "section", "queryKey", "x", "y", "series", "column", "columns"];

const shown = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : stable(value);
  return text.length > DIFF_LIMITS.value ? `${text.slice(0, DIFF_LIMITS.value - 1)}…` : text;
};

function fieldChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null): FieldChange[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((key) => !SKIPPED.has(key));
  keys.sort((a, b) => {
    const left = FIELD_ORDER.indexOf(a);
    const right = FIELD_ORDER.indexOf(b);
    return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.localeCompare(b);
  });
  const out: FieldChange[] = [];
  for (const key of keys) {
    const left = before?.[key];
    const right = after?.[key];
    if (stable(left ?? null) === stable(right ?? null)) continue;
    out.push({ field: key, before: shown(left), after: shown(right) });
  }
  return out;
}

/** The longest common subsequence's index pairs (classic DP; inputs are capped by the caller). */
function lcsPairs<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) table[i]![j] = same(a[i]!, b[j]!) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i]!, b[j]!)) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

/** A line diff (unchanged, added, removed lines in order). Longer texts are cut at DIFF_LIMITS.lines per side. */
export function lineDiff(before: string | null, after: string | null): { lines: DiffLine[]; truncated: boolean } {
  const left = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const right = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  const truncated = left.length > DIFF_LIMITS.lines || right.length > DIFF_LIMITS.lines;
  const a = left.slice(0, DIFF_LIMITS.lines);
  const b = right.slice(0, DIFF_LIMITS.lines);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [x, y] of lcsPairs(a, b, (p, q) => p === q)) {
    while (i < x) lines.push({ op: "del", text: a[i++]! });
    while (j < y) lines.push({ op: "add", text: b[j++]! });
    lines.push({ op: "same", text: a[i]! });
    i += 1;
    j += 1;
  }
  while (i < a.length) lines.push({ op: "del", text: a[i++]! });
  while (j < b.length) lines.push({ op: "add", text: b[j++]! });
  return { lines, truncated };
}

const blockTitle = (block: ReportBlock) => block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.type === "markdown" ? "Text" : block.queryKey);
const contentOf = (block: ReportBlock) => {
  const { provenance: _p, autoFixes: _a, legacy: _l, ...rest } = block as ReportBlock & Record<string, unknown>;
  return stable(rest);
};

const TYPE_NOUN: Record<ReportBlock["type"], [string, string]> = { chart: ["chart", "charts"], kpi: ["KPI", "KPIs"], table: ["table", "tables"], markdown: ["text block", "text blocks"] };
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What changed between two specs: blocks, queries (SQL line diffs), markdown text, and sections. `withText: false` skips line diffs (list summaries). */
export function diffSpecVersions(before: ReportSpec, after: ReportSpec, options: { from: number; to: number; withText?: boolean }): VersionDiff {
  const withText = options.withText ?? true;
  let truncated = false;
  const blocks: BlockDiff[] = [];
  const oldBlocks = new Map(before.blocks.map((block) => [block.id, block]));
  const newIds = new Set(after.blocks.map((block) => block.id));
  const keptBefore = before.blocks.filter((block) => newIds.has(block.id)).map((block) => block.id);
  const keptAfter = after.blocks.filter((block) => oldBlocks.has(block.id)).map((block) => block.id);
  const stayed = new Set(lcsPairs(keptBefore, keptAfter, (x, y) => x === y).map(([index]) => keptBefore[index]!));
  const oldIndex = new Map(before.blocks.map((block, index) => [block.id, index]));

  after.blocks.forEach((block, index) => {
    const old = oldBlocks.get(block.id);
    if (!old) {
      blocks.push({ blockId: block.id, change: "added", type: block.type, title: blockTitle(block), fields: fieldChanges(null, block as unknown as Record<string, unknown>),
        ...(block.type === "markdown" && withText ? { text: lineDiff(null, block.markdown).lines } : {}) });
      return;
    }
    if (contentOf(old) !== contentOf(block)) {
      const text = old.type === "markdown" || block.type === "markdown"
        ? (old.type === "markdown" ? old.markdown : null) !== (block.type === "markdown" ? block.markdown : null) ? lineDiff(old.type === "markdown" ? old.markdown : null, block.type === "markdown" ? block.markdown : null) : null
        : null;
      if (text?.truncated) truncated = true;
      blocks.push({ blockId: block.id, change: "changed", type: block.type, title: blockTitle(block), fields: fieldChanges(old as unknown as Record<string, unknown>, block as unknown as Record<string, unknown>),
        ...(text ? { textChanged: true } : {}), ...(text && withText ? { text: text.lines } : {}),
        ...(!stayed.has(block.id) ? { position: { before: oldIndex.get(block.id)! + 1, after: index + 1 } } : {}) });
      return;
    }
    if (!stayed.has(block.id)) blocks.push({ blockId: block.id, change: "moved", type: block.type, title: blockTitle(block), fields: [], position: { before: oldIndex.get(block.id)! + 1, after: index + 1 } });
  });
  for (const block of before.blocks) {
    if (newIds.has(block.id)) continue;
    blocks.push({ blockId: block.id, change: "removed", type: block.type, title: blockTitle(block), fields: fieldChanges(block as unknown as Record<string, unknown>, null),
      ...(block.type === "markdown" && withText ? { text: lineDiff(block.markdown, null).lines } : {}) });
  }

  const queries: QueryDiff[] = [];
  const oldQueries = new Map(before.queries.map((query) => [query.key, query]));
  const newKeys = new Set(after.queries.map((query) => query.key));
  for (const query of after.queries) {
    const old = oldQueries.get(query.key);
    if (old && old.sql === query.sql && old.purpose === query.purpose) continue;
    const diff = withText ? lineDiff(old?.sql ?? null, query.sql) : { lines: [], truncated: false };
    if (diff.truncated) truncated = true;
    queries.push({ key: query.key, change: old ? "changed" : "added", lines: diff.lines, ...(old && old.purpose !== query.purpose ? { purpose: { field: "purpose", before: old.purpose, after: query.purpose } } : {}) });
  }
  for (const query of before.queries) {
    if (newKeys.has(query.key)) continue;
    const diff = withText ? lineDiff(query.sql, null) : { lines: [], truncated: false };
    if (diff.truncated) truncated = true;
    queries.push({ key: query.key, change: "removed", lines: diff.lines });
  }

  const sections: SectionDiff[] = [];
  const oldSections = new Map((before.sections ?? []).map((section) => [section.id, section]));
  const newSectionIds = new Set((after.sections ?? []).map((section) => section.id));
  const keptOld = (before.sections ?? []).filter((section) => newSectionIds.has(section.id)).map((section) => section.id);
  const keptNew = (after.sections ?? []).filter((section) => oldSections.has(section.id)).map((section) => section.id);
  const sectionsStayed = new Set(lcsPairs(keptOld, keptNew, (x, y) => x === y).map(([index]) => keptOld[index]!));
  const sectionFields = (section: ReportSection | null) => section ? { title: section.title, summary: section.summary } : null;
  for (const section of after.sections ?? []) {
    const old = oldSections.get(section.id);
    if (!old) { sections.push({ id: section.id, change: "added", title: section.title, fields: fieldChanges(null, sectionFields(section)) }); continue; }
    const fields = fieldChanges(sectionFields(old), sectionFields(section));
    if (fields.length) sections.push({ id: section.id, change: "changed", title: section.title, fields });
    else if (!sectionsStayed.has(section.id)) sections.push({ id: section.id, change: "moved", title: section.title, fields: [] });
  }
  for (const section of before.sections ?? []) if (!newSectionIds.has(section.id)) sections.push({ id: section.id, change: "removed", title: section.title, fields: fieldChanges(sectionFields(section), null) });

  const summary = diffSummary(blocks, queries, sections);
  const cap = <T,>(list: T[]) => {
    if (list.length > DIFF_LIMITS.entries) { truncated = true; return list.slice(0, DIFF_LIMITS.entries); }
    return list;
  };
  return { from: options.from, to: options.to, summary, blocks: cap(blocks), queries: cap(queries), sections: cap(sections), truncated };
}

/** "+2 charts, −1 table, 1 query changed, title changed": the diff in one short line. */
export function diffSummary(blocks: readonly BlockDiff[], queries: readonly QueryDiff[], sections: readonly SectionDiff[]): string {
  const parts: string[] = [];
  for (const [change, sign] of [["added", "+"], ["removed", "−"]] as const) {
    const byType = new Map<ReportBlock["type"], number>();
    for (const block of blocks) if (block.change === change) byType.set(block.type, (byType.get(block.type) ?? 0) + 1);
    for (const [type, count] of byType) parts.push(`${sign}${plural(count, ...TYPE_NOUN[type])}`);
  }
  const changed = blocks.filter((block) => block.change === "changed");
  const titleOnly = changed.filter((block) => block.fields.length > 0 && block.fields.every((field) => field.field === "title") && !block.textChanged);
  const textOnly = changed.filter((block) => block.type === "markdown" && block.textChanged && block.fields.every((field) => field.field === "title"));
  const other = changed.length - titleOnly.length - textOnly.length;
  if (other > 0) parts.push(`${plural(other, "block", "blocks")} changed`);
  if (titleOnly.length === 1) parts.push("title changed");
  else if (titleOnly.length > 1) parts.push(`${titleOnly.length} titles changed`);
  if (textOnly.length) parts.push(textOnly.length === 1 ? "text changed" : `${textOnly.length} texts changed`);
  const moved = blocks.filter((block) => block.change === "moved").length + changed.filter((block) => block.position).length;
  if (moved) parts.push(`${plural(moved, "block", "blocks")} moved`);
  for (const change of ["added", "changed", "removed"] as const) {
    const count = queries.filter((query) => query.change === change).length;
    if (count) parts.push(`${plural(count, "query", "queries")} ${change}`);
  }
  if (sections.length) parts.push(sections.length === 1 ? "1 section changed" : `${sections.length} sections changed`);
  return parts.length ? parts.join(", ") : "No changes";
}
