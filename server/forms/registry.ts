import { z } from "zod";
import { audit, db, now } from "../db";
import { logger } from "../log";
import { withResourceLock } from "../storage";
import { SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinProvider, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { readableContainerSql } from "../access/workspaceItems";
import { recordItemActivity } from "../activity/service";
import { each, type WorkKindAdapter } from "../links/adapters";
import { page, sectionScope, TODAY_FETCH, type TodayProvider } from "../today/registry";
import type { SearchScopeDef } from "../searchRegistry";
import type { DatasetDef } from "../datasets/registry";
import type { ProgressSource } from "../goalsProgress";
import { anchorBySql, type Anchor } from "../keyResources";
import { currentSet, summarize } from "../questions/service";
import { formIdOf, formRow, formRowById, levelOf, listItem, respondableSql, syncSchedules, type FormRow } from "./service";
import { formPath } from "../../shared/forms";
import { WORK_KIND_ICONS } from "../../shared/workRefs";

const slog = logger("forms");

/**
 * The Forms module's registrations other than routes and tools (docs/plan/WORKSPACE_MODULES.md §B.1):
 * work kinds (`form`, `response`), key-grant anchors, the Bin, Today, search, datasets, and the
 * `form_metric` progress source for Goals (§C C10).
 */

// ---------------------------------------------------------------- work kinds and anchors

const formTone = (row: FormRow) => row.status === "open" ? "success" as const : row.status === "closed" ? "neutral" as const : "warning" as const;
const statusLabel = (row: FormRow) => row.status === "open" ? "Open" : row.status === "closed" ? "Closed" : "Draft";

export const formWorkKinds: WorkKindAdapter[] = [{
  kind: "form", itemKind: "form", scopes: { read: "forms:read", write: "forms:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? formIdOf(ref.ref) : null,
  level: (id, viewer) => { const row = formRowById(id); return row ? levelOf(row, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const row = formRowById(id);
    if (!row || row.deleted_at !== null) return null;
    const level = levelOf(row, viewer.userId);
    if (level === "none") return null;
    return {
      kind: "form", id, shortId: row.short_id, title: row.title, subtitle: row.kind === "poll" ? "Poll" : row.kind === "time_poll" ? "Find a time" : `${row.response_count} responses`,
      href: formPath(row.title, row.short_id), icon: WORK_KIND_ICONS.form, status: { label: statusLabel(row), tone: formTone(row) }
    };
  })
}, {
  kind: "response", itemKind: "response", scopes: { read: "forms:read", write: "forms:write" },
  level: (id, viewer) => {
    const host = db.query("SELECT host_id FROM responses WHERE id = ? AND host_kind = 'form'").get(id) as { host_id: string } | null;
    const row = host ? formRowById(host.host_id) : null;
    return row ? levelOf(row, viewer.userId) : "none";
  },
  resolve: each((id, viewer) => {
    const host = db.query("SELECT host_id, submitted_at FROM responses WHERE id = ? AND host_kind = 'form'").get(id) as { host_id: string; submitted_at: string } | null;
    const row = host ? formRowById(host.host_id) : null;
    if (!row || !host || row.deleted_at !== null || levelOf(row, viewer.userId) === "none") return null;
    return { kind: "response", id, title: `Response to ${row.title}`, subtitle: host.submitted_at.slice(0, 10), href: `${formPath(row.title, row.short_id, "results")}?response=${id}`, icon: WORK_KIND_ICONS.response };
  })
}];

export const formItemKinds: Array<{ kind: "form" | "response"; anchors: (id: string) => Anchor[] | null }> = [
  { kind: "form", anchors: (id) => { const formId = formIdOf(id); return formId && formRowById(formId) ? [{ kind: "form", id: formId }] : null; } },
  { kind: "response", anchors: anchorBySql("form", "SELECT host_id AS anchor FROM responses WHERE id = ? AND host_kind = 'form'") }
];

// ---------------------------------------------------------------- Bin

const lockKey = (id: string) => `forms:${id}`;
const defaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE forms SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    // Triggers (090) clear links, activity, members, grants, schedules, public links, sets, and responses.
    db.query("DELETE FROM forms WHERE id = ?").run(id);
    audit(options.actorId, null, "forms.purge", { formId: id, reason: options.reason });
    return "purged";
  })();
}

const mayRestore = (row: FormRow, userId: string) => row.owner_id === userId || row.deleted_by === userId;

export const formsBinProvider: BinProvider = {
  list(userId) {
    const rows = db.query("SELECT * FROM forms WHERE deleted_at IS NOT NULL AND (owner_id = ? OR deleted_by = ?) ORDER BY deleted_at DESC, id LIMIT 500").all(userId, userId) as FormRow[];
    return rows.map((row): BinItem => ({ type: "form", id: row.id, title: row.title, folder_id: null, folder_name: "Forms", deleted_at: row.deleted_at!, purge_after: row.purge_after!, purging: row.purge_started_at !== null, ...defaults, can_purge: row.owner_id === userId, href: formPath(row.title, row.short_id) }));
  },
  restore(id, userId) {
    return withResourceLock(lockKey(id), async (): Promise<RestoreOutcome> => db.transaction((): RestoreOutcome => {
      const row = formRowById(id);
      if (!row || !mayRestore(row, userId)) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: null, folderName: "Forms" };
      db.query("UPDATE forms SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), id);
      recordItemActivity({ itemKind: "form", itemId: id, actorId: userId, kind: "restored" });
      audit(userId, null, "forms.restore", { formId: id });
      syncSchedules(formRowById(id)!);
      return { status: "restored", folderId: null, folderName: "Forms", visibility: row.visibility as "private" };
    })());
  },
  purge(id, userId) {
    return withResourceLock(lockKey(id), async () => {
      const row = formRowById(id);
      if (!row || row.owner_id !== userId) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(id, { reason: "user", actorId: userId });
    });
  },
  async sweep(cutoff) {
    const resumed = db.query("SELECT id FROM forms WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
    const due = db.query("SELECT id FROM forms WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
      for (const { id } of items) {
        try {
          if (await withResourceLock(lockKey(id), async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff })) === "purged") counts.purged += 1;
        } catch (error) {
          counts.pending += 1;
          slog.error("Bin sweep could not purge a form", error);
        }
      }
    }
    return counts;
  },
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const { id } of db.query("SELECT id FROM forms WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>) {
      if (await withResourceLock(lockKey(id), async () => purgeNow(id, { reason: "user", actorId: userId })) === "purged") counts.purged += 1;
    }
    return counts;
  }
};

// ---------------------------------------------------------------- Today

export const formsTodayProviders: Array<{ name: string; provider: TodayProvider }> = [{
  name: "formsResponses",
  provider: {
    href: "/forms", mcpScope: "forms:read",
    load: (context) => {
      const scope = sectionScope(context, "forms:read", { form: "f.id" });
      const since = new Date(context.now.getTime() - 7 * 86_400_000).toISOString();
      const rows = db.query(`SELECT f.* FROM forms f WHERE ${readableContainerSql("form", "f", { minLevel: "edit" })} AND f.status = 'open' AND f.last_response_at >= $since AND ${scope.sql}
        ORDER BY f.last_response_at DESC LIMIT $limit`).all({ userId: context.userId, since, limit: TODAY_FETCH, ...scope.params }) as FormRow[];
      return page(rows.map((row) => {
        const recent = (db.query("SELECT COUNT(*) AS n FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted' AND submitted_at >= ?").get(row.id, since) as { n: number }).n;
        return { id: row.id, title: row.title, kind: row.kind, recent, total: row.response_count, lastResponseAt: row.last_response_at, href: formPath(row.title, row.short_id, row.kind === "form" ? "results" : undefined) };
      }));
    }
  }
}, {
  name: "pollsToVote",
  provider: {
    href: "/forms/answer", mcpScope: "forms:read",
    load: (context) => {
      const scope = sectionScope(context, "forms:read", { form: "f.id" });
      const nowIso = context.now.toISOString();
      const rows = db.query(`SELECT f.* FROM forms f WHERE ${respondableSql("f")} AND f.owner_id <> $userId AND f.status = 'open' AND (f.opens_at IS NULL OR f.opens_at <= $now) AND (f.closes_at IS NULL OR f.closes_at > $now)
          AND (f.max_responses IS NULL OR f.response_count < f.max_responses) AND f.anonymous = 0
          AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.host_kind = 'form' AND r.host_id = f.id AND r.respondent_user_id = $userId) AND ${scope.sql}
        ORDER BY COALESCE(f.closes_at, '9999') ASC, f.updated_at DESC LIMIT $limit`).all({ userId: context.userId, now: nowIso, limit: TODAY_FETCH, ...scope.params }) as FormRow[];
      return page(rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, closesAt: row.closes_at, href: formPath(row.title, row.short_id) })));
    }
  }
}];

// ---------------------------------------------------------------- search

const ftsQuery = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, 8).map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");

export const formsSearchScope: SearchScopeDef = {
  scope: "forms", label: "Forms", module: "forms", roles: ["admin", "member", "viewer", "guest"],
  search: ({ userId, q, limit }) => {
    const match = ftsQuery(q);
    if (!match) return { results: [], truncated: false };
    const rows = db.query(`SELECT f.*, snippet(forms_fts, 2, '', '', '…', 12) AS snip FROM forms_fts JOIN forms f ON f.id = forms_fts.form_id
      WHERE forms_fts MATCH $match AND (${readableContainerSql("form", "f")} OR ${respondableSql("f")}) ORDER BY rank LIMIT $limit`).all({ match, userId, limit: limit + 1 }) as Array<FormRow & { snip: string }>;
    return {
      results: rows.slice(0, limit).map((row) => ({ kind: "form" as const, id: row.id, title: row.title, snippet: (row.kind === "poll" ? "Poll" : row.kind === "time_poll" ? "Find a time" : row.snip || "Form").slice(0, 200), href: formPath(row.title, row.short_id), updatedAt: row.updated_at })),
      truncated: rows.length > limit
    };
  }
};

/** The `search_forms` tool's query (same predicate as the scope). */
export function searchForms(userId: string, q: string, limit = 20) {
  const match = ftsQuery(q);
  if (!match) return [];
  const rows = db.query(`SELECT f.* FROM forms_fts JOIN forms f ON f.id = forms_fts.form_id WHERE forms_fts MATCH $match AND (${readableContainerSql("form", "f")} OR ${respondableSql("f")}) ORDER BY rank LIMIT $limit`).all({ match, userId, limit }) as FormRow[];
  return rows.map((row) => listItem(row, userId));
}

// ---------------------------------------------------------------- datasets (§B.10)

const readable = () => ({ sql: readableContainerSql("form", "f") });

export const formsDatasets: DatasetDef[] = [{
  id: "forms.responses", module: "forms", label: "Form responses", readScope: "forms:read",
  description: "Submitted responses to forms you can read results of: form, kind, when, respondent kind, and score.",
  from: "responses r JOIN forms f ON f.id = r.host_id AND r.host_kind = 'form'", scope: () => ({ sql: `r.status = 'submitted' AND ${readable().sql}` }), timeColumn: "submitted_at",
  columns: [
    { name: "form", sql: "f.title", type: "string", label: "Form", dimension: true },
    { name: "form_id", sql: "f.id", type: "string", label: "Form id", dimension: true, measures: ["count_distinct"] },
    { name: "kind", sql: "f.kind", type: "string", label: "Kind", dimension: true },
    { name: "respondent_kind", sql: "CASE WHEN f.anonymous = 1 THEN 'anonymous' ELSE r.respondent_kind END", type: "string", label: "Respondent", dimension: true },
    { name: "public", sql: "(json_extract(r.meta_json, '$.via') = 'public')", type: "bool", label: "Public link", dimension: true },
    // Anonymous forms show the day only (T518).
    { name: "submitted_at", sql: "CASE WHEN f.anonymous = 1 THEN substr(r.submitted_at, 1, 10) || 'T00:00:00.000Z' ELSE r.submitted_at END", type: "datetime", label: "Submitted", dimension: true, measures: ["min", "max"] },
    { name: "score", sql: "r.score", type: "number", label: "Score", measures: ["sum", "avg", "min", "max"] },
    { name: "response_id", sql: "r.id", type: "string", label: "Response", measures: ["count_distinct"] }
  ]
}, {
  id: "forms.answers", module: "forms", label: "Form answers", readScope: "forms:read",
  description: "One row per answered value: form, question, option, number, and the first 200 characters of text.",
  from: "response_answers a JOIN responses r ON r.id = a.response_id AND r.host_kind = 'form' JOIN forms f ON f.id = r.host_id",
  scope: () => ({ sql: `r.status = 'submitted' AND ${readable().sql}` }), timeColumn: "submitted_at",
  columns: [
    { name: "form", sql: "f.title", type: "string", label: "Form", dimension: true },
    { name: "form_id", sql: "f.id", type: "string", label: "Form id", dimension: true },
    { name: "question_id", sql: "a.question_id", type: "string", label: "Question", dimension: true },
    { name: "option_id", sql: "a.option_id", type: "string", label: "Option", dimension: true },
    { name: "value_num", sql: "a.value_num", type: "number", label: "Number", dimension: true, measures: ["sum", "avg", "min", "max"] },
    { name: "value_text", sql: "substr(a.value_text, 1, 200)", type: "string", label: "Text", dimension: true },
    { name: "submitted_at", sql: "CASE WHEN f.anonymous = 1 THEN substr(r.submitted_at, 1, 10) || 'T00:00:00.000Z' ELSE r.submitted_at END", type: "datetime", label: "Submitted", dimension: true },
    { name: "response_id", sql: "r.id", type: "string", label: "Response", measures: ["count_distinct"] }
  ]
}];

// ---------------------------------------------------------------- Goals progress (§C C10)

const metricConfig = z.object({ formId: z.string().max(200), metric: z.enum(["responses", "average", "nps"]), questionId: z.string().max(16).optional() });
export const formMetricSource: Omit<ProgressSource<z.infer<typeof metricConfig>>, "kind"> = {
  label: "Form metric", module: "forms", configSchema: metricConfig,
  describe: (config, context) => {
    const row = formRow(config.formId);
    const title = row && levelOf(row, context.viewerId) !== "none" ? row.title : "a form";
    return config.metric === "responses" ? `Responses to ${title}` : config.metric === "nps" ? `NPS of ${title}` : `Average answer on ${title}`;
  },
  compute: (config, context) => {
    const row = formRow(config.formId);
    if (!row || row.deleted_at !== null || levelOf(row, context.ownerId) === "none") return null;
    const filter = context.period ? { since: new Date(`${context.period.start}T00:00:00Z`).toISOString(), until: new Date(Date.parse(`${context.period.end}T00:00:00Z`) + 86_400_000).toISOString() } : {};
    const summary = summarize({ kind: "form", id: row.id }, filter);
    if (config.metric === "responses") return { value: summary.responses, detail: `${summary.responses} responses` };
    const set = currentSet({ kind: "form", id: row.id })?.set;
    const question = set?.questions.find((item) => config.questionId ? item.id === config.questionId : config.metric === "nps" ? item.type === "nps" : ["rating", "scale", "number", "nps"].includes(item.type));
    const found = question ? summary.questions.find((item) => item.questionId === question.id) : undefined;
    if (!found) return null;
    if (config.metric === "nps") return found.kind === "nps" && found.score !== null ? { value: found.score, detail: `NPS ${found.score}` } : null;
    if (found.kind === "numeric" && found.mean !== null) return { value: found.mean, detail: `Average ${found.mean}` };
    if (found.kind === "nps" && found.answered) { const total = found.distribution.reduce((sum, item) => sum + item.value * item.count, 0); return { value: total / found.answered }; }
    return null;
  }
};
