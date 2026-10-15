import { lex, type Token } from "./sqlGuard";

/**
 * A rough reading of a report query's outermost SELECT (for the sanity checks and the metric catalog,
 * never for security: the guard decides what may run). From the guard's own lexer: the select list
 * (each expression with its alias), the FROM clause's tables and joins (alias, FINAL, join keys), and
 * whether the query ends in a LIMIT. Anything it cannot read comes back empty rather than wrong.
 */

export type SelectItem = { alias: string; expr: string };
export type TableUse = { db: string | null; name: string; alias: string | null; final: boolean };
export type JoinUse = TableUse & { kind: string; keys: Array<{ own: string; other: string; otherAlias: string | null }>; subquery: boolean };
export type QueryShape = { items: SelectItem[]; from: TableUse | null; fromSubquery: boolean; joins: JoinUse[]; where: string; groupBy: string; limited: boolean };

const CLAUSE_END = new Set(["where", "group", "order", "limit", "having", "union", "settings", "window", "qualify", "prewhere", "format", "into"]);
const JOIN_WORDS = new Set(["left", "right", "inner", "full", "outer", "cross", "any", "all", "semi", "anti", "asof", "global", "paste", "array"]);

type Depthed = Token & { depth: number };

function withDepth(tokens: readonly Token[]): Depthed[] {
  let depth = 0;
  return tokens.map((token) => {
    if (token.kind === "punct" && token.text === ")") depth -= 1;
    const out = { ...token, depth };
    if (token.kind === "punct" && token.text === "(") depth += 1;
    return out;
  });
}

const word = (token: Token | undefined, value: string) => token?.kind === "word" && token.value === value;
const nameOf = (token: Token | undefined) => token ? token.kind === "quoted" ? token.value : token.kind === "word" ? token.text : null : null;

/** Normalised expression text: one space, lower case outside strings (for comparing two expressions). */
export function normaliseExpr(expr: string): string {
  try {
    return lex(expr, { params: true }).tokens.map((token) => token.kind === "string" ? token.text : token.kind === "quoted" ? token.value.toLowerCase() : token.value).join(" ")
      .replace(/ ?([(),.]) ?/g, "$1").trim();
  } catch {
    return expr.replace(/\s+/g, " ").trim().toLowerCase();
  }
}

export function queryShape(sql: string): QueryShape {
  const empty: QueryShape = { items: [], from: null, fromSubquery: false, joins: [], where: "", groupBy: "", limited: false };
  let tokens: Depthed[];
  try {
    tokens = withDepth(lex(sql, { params: true }).tokens);
  } catch {
    return empty;
  }
  const select = tokens.findIndex((token) => token.depth === 0 && word(token, "select"));
  if (select < 0) return empty;
  const fromAt = tokens.findIndex((token, index) => index > select && token.depth === 0 && word(token, "from"));
  const listEnd = fromAt < 0 ? tokens.length : fromAt;
  const items: SelectItem[] = [];
  let start = select + 1;
  if (word(tokens[start], "distinct")) start += 1;
  const pushItem = (from: number, to: number) => {
    if (to <= from) return;
    const part = tokens.slice(from, to);
    const asAt = part.map((token, index) => token.depth === 0 && word(token, "as") ? index : -1).filter((index) => index >= 0).pop();
    const exprTokens = asAt !== undefined && asAt > 0 ? part.slice(0, asAt) : part;
    const expr = sql.slice(exprTokens[0]!.start, exprTokens.at(-1)!.end);
    const alias = asAt !== undefined && part[asAt + 1] ? nameOf(part[asAt + 1]) ?? expr : part.length === 1 ? nameOf(part[0]) ?? expr : part.length === 3 && part[1]!.text === "." ? nameOf(part[2]) ?? expr : expr;
    items.push({ alias, expr });
  };
  for (let index = start; index < listEnd; index += 1) {
    if (tokens[index]!.depth === 0 && tokens[index]!.kind === "punct" && tokens[index]!.text === ",") { pushItem(start, index); start = index + 1; }
  }
  pushItem(start, listEnd);
  if (fromAt < 0) return { ...empty, items };

  let at = fromAt + 1;
  const readTable = (): (TableUse & { subquery: boolean }) | null => {
    let subquery = false;
    let db: string | null = null;
    let name = "";
    const token = tokens[at];
    if (!token) return null;
    if (token.kind === "punct" && token.text === "(") {
      subquery = true;
      const close = tokens.findIndex((item, index) => index > at && item.depth === 0 && item.kind === "punct" && item.text === ")");
      if (close < 0) return null;
      at = close + 1;
    } else {
      const first = nameOf(token);
      if (!first) return null;
      at += 1;
      if (tokens[at]?.text === "." && nameOf(tokens[at + 1])) { db = first; name = nameOf(tokens[at + 1])!; at += 2; } else name = first;
      if (tokens[at]?.text === "(") return null; // a table function
    }
    let alias: string | null = null;
    if (word(tokens[at], "as")) { alias = nameOf(tokens[at + 1]); at += 2; }
    else if (tokens[at] && (tokens[at]!.kind === "word" || tokens[at]!.kind === "quoted") && !CLAUSE_END.has(tokens[at]!.value) && !JOIN_WORDS.has(tokens[at]!.value) && !["final", "join", "on", "using", "sample"].includes(tokens[at]!.value)) { alias = nameOf(tokens[at]); at += 1; }
    let final = false;
    if (word(tokens[at], "final")) { final = true; at += 1; }
    return { db, name, alias, final, subquery };
  };
  const first = readTable();
  const joins: JoinUse[] = [];
  for (;;) {
    const token = tokens[at];
    if (!token || token.depth !== 0 || (token.kind === "word" && CLAUSE_END.has(token.value))) break;
    if (token.kind === "punct" && token.text === ",") { at += 1; const table = readTable(); if (!table) break; joins.push({ ...table, kind: "cross", keys: [] }); continue; }
    const kindWords: string[] = [];
    while (tokens[at] && tokens[at]!.kind === "word" && JOIN_WORDS.has(tokens[at]!.value)) { kindWords.push(tokens[at]!.value); at += 1; }
    if (!word(tokens[at], "join")) { at += 1; continue; }
    at += 1;
    const table = readTable();
    if (!table) break;
    const keys: JoinUse["keys"] = [];
    if (word(tokens[at], "using")) {
      at += 1;
      const open = tokens[at]?.text === "(";
      if (open) at += 1;
      const isName = (token: Depthed | undefined) => token !== undefined && (token.kind === "quoted" || (token.kind === "word" && !CLAUSE_END.has(token.value) && !JOIN_WORDS.has(token.value) && token.value !== "join"));
      while (tokens[at] && (isName(tokens[at]) || (tokens[at]!.text === "," && (open || isName(tokens[at + 1]))))) {
        if (tokens[at]!.text !== ",") keys.push({ own: nameOf(tokens[at])!, other: nameOf(tokens[at])!, otherAlias: null });
        at += 1;
      }
      if (open && tokens[at]?.text === ")") at += 1;
    } else if (word(tokens[at], "on")) {
      const begin = at + 1;
      let end = begin;
      while (tokens[end] && !(tokens[end]!.depth === 0 && tokens[end]!.kind === "word" && (CLAUSE_END.has(tokens[end]!.value) || tokens[end]!.value === "join" || JOIN_WORDS.has(tokens[end]!.value)))) end += 1;
      const condition = tokens.slice(begin, end);
      for (let index = 0; index < condition.length; index += 1) {
        if (condition[index]!.text !== "=") continue;
        const left = condition.slice(Math.max(0, index - 3), index);
        const right = condition.slice(index + 1, index + 4);
        const side = (part: Token[], leftSide: boolean): { alias: string | null; column: string } | null => {
          const ordered = leftSide ? part : part;
          if (leftSide) {
            if (ordered.length >= 3 && ordered[ordered.length - 2]!.text === "." ) return { alias: nameOf(ordered[ordered.length - 3]), column: nameOf(ordered[ordered.length - 1])! };
            const last = ordered.at(-1);
            return last && (last.kind === "word" || last.kind === "quoted") ? { alias: null, column: nameOf(last)! } : null;
          }
          if (ordered.length >= 3 && ordered[1]!.text === ".") return { alias: nameOf(ordered[0]), column: nameOf(ordered[2])! };
          return ordered[0] && (ordered[0].kind === "word" || ordered[0].kind === "quoted") ? { alias: null, column: nameOf(ordered[0])! } : null;
        };
        const a = side(left, true);
        const b = side(right, false);
        if (!a || !b) continue;
        const mine = (item: { alias: string | null }) => item.alias !== null && (item.alias === table.alias || item.alias === table.name);
        if (mine(a)) keys.push({ own: a.column, other: b.column, otherAlias: b.alias });
        else if (mine(b)) keys.push({ own: b.column, other: a.column, otherAlias: a.alias });
      }
      at = end;
    }
    joins.push({ ...table, kind: kindWords.join(" ") || "inner", keys });
  }
  const clause = (name: string, stops: string[]) => {
    const begin = tokens.findIndex((token, index) => index >= at && token.depth === 0 && word(token, name));
    if (begin < 0) return "";
    const from = name === "group" ? begin + 2 : begin + 1;
    const end = tokens.findIndex((token, index) => index > from && token.depth === 0 && token.kind === "word" && stops.includes(token.value));
    const last = end < 0 ? tokens.length - 1 : end - 1;
    return last >= from ? sql.slice(tokens[from]!.start, tokens[last]!.end) : "";
  };
  return {
    items,
    from: first && !first.subquery ? { db: first.db, name: first.name, alias: first.alias, final: first.final } : null,
    fromSubquery: Boolean(first?.subquery),
    joins,
    where: clause("where", ["group", "order", "limit", "having", "union", "settings", "window", "qualify"]),
    groupBy: clause("group", ["order", "limit", "having", "union", "settings", "window", "qualify"]),
    limited: tokens.some((token, index) => index >= at && token.depth === 0 && word(token, "limit"))
  };
}

/** The expression a query's result column comes from (its select item), or null. */
export function exprOf(sql: string, column: string): string | null {
  return queryShape(sql).items.find((item) => item.alias === column)?.expr ?? null;
}
