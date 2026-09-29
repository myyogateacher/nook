import type { Context, Hono } from "hono";
import { clientAddress } from "../clientAddress";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { config, isOriginAllowed } from "../config";
import { audit, db, now } from "../db";
import { mailEnabled } from "../mail";
import { can } from "../team/roles";
import { parseJson, uuid } from "../validation";
import { kickMailDispatch, MAX_ATTEMPTS, runMailDispatch } from "./dispatcher";
import { enqueueMail } from "./outbox";
import { emailPrefsPutSchema, readEmailPrefs, turnCategoryOff, writeEmailPrefs } from "./prefs";
import { answerDigestPrompt, digestPromptSchema, digestPromptVisible } from "./digestPrompt";
import { hashAuthToken } from "./resolve";
import { isMuteType, listMutes, MuteError, muteTarget, unmuteTarget } from "./mutes";
import { clearOwnSuppression, suppressionOf } from "./suppression";
import { verifyUnsubscribeToken } from "./unsubscribe";
import { registerMailWebhookRoutes } from "./webhooks";

/**
 * Email routes (docs/plan/research/2026-09-28-outbound-email.md §A.4, §B, §D.4, §E).
 *
 * Public, registered before the session middleware:
 * - POST /api/mail/verify {token}: marks the address verified. The token is single use, expires in
 *   24 h, and must match the address it was issued for (T231). It never signs anyone in.
 * - POST /api/mail/unsubscribe?t=…: RFC 8058 one-click (the mailbox provider's POST, no session or
 *   CSRF) and the landing page's button. It can only turn one category off, and answers 200 with an
 *   empty body for valid and invalid tokens alike (T221). GET never changes anything (405).
 *
 * Signed in: GET/PUT /api/mail/settings, GET/POST /api/mail/digest-prompt, POST /api/mail/verify/send, POST /api/mail/test.
 * Admins: GET /api/team/mail-log and POST /api/team/mail-log/:id/retry (ids and statuses only).
 */

const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const emptySchema = z.object({}).strict();

/** Mails a user may ask for per hour (verify, test; §A.4, §A.2 #15). */
export const SELF_SERVE_HOURLY = 3;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
function limited(key: string, limit: number, windowMs = 60_000) {
  const time = Date.now();
  if (buckets.size > 1000) for (const [entryKey, entry] of buckets) if (entry.resetAt <= time) buckets.delete(entryKey);
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= time) {
    buckets.set(key, { count: 1, resetAt: time + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

/** Test hook. */
export function resetMailRouteLimits() {
  buckets.clear();
}



/** Marks the address verified when the token is live and was issued for the current address. */
export function consumeVerifyToken(token: string, nowMs = Date.now()): "verified" | "invalid" | "expired" {
  const row = db.query(`SELECT t.id, t.user_id, t.expires_at, t.used_at, t.email_at_issue, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.purpose = 'verify_email'`).get(hashAuthToken(token)) as { id: string; user_id: string; expires_at: string; used_at: string | null; email_at_issue: string; email: string } | null;
  if (!row || row.used_at !== null || row.email.toLowerCase() !== row.email_at_issue.toLowerCase()) return "invalid";
  if (Date.parse(row.expires_at) <= nowMs) return "expired";
  const at = new Date(nowMs).toISOString();
  const done = db.transaction(() => {
    const claimed = db.query("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(at, row.id);
    if (claimed.changes !== 1) return false;
    db.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(at, row.user_id);
    audit(row.user_id, null, "mail.email_verified");
    return true;
  })();
  return done ? "verified" : "invalid";
}

/** What Settings → Notifications → Email shows. */
export function emailSettings(userId: string) {
  const user = db.query("SELECT email, email_verified_at FROM users WHERE id = ?").get(userId) as { email: string; email_verified_at: string | null };
  const suppression = suppressionOf(user.email);
  return {
    configured: mailEnabled(),
    address: user.email,
    verified: user.email_verified_at !== null,
    suppressed: suppression !== null,
    /** Why mail is held back (bounce, complaint, soft bounce), and until when for a soft bounce. */
    suppression,
    prefs: readEmailPrefs(userId)
  };
}

const recentCount = (userId: string, template: string) => (db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ? AND template = ? AND created_at > ?")
  .get(userId, template, new Date(Date.now() - 3_600_000).toISOString()) as { count: number }).count;

/** Enqueues the verification mail (also called after registration). Null when email is off or the address is verified. */
export function enqueueVerifyMail(userId: string) {
  const user = db.query("SELECT email_verified_at FROM users WHERE id = ?").get(userId) as { email_verified_at: string | null } | null;
  if (!user || user.email_verified_at !== null) return null;
  const id = enqueueMail({ userId, template: "account.verify", payload: {} });
  if (id) kickMailDispatch();
  return id;
}

/** Public routes: call before the session middleware. */
export function registerPublicMailRoutes(app: Hono<AppEnv>) {
  // Resend bounce and complaint webhooks: 404 unless RESEND_WEBHOOK_SECRET is set (§B.4).
  registerMailWebhookRoutes(app);

  app.post("/api/mail/verify", async (c) => {
    if (!isOriginAllowed(c.req.header("Origin"))) return c.json({ error: "Invalid request origin" }, 403);
    if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Content-Type must be application/json" }, 415);
    if (limited(`verify:${clientAddress(c)}`, 20)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    const body = await parseJson(c.req.raw, tokenSchema);
    const result = consumeVerifyToken(body.token);
    if (result === "verified") return c.json({ ok: true });
    // With email off there is no new link to send (3a/6): the page says so instead of pointing at Settings.
    const emailEnabled = mailEnabled();
    return result === "expired"
      ? c.json({ error: emailEnabled ? "This link expired. Send a new one from Settings → Notifications." : "This link expired. Email is off on this Nook.", code: "TOKEN_EXPIRED", emailEnabled }, 410)
      : c.json({ error: "This link is not valid or was already used.", code: "TOKEN_INVALID", emailEnabled }, 400);
  });

  app.get("/api/mail/unsubscribe", (c) => c.json({ error: "Use POST" }, 405));
  app.post("/api/mail/unsubscribe", async (c) => {
    // Answer the same for every token so the endpoint is no oracle; a flood only gets 429.
    if (limited(`unsubscribe:${clientAddress(c)}`, 30)) return c.body(null, 429);
    const token = c.req.query("t") ?? "";
    const verified = token ? await verifyUnsubscribeToken(token) : null;
    if (verified) turnCategoryOff(verified.userId, verified.category);
    return c.body(null, 200);
  });
}

/** Signed-in routes (after the session, CSRF, TOTP, and role gates). */
export function registerMailRoutes(app: Hono<AppEnv>) {
  app.get("/api/mail/settings", (c) => c.json(emailSettings(c.get("user").id)));

  app.put("/api/mail/settings", async (c) => {
    const body = await parseJson(c.req.raw, emailPrefsPutSchema);
    const result = writeEmailPrefs(c.get("user").id, body);
    if (!result.ok) return c.json({ error: "Your email settings changed in another window. Reload and try again.", code: "PREFERENCES_CHANGED", prefs: result.current }, 409);
    return c.json(emailSettings(c.get("user").id));
  });

  // The one-time Today prompt for the digest (D248): whether to show it, and the card's answer.
  app.get("/api/mail/digest-prompt", (c) => c.json({ show: digestPromptVisible(c.get("user").id) }));
  app.post("/api/mail/digest-prompt", async (c) => {
    const body = await parseJson(c.req.raw, digestPromptSchema);
    const userId = c.get("user").id;
    // A cadence needs email on and a verified address, as the prompt itself does; dismissing always works.
    if (body.choice !== "dismiss" && !digestPromptVisible(userId)) return c.json({ error: "The email digest cannot be turned on from here. Use Settings → Notifications.", code: "PROMPT_NOT_AVAILABLE" }, 409);
    const result = answerDigestPrompt(userId, body);
    if (!result.ok) return c.json({ error: "Your email settings changed in another window. Reload and try again.", code: "PREFERENCES_CHANGED" }, 409);
    return c.json({ show: false, digest: result.prefs.digest, digestLocalTime: result.prefs.digestLocalTime, tz: result.prefs.tz });
  });

  app.post("/api/mail/verify/send", async (c) => {
    await parseJson(c.req.raw, emptySchema);
    const userId = c.get("user").id;
    if (!mailEnabled()) return c.json({ error: "Email is not configured", code: "NOT_CONFIGURED" }, 503);
    if (emailSettings(userId).verified) return c.json({ error: "Your address is already verified", code: "ALREADY_VERIFIED" }, 409);
    if (recentCount(userId, "account.verify") >= SELF_SERVE_HOURLY) return c.json({ error: "Too many verification emails. Try again in an hour.", code: "RATE_LIMITED" }, 429);
    enqueueVerifyMail(userId);
    return c.json({ queued: true });
  });

  // Mute emails from a board, calendar, or collection (§B.1 D249): the caller's own switch.
  app.get("/api/mail/mutes", (c) => c.json(listMutes(c.get("user").id)));
  const muteTargetOf = (c: Context<AppEnv>) => {
    const type = c.req.param("targetType") ?? "";
    const id = uuid.safeParse(c.req.param("targetId")?.toLowerCase()).data;
    return isMuteType(type) && id ? { type, id } : null;
  };
  app.put("/api/mail/mutes/:targetType/:targetId", async (c) => {
    const target = muteTargetOf(c);
    if (!target) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    await parseJson(c.req.raw, emptySchema);
    try {
      return c.json(muteTarget(c.get("user").id, target.type, target.id));
    } catch (error) {
      if (error instanceof MuteError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });
  app.delete("/api/mail/mutes/:targetType/:targetId", (c) => {
    const target = muteTargetOf(c);
    if (!target) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    return c.json(unmuteTarget(c.get("user").id, target.type, target.id));
  });

  // "Try again" after a bounce (§B.4): the owner clears their own address, once a day.
  app.post("/api/mail/suppression/clear", async (c) => {
    await parseJson(c.req.raw, emptySchema);
    const userId = c.get("user").id;
    const result = clearOwnSuppression(userId);
    if (result === "limited") return c.json({ error: "You can try again once a day.", code: "RATE_LIMITED" }, 429);
    if (result === "none") return c.json({ error: "Email to your address is not held back", code: "NOT_SUPPRESSED" }, 409);
    return c.json(emailSettings(userId));
  });

  app.post("/api/mail/test", async (c) => {
    await parseJson(c.req.raw, emptySchema);
    const userId = c.get("user").id;
    if (!mailEnabled()) return c.json({ error: "Email is not configured", code: "NOT_CONFIGURED" }, 503);
    const settings = emailSettings(userId);
    if (!settings.verified) return c.json({ error: "Verify your address first", code: "UNVERIFIED" }, 409);
    if (recentCount(userId, "account.test") >= SELF_SERVE_HOURLY) return c.json({ error: "Too many test emails. Try again in an hour.", code: "RATE_LIMITED" }, 429);
    const id = enqueueMail({ userId, template: "account.test", payload: {} })!;
    kickMailDispatch();
    return c.json({ queued: true, id });
  });
}

type LogRow = { id: string; user_id: string | null; to_hash: string; template: string; class: string; status: string; skip_reason: string | null; attempts: number; error_code: string | null; provider_id: string | null; created_at: string; sent_at: string | null; not_before: string; display_name: string | null; email: string | null };
const LOG_STATUSES = ["queued", "sending", "sent", "failed", "suppressed", "skipped", "dead"] as const;
const logQuery = z.object({
  status: z.enum(["all", "sent", "held", "failed", "dead", "skipped"]).optional(),
  cursor: z.string().max(80).optional()
});

/** Team → Email log (§D.4): ids, templates, statuses, and names or hashes; never an address, subject, or payload. */
export function mailLog(options: z.infer<typeof logQuery>) {
  const statuses: Record<string, readonly string[]> = { all: LOG_STATUSES, sent: ["sent"], held: ["queued", "sending"], failed: ["failed", "suppressed"], dead: ["dead"], skipped: ["skipped"] };
  const wanted = statuses[options.status ?? "all"]!;
  const [cursorAt, cursorId] = options.cursor?.split("|") ?? [];
  const rows = db.query(`SELECT o.id, o.user_id, o.to_hash, o.template, o.class, o.status, o.skip_reason, o.attempts, o.error_code, o.provider_id, o.created_at, o.sent_at, o.not_before, u.display_name, u.email
      FROM mail_outbox o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status IN (SELECT value FROM json_each($statuses)) AND ($cursorAt IS NULL OR o.created_at < $cursorAt OR (o.created_at = $cursorAt AND o.id < $cursorId))
      ORDER BY o.created_at DESC, o.id DESC LIMIT 51`)
    .all({ statuses: JSON.stringify(wanted), cursorAt: cursorAt ?? null, cursorId: cursorId ?? null }) as LogRow[];
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const counts = db.query(`SELECT
      SUM(CASE WHEN status = 'sent' AND sent_at > $since THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) AS held,
      SUM(CASE WHEN status IN ('failed','suppressed') AND created_at > $since THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'dead' AND created_at > $since THEN 1 ELSE 0 END) AS dead
    FROM mail_outbox`).get({ since }) as Record<string, number | null>;
  const page = rows.slice(0, 50);
  const last = page.at(-1);
  // Whether each recipient account's address is suppressed now (never the address itself).
  const suppressed = new Map<string, string | null>();
  for (const row of page) if (row.user_id && row.email && !suppressed.has(row.user_id)) suppressed.set(row.user_id, suppressionOf(row.email)?.reason ?? null);
  return {
    emailEnabled: mailEnabled(),
    today: { sent: counts.sent ?? 0, held: counts.held ?? 0, failed: counts.failed ?? 0, dead: counts.dead ?? 0, limit: config.mail.dailyLimit },
    entries: page.map((row) => ({
      id: row.id,
      template: row.template,
      class: row.class,
      status: row.status,
      skipReason: row.skip_reason,
      attempts: row.attempts,
      errorCode: row.error_code,
      providerId: row.provider_id,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      notBefore: row.status === "queued" ? row.not_before : null,
      to: row.user_id && row.display_name !== null ? { userId: row.user_id, displayName: row.display_name } : { hash: row.to_hash },
      /** The recipient address's suppression now: bounce, complaint, soft, manual, or null. */
      suppression: row.user_id ? suppressed.get(row.user_id) ?? null : null
    })),
    nextCursor: rows.length > 50 && last ? `${last.created_at}|${last.id}` : null
  };
}

/** Registered before /api/team/:userId so "mail-log" is never read as a user id. */
export function registerMailLogRoutes(app: Hono<AppEnv>) {
  const gate = (c: Context<AppEnv>) => {
    const user = c.get("user");
    if (!can(user.role, "team.read")) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (!can(user.role, "team.manage")) return c.json({ error: "Only admins can see the email log", code: "ADMIN_ONLY" }, 403);
    return null;
  };
  app.get("/api/team/mail-log", (c) => {
    const refused = gate(c);
    if (refused) return refused;
    const query = logQuery.parse({ status: c.req.query("status") || undefined, cursor: c.req.query("cursor") || undefined });
    return c.json(mailLog(query));
  });
  app.post("/api/team/mail-log/:id/retry", async (c) => {
    const refused = gate(c);
    if (refused) return refused;
    const id = uuid.safeParse(c.req.param("id")?.toLowerCase()).data;
    if (!id) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    await parseJson(c.req.raw, emptySchema);
    // One more attempt for a dead row that has a recipient account (invites are not queued).
    const result = db.query("UPDATE mail_outbox SET status = 'queued', not_before = ?, attempts = ?, claimed_at = NULL WHERE id = ? AND status = 'dead' AND user_id IS NOT NULL")
      .run(now(), MAX_ATTEMPTS - 1, id);
    if (result.changes !== 1) return c.json({ error: "Only a dead email can be retried", code: "NOT_RETRYABLE" }, 409);
    audit(c.get("user").id, null, "mail.retry", { outboxId: id });
    kickMailDispatch();
    return c.json({ ok: true });
  });
}

export { runMailDispatch };
