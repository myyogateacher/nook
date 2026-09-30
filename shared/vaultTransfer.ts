/**
 * Vault import and export formats (vault plan §6.4, D230: in-house, no dependency). Pure functions
 * shared by the client (which reads the file with FileReader and parses it; the file itself is never
 * uploaded) and the server (which re-validates every entry and writes the export).
 *
 * - `.env`: `KEY=value` lines; `#` comments and blank lines are skipped; an `export ` prefix is
 *   allowed; values may be unquoted (trimmed; ` #` starts a comment), single-quoted (literal), or
 *   double-quoted (`\n`, `\r`, `\t`, `\"`, `\\` escapes, and real line breaks inside the quotes). A
 *   byte-order mark and CRLF line ends are accepted. Keys match `^[A-Za-z_][A-Za-z0-9_.-]*$`. A key
 *   given twice keeps the later value (as shells do); the earlier line is reported.
 * - JSON: a flat object `{ "NAME": "value" }`, an array of `{ name, value, comment? }`, or the export
 *   shape `{ secrets: [{ name, value, comment?, type? }] }`.
 * - CSV (RFC 4180): a header row with `name` and `value` (and optionally `comment`), commas, double
 *   quotes doubled inside quoted fields, and line breaks inside quotes.
 *
 * No value, anywhere, ever contains NUL. Nothing here logs.
 */

export const IMPORT_FORMATS = ["dotenv", "json", "csv"] as const;
export type TransferFormat = (typeof IMPORT_FORMATS)[number];

export type ImportEntry = { name: string; value: string; comment?: string | null };
export type ParseProblem = { line: number | null; name: string | null; reason: string };
export type ParseResult = { entries: ImportEntry[]; problems: ParseProblem[] };

export const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NUL = "\u0000";

/** The format a file name suggests (`.env`, `production.env`, `x.json`, `x.csv`), or null. */
export function formatFromFileName(name: string): TransferFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  if (lower === ".env" || lower.endsWith(".env") || lower.startsWith(".env.") || lower.endsWith(".txt")) return "dotenv";
  return null;
}

const normalizeText = (text: string) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

export function parseDotenv(input: string): ParseResult {
  const text = normalizeText(input);
  const problems: ParseProblem[] = [];
  const byName = new Map<string, { entry: ImportEntry; line: number }>();
  if (text.includes(NUL)) return { entries: [], problems: [{ line: null, name: null, reason: "The file contains NUL characters" }] };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const equals = line.indexOf("=");
    if (equals <= 0) {
      problems.push({ line: lineNumber, name: null, reason: "Not a KEY=value line" });
      continue;
    }
    const name = line.slice(0, equals).trim();
    if (!DOTENV_KEY.test(name)) {
      problems.push({ line: lineNumber, name: null, reason: "The key must start with a letter or _ and use letters, digits, _, ., and -" });
      continue;
    }
    let rest = line.slice(equals + 1).trimStart();
    let value: string;
    if (rest.startsWith("\"")) {
      // Double quotes: escapes, and the value may continue on the following lines.
      let body = rest.slice(1);
      let end = findClosingQuote(body);
      let consumed = index;
      while (end < 0 && consumed + 1 < lines.length) {
        consumed += 1;
        body += `\n${lines[consumed]}`;
        end = findClosingQuote(body);
      }
      if (end < 0) {
        problems.push({ line: lineNumber, name, reason: "The double quote is never closed" });
        index = consumed;
        continue;
      }
      const after = body.slice(end + 1).trim();
      if (after && !after.startsWith("#")) {
        problems.push({ line: lineNumber, name, reason: "Text after the closing quote" });
        index = consumed;
        continue;
      }
      value = unescapeDouble(body.slice(0, end));
      index = consumed;
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) {
        problems.push({ line: lineNumber, name, reason: "The single quote is never closed" });
        continue;
      }
      const after = rest.slice(end + 1).trim();
      if (after && !after.startsWith("#")) {
        problems.push({ line: lineNumber, name, reason: "Text after the closing quote" });
        continue;
      }
      value = rest.slice(1, end);
    } else {
      const comment = rest.search(/\s#/);
      if (comment >= 0) rest = rest.slice(0, comment);
      value = rest.trim();
    }
    const earlier = byName.get(name);
    if (earlier) problems.push({ line: earlier.line, name, reason: `Replaced by line ${lineNumber}` });
    byName.set(name, { entry: { name, value }, line: lineNumber });
  }
  return { entries: [...byName.values()].map((item) => item.entry), problems };
}

function findClosingQuote(body: string) {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") index += 1;
    else if (body[index] === "\"") return index;
  }
  return -1;
}

function unescapeDouble(body: string) {
  return body.replace(/\\(.)/gs, (_, char: string) => char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char);
}

/** One `.env` value, always double-quoted, so every string (quotes, `#`, spaces, line breaks) round-trips. */
export function dotenvValue(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** A comment line: one line of text after `# ` (line breaks become spaces). */
const commentLine = (comment: string) => `# ${comment.replace(/[\r\n]+/g, " ").trim()}`;

export type ExportEntry = { name: string; value: string; comment: string | null; type: string };

/**
 * A `.env` file. Names that are not valid keys are left out and listed (the caller reports them).
 * Comments, when included, go on a `#` line above their value.
 */
export function serializeDotenv(entries: readonly ExportEntry[], options: { comments: boolean; header?: string }): { text: string; skipped: string[] } {
  const skipped: string[] = [];
  const lines: string[] = [];
  if (options.header) lines.push(commentLine(options.header));
  for (const entry of entries) {
    if (!DOTENV_KEY.test(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    if (options.comments && entry.comment) lines.push(commentLine(entry.comment));
    lines.push(`${entry.name}=${dotenvValue(entry.value)}`);
  }
  return { text: `${lines.join("\n")}\n`, skipped };
}

export function serializeJson(entries: readonly ExportEntry[], options: { comments: boolean; vault: string; environment: string }) {
  return `${JSON.stringify({
    vault: options.vault,
    environment: options.environment,
    secrets: entries.map((entry) => ({ name: entry.name, type: entry.type, value: entry.value, ...(options.comments && entry.comment ? { comment: entry.comment } : {}) }))
  }, null, 2)}\n`;
}

const csvField = (value: string) => /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, "\"\"")}"` : value;

export function serializeCsv(entries: readonly ExportEntry[], options: { comments: boolean }) {
  const rows = [options.comments ? "name,value,comment" : "name,value"];
  for (const entry of entries) rows.push([entry.name, entry.value, ...(options.comments ? [entry.comment ?? ""] : [])].map(csvField).join(","));
  return `${rows.join("\r\n")}\r\n`;
}

export function parseJsonImport(input: string): ParseResult {
  const text = normalizeText(input);
  if (text.includes(NUL)) return { entries: [], problems: [{ line: null, name: null, reason: "The file contains NUL characters" }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], problems: [{ line: null, name: null, reason: "Not valid JSON" }] };
  }
  const problems: ParseProblem[] = [];
  const entries: ImportEntry[] = [];
  const list = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { secrets?: unknown }).secrets) ? (parsed as { secrets: unknown[] }).secrets
      : null;
  if (list) {
    list.forEach((item, index) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
      if (!record || typeof record.name !== "string" || typeof record.value !== "string") {
        problems.push({ line: null, name: record && typeof record.name === "string" ? record.name : null, reason: `Item ${index + 1} needs a text name and value` });
        return;
      }
      const comment = typeof record.comment === "string" ? record.comment : null;
      entries.push({ name: record.name, value: record.value, ...(comment ? { comment } : {}) });
    });
  } else if (parsed && typeof parsed === "object") {
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") problems.push({ line: null, name, reason: "The value is not text" });
      else entries.push({ name, value });
    }
  } else {
    problems.push({ line: null, name: null, reason: "Expected an object of names and values, or a list of secrets" });
  }
  return dedupeEntries(entries, problems);
}

/**
 * RFC 4180 rows (quoted fields may hold commas, doubled quotes, and line breaks, kept exactly: a
 * CRLF inside quotes stays CRLF). Outside quotes CRLF, LF, and CR each end a row.
 */
export function csvRows(input: string): string[][] | null {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === "\"" && field === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      wasQuoted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      wasQuoted = false;
    } else field += char;
  }
  if (quoted) return null;
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => !(item.length === 1 && item[0] === ""));
}

export function parseCsvImport(input: string): ParseResult {
  if (input.includes(NUL)) return { entries: [], problems: [{ line: null, name: null, reason: "The file contains NUL characters" }] };
  const rows = csvRows(input);
  if (!rows) return { entries: [], problems: [{ line: null, name: null, reason: "A quoted field is never closed" }] };
  if (!rows.length) return { entries: [], problems: [] };
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const nameAt = header.indexOf("name");
  const valueAt = header.indexOf("value");
  const commentAt = header.indexOf("comment");
  if (nameAt < 0 || valueAt < 0) return { entries: [], problems: [{ line: 1, name: null, reason: "The first row must name the columns: name, value (and comment)" }] };
  const problems: ParseProblem[] = [];
  const entries: ImportEntry[] = [];
  rows.slice(1).forEach((row, index) => {
    const name = row[nameAt]?.trim() ?? "";
    const value = row[valueAt];
    if (!name || value === undefined) {
      problems.push({ line: index + 2, name: name || null, reason: "The row needs a name and a value" });
      return;
    }
    const comment = commentAt >= 0 ? row[commentAt] ?? "" : "";
    entries.push({ name, value, ...(comment ? { comment } : {}) });
  });
  return dedupeEntries(entries, problems);
}

function dedupeEntries(entries: ImportEntry[], problems: ParseProblem[]): ParseResult {
  const byName = new Map<string, ImportEntry>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (byName.has(key)) problems.push({ line: null, name: entry.name, reason: "Repeated: the later one is used" });
    byName.set(key, entry);
  }
  return { entries: [...byName.values()], problems };
}

export function parseImport(format: TransferFormat, text: string): ParseResult {
  return format === "json" ? parseJsonImport(text) : format === "csv" ? parseCsvImport(text) : parseDotenv(text);
}
