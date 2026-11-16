import { audit, db, now } from "../db";
import { captureUndo } from "../undo";
import { keyedHash } from "../public/secret";
import {
  QUESTION_TYPES, scoreResponse, validateAnswers, validateQuestionSet, YES_NO_OPTIONS,
  type Answers, type AnswerValue, type Audience, type Question, type QuestionHostKind, type QuestionSet, type QuestionSummary, type RespondentKind, type ResponseSummary, type SetProblem, type SetSummary
} from "../../shared/questions";

/**
 * The question engine's server side (docs/plan/WORKSPACE_MODULES.md §B.2, D802). Hosts (a form, a
 * standup, a booking type, a townhall session) keep versioned question sets: one draft (version 0)
 * and immutable published versions 1, 2, …; a response pins the version it answered, so editing a live
 * form never changes old answers. Answers are stored one normalized row per value (`response_answers`),
 * so summaries aggregate in SQL.
 *
 * These are services, not routes: the calling module checks who may edit the host, answer it, and
 * read its results, then calls them inside its own write's transaction where it has one.
 */

export type QuestionHost = { kind: QuestionHostKind; id: string };

export class QuestionError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

type SetRow = { version: number; status: "draft" | "published"; set_json: string; updated_at: string };

/** The latest published version, or null. */
export function currentSet(host: QuestionHost): { version: number; set: QuestionSet } | null {
  const row = db.query("SELECT version, set_json FROM question_sets WHERE host_kind = ? AND host_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1").get(host.kind, host.id) as SetRow | null;
  return row ? { version: row.version, set: JSON.parse(row.set_json) as QuestionSet } : null;
}

/** One published version, or null. */
export function setVersion(host: QuestionHost, version: number): QuestionSet | null {
  const row = db.query("SELECT set_json FROM question_sets WHERE host_kind = ? AND host_id = ? AND version = ? AND status = 'published'").get(host.kind, host.id, version) as SetRow | null;
  return row ? JSON.parse(row.set_json) as QuestionSet : null;
}

/** The draft, or null when the host has none (it then edits from its current version). */
export function draftSet(host: QuestionHost): { set: QuestionSet; updatedAt: string } | null {
  const row = db.query("SELECT set_json, updated_at FROM question_sets WHERE host_kind = ? AND host_id = ? AND version = 0").get(host.kind, host.id) as SetRow | null;
  return row ? { set: JSON.parse(row.set_json) as QuestionSet, updatedAt: row.updated_at } : null;
}

function invalidSet(problems: SetProblem[]): never {
  throw new QuestionError(400, "INVALID_QUESTIONS", problems[0]?.message ?? "The questions are not valid", { problems });
}

/** Question ids already published with another type: ids are never reused for something else. */
function reusedIds(host: QuestionHost, set: QuestionSet): SetProblem[] {
  const earlier = new Map<string, string>();
  for (const row of db.query("SELECT set_json FROM question_sets WHERE host_kind = ? AND host_id = ? AND status = 'published'").all(host.kind, host.id) as SetRow[]) {
    for (const question of (JSON.parse(row.set_json) as QuestionSet).questions) earlier.set(question.id, question.type);
  }
  return set.questions.flatMap((question, index) => earlier.has(question.id) && earlier.get(question.id) !== question.type
    ? [{ path: `questions.${index}.id`, message: "This id was used for a question of another type; give the question a new id" }] : []);
}

/** Saves the draft set (validated, any audience; publishing checks the audience). Call inside the host's write. */
export function saveDraftSet(host: QuestionHost, set: unknown, actorId: string | null): QuestionSet {
  const checked = validateQuestionSet(set);
  if (!checked.ok) invalidSet(checked.problems);
  const reused = reusedIds(host, checked.set);
  if (reused.length) invalidSet(reused);
  const json = JSON.stringify(checked.set);
  const timestamp = now();
  db.query(`INSERT INTO question_sets (id, host_kind, host_id, version, status, set_json, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 'draft', ?, ?, ?, ?)
    ON CONFLICT (host_kind, host_id, version) DO UPDATE SET set_json = excluded.set_json, updated_at = excluded.updated_at`).run(Bun.randomUUIDv7(), host.kind, host.id, json, actorId, timestamp, timestamp);
  return checked.set;
}

/** Discards the draft (the current version stays). */
export const discardDraftSet = (host: QuestionHost) => db.query("DELETE FROM question_sets WHERE host_kind = ? AND host_id = ? AND version = 0").run(host.kind, host.id).changes > 0;

/**
 * Publishes the draft as the next version (D841). `audience: "public"` refuses members-only question
 * types. Returns the new version. 409 NO_DRAFT when there is nothing to publish.
 */
export function publishSet(host: QuestionHost, actorId: string | null, options: { audience?: Audience } = {}): { version: number; set: QuestionSet } {
  return db.transaction(() => {
    const draft = draftSet(host);
    if (!draft) throw new QuestionError(409, "NO_DRAFT", "There are no changes to publish");
    const checked = validateQuestionSet(draft.set, { audience: options.audience });
    if (!checked.ok) invalidSet(checked.problems);
    const reused = reusedIds(host, checked.set);
    if (reused.length) invalidSet(reused);
    const version = ((db.query("SELECT MAX(version) AS version FROM question_sets WHERE host_kind = ? AND host_id = ?").get(host.kind, host.id) as { version: number | null }).version ?? 0) + 1;
    const timestamp = now();
    db.query("INSERT INTO question_sets (id, host_kind, host_id, version, status, set_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)")
      .run(Bun.randomUUIDv7(), host.kind, host.id, version, JSON.stringify(checked.set), actorId, timestamp, timestamp);
    db.query("DELETE FROM question_sets WHERE host_kind = ? AND host_id = ? AND version = 0").run(host.kind, host.id);
    audit(actorId, null, "questions.published", { hostKind: host.kind, hostId: host.id, version, questions: checked.set.questions.length });
    return { version, set: checked.set };
  })();
}

/** Removes every set and response of a host (the host is purged). Lanes call it from their purge. */
export function purgeHostQuestions(host: QuestionHost) {
  db.query("DELETE FROM responses WHERE host_kind = ? AND host_id = ?").run(host.kind, host.id);
  db.query("DELETE FROM question_sets WHERE host_kind = ? AND host_id = ?").run(host.kind, host.id);
}

// ---------------------------------------------------------------- answers as rows

type AnswerRow = { question_id: string; ord: number; option_id: string | null; value_text: string | null; value_num: number | null; value_json: string | null };

/** One normalized row per value (§B.2 Storage). */
export function answerRows(question: Question, value: AnswerValue): AnswerRow[] {
  const row = (ord: number, fields: Partial<AnswerRow>): AnswerRow => ({ question_id: question.id, ord, option_id: null, value_text: null, value_num: null, value_json: null, ...fields });
  switch (question.type) {
    case "single_choice": case "dropdown": case "yes_no":
      return typeof value === "string" ? [row(0, { option_id: value })] : [row(0, { option_id: "other", value_text: (value as { other: string }).other })];
    case "multi_choice": {
      const answer = value as { options: string[]; other?: string };
      return [...answer.options.map((id, index) => row(index, { option_id: id })), ...(answer.other ? [row(answer.options.length, { option_id: "other", value_text: answer.other })] : [])];
    }
    case "ranking": return (value as string[]).map((id, index) => row(index, { option_id: id, value_num: index + 1 }));
    case "rating": case "scale": case "nps": case "number": return [row(0, { value_num: value as number })];
    case "matrix": return Object.entries(value as Record<string, string | string[]>).flatMap(([rowId, cell]) => (Array.isArray(cell) ? cell : [cell]).map((columnId) => ({ rowId, columnId })))
      .map((cell, index) => row(index, { option_id: `${cell.rowId}:${cell.columnId}` }));
    case "time_slots": return Object.entries(value as Record<string, string>).map(([slotId, vote], index) => row(index, { option_id: slotId, value_text: vote }));
    case "contact": return [row(0, { value_text: (value as { name: string }).name, value_json: JSON.stringify(value) })];
    case "file": case "person": case "card": return (value as string[]).map((id, index) => row(index, { option_id: id }));
    case "hidden": return [row(0, { option_id: String(value).slice(0, 64), value_text: String(value) })];
    default: return [row(0, { value_text: String(value) })];
  }
}

/** The answers of rows, read back by the questions of the set the response pinned. */
export function answersOf(set: QuestionSet, rows: readonly AnswerRow[]): Answers {
  const answers: Answers = {};
  const byQuestion = new Map<string, AnswerRow[]>();
  for (const row of rows) byQuestion.set(row.question_id, [...(byQuestion.get(row.question_id) ?? []), row]);
  for (const question of set.questions) {
    const list = (byQuestion.get(question.id) ?? []).sort((a, b) => a.ord - b.ord);
    if (!list.length) continue;
    switch (question.type) {
      case "single_choice": case "dropdown": case "yes_no": answers[question.id] = list[0]!.option_id === "other" ? { other: list[0]!.value_text ?? "" } : list[0]!.option_id!; break;
      case "multi_choice": {
        const other = list.find((row) => row.option_id === "other");
        answers[question.id] = { options: list.filter((row) => row.option_id !== "other").map((row) => row.option_id!), ...(other ? { other: other.value_text ?? "" } : {}) };
        break;
      }
      case "ranking": case "file": case "person": case "card": answers[question.id] = list.map((row) => row.option_id!); break;
      case "rating": case "scale": case "nps": case "number": answers[question.id] = list[0]!.value_num!; break;
      case "matrix": {
        const cells: Record<string, string | string[]> = {};
        for (const row of list) {
          const [rowId, columnId] = row.option_id!.split(":") as [string, string];
          if (question.matrix?.multiple) cells[rowId] = [...((cells[rowId] as string[] | undefined) ?? []), columnId];
          else cells[rowId] = columnId;
        }
        answers[question.id] = cells;
        break;
      }
      case "time_slots": answers[question.id] = Object.fromEntries(list.map((row) => [row.option_id!, row.value_text ?? "no"])); break;
      case "contact": answers[question.id] = JSON.parse(list[0]!.value_json ?? "{}") as AnswerValue; break;
      default: answers[question.id] = list[0]!.value_text ?? "";
    }
  }
  return answers;
}

// ---------------------------------------------------------------- responses

export type Respondent =
  | { kind: "user"; userId: string }
  | { kind: "contact"; contactId: string; name?: string | null; email?: string | null }
  | { kind: "guest"; name: string; email?: string | null }
  | { kind: "anonymous"; dedupeHash?: string | null };

/** A keyed hash of the person and host for one-per-person on anonymous hosts (D843): it cannot be reversed to the user from the row. */
export const anonymousDedupeHash = (host: QuestionHost, userId: string) => keyedHash("respondent", `${host.kind}:${host.id}:${userId}`);

type ResponseRow = {
  id: string; host_kind: QuestionHostKind; host_id: string; set_version: number; subject_kind: string | null; subject_id: string | null; respondent_kind: RespondentKind;
  respondent_user_id: string | null; respondent_contact_id: string | null; respondent_name: string | null; respondent_email: string | null; dedupe_hash: string | null;
  status: "submitted" | "pending_verification"; score: number | null; meta_json: string; submitted_at: string; updated_at: string; revision: number;
};

function toSummary(row: ResponseRow, set: QuestionSet | null): ResponseSummary {
  const rows = db.query("SELECT question_id, ord, option_id, value_text, value_num, value_json FROM response_answers WHERE response_id = ?").all(row.id) as AnswerRow[];
  return {
    id: row.id, hostKind: row.host_kind, hostId: row.host_id, setVersion: row.set_version,
    respondent: { kind: row.respondent_kind, userId: row.respondent_user_id, contactId: row.respondent_contact_id, name: row.respondent_name, email: row.respondent_email },
    status: row.status, score: row.score, answers: set ? answersOf(set, rows) : {}, submittedAt: row.submitted_at, updatedAt: row.updated_at, revision: row.revision
  };
}

export function getResponse(responseId: string): ResponseSummary | null {
  const row = db.query("SELECT * FROM responses WHERE id = ?").get(responseId) as ResponseRow | null;
  return row ? toSummary(row, setVersion({ kind: row.host_kind, id: row.host_id }, row.set_version)) : null;
}

function writeAnswers(responseId: string, set: QuestionSet, answers: Answers) {
  db.query("DELETE FROM response_answers WHERE response_id = ?").run(responseId);
  const insert = db.query("INSERT INTO response_answers (response_id, question_id, ord, option_id, value_text, value_num, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const question of set.questions) {
    const value = answers[question.id];
    if (value === undefined || !QUESTION_TYPES[question.type].answers) continue;
    for (const row of answerRows(question, value)) insert.run(responseId, row.question_id, row.ord, row.option_id, row.value_text, row.value_num, row.value_json);
  }
}

function checkAnswersOrThrow(set: QuestionSet, answers: Record<string, unknown>, audience: Audience, hidden?: Record<string, string>) {
  const checked = validateAnswers(set, answers, { audience, hidden });
  if (!checked.ok) throw new QuestionError(400, "INVALID_ANSWERS", "Some answers need attention", { errors: checked.errors });
  return checked;
}

/**
 * Validates and stores a response against the host's current version (or `version`). Answers to
 * hidden questions are dropped; `required` applies to visible ones; public submissions refuse
 * members-only types. Returns the stored response. Call inside the module's transaction.
 */
export function submitResponse(input: {
  host: QuestionHost; version?: number; subject?: { kind: string; id: string } | null; respondent: Respondent; answers: Record<string, unknown>;
  meta?: Record<string, unknown>; audience: Audience; hidden?: Record<string, string>; status?: "submitted" | "pending_verification"; nowMs?: number;
}): ResponseSummary {
  const pinned = input.version !== undefined ? { version: input.version, set: setVersion(input.host, input.version) } : currentSet(input.host);
  if (!pinned?.set) throw new QuestionError(404, "NOT_FOUND", "There is nothing to answer");
  const checked = checkAnswersOrThrow(pinned.set, input.answers, input.audience, input.hidden);
  const meta = JSON.stringify({ ...(input.meta ?? {}), ...(checked.ending ? { ending: checked.ending } : {}) });
  if (meta.length > 4096) throw new QuestionError(400, "INVALID", "Too much metadata");
  const id = crypto.randomUUID();
  const timestamp = new Date(input.nowMs ?? Date.now()).toISOString();
  const respondent = input.respondent;
  db.query(`INSERT INTO responses (id, host_kind, host_id, set_version, subject_kind, subject_id, respondent_kind, respondent_user_id, respondent_contact_id, respondent_name, respondent_email,
      dedupe_hash, status, score, meta_json, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.host.kind, input.host.id, pinned.version, input.subject?.kind ?? null, input.subject?.id ?? null, respondent.kind,
      respondent.kind === "user" ? respondent.userId : null, respondent.kind === "contact" ? respondent.contactId : null,
      respondent.kind === "guest" ? respondent.name.slice(0, 120) : respondent.kind === "contact" ? respondent.name?.slice(0, 120) ?? null : null,
      respondent.kind === "guest" || respondent.kind === "contact" ? respondent.email?.slice(0, 254) ?? null : null,
      respondent.kind === "anonymous" ? respondent.dedupeHash ?? null : null,
      input.status ?? "submitted", scoreResponse(pinned.set, checked.answers), meta, timestamp, timestamp);
  writeAnswers(id, pinned.set, checked.answers);
  return getResponse(id)!;
}

/** Replaces a response's answers (allow-edit forms, standups), re-validated against its pinned version. */
export function updateResponse(input: { responseId: string; answers: Record<string, unknown>; audience: Audience; expectedRevision?: number; nowMs?: number }): ResponseSummary {
  const row = db.query("SELECT * FROM responses WHERE id = ?").get(input.responseId) as ResponseRow | null;
  if (!row) throw new QuestionError(404, "NOT_FOUND", "Response not found");
  if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) throw new QuestionError(409, "RESPONSE_CHANGED", "This response changed since you opened it");
  const set = setVersion({ kind: row.host_kind, id: row.host_id }, row.set_version);
  if (!set) throw new QuestionError(404, "NOT_FOUND", "Response not found");
  const checked = checkAnswersOrThrow(set, input.answers, input.audience);
  db.query("UPDATE responses SET score = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(scoreResponse(set, checked.answers), new Date(input.nowMs ?? Date.now()).toISOString(), row.id);
  writeAnswers(row.id, set, checked.answers);
  return getResponse(row.id)!;
}

/** Marks a held response submitted (after email verification). */
export const markResponseSubmitted = (responseId: string) => db.query("UPDATE responses SET status = 'submitted', updated_at = ? WHERE id = ? AND status = 'pending_verification'").run(now(), responseId).changes === 1;

/** Deletes a response at once with an Undo ticket (D813). The caller checked the actor may. */
export function deleteResponse(responseId: string, actorId: string): { undoTicket: string } {
  return db.transaction(() => {
    const row = db.query("SELECT id, host_kind, host_id FROM responses WHERE id = ?").get(responseId) as { id: string; host_kind: string; host_id: string } | null;
    if (!row) throw new QuestionError(404, "NOT_FOUND", "Response not found");
    const undoTicket = captureUndo({ actorId, kind: "response", label: "Response", rows: [{ table: "responses", where: { id: row.id } }, { table: "response_answers", where: { response_id: row.id } }] });
    db.query("DELETE FROM responses WHERE id = ?").run(row.id);
    audit(actorId, null, "questions.response_deleted", { hostKind: row.host_kind, hostId: row.host_id, responseId: row.id });
    return { undoTicket };
  })();
}

// ---------------------------------------------------------------- reading results

export type ResponseFilter = {
  subject?: { kind: string; id: string };
  respondentUserId?: string;
  /** Responses with this answer: an option chosen (or a hidden value). */
  answer?: { questionId: string; optionId: string };
  since?: string;
  until?: string;
  includePending?: boolean;
};

function filterSql(host: QuestionHost, filter: ResponseFilter = {}) {
  const terms = ["r.host_kind = $hostKind", "r.host_id = $hostId"];
  const params: Record<string, string> = { hostKind: host.kind, hostId: host.id };
  if (!filter.includePending) terms.push("r.status = 'submitted'");
  if (filter.subject) { terms.push("r.subject_kind = $subjectKind AND r.subject_id = $subjectId"); params.subjectKind = filter.subject.kind; params.subjectId = filter.subject.id; }
  if (filter.respondentUserId) { terms.push("r.respondent_user_id = $respondent"); params.respondent = filter.respondentUserId; }
  if (filter.answer) { terms.push("EXISTS (SELECT 1 FROM response_answers fa WHERE fa.response_id = r.id AND fa.question_id = $filterQuestion AND fa.option_id = $filterOption)"); params.filterQuestion = filter.answer.questionId; params.filterOption = filter.answer.optionId; }
  if (filter.since) { terms.push("r.submitted_at >= $since"); params.since = filter.since; }
  if (filter.until) { terms.push("r.submitted_at < $until"); params.until = filter.until; }
  return { sql: terms.join(" AND "), params };
}

/**
 * Day-only reading of an anonymous host (D1102, T623): timestamps are the day, rows are ordered by day
 * then id (random), and the cursor carries the day only, so nothing returns a submission's time of day
 * or its order within the day.
 */
export type ResponseReadOptions = { dayOnly?: boolean };
const SORT_AT = (dayOnly: boolean | undefined) => dayOnly ? "substr(r.submitted_at, 1, 10)" : "r.submitted_at";
const encodeCursor = (row: { submitted_at: string; id: string }, dayOnly?: boolean) => Buffer.from(JSON.stringify([dayOnly ? row.submitted_at.slice(0, 10) : row.submitted_at, row.id])).toString("base64url");
function decodeCursor(value: string | null | undefined): [string, string] | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? [parsed[0], parsed[1]] : null;
  } catch {
    return null;
  }
}

/** Newest first, keyset-paged (`submitted_at`, `id`; the day and `id` with `dayOnly`). */
export function responsesPage(host: QuestionHost, filter: ResponseFilter = {}, cursor?: string | null, limit = 50, options: ResponseReadOptions = {}): { items: ResponseSummary[]; nextCursor: string | null } {
  const bounded = Math.min(Math.max(1, limit), 100);
  const where = filterSql(host, filter);
  const after = decodeCursor(cursor);
  const sortAt = SORT_AT(options.dayOnly);
  const rows = db.query(`SELECT r.* FROM responses r WHERE ${where.sql}${after ? ` AND (${sortAt}, r.id) < ($cursorAt, $cursorId)` : ""} ORDER BY ${sortAt} DESC, r.id DESC LIMIT $limit`)
    .all({ ...where.params, ...(after ? { cursorAt: after[0], cursorId: after[1] } : {}), limit: bounded + 1 }) as ResponseRow[];
  const page = rows.slice(0, bounded);
  const sets = new Map<number, QuestionSet | null>();
  const setOf = (version: number) => { if (!sets.has(version)) sets.set(version, setVersion(host, version)); return sets.get(version)!; };
  return { items: page.map((row) => toSummary(row, setOf(row.set_version))), nextCursor: rows.length > bounded ? encodeCursor(page[page.length - 1]!, options.dayOnly) : null };
}

const STOP_WORDS = new Set(["the", "and", "for", "that", "with", "this", "was", "are", "but", "not", "you", "have", "had", "our", "its", "it's", "from", "they", "were", "been", "has", "will", "would", "there", "their", "what", "about", "which", "when", "your", "can", "all", "just", "more", "some", "very", "also"]);

/**
 * Per-question summaries of the submitted responses (§B.2), labelled by the current set: renamed
 * options show their current label; options no longer in the set show "Removed option".
 */
export function summarize(host: QuestionHost, filter: ResponseFilter = {}): SetSummary {
  const where = filterSql(host, filter);
  const set = currentSet(host)?.set ?? draftSet(host)?.set ?? null;
  const responses = (db.query(`SELECT COUNT(*) AS count FROM responses r WHERE ${where.sql}`).get(where.params) as { count: number }).count;
  if (!set) return { responses, questions: [] };
  const answersFrom = `FROM response_answers a JOIN responses r ON r.id = a.response_id WHERE ${where.sql} AND a.question_id = $questionId`;
  const questions: QuestionSummary[] = [];
  for (const question of set.questions) {
    const kind = QUESTION_TYPES[question.type].summary;
    if (!kind) continue;
    const params = { ...where.params, questionId: question.id };
    const answered = (db.query(`SELECT COUNT(DISTINCT a.response_id) AS count ${answersFrom}`).get(params) as { count: number }).count;
    const optionLabel = (id: string) => (question.type === "yes_no" ? YES_NO_OPTIONS.find((option) => option.id === id)?.label : question.options?.find((option) => option.id === id)?.label);
    if (kind === "choice") {
      const counts = db.query(`SELECT a.option_id AS id, COUNT(*) AS count ${answersFrom} GROUP BY a.option_id ORDER BY count DESC LIMIT 500`).all(params) as Array<{ id: string; count: number }>;
      const known = question.type === "yes_no" ? YES_NO_OPTIONS.map((option) => option.id) : question.options?.map((option) => option.id) ?? [];
      const options = [
        ...known.map((id) => ({ optionId: id, label: optionLabel(id) ?? id, count: counts.find((row) => row.id === id)?.count ?? 0 })),
        ...counts.filter((row) => row.id !== "other" && !known.includes(row.id)).map((row) => ({ optionId: row.id, label: question.type === "hidden" ? row.id : question.type === "person" || question.type === "card" ? row.id : "Removed option", count: row.count, ...(question.options ? { removed: true } : {}) }))
      ];
      questions.push({ questionId: question.id, kind: "choice", answered, options, other: counts.find((row) => row.id === "other")?.count ?? 0 });
    } else if (kind === "ranking") {
      const rows = db.query(`SELECT a.option_id AS id, COUNT(*) AS count, AVG(a.value_num) AS average ${answersFrom} GROUP BY a.option_id`).all(params) as Array<{ id: string; count: number; average: number }>;
      const n = question.options?.length ?? 0;
      const borda = db.query(`SELECT a.option_id AS id, SUM($n - a.value_num + 1) AS points ${answersFrom} GROUP BY a.option_id`).all({ ...params, n }) as Array<{ id: string; points: number }>;
      questions.push({
        questionId: question.id, kind: "ranking", answered,
        options: (question.options ?? []).map((option) => ({ optionId: option.id, label: option.label, count: rows.find((row) => row.id === option.id)?.count ?? 0, averageRank: rows.find((row) => row.id === option.id)?.average ?? null, borda: borda.find((row) => row.id === option.id)?.points ?? 0 }))
          .sort((a, b) => b.borda - a.borda)
      });
    } else if (kind === "numeric" || kind === "nps") {
      const distribution = db.query(`SELECT a.value_num AS value, COUNT(*) AS count ${answersFrom} AND a.value_num IS NOT NULL GROUP BY a.value_num ORDER BY a.value_num LIMIT 1000`).all(params) as Array<{ value: number; count: number }>;
      const stats = db.query(`SELECT MIN(a.value_num) AS min, MAX(a.value_num) AS max, AVG(a.value_num) AS mean, COALESCE(SUM(a.value_num), 0) AS sum, COUNT(a.value_num) AS n ${answersFrom}`).get(params) as { min: number | null; max: number | null; mean: number | null; sum: number; n: number };
      if (kind === "nps") {
        const total = distribution.reduce((sum, row) => sum + row.count, 0);
        const promoters = distribution.filter((row) => row.value >= 9).reduce((sum, row) => sum + row.count, 0);
        const detractors = distribution.filter((row) => row.value <= 6).reduce((sum, row) => sum + row.count, 0);
        questions.push({ questionId: question.id, kind: "nps", answered, promoters, passives: total - promoters - detractors, detractors, score: total ? Math.round(((promoters - detractors) / total) * 100) : null, distribution });
      } else {
        let median: number | null = null;
        if (stats.n) {
          const middle = [Math.floor((stats.n - 1) / 2), Math.ceil((stats.n - 1) / 2)];
          const picks: number[] = [];
          let seen = 0;
          for (const row of distribution) {
            for (const position of middle) if (position >= seen && position < seen + row.count) picks.push(row.value);
            seen += row.count;
          }
          median = picks.length ? picks.reduce((sum, value) => sum + value, 0) / picks.length : null;
        }
        questions.push({ questionId: question.id, kind: "numeric", answered, min: stats.min, max: stats.max, mean: stats.mean === null ? null : Math.round(stats.mean * 1000) / 1000, median, sum: stats.sum, distribution: distribution.slice(0, 100) });
      }
    } else if (kind === "text") {
      const latest = (db.query(`SELECT a.value_text AS text ${answersFrom} AND a.value_text IS NOT NULL ORDER BY r.submitted_at DESC LIMIT 500`).all(params) as Array<{ text: string }>).map((row) => row.text);
      const words = new Map<string, number>();
      for (const text of latest) for (const word of text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []) if (!STOP_WORDS.has(word)) words.set(word, (words.get(word) ?? 0) + 1);
      questions.push({ questionId: question.id, kind: "text", answered, latest: latest.slice(0, 20), topWords: [...words].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([word, count]) => ({ word, count })) });
    } else if (kind === "dates") {
      const byDay = db.query(`SELECT substr(a.value_text, 1, 10) AS day, COUNT(*) AS count ${answersFrom} GROUP BY day ORDER BY day LIMIT 1000`).all(params) as Array<{ day: string; count: number }>;
      questions.push({ questionId: question.id, kind: "dates", answered, byDay });
    } else if (kind === "matrix") {
      const cells = (db.query(`SELECT a.option_id AS id, COUNT(*) AS count ${answersFrom} GROUP BY a.option_id`).all(params) as Array<{ id: string; count: number }>)
        .map((row) => { const [rowId, columnId] = row.id.split(":") as [string, string]; return { rowId, columnId, count: row.count }; });
      questions.push({ questionId: question.id, kind: "matrix", answered, cells });
    } else if (kind === "slots") {
      const votes = db.query(`SELECT a.option_id AS id, a.value_text AS vote, COUNT(*) AS count ${answersFrom} GROUP BY a.option_id, a.value_text`).all(params) as Array<{ id: string; vote: string; count: number }>;
      const slots = (question.slots ?? []).map((slot) => ({
        slotId: slot.id, yes: votes.find((row) => row.id === slot.id && row.vote === "yes")?.count ?? 0, maybe: votes.find((row) => row.id === slot.id && row.vote === "maybe")?.count ?? 0, no: votes.find((row) => row.id === slot.id && row.vote === "no")?.count ?? 0
      }));
      const best = [...slots].sort((a, b) => b.yes - a.yes || b.maybe - a.maybe)[0];
      questions.push({ questionId: question.id, kind: "slots", answered, slots, best: best && (best.yes || best.maybe) ? best.slotId : null });
    } else {
      questions.push({ questionId: question.id, kind: "count", answered });
    }
  }
  return { responses, questions };
}

/** A CSV cell, quoted, with formula injection neutralized (T514): a cell starting with = + - @ (or a tab/CR) gets a leading '. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) || text.startsWith("'") ? `"${text.replace(/"/g, '""')}"` : text;
}

export function answerText(question: Question, value: AnswerValue | undefined): string {
  if (value === undefined) return "";
  const label = (id: string) => (question.type === "yes_no" ? YES_NO_OPTIONS.find((option) => option.id === id)?.label : question.options?.find((option) => option.id === id)?.label) ?? id;
  if (typeof value === "string") return ["single_choice", "dropdown", "yes_no"].includes(question.type) ? label(value) : value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((id) => question.type === "ranking" ? label(id) : id).join("; ");
  if ("options" in value && Array.isArray(value.options)) return [...value.options.map((id) => label(id as string)), ...(typeof value.other === "string" ? [`Other: ${value.other}`] : [])].join("; ");
  if ("other" in value && typeof value.other === "string") return `Other: ${value.other}`;
  if ("name" in value) return [value.name, value.email, value.phone, value.company].filter(Boolean).join(", ");
  return Object.entries(value).map(([key, cell]) => `${key}: ${Array.isArray(cell) ? cell.join("/") : cell}`).join("; ");
}

/**
 * Every submitted response as CSV (UTF-8, CRLF), one column per question of the current set, oldest
 * first, at most 100 000 rows. `identity: false` leaves out respondent names and emails; `dayOnly`
 * writes the day only and orders rows by day then id (anonymous hosts, D1102).
 */
export function exportCsv(host: QuestionHost, filter: ResponseFilter = {}, options: { identity?: boolean } & ResponseReadOptions = {}): string {
  const set = currentSet(host)?.set;
  const questions = (set?.questions ?? []).filter((question) => QUESTION_TYPES[question.type].answers);
  const header = ["Submitted at", ...(options.identity === false ? [] : ["Respondent", "Email"]), "Score", ...questions.map((question) => question.title)];
  const lines = [header.map(csvCell).join(",")];
  const where = filterSql(host, filter);
  const rows = db.query(`SELECT r.* FROM responses r WHERE ${where.sql} ORDER BY ${SORT_AT(options.dayOnly)}, r.id LIMIT 100000`).all(where.params) as ResponseRow[];
  const sets = new Map<number, QuestionSet | null>();
  for (const row of rows) {
    if (!sets.has(row.set_version)) sets.set(row.set_version, setVersion(host, row.set_version));
    const summary = toSummary(row, sets.get(row.set_version)!);
    const who = row.respondent_user_id ? (db.query("SELECT display_name FROM users WHERE id = ?").get(row.respondent_user_id) as { display_name: string } | null)?.display_name ?? "Former member" : row.respondent_name ?? (row.respondent_kind === "anonymous" ? "Anonymous" : "");
    const cells = [options.dayOnly ? row.submitted_at.slice(0, 10) : row.submitted_at, ...(options.identity === false ? [] : [who, row.respondent_email ?? ""]), row.score ?? "", ...questions.map((question) => answerText(question, summary.answers[question.id]))];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
