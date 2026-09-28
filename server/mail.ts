/**
 * Outbound email transport (operator decision 2026-09-28; D93, outbound email plan §D.2): a small
 * provider-agnostic `sendMail` over Resend. The outbox (server/mail/outbox.ts) is its main caller;
 * team invites call it directly (D254).
 *
 * - Off unless RESEND_API_KEY and MAIL_FROM are set and links can work (config.mail). A caller then
 *   gets `{ sent: false, reason: "not_configured" }` and carries on: email never fails the action.
 * - In-memory limits, the provider-facing guard (durable caps live in the outbox): 20 an hour per
 *   sender, 20 an hour per recipient account and 5 an hour for mail to a bare address (invites), and
 *   MAIL_DAILY_LIMIT a day per instance. Attempts count, so a failing provider cannot be hammered.
 * - The idempotency key comes from the caller (the outbox row id), so a retry after a timeout cannot
 *   send twice (Resend keeps keys for 24 hours).
 * - A 10 second timeout per send.
 * - Logs name the purpose, a hashed recipient, and the provider's message id (or error name and
 *   HTTP status). Never the address, the subject, the body (links can be credentials), or the
 *   API key. The Resend SDK's own error logging is silenced (see `quietResend`).
 * - Tests install a transport with `setMailTransportForTests`; MAIL_TRANSPORT=file (development only)
 *   writes each message to MAIL_FILE_PATH instead of sending it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Resend } from "resend";
import { config } from "./config";

export type MailMessage = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };
export type MailSendRequest = MailMessage & { from: string; idempotencyKey: string };
/** Delivers one message or throws. `signal` aborts at the timeout. */
export type MailTransport = (message: MailSendRequest, signal: AbortSignal) => Promise<{ id: string }>;

export type MailOutcome =
  | { sent: true; id: string }
  | { sent: false; reason: "not_configured" }
  | { sent: false; reason: "rate_limited" }
  /** `code` is the provider's error name (or "timeout"); `retryable` is false for a 4xx validation error. */
  | { sent: false; reason: "failed"; code: string; retryable: boolean };

export const MAIL_TIMEOUT_MS = 10_000;
export const MAIL_LIMITS = { perSenderHour: 20, perRecipientHour: 20, perAddressHour: 5, perInstanceDay: config.mail.dailyLimit } as const;

export const NOT_CONFIGURED_MESSAGE = "Email is not configured";

/** A short, stable, non-reversible handle for a recipient in logs and the outbox. */
export const recipientHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 12);
/** The full SHA-256 of a lowercased address (mail_suppressions). */
export const addressHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

/** A provider failure. Carries the provider's error name and status only (no message text). */
export class MailProviderError extends Error {
  constructor(readonly providerCode: string, readonly status: number | null) {
    super(`Mail provider error (${providerCode})`);
    this.name = "MailProviderError";
  }
}

/**
 * A Resend client that never logs. The SDK has no logger option, and outside NODE_ENV=production
 * it prints the provider's whole error body with console.error, which can quote the recipient's
 * address (review L3). Its private `logError` is shadowed on the instance; `sendMail` logs the
 * failure itself with the error name, the HTTP status, and a hashed recipient only.
 */
function quietResend(apiKey: string, baseUrl?: string) {
  const client = new Resend(apiKey, baseUrl ? { baseUrl } : undefined);
  Object.defineProperty(client, "logError", { value: () => undefined });
  return client;
}

/** The Resend transport; `baseUrl` lets tests point it at a local fake provider. */
export function resendTransport(apiKey: string, baseUrl?: string): MailTransport {
  const client = quietResend(apiKey, baseUrl);
  return async (message, signal) => {
    // `signal` is passed through to fetch by the SDK's request options.
    const options = { idempotencyKey: message.idempotencyKey, signal } as { idempotencyKey: string };
    const { data, error } = await client.emails.send({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.headers ? { headers: message.headers } : {})
    }, options);
    // The provider's error name is logged, so only a short identifier survives.
    if (error || !data) throw new MailProviderError(String(error?.name ?? "unknown_error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unknown_error", error?.statusCode ?? null);
    return { id: data.id };
  };
}

/**
 * Development transport: appends each message to a JSON array at `path` (MAIL_FILE_PATH), so QA can
 * read mail without a provider. Refused in production by config.ts.
 */
export function fileTransport(path: string): MailTransport {
  return async (message) => {
    let list: unknown[] = [];
    try {
      if (existsSync(path)) list = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    } catch {
      list = [];
    }
    const id = `file_${crypto.randomUUID()}`;
    list.push({ id, at: new Date().toISOString(), ...message });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return { id };
  };
}

if (config.mail.partial) console.warn("Email is off: set both RESEND_API_KEY and MAIL_FROM to turn it on");
if (config.mail.blockedReason) console.warn(`Email is off: ${config.mail.blockedReason}`);
if (config.mail.httpLinks) console.warn("Email is on with http links (MAIL_ALLOW_HTTP_LINKS=true): links in mail are not encrypted");
if (config.mail.transport === "file") console.warn("Email goes to the MAIL_FILE_PATH file (MAIL_TRANSPORT=file); nothing is sent");

let transport: MailTransport | null = config.mail.transport === "file"
  ? fileTransport(config.mail.filePath!)
  : config.mail.enabled ? resendTransport(config.mail.apiKey!) : null;
let from: string | null = config.mail.transport === "file" ? config.mail.from ?? "Nook <nook@example.test>" : config.mail.from;

/** Test hook: a fake transport (enables mail with a placeholder sender), or null to turn mail off. */
export function setMailTransportForTests(next: MailTransport | null, sender = "Nook <nook@example.test>") {
  transport = next;
  from = next ? sender : null;
}

export const mailEnabled = () => transport !== null && from !== null;

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

/** Test hook. */
export function resetMailLimits() {
  windows.clear();
}

function take(key: string, limit: number, windowMs: number, nowMs: number) {
  if (windows.size > 2000) for (const [entryKey, entry] of windows) if (entry.resetAt <= nowMs) windows.delete(entryKey);
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= nowMs) return () => windows.set(key, { count: 1, resetAt: nowMs + windowMs });
  if (entry.count >= limit) return null;
  return () => { entry.count += 1; };
}

/** Takes one slot from every limit, or none when any is full. */
function withinLimits(senderId: string | null, address: string, recipient: "user" | "address", nowMs: number) {
  const takes = [
    take("instance", MAIL_LIMITS.perInstanceDay, 86_400_000, nowMs),
    take(`recipient:${recipientHash(address)}`, recipient === "user" ? MAIL_LIMITS.perRecipientHour : MAIL_LIMITS.perAddressHour, 3_600_000, nowMs),
    senderId ? take(`sender:${senderId}`, MAIL_LIMITS.perSenderHour, 3_600_000, nowMs) : () => undefined
  ];
  if (takes.some((commit) => commit === null)) return false;
  for (const commit of takes) commit!();
  return true;
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MailProviderError("timeout", null));
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Timeouts, network errors, 429, and 5xx are worth retrying; a 4xx validation error is not (§D.3). */
function isRetryable(error: unknown) {
  if (!(error instanceof MailProviderError)) return true;
  if (error.providerCode === "timeout" || error.status === null) return true;
  return error.status === 429 || error.status >= 500;
}

export type SendOptions = {
  /** A short label for logs, such as the template name. */
  purpose: string;
  /** The account the mail is sent on behalf of (sender limit), or null. */
  senderId: string | null;
  /** "user" for an account's address (20/h), "address" for a bare address such as an invite (5/h). */
  recipient?: "user" | "address";
  /** Stable across retries: the outbox row's key. A fresh one when omitted. */
  idempotencyKey?: string;
  timeoutMs?: number;
};

/** Sends one message. Never throws: the outcome says whether it was sent. */
export async function sendMail(message: MailMessage, options: SendOptions): Promise<MailOutcome> {
  if (!mailEnabled()) return { sent: false, reason: "not_configured" };
  const address = message.to.trim();
  const handle = recipientHash(address);
  if (!withinLimits(options.senderId, address, options.recipient ?? "address", Date.now())) {
    console.warn(`Mail not sent: purpose=${options.purpose} recipient=${handle} reason=rate_limited`);
    return { sent: false, reason: "rate_limited" };
  }
  try {
    const request = { ...message, to: address, from: from!, idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() };
    const { id } = await withTimeout((signal) => transport!(request, signal), options.timeoutMs ?? MAIL_TIMEOUT_MS);
    console.info(`Mail sent: purpose=${options.purpose} recipient=${handle} id=${id}`);
    return { sent: true, id };
  } catch (error) {
    const code = (error instanceof MailProviderError ? error.providerCode : error instanceof Error ? error.name : "unknown_error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unknown_error";
    const status = error instanceof MailProviderError && Number.isInteger(error.status) ? ` status=${error.status}` : "";
    console.error(`Mail failed: purpose=${options.purpose} recipient=${handle} error=${code}${status}`);
    return { sent: false, reason: "failed", code, retryable: isRetryable(error) };
  }
}

export { escapeHtml } from "./mail/html";
