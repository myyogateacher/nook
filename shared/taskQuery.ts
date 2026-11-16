/**
 * The task filter grammar (docs/plan/research/2026-09-26-task-hierarchy-workflows.md
 * §10.3, D137, D140–D145). One pure, dependency-free module shared by the server
 * (the `POST /api/tasks/query` compiler, saved views, MCP `query_cards`) and the
 * client (the Wave 13 board filter bar, the Tasks home, URL round-trips).
 *
 * A query is a list of terms separated by spaces. Terms AND together; the
 * values of one term OR together; a leading `-` negates a term.
 *
 *   assignee:me state:todo,doing due:overdue,week start:<2026-12-01
 *   board:<uuid> -state:done tag:"Needs design" "invoice"
 *
 * - `key:value[,value…]` filters one field. Values may be quoted (`"a b"`, with
 *   `\"` and `\\` escapes).
 * - A quoted phrase, or a bare word that is not `key:…`, is a text term: the
 *   card title or description excerpt contains it (case-insensitive, no
 *   wildcards).
 * - Keys and keyword values are case-insensitive; ids are UUIDs.
 *
 * `format` writes the canonical form: terms in a fixed key order (positive
 * before negated), values deduplicated and sorted, text always quoted. The
 * canonical form is what URLs (`?q=`), `task_views.query`, and MCP carry.
 *
 * The second half of the module is the structured card filter of Wave 13
 * (D113): `CardFilter` and the in-memory pipeline (`queryCards`, `sortCards`)
 * the client runs over a loaded board, which MCP `list_cards` mirrors in SQL
 * (`server/tasks/cardQuery.ts`). `cardFilterFromQuery` and
 * `queryFromCardFilter` translate between the two, so there is one grammar:
 * a board-scoped text query that fits the structured filter runs through the
 * board pipeline, and a structured filter always has a canonical text form.
 *
 * Nothing here touches the network, the DOM, or the database.
 */

export const TASK_QUERY_LIMITS = {
  /** Characters in a query string. */
  length: 2000,
  /** Terms in one query. */
  terms: 20,
  /** Values in one term. */
  values: 20,
  /** Characters in one text term. */
  text: 100,
  /** Characters in a tag name value (board tags are 1–40, WAVE_13 D109). */
  tagName: 40
} as const;

/** Keys in canonical order. */
/** The sort orders of a task query (POST /api/tasks/query, saved views, MCP, and the home's Sort menu). */
/** `priority` (D1316): Urgent first, then High, Medium, Low; cards without a priority last; ties by due date. */
export const QUERY_SORTS = ["due", "updated", "created", "title", "board", "start", "priority"] as const;
export type QuerySort = typeof QUERY_SORTS[number];

export const FILTER_KEYS = ["board", "state", "column", "assignee", "creator", "tag", "priority", "flag", "due", "start", "sprint", "parent", "level", "has", "text"] as const;
export type FilterKey = typeof FILTER_KEYS[number];

/**
 * Keys reserved for a later sub-wave parse as `FILTER_UNSUPPORTED`, so a query that uses them is
 * refused rather than silently widened. None today: `parent:` and `level:` shipped with 17A and
 * `sprint:` with 17B.
 */
export const RESERVED_FILTER_KEYS: readonly string[] = [];
/** How much of an unknown key an error message repeats back. */
const UNKNOWN_KEY_ECHO = 40;

/**
 * `sprint:` values (17B, D137): `current` is each board's active sprint, `next` its first planned
 * one, `none` no sprint (the backlog; `backlog` is read as `none`), or a sprint id. A card below the
 * work level has its parent's sprint.
 */
export const SPRINT_VALUES = ["current", "next", "none"] as const;

export const TASK_STATES = ["todo", "doing", "done"] as const;
export type TaskState = typeof TASK_STATES[number];
/**
 * The fixed card flag set (WAVE_13 D110), in display order. `urgent` left the set when it became a
 * priority (D1310, migration 123): see `LEGACY_URGENT_FLAG`.
 */
export const TASK_FLAGS = ["blocked", "needs_review", "on_hold"] as const;
export type TaskFlag = typeof TASK_FLAGS[number];
/**
 * A card's priority (D1310, migration 123), most pressing first: the display, sort, and filter order.
 * A card without one has `priority: null` (`priority:none` in the grammar).
 */
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];
export const isTaskPriority = (value: unknown): value is TaskPriority => typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
/** A priority's sort rank: 0 for Urgent to 3 for Low, 4 without one. */
export const priorityRank = (value: string | null | undefined) => {
  const index = value ? (TASK_PRIORITIES as readonly string[]).indexOf(value) : -1;
  return index < 0 ? TASK_PRIORITIES.length : index;
};
/**
 * Deprecated (D1312, D1313): the old Urgent flag. A write that sends it in `flags` sets the priority
 * to Urgent instead; a `flag:urgent` filter means `priority:urgent` (rewritten so when it stands
 * alone, and matched as the card's priority when it shares a term with other flags), so older links,
 * saved views, and integrations keep working.
 */
export const LEGACY_URGENT_FLAG = "urgent";
/** A `flag:` filter value: a flag, the legacy `urgent` (the Urgent priority), or `none`. */
export type FlagFilterValue = TaskFlag | typeof LEGACY_URGENT_FLAG | "none";
/**
 * `has:` values. `relation`: any visible relation; `blocked`: an open `depends_on` blocker; `subtasks`: live children (17A);
 * `estimate`: an estimate on a board with estimates on (lane ESTIMATES, D756).
 */
export const HAS_VALUES = ["relation", "blocked", "subtasks", "estimate"] as const;
const RESERVED_HAS_VALUES: readonly string[] = [];
/** `level:` values (17A, D137): a level number, or `work` for each board's work level. */
export const LEVEL_VALUES = ["work", "0", "1", "2"] as const;
/** Relative due keywords. `week` is today and the next six days; `next-week` the seven days after that. */
export const DUE_KEYWORDS = ["overdue", "today", "week", "next-week", "none"] as const;
/**
 * `start:` values (D722): the due keywords but `overdue`, and the same dates (`YYYY-MM-DD`,
 * `<YYYY-MM-DD`, `>YYYY-MM-DD`), over the card's civil `start_on`.
 */
export const START_KEYWORDS = ["today", "week", "next-week", "none"] as const;

export type FilterTerm = { key: FilterKey; negate: boolean; values: string[] };
export type TaskQuery = { terms: FilterTerm[] };

export type TaskQueryErrorCode = "FILTER_INVALID" | "FILTER_UNSUPPORTED" | "FILTER_SCOPE";
export type TaskQueryError = { code: TaskQueryErrorCode; message: string; position: number };
export type ParseResult = { ok: true; query: TaskQuery } | { ok: false; error: TaskQueryError };

export type ParseOptions = {
  /**
   * The query runs inside one board (the board page), so `column:` is valid on
   * its own. Otherwise `column:` needs exactly one positive `board:` value.
   */
  boardScoped?: boolean;
  /**
   * Skip invalid terms and values instead of failing (URL decoding: unknown
   * keys and bad values are dropped, WAVE_13 §4.6). Limits still apply by
   * truncation. Scope errors drop the `column:` terms.
   */
  lenient?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

// C0/C1 controls and bidi overrides never belong in a value (as for board and tag names).
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** A real calendar date `YYYY-MM-DD` between 1900 and 2999 (the card due date rule, T71). */
export function isQueryDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `date` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD. */
export function addQueryDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

class Fail extends Error {
  constructor(readonly code: TaskQueryErrorCode, message: string, readonly position: number) {
    super(message);
  }
}

/** The canonical value for `key`, or a Fail. `raw` is already unquoted. */
function normalizeValue(key: FilterKey, raw: string, position: number): string {
  const lower = raw.toLowerCase();
  const bad = (message: string) => new Fail("FILTER_INVALID", message, position);
  if (!raw) throw bad(`Give a value for ${key}:`);
  if (CONTROL.test(raw)) throw bad("Filters cannot contain control characters");
  switch (key) {
    case "board":
    case "column":
      if (!isUuid(raw)) throw bad(`${key}: takes an id`);
      return lower;
    case "assignee":
      if (lower === "me" || lower === "none") return lower;
      if (!isUuid(raw)) throw bad("assignee: takes me, none, or a user id");
      return lower;
    case "creator":
      if (lower === "me") return lower;
      if (!isUuid(raw)) throw bad("creator: takes me or a user id");
      return lower;
    case "state":
      if (!(TASK_STATES as readonly string[]).includes(lower)) throw bad("state: takes todo, doing, or done");
      return lower;
    case "flag":
      // `urgent` is the legacy flag (D1313): kept, and read as the Urgent priority.
      if (lower === "none" || lower === LEGACY_URGENT_FLAG || (TASK_FLAGS as readonly string[]).includes(lower)) return lower;
      throw bad(`flag: takes ${TASK_FLAGS.join(", ")}, or none`);
    case "priority":
      if (lower === "none" || (TASK_PRIORITIES as readonly string[]).includes(lower)) return lower;
      throw bad(`priority: takes ${TASK_PRIORITIES.join(", ")}, or none`);
    case "tag": {
      if (lower === "none") return lower;
      if (isUuid(raw)) return lower;
      const name = raw.trim();
      if (!name || name.length > TASK_QUERY_LIMITS.tagName) throw bad(`Tag names are 1 to ${TASK_QUERY_LIMITS.tagName} characters`);
      return name;
    }
    case "due": {
      if ((DUE_KEYWORDS as readonly string[]).includes(lower)) return lower;
      // Wave 13 URL spellings: before:D and after:D.
      const alias = /^(before|after):(.*)$/.exec(lower);
      const comparison = alias ? `${alias[1] === "before" ? "<" : ">"}${alias[2]}` : lower;
      const date = comparison.replace(/^[<>]/, "");
      if (!isQueryDate(date)) throw bad("due: takes overdue, today, week, next-week, none, or a date as YYYY-MM-DD, <YYYY-MM-DD, or >YYYY-MM-DD");
      return comparison;
    }
    case "start": {
      if ((START_KEYWORDS as readonly string[]).includes(lower)) return lower;
      const date = lower.replace(/^[<>]/, "");
      if (!isQueryDate(date)) throw bad("start: takes today, week, next-week, none, or a date as YYYY-MM-DD, <YYYY-MM-DD, or >YYYY-MM-DD");
      return lower;
    }
    case "parent":
      if (lower === "none") return lower;
      if (!isUuid(raw)) throw bad("parent: takes none or a card id");
      return lower;
    case "sprint":
      if (lower === "backlog") return "none";
      if ((SPRINT_VALUES as readonly string[]).includes(lower)) return lower;
      if (!isUuid(raw)) throw bad("sprint: takes current, next, none (backlog), or a sprint id");
      return lower;
    case "level":
      if ((LEVEL_VALUES as readonly string[]).includes(lower)) return lower;
      throw bad("level: takes work, 0, 1, or 2");
    case "has":
      if ((HAS_VALUES as readonly string[]).includes(lower)) return lower;
      if (RESERVED_HAS_VALUES.includes(lower)) throw new Fail("FILTER_UNSUPPORTED", `has:${lower} is not available yet`, position);
      throw bad(`has: takes ${HAS_VALUES.join(" or ")}`);
    case "text": {
      const text = raw.normalize("NFC").trim();
      if (!text) throw bad("Give some text to match");
      if (text.length > TASK_QUERY_LIMITS.text) throw bad(`Text filters are at most ${TASK_QUERY_LIMITS.text} characters`);
      return text;
    }
  }
}

/** Sort rank of a value within its key: keywords in declared order, then everything else. */
const KEYWORD_ORDER: Partial<Record<FilterKey, readonly string[]>> = {
  assignee: ["me", "none"],
  creator: ["me"],
  state: TASK_STATES,
  flag: [LEGACY_URGENT_FLAG, ...TASK_FLAGS, "none"],
  priority: [...TASK_PRIORITIES, "none"],
  tag: ["none"],
  due: DUE_KEYWORDS,
  start: START_KEYWORDS,
  parent: ["none"],
  sprint: SPRINT_VALUES,
  level: LEVEL_VALUES,
  has: HAS_VALUES
};

function compareValues(key: FilterKey, a: string, b: string) {
  const order = KEYWORD_ORDER[key] ?? [];
  const rank = (value: string) => {
    const index = order.indexOf(value);
    return index < 0 ? order.length : index;
  };
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  // Dates sort by date, then exact before < before >.
  if (key === "due" || key === "start") {
    const date = (value: string) => value.replace(/^[<>]/, "");
    const op = (value: string) => (value[0] === "<" ? 1 : value[0] === ">" ? 2 : 0);
    if (date(a) !== date(b)) return date(a) < date(b) ? -1 : 1;
    return op(a) - op(b);
  }
  const fold = (value: string) => value.toLowerCase();
  return fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Dedupes values (tag names case-insensitively) and sorts them canonically. */
function canonicalValues(key: FilterKey, values: readonly string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const identity = key === "tag" || key === "text" ? value.toLowerCase() : value;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(value);
  }
  return unique.sort((a, b) => compareValues(key, a, b));
}

const termOrder = (term: FilterTerm) => FILTER_KEYS.indexOf(term.key) * 2 + (term.negate ? 1 : 0);
const termText = (term: FilterTerm) => formatTerm(term);

/** Terms in canonical order, with exact duplicates removed. Values are canonical already. */
function canonicalTerms(terms: readonly FilterTerm[]) {
  const sorted = [...terms].sort((a, b) => termOrder(a) - termOrder(b) || (termText(a) < termText(b) ? -1 : termText(a) > termText(b) ? 1 : 0));
  const seen = new Set<string>();
  return sorted.filter((term) => {
    const text = termText(term);
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

const needsQuotes = (value: string) => value === "" || /[\s,"\\]/.test(value);
const quote = (value: string) => `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;

function formatTerm(term: FilterTerm) {
  const sign = term.negate ? "-" : "";
  if (term.key === "text") return `${sign}${quote(term.values[0] ?? "")}`;
  return `${sign}${term.key}:${term.values.map((value) => (needsQuotes(value) ? quote(value) : value)).join(",")}`;
}

/** The canonical string for a query. `parse(format(q))` gives back `q` in canonical form. */
export function format(query: TaskQuery): string {
  return canonicalTerms(query.terms.map((term) => ({ ...term, values: term.key === "text" ? term.values.slice(0, 1) : canonicalValues(term.key, term.values) })))
    .map(formatTerm).join(" ");
}

type RawTerm = { term: FilterTerm; position: number };

const isSpace = (character: string | undefined) => character !== undefined && /\s/.test(character);

/**
 * Parses a query string. Strict by default: the first problem returns
 * `{ok: false, error: {code, message, position}}`, where `position` is the
 * character offset of the problem.
 */
export function parse(input: string, options: ParseOptions = {}): ParseResult {
  const lenient = options.lenient === true;
  let source = input;
  if (source.length > TASK_QUERY_LIMITS.length) {
    if (!lenient) return { ok: false, error: { code: "FILTER_INVALID", message: `Filters are at most ${TASK_QUERY_LIMITS.length} characters`, position: TASK_QUERY_LIMITS.length } };
    source = source.slice(0, TASK_QUERY_LIMITS.length);
  }
  const terms: RawTerm[] = [];
  let index = 0;

  const readQuoted = () => {
    // At an opening quote; returns the unescaped text and moves past the closing quote.
    const start = index;
    index += 1;
    let text = "";
    while (index < source.length) {
      const character = source[index]!;
      if (character === "\\" && index + 1 < source.length) {
        text += source[index + 1];
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        return text;
      }
      text += character;
      index += 1;
    }
    throw new Fail("FILTER_INVALID", "Close the quote", start);
  };

  const skipTerm = () => {
    // Lenient recovery: jump to the next whitespace outside quotes.
    let quoted = false;
    while (index < source.length && (quoted || !isSpace(source[index]))) {
      if (source[index] === "\\" && quoted) index += 1;
      else if (source[index] === '"') quoted = !quoted;
      index += 1;
    }
  };

  while (index < source.length) {
    if (isSpace(source[index])) {
      index += 1;
      continue;
    }
    const start = index;
    try {
      let negate = false;
      if (source[index] === "-" && index + 1 < source.length && !isSpace(source[index + 1])) {
        negate = true;
        index += 1;
      }
      let term: FilterTerm;
      if (source[index] === '"') {
        const valueStart = index;
        const text = readQuoted();
        if (index < source.length && !isSpace(source[index])) throw new Fail("FILTER_INVALID", "Put a space after the quote", index);
        term = { key: "text", negate, values: [normalizeValue("text", text, valueStart)] };
      } else {
        const keyMatch = /^([A-Za-z][A-Za-z_-]*):/.exec(source.slice(index));
        if (!keyMatch) {
          // A bare word is text.
          const wordStart = index;
          while (index < source.length && !isSpace(source[index])) {
            if (source[index] === '"') throw new Fail("FILTER_INVALID", "Quote the whole phrase", index);
            index += 1;
          }
          term = { key: "text", negate, values: [normalizeValue("text", source.slice(wordStart, index), wordStart)] };
        } else {
          const keyName = keyMatch[1]!.toLowerCase();
          if ((RESERVED_FILTER_KEYS as readonly string[]).includes(keyName)) throw new Fail("FILTER_UNSUPPORTED", `${keyName}: is not available yet`, index);
          if (!(FILTER_KEYS as readonly string[]).includes(keyName) || keyName === "text") throw new Fail("FILTER_INVALID", `Unknown filter ${keyName.length > UNKNOWN_KEY_ECHO ? `${keyName.slice(0, UNKNOWN_KEY_ECHO)}…` : keyName}:`, index);
          const key = keyName as FilterKey;
          index += keyMatch[0].length;
          const values: string[] = [];
          for (;;) {
            const valueStart = index;
            let raw: string;
            if (source[index] === '"') raw = readQuoted();
            else {
              while (index < source.length && !isSpace(source[index]) && source[index] !== ",") {
                if (source[index] === '"') throw new Fail("FILTER_INVALID", "Quote the whole value", index);
                index += 1;
              }
              raw = source.slice(valueStart, index);
            }
            try {
              values.push(normalizeValue(key, raw, valueStart));
            } catch (error) {
              if (!lenient || !(error instanceof Fail)) throw error;
            }
            if (values.length > TASK_QUERY_LIMITS.values) {
              if (!lenient) throw new Fail("FILTER_INVALID", `A filter takes at most ${TASK_QUERY_LIMITS.values} values`, valueStart);
              values.length = TASK_QUERY_LIMITS.values;
            }
            if (source[index] === ",") {
              index += 1;
              continue;
            }
            if (index < source.length && !isSpace(source[index])) throw new Fail("FILTER_INVALID", "Separate values with commas", index);
            break;
          }
          if (!values.length) throw new Fail("FILTER_INVALID", `Give a value for ${key}:`, start);
          term = legacyUrgentTerm({ key, negate, values: canonicalValues(key, values) });
        }
      }
      if (terms.length >= TASK_QUERY_LIMITS.terms) {
        if (!lenient) throw new Fail("FILTER_INVALID", `Use at most ${TASK_QUERY_LIMITS.terms} filters`, start);
        break;
      }
      terms.push({ term, position: start });
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      if (!lenient) return { ok: false, error: { code: error.code, message: error.message, position: error.position } };
      index = Math.max(index, start + 1);
      skipTerm();
    }
  }

  const scope = scopeProblem(terms, options.boardScoped === true);
  if (scope) {
    if (!lenient) return { ok: false, error: scope };
    return { ok: true, query: { terms: canonicalTerms(terms.filter((raw) => raw.term.key !== "column").map((raw) => raw.term)) } };
  }
  return { ok: true, query: { terms: canonicalTerms(terms.map((raw) => raw.term)) } };
}

/**
 * `flag:urgent` alone is `priority:urgent` (D1313), negated or not, so a pre-priority link or saved
 * view reads in today's words. Mixed with other flags (`flag:blocked,urgent`: blocked or urgent) it
 * stays a flag term, since one term cannot OR two keys; the matchers read its `urgent` as the priority.
 */
function legacyUrgentTerm(term: FilterTerm): FilterTerm {
  return term.key === "flag" && term.values.length === 1 && term.values[0] === LEGACY_URGENT_FLAG ? { key: "priority", negate: term.negate, values: ["urgent"] } : term;
}

/** `column:` needs one board: the board page, or exactly one positive `board:` value (§10.3 scope rules). */
function scopeProblem(terms: readonly RawTerm[], boardScoped: boolean): TaskQueryError | null {
  const column = terms.find((raw) => raw.term.key === "column");
  if (!column || boardScoped) return null;
  const boards = terms.filter((raw) => raw.term.key === "board" && !raw.term.negate);
  if (boards.length === 1 && boards[0]!.term.values.length === 1) return null;
  return { code: "FILTER_SCOPE", message: "Filter by one board to filter by column", position: column.position };
}

/** The single board a query is scoped to (exactly one positive `board:` value), or null. */
export function scopedBoardId(query: TaskQuery): string | null {
  const boards = query.terms.filter((term) => term.key === "board" && !term.negate);
  return boards.length === 1 && boards[0]!.values.length === 1 ? boards[0]!.values[0]! : null;
}

/** Parses and re-formats: the canonical string, or the error. */
export function canonicalize(input: string, options: ParseOptions = {}): { ok: true; query: string } | { ok: false; error: TaskQueryError } {
  const parsed = parse(input, options);
  return parsed.ok ? { ok: true, query: format(parsed.query) } : parsed;
}

/**
 * Re-validates a query built in code (for example by the filter bar's pills)
 * by formatting and parsing it again, so a hand-built AST obeys the same
 * limits and value rules as typed text.
 */
export function validateQuery(query: TaskQuery, options: ParseOptions = {}): ParseResult {
  return parse(format(query), options);
}

// ---------------------------------------------------------------------------
// Due windows. The server compiles these to SQL and the client can filter a
// loaded board with them, so both agree on what "week" means.

export type DueWindow =
  | { kind: "none" }
  | { kind: "overdue"; before: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "before"; date: string }
  | { kind: "after"; date: string };

/**
 * What a canonical `due:` value means given the viewer's `today` (YYYY-MM-DD).
 * `overdue` is a due date before today; a timed card due today also counts
 * once its wall time has passed (the server compares against the viewer's
 * current wall time, approximate across zones as Today accepts, §5.1).
 */
export function dueWindow(value: string, today: string): DueWindow {
  switch (value) {
    case "none": return { kind: "none" };
    case "overdue": return { kind: "overdue", before: today };
    case "today": return { kind: "range", from: today, to: today };
    case "week": return { kind: "range", from: today, to: addQueryDays(today, 6) };
    case "next-week": return { kind: "range", from: addQueryDays(today, 7), to: addQueryDays(today, 13) };
  }
  if (value.startsWith("<")) return { kind: "before", date: value.slice(1) };
  if (value.startsWith(">")) return { kind: "after", date: value.slice(1) };
  return { kind: "range", from: value, to: value };
}

// ---------------------------------------------------------------------------
// URL codec. `?q=` carries the canonical grammar. The Wave 13 per-key
// parameters (§4.6: assignee, tag, flag, due, column, rel, plus board and
// state) are still read, so older links keep working; they are never written.

/** Every query parameter this codec owns. Callers keep the others (view, layout, group, sort, …). */
export const FILTER_PARAM_KEYS = ["q", "board", "state", "column", "assignee", "creator", "tag", "flag", "due", "has", "rel"] as const;

const LEGACY_PARAM_KEYS = ["board", "state", "column", "assignee", "creator", "tag", "flag", "due", "has"] as const;

type ParamsLike = { getAll(name: string): string[] };

/**
 * Decodes filters from URL parameters, leniently: unknown keys and invalid
 * values are dropped, limits truncate. Values of one legacy key OR together,
 * whether repeated or comma-separated, and AND with the `q` terms.
 */
export function decodeFilterParams(params: ParamsLike, options: Omit<ParseOptions, "lenient"> = {}): TaskQuery {
  const pieces: string[] = [];
  for (const q of params.getAll("q")) pieces.push(q);
  for (const key of LEGACY_PARAM_KEYS) {
    const values = params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    if (values.length) pieces.push(`${key}:${values.map((value) => (needsQuotes(value) ? quote(value) : value)).join(",")}`);
  }
  for (const rel of params.getAll("rel").flatMap((value) => value.split(","))) {
    const value = rel.trim().toLowerCase();
    if (value === "any") pieces.push("has:relation");
    else if (value === "none") pieces.push("-has:relation");
    else if (value === "blocked") pieces.push("has:blocked");
  }
  const parsed = parse(pieces.join(" "), { ...options, lenient: true });
  return parsed.ok ? parsed.query : { terms: [] };
}

/** Writes the filters into `params` as one canonical `q`, removing every other filter key. */
export function encodeFilterParams(query: TaskQuery, params: URLSearchParams = new URLSearchParams()) {
  for (const key of FILTER_PARAM_KEYS) params.delete(key);
  const text = format(query);
  if (text) params.set("q", text);
  return params;
}

// ---------------------------------------------------------------------------
// Structured card filter and the board pipeline (WAVE_13_TASK_CARD_UX.md D113,
// §4.5, §5.5; 13C). This is the client-side approach of D113: the board JSON
// already holds every live card, so the client filters it in memory with
// `queryCards`. MCP `list_cards` filters on the server with bound SQL
// (`server/tasks/cardQuery.ts`), and a parity test runs both over one fixture.
//
// Semantics (Linear-style, §4.6): values inside one field are OR-ed, fields
// are AND-ed, and an empty or missing field does not filter.
// - `assignees`: user ids, `me` (the viewer), or `none` (no assignee).
// - `tags`: tag ids, or `none` (no tag). An id no card carries matches nothing.
// - `flags`: flags from the fixed set, or `none` (no flag); the legacy `urgent` is the Urgent priority.
// - `priorities`: urgent, high, medium, low, or `none` (no priority; D1315).
// - `due`: `before`/`after` are exclusive bounds on `due_on` (the civil date
//   in the card's zone) and are AND-ed into one range over dated cards;
//   `none` adds cards without a date. `{ none: true }` alone means undated
//   cards only. Relative windows (overdue, today, week) are grammar-only
//   (`dueWindow`), since they need the viewer's zone.
// - `columns`: column ids.
// - `text`: 1–100 characters, matched as a substring of the title and the
//   description excerpt, ignoring case and accents.

export const QUERY_LIMITS = { values: 30, textMax: 100 } as const;

/** The card fields the query reads; `CardSummary` from `GET /boards/:b` satisfies it. */
export type QueryCard = {
  id: string;
  column_id: string;
  position: number;
  title: string;
  description_excerpt: string;
  due_on: string | null;
  assignees: ReadonlyArray<{ id: string }>;
  tag_ids: readonly string[];
  flags: readonly string[];
  /** The card's priority (D1310); null, or absent in an older payload, without one. */
  priority?: string | null;
  created_at: string;
  updated_at: string;
};
export type QueryColumn = { id: string; position: number };

export type CardFilter = {
  assignees?: readonly string[];
  tags?: readonly string[];
  /** Flags, or `none`; the legacy `urgent` matches the Urgent priority (D1313). */
  flags?: ReadonlyArray<FlagFilterValue>;
  /** Priorities (D1315), or `none` for cards without one. */
  priorities?: ReadonlyArray<TaskPriority | "none">;
  due?: { before?: string; after?: string; none?: boolean };
  columns?: readonly string[];
  text?: string;
};

export const CARD_SORT_KEYS = ["board", "due", "title", "created", "updated", "priority"] as const;
export type CardSortKey = typeof CARD_SORT_KEYS[number];
export type CardSort = { key: CardSortKey; direction: "asc" | "desc" };

export type QueryContext = { userId: string };

/** A filter with `me` resolved, ids lower-cased and deduplicated, and `none` split out. */
export type NormalizedFilter = {
  assignees: { ids: string[]; none: boolean } | null;
  tags: { ids: string[]; none: boolean } | null;
  /** `urgent`: the legacy flag was asked for, so cards with the Urgent priority match too (D1313). */
  flags: { values: TaskFlag[]; none: boolean; urgent: boolean } | null;
  priorities: { values: TaskPriority[]; none: boolean } | null;
  due: { before: string | null; after: string | null; none: boolean } | null;
  columns: string[] | null;
  text: string | null;
};

function idSet(values: readonly string[] | undefined, me?: string) {
  if (!values?.length) return null;
  const ids = new Set<string>();
  let none = false;
  for (const value of values) {
    if (value === "none") none = true;
    else ids.add(value === "me" && me ? me.toLowerCase() : value.toLowerCase());
  }
  return { ids: [...ids], none };
}

/** Case- and accent-folded text for matching: NFKD, combining marks removed, lower case. */
export function foldText(value: string) {
  return value.normalize("NFKD").replace(/\p{Mn}/gu, "").toLowerCase();
}

export function normalizeFilter(filter: CardFilter, context: QueryContext): NormalizedFilter {
  const flags = filter.flags?.length
    ? { values: TASK_FLAGS.filter((flag) => filter.flags!.includes(flag)), none: filter.flags.includes("none"), urgent: filter.flags.includes(LEGACY_URGENT_FLAG) }
    : null;
  const priorities = filter.priorities?.length
    ? { values: TASK_PRIORITIES.filter((priority) => filter.priorities!.includes(priority)), none: filter.priorities.includes("none") }
    : null;
  const due = filter.due && (filter.due.before || filter.due.after || filter.due.none)
    ? { before: filter.due.before ?? null, after: filter.due.after ?? null, none: filter.due.none === true }
    : null;
  const text = filter.text?.trim() ? foldText(filter.text.trim()) : null;
  return {
    assignees: idSet(filter.assignees, context.userId),
    tags: idSet(filter.tags),
    flags,
    priorities,
    due,
    columns: filter.columns?.length ? [...new Set(filter.columns.map((id) => id.toLowerCase()))] : null,
    text
  };
}

const anyOf = (set: { ids: string[]; none: boolean }, present: readonly string[]) =>
  (set.none && present.length === 0) || present.some((value) => set.ids.includes(value));

/** Whether a card's title or excerpt contains the folded text. */
export function matchesText(card: Pick<QueryCard, "title" | "description_excerpt">, foldedText: string) {
  return foldText(card.title).includes(foldedText) || foldText(card.description_excerpt).includes(foldedText);
}

/** The due clause: a range over dated cards (both bounds exclusive), OR undated cards when `none`. */
function matchesDue(due: NonNullable<NormalizedFilter["due"]>, dueOn: string | null) {
  if (dueOn === null) return due.none;
  if (due.before === null && due.after === null) return false;
  return (due.before === null || dueOn < due.before) && (due.after === null || dueOn > due.after);
}

export function matchesCard(card: QueryCard, filter: NormalizedFilter) {
  if (filter.columns && !filter.columns.includes(card.column_id)) return false;
  if (filter.assignees && !anyOf(filter.assignees, card.assignees.map((assignee) => assignee.id))) return false;
  if (filter.tags && !anyOf(filter.tags, card.tag_ids)) return false;
  if (filter.flags && !((filter.flags.none && card.flags.length === 0) || card.flags.some((flag) => (filter.flags!.values as readonly string[]).includes(flag))
    || (filter.flags.urgent && card.priority === "urgent"))) return false;
  if (filter.priorities && !(card.priority ? (filter.priorities.values as readonly string[]).includes(card.priority) : filter.priorities.none)) return false;
  if (filter.due && !matchesDue(filter.due, card.due_on)) return false;
  if (filter.text !== null && !matchesText(card, filter.text)) return false;
  return true;
}

/**
 * Stable sort. `board` is column position, then card position, then id (the
 * board and `list_cards` order). Other keys tie-break on that board order;
 * cards without a due date sort last in both directions.
 */
export function sortCards<T extends QueryCard>(cards: readonly T[], columns: readonly QueryColumn[], sort: CardSort = { key: "board", direction: "asc" }) {
  const columnPosition = new Map(columns.map((column) => [column.id, column.position]));
  const board = (a: T, b: T) => ((columnPosition.get(a.column_id) ?? Infinity) - (columnPosition.get(b.column_id) ?? Infinity))
    || (a.position - b.position) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sign = sort.direction === "desc" ? -1 : 1;
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const byKey: Record<CardSortKey, (a: T, b: T) => number> = {
    board: (a, b) => sign * board(a, b),
    due: (a, b) => {
      if (a.due_on === b.due_on) return board(a, b);
      if (a.due_on === null) return 1;
      if (b.due_on === null) return -1;
      return sign * compare(a.due_on, b.due_on) || board(a, b);
    },
    title: (a, b) => sign * foldText(a.title).localeCompare(foldText(b.title)) || board(a, b),
    created: (a, b) => sign * compare(a.created_at, b.created_at) || board(a, b),
    updated: (a, b) => sign * compare(a.updated_at, b.updated_at) || board(a, b),
    // D1316: Urgent first ascending; cards without a priority sort last both ways, like an empty due date.
    priority: (a, b) => {
      const left = priorityRank(a.priority);
      const right = priorityRank(b.priority);
      if (left === right) return board(a, b);
      if (left === TASK_PRIORITIES.length) return 1;
      if (right === TASK_PRIORITIES.length) return -1;
      return sign * (left - right) || board(a, b);
    }
  };
  return [...cards].sort(byKey[sort.key]);
}

/** Filters, then sorts: the whole client-side pipeline over a board's cards. */
export function queryCards<T extends QueryCard>(cards: readonly T[], columns: readonly QueryColumn[], filter: CardFilter, context: QueryContext, sort?: CardSort) {
  const normalized = normalizeFilter(filter, context);
  return sortCards(cards.filter((card) => matchesCard(card, normalized)), columns, sort);
}

// ---------------------------------------------------------------------------
// Bridges between the grammar and the structured filter.

/** The canonical grammar for a structured filter: `format(queryFromCardFilter(f))` is what a URL or a saved view carries. */
export function queryFromCardFilter(filter: CardFilter): TaskQuery {
  const terms: FilterTerm[] = [];
  const add = (key: FilterKey, values: readonly string[] | undefined) => {
    if (values?.length) terms.push({ key, negate: false, values: [...values] });
  };
  add("column", filter.columns);
  add("assignee", filter.assignees);
  add("tag", filter.tags);
  add("priority", filter.priorities);
  add("flag", filter.flags);
  const due = filter.due;
  if (due && (due.before || due.after || due.none)) {
    const none = due.none ? ["none"] : [];
    if (due.before) terms.push({ key: "due", negate: false, values: [`<${due.before}`, ...none] });
    if (due.after) terms.push({ key: "due", negate: false, values: [`>${due.after}`, ...none] });
    if (!due.before && !due.after) terms.push({ key: "due", negate: false, values: ["none"] });
  }
  const text = filter.text?.trim();
  if (text) terms.push({ key: "text", negate: false, values: [text] });
  const parsed = validateQuery({ terms }, { boardScoped: true, lenient: true });
  return parsed.ok ? parsed.query : { terms: [] };
}

/**
 * The structured filter for a board-scoped query, or null when the query uses
 * something the board pipeline does not model (negation, `board:`, `state:`,
 * `creator:`, `has:`, tag names, relative due windows, or more than one term
 * of a key). Callers with null run the query on the server
 * (`POST /api/tasks/query` with the board's `board:` term).
 */
export function cardFilterFromQuery(query: TaskQuery): CardFilter | null {
  const filter: CardFilter = {};
  const seen = new Set<FilterKey>();
  const dueTerms: string[][] = [];
  for (const term of query.terms) {
    if (term.negate) return null;
    if (term.key === "due") {
      dueTerms.push(term.values);
      continue;
    }
    if (seen.has(term.key)) return null;
    seen.add(term.key);
    switch (term.key) {
      case "column": filter.columns = term.values; break;
      case "assignee": filter.assignees = term.values; break;
      case "tag":
        if (!term.values.every((value) => value === "none" || isUuid(value))) return null;
        filter.tags = term.values;
        break;
      case "flag": filter.flags = term.values as FlagFilterValue[]; break;
      case "priority": filter.priorities = term.values as Array<TaskPriority | "none">; break;
      case "text": filter.text = term.values[0]; break;
      default: return null;
    }
  }
  if (dueTerms.length) {
    const due = dueFromTerms(dueTerms);
    if (!due) return null;
    filter.due = due;
  }
  return filter;
}

/**
 * The inverse of the `due` part of `queryFromCardFilter`: `due:none` alone, or
 * one `<before` and/or one `>after` term, each with the same optional `none`
 * (`(<b OR none) AND (>a OR none)` is the structured `(range) OR undated`).
 */
function dueFromTerms(terms: readonly string[][]): CardFilter["due"] | null {
  if (terms.length === 1 && terms[0]!.length === 1 && terms[0]![0] === "none") return { none: true };
  let before: string | undefined;
  let after: string | undefined;
  let none: boolean | undefined;
  for (const values of terms) {
    const bounds = values.filter((value) => value !== "none");
    const withNone = bounds.length !== values.length;
    if (bounds.length !== 1 || (none !== undefined && none !== withNone)) return null;
    none = withNone;
    const bound = bounds[0]!;
    if (bound.startsWith("<") && before === undefined) before = bound.slice(1);
    else if (bound.startsWith(">") && after === undefined) after = bound.slice(1);
    else return null;
  }
  return { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(none ? { none: true } : {}) };
}

// ---------------------------------------------------------------------------
// In-memory evaluation of the grammar over a loaded board (13E, D113). The
// board views filter the board JSON on the client. A query `cardFilterFromQuery`
// models runs through `queryCards`; anything else (negation, relative due
// windows, `has:`, tag names, `state:`, `creator:`) runs through
// `matchesQuery`, which mirrors the server compiler (`server/tasks/query.ts`)
// term by term: values OR, terms AND, `-` negates, and dates compare the
// card's civil `due_on`. One refinement: a timed card is overdue once its exact
// instant (`due_at`) has passed, where the server compares wall times.

/** The card fields `matchesQuery` reads beyond `QueryCard` (all in the board JSON). */
export type MemoryQueryCard = QueryCard & {
  board_id?: string;
  created_by?: string | null;
  due_time?: string | null;
  due_at?: string | null;
  /** The optional start's civil date (D720), for `start:`. */
  start_on?: string | null;
  relation_count?: number;
  open_blockers?: number;
  /** Hierarchy (17A): the parent on the same board, the level, and live direct children. */
  parent_card_id?: string | null;
  level?: number;
  child_count?: number;
  /** The card's sprint (17B): stored on the work level, the parent's below it, null in the backlog. */
  sprint_id?: string | null;
  /** Lane ESTIMATES (D756): null without one, and on a board with estimates off (the server sends null then). */
  estimate?: number | null;
};

export type MemoryQueryContext = {
  /** The board's work level, for `level:work` (17A); 0 when unknown. */
  workLevel?: number;
  /** The board's active sprint and first planned sprint, for `sprint:current` and `sprint:next` (17B). */
  sprints?: { current: string | null; next: string | null };
  userId: string;
  /** The viewer's local date, YYYY-MM-DD, for the relative due windows. */
  today: string;
  /** The viewer's clock in ms, for timed overdue cards. */
  now?: number;
  /** The board's tags, to match `tag:` names (case-insensitively). */
  tags?: ReadonlyArray<{ id: string; name: string }>;
  /** Each column's state (migration 020); a column missing here counts as `doing`. */
  columnStates?: Readonly<Record<string, TaskState>>;
};

function matchesDueValue(card: MemoryQueryCard, value: string, context: MemoryQueryContext) {
  const window = dueWindow(value, context.today);
  const due = card.due_on;
  if (window.kind === "none") return due === null;
  if (due === null) return false;
  switch (window.kind) {
    case "overdue": {
      const at = card.due_time && card.due_at ? Date.parse(card.due_at) : Number.NaN;
      return Number.isFinite(at) ? at <= (context.now ?? Date.now()) : due < window.before;
    }
    case "range": return due >= window.from && due <= window.to;
    case "before": return due < window.date;
    case "after": return due > window.date;
  }
}

/** A `start:` value over the card's civil `start_on` (D722), as `dueWindow` reads the due keywords. */
function matchesStartValue(card: MemoryQueryCard, value: string, context: MemoryQueryContext) {
  const window = dueWindow(value, context.today);
  const start = card.start_on ?? null;
  if (window.kind === "none") return start === null;
  if (start === null) return false;
  switch (window.kind) {
    case "overdue": return false;
    case "range": return start >= window.from && start <= window.to;
    case "before": return start < window.date;
    case "after": return start > window.date;
  }
}

function matchesTerm(card: MemoryQueryCard, term: FilterTerm, context: MemoryQueryContext) {
  const values = term.values;
  const user = (value: string) => value === "me" ? context.userId.toLowerCase() : value;
  switch (term.key) {
    case "board": return card.board_id !== undefined && values.includes(card.board_id);
    case "column": return values.includes(card.column_id);
    case "state": return values.includes(context.columnStates?.[card.column_id] ?? "doing");
    case "creator": return !!card.created_by && values.map(user).includes(card.created_by);
    case "assignee": {
      const ids = card.assignees.map((assignee) => assignee.id);
      return (values.includes("none") && ids.length === 0) || values.filter((value) => value !== "none").map(user).some((value) => ids.includes(value));
    }
    case "tag": {
      if (values.includes("none") && card.tag_ids.length === 0) return true;
      const names = values.filter((value) => value !== "none" && !isUuid(value)).map((value) => value.toLowerCase());
      const ids = new Set(values.filter(isUuid));
      for (const tag of context.tags ?? []) if (names.includes(tag.name.toLowerCase())) ids.add(tag.id);
      return card.tag_ids.some((id) => ids.has(id));
    }
    case "flag": return (values.includes("none") && card.flags.length === 0) || card.flags.some((flag) => values.includes(flag))
      || (values.includes(LEGACY_URGENT_FLAG) && card.priority === "urgent");
    case "priority": return card.priority ? values.includes(card.priority) : values.includes("none");
    case "due": return values.some((value) => matchesDueValue(card, value, context));
    case "start": return values.some((value) => matchesStartValue(card, value, context));
    case "parent": return (values.includes("none") && !card.parent_card_id) || (!!card.parent_card_id && values.includes(card.parent_card_id));
    case "sprint": {
      const sprint = card.sprint_id ?? null;
      return values.some((value) => {
        if (value === "none") return sprint === null;
        if (value === "current" || value === "next") {
          const resolved = context.sprints?.[value] ?? null;
          return resolved !== null && sprint === resolved;
        }
        return sprint === value;
      });
    }
    case "level": return values.some((value) => (value === "work" ? context.workLevel ?? 0 : Number(value)) === (card.level ?? 0));
    case "has": return values.some((value) => value === "blocked" ? (card.open_blockers ?? 0) > 0
      : value === "subtasks" ? (card.child_count ?? 0) > 0 : value === "estimate" ? card.estimate !== null && card.estimate !== undefined : (card.relation_count ?? 0) > 0);
    case "text": return matchesText(card, foldText(values[0] ?? ""));
  }
}

/** Whether a loaded card matches a parsed query (every term, negated terms inverted). */
export function matchesQuery(card: MemoryQueryCard, query: TaskQuery, context: MemoryQueryContext) {
  return query.terms.every((term) => matchesTerm(card, term, context) !== term.negate);
}
