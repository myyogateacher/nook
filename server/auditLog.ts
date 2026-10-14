/**
 * Audit rows to the log (docs/OPERATIONS.md "Logs"): every audit() event also writes one log line,
 * so sign-ins, key changes, report runs, agent runs, and the rest show up in `docker compose logs`
 * with the request id they happened under.
 *
 * Only safe metadata reaches the log: numbers and booleans (counts, sizes, durations), ids (short
 * form: reportId → report=1a2b3c4d), and a short list of code-like string fields (status, trigger,
 * code, via, ...). Names, titles, emails, and any free text in the metadata are left out.
 */
import { logger, shortId, type LogFields, type Logger, type LogLevel } from "./log";

const SCOPES: Record<string, string> = {
  account: "auth", auth: "auth", team: "team", group: "team", key: "keys", mcp: "keys",
  reports: "reports", agents: "agents", proposal: "agents", routine: "agents", inbox: "agents",
  knowledge: "knowledge", document: "files", attachment: "files", storage: "storage",
  note: "notes", version: "notes", draft: "notes", folder: "notes", whiteboard: "notes",
  mail: "mail", push: "calendar", reminder: "calendar", calendar: "calendar", event: "calendar",
  vault: "vault", task: "tasks", collection: "collections", item: "access", preferences: "settings"
};
const loggers = new Map<string, Logger>();
const scoped = (scope: string) => {
  let found = loggers.get(scope);
  if (!found) loggers.set(scope, found = logger(scope));
  return found;
};

/** Everyday edits stay at debug: the request line already says they happened. */
const QUIET = /^(task|collection|event|folder|attachment|draft|preferences|whiteboard\.(save|snapshot)|knowledge\.search|mail\.(prefs_update|mute|unmute)|inbox\.push_setting|reports\.(report\.update|instruction\.reorder|spec\.manual)|item\.)/;
const WARN = /(_failed|\.failed|_blocked|_refused|\.refused|_unreadable|reauth_failed|rate_limited|auto_disabled|abandoned|\.expired|\.stale|suppressed|login_failed|\.denied|policy_blocked)$/;
const CODE_LIKE = /^[\w.:/+-]{1,60}$/;
const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** String metadata that is a code, never free text. */
const SAFE_STRINGS = new Set([
  "via", "trigger", "status", "kind", "code", "errorCode", "reason", "method", "surface", "decision", "outcome", "state",
  "role", "fromRole", "toRole", "from_role", "to_role", "action", "tool", "mode", "class", "purpose", "previewKind", "scope",
  "backend", "provider", "model", "level", "window", "format", "type", "source", "target", "mimeType", "to"
]);

function metadataFields(metadata: unknown): LogFields {
  const fields: LogFields = {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fields;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "boolean") fields[key] = value;
    else if (typeof value === "string" && /(Id|_id)$/.test(key)) fields[key.replace(/(Id|_id)$/, "")] = UUID.test(value) ? shortId(value) : value.slice(0, 64);
    else if (typeof value === "string" && SAFE_STRINGS.has(key)) {
      // Only code-like values (no spaces): a model-written "purpose" or any sentence is left out.
      const code = value.split(";")[0]!.trim();
      if (CODE_LIKE.test(code)) fields[key] = code;
    }
    else if (Array.isArray(value) && key === "scopes") fields.scopes = value.filter((item) => typeof item === "string").join(",").slice(0, 200);
  }
  return fields;
}

export function logAudit(actorId: string | null, noteId: string | null, eventType: string, metadata: unknown) {
  const prefix = eventType.slice(0, eventType.indexOf(".") >>> 0);
  const level: LogLevel = WARN.test(eventType) ? "warn" : QUIET.test(eventType) ? "debug" : "info";
  const log = scoped(SCOPES[prefix] ?? (prefix || "audit"));
  if (!log.enabled(level)) return;
  log[level](eventType, { actor: shortId(actorId), note: shortId(noteId), ...metadataFields(metadata) });
}
