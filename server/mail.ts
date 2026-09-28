/**
 * Outbound email (operator decision 2026-09-28): a small provider-agnostic `sendMail` over Resend.
 * Generic on purpose, so Calendar reminders and notifications can use it later.
 *
 * - Off unless both RESEND_API_KEY and MAIL_FROM are set (config.mail). A caller then gets
 *   `{ sent: false, reason: "not_configured" }` and carries on: email never fails the main action.
 * - Rate limits (in memory, like the auth limits): 20 an hour per sender, 5 an hour per recipient,
 *   and 200 a day per instance. Attempts count, successful or not, so a failing provider cannot be
 *   hammered.
 * - A 10 second timeout per send.
 * - Logs name the purpose, a hashed recipient, and the provider's message id (or error name and
 *   HTTP status). Never the address, the subject, the body (an invite link is a credential), or
 *   the API key. The Resend SDK's own error logging is silenced (see `quietResend`).
 * - Tests install a transport with `setMailTransportForTests`, so the suite never reaches the network.
 */
import { createHash } from "node:crypto";
import { Resend } from "resend";
import { config } from "./config";

export type MailMessage = { to: string; subject: string; text: string; html?: string };
export type MailSendRequest = MailMessage & { from: string; idempotencyKey: string };
/** Delivers one message or throws. `signal` aborts at the timeout. */
export type MailTransport = (message: MailSendRequest, signal: AbortSignal) => Promise<{ id: string }>;

export type MailOutcome =
  | { sent: true; id: string }
  | { sent: false; reason: "not_configured" | "rate_limited" | "failed" };

export const MAIL_TIMEOUT_MS = 10_000;
export const MAIL_LIMITS = { perSenderHour: 20, perRecipientHour: 5, perInstanceDay: 200 } as const;

export const NOT_CONFIGURED_MESSAGE = "Email is not configured";

/** A short, stable, non-reversible handle for a recipient in logs. */
export const recipientHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 12);

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
      ...(message.html ? { html: message.html } : {})
    }, options);
    // The provider's error name is logged, so only a short identifier survives.
    if (error || !data) throw new MailProviderError(String(error?.name ?? "unknown_error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unknown_error", error?.statusCode ?? null);
    return { id: data.id };
  };
}

/** A provider failure. Carries the provider's error name and status only (no message text). */
export class MailProviderError extends Error {
  constructor(readonly providerCode: string, readonly status: number | null) {
    super(`Mail provider error (${providerCode})`);
    this.name = "MailProviderError";
  }
}

if (config.mail.partial) console.warn("Email is off: set both RESEND_API_KEY and MAIL_FROM to turn it on");

let transport: MailTransport | null = config.mail.enabled ? resendTransport(config.mail.apiKey!) : null;
let from: string | null = config.mail.from;

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
function withinLimits(senderId: string | null, address: string, nowMs: number) {
  const takes = [
    take("instance", MAIL_LIMITS.perInstanceDay, 86_400_000, nowMs),
    take(`recipient:${recipientHash(address)}`, MAIL_LIMITS.perRecipientHour, 3_600_000, nowMs),
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

/**
 * Sends one message. Never throws: the outcome says whether it was sent. `purpose` is a short
 * label for logs ("team_invite"); `senderId` is the account the mail is sent on behalf of.
 */
export async function sendMail(message: MailMessage, options: { purpose: string; senderId: string | null; timeoutMs?: number }): Promise<MailOutcome> {
  if (!mailEnabled()) return { sent: false, reason: "not_configured" };
  const address = message.to.trim();
  const handle = recipientHash(address);
  if (!withinLimits(options.senderId, address, Date.now())) {
    console.warn(`Mail not sent: purpose=${options.purpose} recipient=${handle} reason=rate_limited`);
    return { sent: false, reason: "rate_limited" };
  }
  try {
    const { id } = await withTimeout((signal) => transport!({ ...message, to: address, from: from!, idempotencyKey: crypto.randomUUID() }, signal), options.timeoutMs ?? MAIL_TIMEOUT_MS);
    console.info(`Mail sent: purpose=${options.purpose} recipient=${handle} id=${id}`);
    return { sent: true, id };
  } catch (error) {
    const code = error instanceof MailProviderError ? error.providerCode : error instanceof Error ? error.name : "unknown_error";
    const status = error instanceof MailProviderError && Number.isInteger(error.status) ? ` status=${error.status}` : "";
    console.error(`Mail failed: purpose=${options.purpose} recipient=${handle} error=${code}${status}`);
    return { sent: false, reason: "failed" };
  }
}

/** Escapes text for the HTML part of a message. */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
