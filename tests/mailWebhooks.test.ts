import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createUser, db, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { resetMailRouteLimits } = await import("../server/mail/routes");
const { setWebhookSecretForTests, WEBHOOK_BODY_LIMIT } = await import("../server/mail/webhooks");
const { recordSoftBounce, suppressionOf, SOFT_SUPPRESS_MS } = await import("../server/mail/suppression");
const { enqueueMail } = await import("../server/mail/outbox");
const { mailTwoFactor } = await import("../server/mail/triggers");

/**
 * Resend webhooks and suppression (outbound email §B.4, T229): the signature over the raw body,
 * replay protection by svix-id, hard and soft bounces, complaints, "Try again", and what the Email
 * log and the dispatcher do with a suppressed address. The secret is a fake placeholder.
 */

const SECRET = `whsec_${Buffer.alloc(24, 9).toString("base64")}`;
const KEY = Buffer.from(SECRET.slice("whsec_".length), "base64");

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  resetMailRouteLimits();
  db.query("DELETE FROM mail_outbox").run();
  db.query("DELETE FROM mail_webhook_events").run();
  db.query("DELETE FROM mail_suppressions").run();
  db.query("DELETE FROM mail_soft_bounces").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
  setWebhookSecretForTests(SECRET);
});
afterEach(() => {
  mail.setMailTransportForTests(null);
  setWebhookSecretForTests(null);
});

/** Signs like Resend (Svix / standardwebhooks): base64(HMAC-SHA256(key, "id.timestamp.body")). */
function sign(id: string, timestamp: number, body: string) {
  return `v1,${createHmac("sha256", KEY).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

async function deliver(event: unknown, options: { id?: string; timestamp?: number; body?: string; signature?: string } = {}) {
  const body = options.body ?? JSON.stringify(event);
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const response = await request("/mail/webhook", {
    method: "POST",
    body,
    headers: { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": options.signature ?? sign(id, timestamp, JSON.stringify(event)) }
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, id };
}

const bounce = (to: string, type = "Permanent", emailId = "em_1") => ({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], subject: "x", from: "nook@example.test", created_at: new Date().toISOString(), bounce: { type, subType: "General", message: "placeholder" } } });

async function person(label: string) {
  const session = await createUser(label);
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

describe("the webhook endpoint", () => {
  test("is 404 when no secret is set", async () => {
    setWebhookSecretForTests(null);
    const result = await deliver(bounce("nobody@example.test"));
    expect(result.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_webhook_events").get()).toEqual({ count: 0 });
  });

  test("a bad signature, a changed body, a stale timestamp, or missing headers is 401 and stores nothing", async () => {
    const event = bounce("victim@example.test");
    expect((await deliver(event, { signature: "v1,AAAA" })).status).toBe(401);
    // Raw body: whitespace added after signing breaks the signature.
    expect((await deliver(event, { body: JSON.stringify(event, null, 2) })).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await deliver(event, { timestamp: old, signature: sign("msg_old", old, JSON.stringify(event)), id: "msg_old" })).status).toBe(401);
    const bare = await request("/mail/webhook", { method: "POST", body: JSON.stringify(event) });
    expect(bare.status).toBe(401);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_webhook_events").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_suppressions").get()).toEqual({ count: 0 });
  });

  test("a body over 64 KiB is refused before verification", async () => {
    const huge = { type: "email.delivered", data: { pad: "x".repeat(WEBHOOK_BODY_LIMIT) } };
    expect((await deliver(huge)).status).toBe(413);
  });

  test("a hard bounce suppresses the address; a replayed svix-id is a no-op", async () => {
    const user = await person("Bounce Hard");
    const event = bounce(user.email.toUpperCase());
    const first = await deliver(event);
    expect(first).toMatchObject({ status: 200, body: { ok: true } });
    expect(suppressionOf(user.email)).toMatchObject({ reason: "bounce", until: null });
    // A replay of the same delivery changes nothing, even after the suppression was cleared.
    db.query("DELETE FROM mail_suppressions").run();
    const replay = await deliver(event, { id: first.id });
    expect(replay).toEqual({ status: 200, body: { ok: true, duplicate: true }, id: first.id });
    expect(suppressionOf(user.email)).toBeNull();
    // Only the id, type-free, is stored; no address or payload.
    expect(db.query("SELECT svix_id FROM mail_webhook_events").all()).toEqual([{ svix_id: first.id }]);
  });

  test("complaints and Resend suppressions suppress; delivered and opened are ignored (no tracking)", async () => {
    const complainer = await person("Bounce Complaint");
    const other = await person("Bounce Delivered");
    await deliver({ type: "email.complained", data: { email_id: "em_2", to: [complainer.email] } });
    expect(suppressionOf(complainer.email)?.reason).toBe("complaint");
    for (const type of ["email.delivered", "email.opened", "email.clicked", "email.delivery_delayed"]) {
      expect((await deliver({ type, data: { email_id: "em_3", to: [other.email] } })).status).toBe(200);
    }
    expect(suppressionOf(other.email)).toBeNull();
    const suppressed = await person("Bounce Provider");
    await deliver({ type: "email.suppressed", data: { email_id: "em_4", to: [suppressed.email], suppressed: { type: "OnAccountSuppressionList", message: "x" } } });
    expect(suppressionOf(suppressed.email)?.reason).toBe("bounce");
  });

  test("email.failed marks the sent outbox row by its provider id", async () => {
    const user = await person("Bounce Failed");
    enqueueMail({ userId: user.userId, template: "account.test", payload: {} });
    await runMailDispatch();
    const row = db.query("SELECT provider_id FROM mail_outbox WHERE user_id = ?").get(user.userId) as { provider_id: string };
    await deliver({ type: "email.failed", data: { email_id: row.provider_id, to: [user.email], failed: { reason: "x" } } });
    expect(db.query("SELECT status, error_code FROM mail_outbox WHERE user_id = ?").get(user.userId)).toEqual({ status: "failed", error_code: "provider_failed" });
  });
});

describe("suppression", () => {
  test("a suppressed address gets security mail but no other mail", async () => {
    const user = await person("Suppressed Mail");
    await deliver(bounce(user.email));
    enqueueMail({ userId: user.userId, template: "account.test", payload: {} });
    mailTwoFactor(user.userId, "enabled");
    await runMailDispatch();
    expect(sent.filter((message) => message.to === user.email).map((message) => message.subject)).toEqual(["Two-factor authentication is on"]);
    expect(db.query("SELECT template, status, skip_reason FROM mail_outbox WHERE user_id = ? ORDER BY template").all(user.userId)).toEqual([
      { template: "account.test", status: "suppressed", skip_reason: "suppressed" },
      { template: "security.two_factor", status: "sent", skip_reason: null }
    ]);
  });

  test("soft bounces count; the third within a week holds mail for three days, then clears itself", async () => {
    const user = await person("Soft Bounce");
    await deliver(bounce(user.email, "Transient"));
    await deliver(bounce(user.email, "Undetermined"));
    expect(suppressionOf(user.email)).toBeNull();
    await deliver(bounce(user.email, "Transient"));
    const state = suppressionOf(user.email)!;
    expect(state.reason).toBe("soft");
    expect(Date.parse(state.until!) - Date.now()).toBeGreaterThan(SOFT_SUPPRESS_MS - 60_000);
    enqueueMail({ userId: user.userId, template: "account.test", payload: {} });
    await runMailDispatch();
    expect(db.query("SELECT status, skip_reason FROM mail_outbox WHERE user_id = ?").get(user.userId)).toEqual({ status: "suppressed", skip_reason: "soft_bounce" });
    expect(suppressionOf(user.email, Date.now() + SOFT_SUPPRESS_MS + 1000)).toBeNull();
    // Counts older than a week start over.
    const hash = mail.addressHash("old@example.test");
    recordSoftBounce(hash, Date.now() - 8 * 86_400_000);
    recordSoftBounce(hash, Date.now() - 8 * 86_400_000);
    expect(recordSoftBounce(hash)).toEqual({ count: 1, suppressed: false });
  });

  test("Settings shows the bounced state; Try again clears it once a day", async () => {
    const user = await person("Try Again");
    expect((await call(user, "POST", "/mail/suppression/clear")).body.code).toBe("NOT_SUPPRESSED");
    await deliver(bounce(user.email, "Transient"));
    await deliver(bounce(user.email, "Transient"));
    await deliver(bounce(user.email, "Transient"));
    const settings = await call(user, "GET", "/mail/settings");
    expect(settings.body).toMatchObject({ suppressed: true, suppression: { reason: "soft" } });
    const cleared = await call(user, "POST", "/mail/suppression/clear");
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ suppressed: false, suppression: null });
    await deliver(bounce(user.email));
    expect((await call(user, "POST", "/mail/suppression/clear")).body.code).toBe("RATE_LIMITED");
    expect(suppressionOf(user.email)?.reason).toBe("bounce");
  });

  test("the Email log shows each recipient's suppression, never the address", async () => {
    const admin = await person("Log Admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const user = await person("Log Bounced");
    enqueueMail({ userId: user.userId, template: "account.test", payload: {} });
    await runMailDispatch();
    await deliver(bounce(user.email, "Permanent", (db.query("SELECT provider_id FROM mail_outbox WHERE user_id = ?").get(user.userId) as { provider_id: string }).provider_id));
    const log = await call(admin, "GET", "/team/mail-log");
    const entry = log.body.entries.find((item: { to: { userId?: string } }) => item.to.userId === user.userId);
    expect(entry).toMatchObject({ status: "failed", errorCode: "bounced", suppression: "bounce" });
    expect(JSON.stringify(log.body)).not.toContain("@");
  });
});
