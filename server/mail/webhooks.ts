import type { Hono } from "hono";
import { Resend } from "resend";
import type { AppEnv } from "../auth";
import { config } from "../config";
import { audit, db } from "../db";
import { addressHash } from "../mail";
import { readBoundedBody } from "../validation";
import { recordSoftBounce, suppressHash } from "./suppression";

/**
 * Resend webhooks (docs/plan/research/2026-09-28-outbound-email.md §B.4, T229): POST
 * /api/mail/webhook. Off (404) unless RESEND_WEBHOOK_SECRET is set, because it is a public,
 * unauthenticated endpoint and many Nooks are reachable only on a tailnet.
 *
 * - The signature is checked with the Resend SDK's `webhooks.verify` (standardwebhooks, the Svix
 *   scheme: `svix-id`, `svix-timestamp`, `svix-signature`) over the RAW body, read before any JSON
 *   parse, with the library's 5-minute timestamp tolerance. A bad signature is 401 and stores
 *   nothing. The body is capped at 64 KiB.
 * - `svix-id` goes into `mail_webhook_events` first, so a replayed delivery is a no-op.
 * - Hard bounces, complaints, and Resend's own suppressions suppress the address (hash only); soft
 *   bounces count toward a temporary suppression; `email.failed` marks the outbox row. Delivered,
 *   opened, clicked, and every other event are ignored: Nook does no tracking.
 * - Nothing from the payload is logged or stored beyond the event id, its type, and a hash.
 */

export const WEBHOOK_BODY_LIMIT = 64 * 1024;

let secret = config.mail.webhookSecret;
/** Test hook: a fake whsec_ secret turns the endpoint on; null turns it off. */
export function setWebhookSecretForTests(next: string | null) {
  secret = next;
}

// `webhooks.verify` makes no request; the placeholder key only satisfies the constructor.
let verifier: Resend | null = null;
const client = () => (verifier ??= new Resend("re_webhook_verify_only"));

type Event = { type?: unknown; data?: { email_id?: unknown; to?: unknown; bounce?: { type?: unknown } } };

const recipients = (event: Event) => Array.isArray(event.data?.to) ? event.data.to.filter((value): value is string => typeof value === "string" && value.length <= 254).slice(0, 50) : [];
const providerId = (event: Event) => typeof event.data?.email_id === "string" ? event.data.email_id.slice(0, 64) : null;

/** The account behind an address hash, for the audit trail (null for an invitee). */
function userIdForHash(hash: string) {
  const rows = db.query("SELECT id, email FROM users").all() as Array<{ id: string; email: string }>;
  return rows.find((row) => addressHash(row.email) === hash)?.id ?? null;
}

function markRow(id: string | null, errorCode: string) {
  if (!id) return;
  db.query("UPDATE mail_outbox SET status = 'failed', error_code = ? WHERE provider_id = ? AND status = 'sent'").run(errorCode, id);
}

/** Applies one verified, first-seen event. Returns what it did, for tests. */
export function applyWebhookEvent(event: Event, eventId: string, nowMs = Date.now()): "suppressed" | "soft_bounce" | "failed" | "ignored" {
  const type = typeof event.type === "string" ? event.type : "";
  const hashes = recipients(event).map(addressHash);
  switch (type) {
    case "email.bounced": {
      // Resend reports "Permanent", "Transient", or "Undetermined"; only a permanent bounce is hard.
      const hard = String(event.data?.bounce?.type ?? "").toLowerCase() === "permanent";
      for (const hash of hashes) {
        if (hard) {
          if (suppressHash(hash, "bounce", eventId, nowMs)) audit(userIdForHash(hash), null, "mail.suppressed", { reason: "bounce" });
        } else if (recordSoftBounce(hash, nowMs).suppressed) audit(userIdForHash(hash), null, "mail.suppressed", { reason: "soft" });
      }
      markRow(providerId(event), hard ? "bounced" : "soft_bounce");
      return hard ? "suppressed" : "soft_bounce";
    }
    case "email.complained":
    case "email.suppressed": {
      const reason = type === "email.complained" ? "complaint" : "bounce";
      for (const hash of hashes) if (suppressHash(hash, reason, eventId, nowMs)) audit(userIdForHash(hash), null, "mail.suppressed", { reason });
      markRow(providerId(event), type === "email.complained" ? "complained" : "provider_suppressed");
      return "suppressed";
    }
    case "email.failed":
      markRow(providerId(event), "provider_failed");
      return "failed";
    default:
      // Delivered, opened, clicked, delayed, contacts, domains: no tracking, nothing to do.
      return "ignored";
  }
}

/** Public: register before the session middleware (the provider has no session or CSRF token). */
export function registerMailWebhookRoutes(app: Hono<AppEnv>) {
  app.post("/api/mail/webhook", async (c) => {
    if (!secret) return c.json({ error: "Not found" }, 404);
    const id = c.req.header("svix-id") ?? "";
    const timestamp = c.req.header("svix-timestamp") ?? "";
    const signature = c.req.header("svix-signature") ?? "";
    if (!id || id.length > 100 || !timestamp || !signature || signature.length > 2000) return c.json({ error: "Invalid signature" }, 401);
    // The raw bytes, exactly as signed: parsing first would change them.
    const payload = new TextDecoder().decode(await readBoundedBody(c.req.raw, WEBHOOK_BODY_LIMIT));
    let event: Event;
    try {
      event = client().webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret: secret }) as unknown as Event;
    } catch {
      return c.json({ error: "Invalid signature" }, 401);
    }
    const first = db.transaction(() => {
      const inserted = db.query("INSERT OR IGNORE INTO mail_webhook_events (svix_id, received_at) VALUES (?, ?)").run(id, new Date().toISOString()).changes === 1;
      if (inserted && event && typeof event === "object") applyWebhookEvent(event, id);
      return inserted;
    })();
    return c.json({ ok: true, ...(first ? {} : { duplicate: true }) });
  });
}
