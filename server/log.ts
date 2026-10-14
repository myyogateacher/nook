/**
 * Nook's server log (D-logging, docs/OPERATIONS.md "Logs"). One small logger, no dependency.
 *
 * - Levels error, warn, info, debug (and silent, for tests): LOG_LEVEL, default info.
 * - LOG_FORMAT=pretty (one readable line plus logfmt key=values) or json (one object per line).
 * - Child loggers carry a scope (http, auth, reports, ...) and context (run=, report=, key=); a
 *   request's id and user ride along through AsyncLocalStorage, so a workflow line logged deep inside
 *   a request carries the same req= as its request line.
 * - Everything goes to stdout; error lines go to stderr.
 * - Every message and string field passes redact(): secrets, tokens, and email addresses never reach
 *   the output, and fields named like a secret or like content are dropped to "[redacted]".
 *
 * This module reads its own environment (not ./config), so it can be imported from anywhere,
 * including config.ts and the migrations, without an import cycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
type Threshold = LogLevel | "silent";
export type LogFields = Record<string, unknown>;

const ORDER: Record<Threshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LABEL: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };

function readLevel(value: string | undefined): Threshold {
  const level = value?.trim().toLowerCase();
  if (level && level in ORDER) return level as Threshold;
  // Tests run silent unless they ask (tests/support/preload.ts sets LOG_LEVEL=silent too).
  if (!level && process.env.NODE_ENV === "test") return "silent";
  return "info";
}

let threshold: Threshold = readLevel(process.env.LOG_LEVEL);
let format: "pretty" | "json" = process.env.LOG_FORMAT?.trim().toLowerCase() === "json" ? "json" : "pretty";
const parsedSlow = Number(process.env.LOG_SLOW_MS);
/** Requests slower than this (milliseconds) log at warn. LOG_SLOW_MS, default 1000. */
export const logSlowMs = Number.isFinite(parsedSlow) && parsedSlow > 0 ? parsedSlow : 1000;

/** The settings the startup summary prints. */
export const logSettings = () => ({ level: threshold, format, slowMs: logSlowMs });

/** Whether a level would be written now. Check it before building an expensive debug payload. */
export const logEnabled = (level: LogLevel) => ORDER[level] >= ORDER[threshold];

type Sink = (line: string, level: LogLevel) => void;
const defaultSink: Sink = (line, level) => {
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};
let sink: Sink = defaultSink;

/** Test hook: capture lines (and optionally change the level and format) until the returned restore runs. */
export function captureLogs(options: { level?: Threshold; format?: "pretty" | "json" } = {}) {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const previous = { sink, threshold, format };
  sink = (line, level) => { lines.push({ level, line }); };
  if (options.level) threshold = options.level;
  if (options.format) format = options.format;
  return {
    lines,
    text: () => lines.map((entry) => entry.line).join("\n"),
    restore: () => { sink = previous.sink; threshold = previous.threshold; format = previous.format; }
  };
}

// ---------------------------------------------------------------- redaction

const SECRET_KEY = /(^|_)(pass|password|passwd|secret|token|tokens|cookie|cookies|set_cookie|authorization|auth_header|api_key|apikey|bearer|credential|credentials|totp|totp_code|recovery_code|recovery_codes|otp|csrf|csrf_token|private_key|access_key|signature)$/;
const CONTENT_KEY = /(^|_)(content|markdown|body|html|prompt|prompts|reply|replies|answer|messages|rows|result_rows|values|value|text|note_text|doc_markdown|email_body)$/;
const EMAIL_KEY = /(^|_)(email|emails|to|from|address|recipient|recipients)$/;
/** camelCase and kebab-case keys compare as snake_case: totpCode → totp_code. */
const normalizeKey = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9-]*((?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>, Basic <credentials>
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  // Nook keys (mynotes_..., nkv_...) and common provider key shapes.
  [/\b(mynotes|nkv|sk|pk|rk|sk-ant|ghp|gho|ghs|xox[abpr]|re)[_-][A-Za-z0-9_-]{12,}/g, "[redacted]"],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  // key=value or "key": "value" pairs naming a secret (query strings, connection strings, JSON).
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|authorization|cookie|session|code|totp)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1$2[redacted]"],
  // Credentials in a URL: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[redacted]@"],
  // PEM blocks.
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[redacted]"],
  // Long opaque runs (session tokens, base64url keys) that mix letters and digits. 40+ characters, so
  // a UUID (36) and a path segment stay readable; "/" ends a run, so file paths in stacks do too.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}={0,2}/g, "[redacted]"]
];

/** An email address as p***@m***.com: enough to tell two people apart, not enough to read it. */
export const maskEmail = (value: string) => value.replace(EMAIL, (_match, first: string, domainFirst: string, tld: string) => {
  const suffix = tld.slice(tld.lastIndexOf("."));
  return `${first}***@${domainFirst}***${suffix}`;
});

/** Strips secrets, tokens, and email addresses from a string. */
export function redactText(value: string) {
  let result = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) result = result.replace(pattern, replacement);
  return maskEmail(result);
}

/**
 * Redacts one value for the log: a field named like a secret, or a non-numeric field named like
 * content, becomes "[redacted]",
 * an email-named field is masked, strings lose anything that looks like a secret, and objects and
 * arrays are walked (to a small depth).
 */
export function redact(value: unknown, key = "", depth = 0): unknown {
  if (key) {
    const normalized = normalizeKey(key);
    if (value === undefined || value === null) return value;
    if (SECRET_KEY.test(normalized)) return "[redacted]";
    // A content-named field may still be a count (rows=12, body=0): only text and structures are content.
    if (CONTENT_KEY.test(normalized) && typeof value !== "number" && typeof value !== "boolean") return "[redacted]";
    if (EMAIL_KEY.test(normalized) && typeof value === "string") return maskEmail(value);
  }
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 3) return "[object]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, "", depth + 1));
  const result: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) result[name] = redact(item, name, depth + 1);
  return result;
}

const MAX_STACK = 4000;
function serializeError(error: Error) {
  const code = (error as NodeJS.ErrnoException).code;
  const status = (error as { status?: unknown }).status;
  return {
    name: error.name,
    message: redactText(error.message).slice(0, 500),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(error.stack ? { stack: redactText(error.stack).slice(0, MAX_STACK) } : {})
  };
}

/** A user id in the short form the log uses: its first eight characters. */
export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : undefined);
/** A stable, non-reversible tag for a value we must not print (an address, a query text): 8 hex chars. */
export const hashTag = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

// ---------------------------------------------------------------- request context

/** The per-request (or per-job) context every line inside it carries: req=, user=, role=, via=, key=. */
export type LogContext = Record<string, string | number | undefined>;
const contextStore = new AsyncLocalStorage<LogContext>();

/** Runs `operation` with a log context; lines logged inside it (and in work it starts) carry the context. */
export const withLogContext = <T>(context: LogContext, operation: () => T): T => contextStore.run(context, operation);
/** Adds fields to the current context (e.g. the user once authenticated, the key once checked). */
export function setLogContext(fields: LogContext) {
  const store = contextStore.getStore();
  if (store) Object.assign(store, fields);
}
export const currentLogContext = () => contextStore.getStore();

// ---------------------------------------------------------------- formatting

const BARE = /^[A-Za-z0-9_.:/@*+\-…]+$/;
function logfmtValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value !== "" && BARE.test(value) ? value : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function render(level: LogLevel, scope: string, message: string, fields: LogFields): string {
  const time = new Date().toISOString();
  if (format === "json") return JSON.stringify({ time, level, scope, msg: message, ...fields });
  let stack: string | undefined;
  let line = `${time} ${LABEL[level]} ${scope.padEnd(8)} ${message}`;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (name === "err" && value && typeof value === "object") {
      const error = value as { name?: string; message?: string; code?: unknown; stack?: string };
      line += ` err=${logfmtValue(error.name ?? "Error")}`;
      if (error.code !== undefined) line += ` errCode=${logfmtValue(error.code)}`;
      if (error.message) line += ` errMsg=${logfmtValue(error.message)}`;
      stack = error.stack;
      continue;
    }
    line += ` ${name}=${logfmtValue(value)}`;
  }
  // The stack goes on indented lines after the event, so the event itself stays one greppable line.
  if (stack) line += `\n${stack.split("\n").slice(1).map((frame) => `    ${frame.trim()}`).join("\n")}`;
  return line;
}

// ---------------------------------------------------------------- loggers

export type Logger = {
  readonly scope: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  /** `fields` may be an Error (logged with its stack), or fields with `err`. */
  error(message: string, fields?: LogFields | unknown): void;
  /** A logger with the same scope (or a new one) and more context. */
  child(fields: LogFields, scope?: string): Logger;
  enabled(level: LogLevel): boolean;
};

function emit(level: LogLevel, scope: string, bound: LogFields, message: string, fields: LogFields | undefined) {
  const merged: LogFields = {};
  for (const [name, value] of Object.entries(fields ?? {})) merged[name] = redact(value, name === "err" ? "" : name);
  for (const [name, value] of Object.entries(bound)) if (!(name in merged)) merged[name] = redact(value, name);
  const context = contextStore.getStore();
  if (context) for (const [name, value] of Object.entries(context)) if (!(name in merged) && value !== undefined) merged[name] = value;
  try {
    sink(render(level, scope, redactText(message), merged), level);
  } catch {
    // A broken stdout must never take a request down with it.
  }
}

function makeLogger(scope: string, bound: LogFields): Logger {
  return {
    scope,
    debug: (message, fields) => { if (ORDER.debug >= ORDER[threshold]) emit("debug", scope, bound, message, fields); },
    info: (message, fields) => { if (ORDER.info >= ORDER[threshold]) emit("info", scope, bound, message, fields); },
    warn: (message, fields) => { if (ORDER.warn >= ORDER[threshold]) emit("warn", scope, bound, message, fields); },
    error: (message, fields) => {
      if (ORDER.error < ORDER[threshold]) return;
      const asFields: LogFields = fields instanceof Error ? { err: fields }
        : fields && typeof fields === "object" ? fields as LogFields
        : fields === undefined ? {} : { err: String(fields) };
      emit("error", scope, bound, message, asFields);
    },
    child: (fields, childScope) => makeLogger(childScope ?? scope, { ...bound, ...fields }),
    enabled: logEnabled
  };
}

/** A logger for one area of the server: logger("reports"), logger("mcp", { key: keyId }). */
export const logger = (scope: string, fields: LogFields = {}): Logger => makeLogger(scope, fields);

/** The process-wide logger (startup, shutdown, crashes). */
export const log = logger("app");

/** Milliseconds since `start` (performance.now()), rounded for the log. */
export const elapsed = (start: number) => Math.round(performance.now() - start);

let processHooksInstalled = false;
/**
 * unhandledRejection and uncaughtException go to the log at error, with the stack. A rejection is
 * logged and the server keeps serving; an exception exits 1 once its line is written (compose's
 * restart policy brings the server back). Not under tests: bun test reports those itself.
 */
export function installProcessHooks() {
  if (processHooksInstalled || process.env.NODE_ENV === "test") return;
  processHooksInstalled = true;
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", reason instanceof Error ? reason : { err: String(reason) });
  });
  process.on("uncaughtException", (error) => {
    log.error("Uncaught exception; exiting", error);
    process.exit(1);
  });
}
