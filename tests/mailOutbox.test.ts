import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createUser, db } from "./support/harness";

const mail = await import("../server/mail");
const { enqueueMail, mergeIds, logSentMail, WINDOW_MS } = await import("../server/mail/outbox");
const { runMailDispatch, releaseStaleClaims, setMailJitterForTests, MAIL_CAPS, sweepMail, RETRY_BACKOFF_MS } = await import("../server/mail/dispatcher");
const { verifyUnsubscribeToken } = await import("../server/mail/unsubscribe");

/**
 * The outbox and dispatcher (outbound email plan §D, F.2): transactional enqueue, coalescing with a
 * max wait, send-time gates, durable caps, retries with the same idempotency key, dead letters,
 * crash recovery, List-Unsubscribe on activity mail only, and logs without addresses.
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
const HOUR = 3_600_000;

function transport(behaviour: () => "ok" | "fail4xx" | "fail5xx" = () => "ok") {
  const sent: Sent[] = [];
  const fn: import("../server/mail").MailTransport = async (message) => {
    sent.push(message);
    const mode = behaviour();
    if (mode === "fail4xx") throw new mail.MailProviderError("validation_error", 422);
    if (mode === "fail5xx") throw new mail.MailProviderError("internal_server_error", 500);
    return { id: `msg_${sent.length}` };
  };
  return { sent, fn };
}

let logs: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  mail.resetMailLimits();
  db.query("DELETE FROM mail_outbox").run();
  setMailJitterForTests(() => 0.5);
  logs = [];
  spies = (["info", "warn", "error"] as const).map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  mail.setMailTransportForTests(null);
  setMailJitterForTests(null);
  // No log line may carry an address (F.2 Logs).
  expect(logs.filter((line) => line.includes("@"))).toEqual([]);
});

async function verifiedUser(label: string) {
  const session = await createUser(label);
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}
const row = (id: string) => db.query("SELECT * FROM mail_outbox WHERE id = ?").get(id) as Record<string, any>;
const twoFactor = (userId: string, nowMs = Date.now()) => enqueueMail({ userId, template: "security.two_factor", payload: { event: "enabled", at: new Date(nowMs).toISOString(), remaining: null }, nowMs });

describe("enqueue", () => {
  test("nothing is queued while email is off", async () => {
    const user = await verifiedUser("Outbox off");
    expect(twoFactor(user.userId)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox").get()).toEqual({ count: 0 });
  });

  test("a rolled-back action leaves no row; a committed one stores ids only and the recipient hash", async () => {
    const user = await verifiedUser("Outbox tx");
    mail.setMailTransportForTests(transport().fn);
    expect(() => db.transaction(() => { twoFactor(user.userId); throw new Error("rollback"); })()).toThrow("rollback");
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox").get()).toEqual({ count: 0 });
    const id = db.transaction(() => enqueueMail({ userId: user.userId, template: "tasks.assigned", payload: { cardIds: ["c1"], actorIds: ["a1"] }, coalesceKey: `tasks.assigned:${user.userId}`, windowMs: WINDOW_MS.activity }))()!;
    const stored = row(id);
    expect(stored).toMatchObject({ status: "queued", class: "activity", category: "assignments", to_hash: mail.recipientHash(user.email), to_address: null, idempotency_key: id });
    expect(JSON.parse(stored.payload)).toEqual({ cardIds: ["c1"], actorIds: ["a1"] });
  });

  test("coalescing merges into the queued row without extending its window (max wait)", async () => {
    const user = await verifiedUser("Outbox coalesce");
    mail.setMailTransportForTests(transport().fn);
    const start = Date.parse("2026-09-28T10:00:00.000Z");
    const add = (cardId: string, minutes: number) => enqueueMail({
      userId: user.userId, template: "tasks.assigned", payload: { cardIds: [cardId], actorIds: ["a"] }, coalesceKey: `tasks.assigned:${user.userId}`, windowMs: WINDOW_MS.activity,
      merge: (queued, incoming) => ({ cardIds: mergeIds(queued.cardIds, incoming.cardIds), actorIds: mergeIds(queued.actorIds, incoming.actorIds) }), nowMs: start + minutes * 60_000
    });
    const first = add("c1", 0);
    for (const [index, minutes] of [1, 3, 5, 8, 9].entries()) expect(add(`c${index + 2}`, minutes)).toBe(first);
    add("c1", 9);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox").get()).toEqual({ count: 1 });
    expect(new Set(JSON.parse(row(first!).payload).cardIds)).toEqual(new Set(["c1", "c2", "c3", "c4", "c5", "c6"]));
    expect(row(first!).not_before).toBe(new Date(start + WINDOW_MS.activity).toISOString());
    expect(mergeIds(Array.from({ length: 60 }, (_, index) => `x${index}`), ["y"]).length).toBe(50);
  });

  test("quiet hours move activity to the quiet end in the stored zone; security is never held", async () => {
    const user = await verifiedUser("Outbox quiet");
    mail.setMailTransportForTests(transport().fn);
    db.query("INSERT INTO email_prefs (user_id, quiet_start, quiet_end, tz, updated_at) VALUES (?, '22:00', '07:30', 'Europe/Berlin', ?)").run(user.userId, new Date().toISOString());
    // 23:00 in Berlin (CEST, UTC+2) on 28 Sep = 21:00 UTC; quiet ends 07:30 Berlin = 05:30 UTC next day.
    const at = Date.parse("2026-09-28T21:00:00.000Z");
    const activity = enqueueMail({ userId: user.userId, template: "account.test", payload: {}, nowMs: at })!;
    expect(row(activity).not_before).toBe(new Date(at).toISOString());
    const assigned = enqueueMail({ userId: user.userId, template: "tasks.assigned", payload: { cardIds: [], actorIds: [] }, nowMs: at })!;
    expect(row(assigned).not_before).toBe("2026-09-29T05:30:00.000Z");
    expect(row(twoFactor(user.userId, at)!).not_before).toBe(new Date(at).toISOString());
  });
});

describe("dispatch", () => {
  test("sends with the row id as idempotency key, then drops the payload", async () => {
    const user = await verifiedUser("Dispatch send");
    const { sent, fn } = transport();
    mail.setMailTransportForTests(fn);
    const id = twoFactor(user.userId)!;
    expect(await runMailDispatch()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: user.email, idempotencyKey: id, subject: "Two-factor authentication is on" });
    expect(sent[0]!.headers).toBeUndefined();
    expect(row(id)).toMatchObject({ status: "sent", provider_id: "msg_1", attempts: 1, payload: "{}" });
    expect(logs.join("\n")).toContain(`Mail sent: purpose=security.two_factor recipient=${mail.recipientHash(user.email)} id=msg_1`);
  });

  test("gates: unverified gets only verify and security; blocked gets only security; prefs off skips", async () => {
    const { sent, fn } = transport();
    mail.setMailTransportForTests(fn);
    const unverified = await createUser("Dispatch unverified");
    const skippedTest = enqueueMail({ userId: unverified.userId, template: "account.test", payload: {} })!;
    const verify = enqueueMail({ userId: unverified.userId, template: "account.verify", payload: {} })!;
    const security = twoFactor(unverified.userId)!;
    const blocked = await verifiedUser("Dispatch blocked");
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), blocked.userId);
    const blockedTest = enqueueMail({ userId: blocked.userId, template: "account.test", payload: {} })!;
    const blockedSecurity = enqueueMail({ userId: blocked.userId, template: "security.account", payload: { event: "blocked", actorId: null, at: new Date().toISOString() } })!;
    const off = await verifiedUser("Dispatch prefs off");
    db.query("INSERT INTO email_prefs (user_id, enabled, updated_at) VALUES (?, 0, ?)").run(off.userId, new Date().toISOString());
    const offActivity = enqueueMail({ userId: off.userId, template: "inbox.proposals", payload: {} })!;
    const offSecurity = twoFactor(off.userId)!;
    await runMailDispatch();
    expect(row(skippedTest)).toMatchObject({ status: "skipped", skip_reason: "unverified" });
    expect(row(verify).status).toBe("sent");
    expect(row(security).status).toBe("sent");
    expect(row(blockedTest)).toMatchObject({ status: "skipped", skip_reason: "blocked" });
    expect(row(blockedSecurity).status).toBe("sent");
    expect(row(offActivity)).toMatchObject({ status: "skipped", skip_reason: "prefs_off" });
    expect(row(offSecurity).status).toBe("sent");
    // The verify mail's token is in the fragment only, and stored hashed (T220).
    const verifyMail = sent.find((message) => message.subject.startsWith("Verify"))!;
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(verifyMail.text)![1]!;
    expect(verifyMail.html).not.toContain(`?token=`);
    expect(db.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE user_id = ? AND token_hash = ?").get(unverified.userId, new Bun.CryptoHasher("sha256").update(token).digest("hex"))).toEqual({ count: 1 });
    expect(JSON.stringify(db.query("SELECT * FROM mail_outbox").all())).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
  });

  test("a suppressed address gets security mail only; a card the recipient cannot read is skipped as access_lost", async () => {
    mail.setMailTransportForTests(transport().fn);
    const suppressed = await verifiedUser("Dispatch suppressed");
    db.query("INSERT INTO mail_suppressions (address_hash, reason, created_at) VALUES (?, 'bounce', ?)").run(mail.addressHash(suppressed.email), new Date().toISOString());
    const id = enqueueMail({ userId: suppressed.userId, template: "account.test", payload: {} })!;
    const security = twoFactor(suppressed.userId)!;
    const reader = await verifiedUser("Dispatch access");
    const lost = enqueueMail({ userId: reader.userId, template: "tasks.assigned", payload: { cardIds: [crypto.randomUUID()], actorIds: [] } })!;
    await runMailDispatch();
    expect(row(id).status).toBe("suppressed");
    // Wave 29 (§B.4): security mail still reaches a bounced address; it protects the account.
    expect(row(security).status).toBe("sent");
    expect(row(lost)).toMatchObject({ status: "skipped", skip_reason: "access_lost", payload: "{}" });
  });

  test("activity mail carries List-Unsubscribe headers with a token that verifies; security does not", async () => {
    const user = await verifiedUser("Dispatch unsubscribe");
    const { sent, fn } = transport();
    mail.setMailTransportForTests(fn);
    db.query("INSERT INTO proposals (id, owner_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at) VALUES (?, ?, 'laptop', 'card_comment', 'card', ?, 'Agent title never mailed', '{}', ?, ?)")
      .run(crypto.randomUUID(), user.userId, crypto.randomUUID(), new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    enqueueMail({ userId: user.userId, template: "inbox.proposals", payload: {} });
    await runMailDispatch();
    const message = sent[0]!;
    expect(message.subject).toBe("Key “laptop” suggested 1 change");
    expect(message.html + message.text).not.toContain("Agent title never mailed");
    expect(message.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const token = /[?&]t=([^>]+)>/.exec(message.headers!["List-Unsubscribe"]!)![1]!;
    expect(await verifyUnsubscribeToken(token)).toEqual({ userId: user.userId, category: "proposals" });
    expect(message.text).toContain(`/mail/unsubscribe#t=${token}`);
  });

  test("retries: 5xx backs off with the same key, then dies after 5 attempts; 4xx dies at once", async () => {
    const user = await verifiedUser("Dispatch retry");
    const failing = transport(() => "fail5xx");
    mail.setMailTransportForTests(failing.fn);
    const start = Date.now();
    const id = twoFactor(user.userId, start)!;
    let clock = start;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runMailDispatch({ nowMs: clock });
      const current = row(id);
      expect(current.attempts).toBe(attempt + 1);
      if (attempt < 4) {
        expect(current.status).toBe("queued");
        expect(Date.parse(current.not_before) - clock).toBe(RETRY_BACKOFF_MS[attempt]);
        clock = Date.parse(current.not_before);
      }
    }
    expect(row(id)).toMatchObject({ status: "dead", error_code: "internal_server_error" });
    expect(new Set(failing.sent.map((message) => message.idempotencyKey))).toEqual(new Set([id]));

    mail.resetMailLimits();
    mail.setMailTransportForTests(transport(() => "fail4xx").fn);
    const invalid = twoFactor(user.userId)!;
    await runMailDispatch();
    expect(row(invalid)).toMatchObject({ status: "dead", attempts: 1, error_code: "validation_error" });
  });

  test("a crash mid-send is released on boot and resent with the same key", async () => {
    const user = await verifiedUser("Dispatch crash");
    const { sent, fn } = transport();
    mail.setMailTransportForTests(fn);
    const id = twoFactor(user.userId)!;
    db.query("UPDATE mail_outbox SET status = 'sending', claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60_000).toISOString(), id);
    expect(await runMailDispatch()).toMatchObject({ sent: 0 });
    expect(releaseStaleClaims()).toBe(1);
    await runMailDispatch();
    expect(sent.map((message) => message.idempotencyKey)).toEqual([id]);
  });

  test("durable caps: the 13th activity mail in an hour is held, not dropped; security has its own cap", async () => {
    const user = await verifiedUser("Dispatch caps");
    mail.setMailTransportForTests(transport().fn);
    const nowMs = Date.now();
    for (let index = 0; index < MAIL_CAPS.activityHour; index += 1) {
      db.query(`INSERT INTO mail_outbox (id, user_id, to_hash, template, class, category, payload, idempotency_key, status, not_before, created_at, sent_at)
        VALUES (?, ?, 'abcdefabcdef', 'inbox.proposals', 'activity', 'proposals', '{}', ?, 'sent', ?, ?, ?)`).run(`cap-${index}`, user.userId, `cap-${index}`, new Date(nowMs).toISOString(), new Date(nowMs - 30 * 60_000).toISOString(), new Date(nowMs - (30 - index) * 60_000).toISOString());
    }
    const held = enqueueMail({ userId: user.userId, template: "account.test", payload: {}, nowMs })!;
    db.query("UPDATE mail_outbox SET class = 'activity', category = 'sharing', template = 'sharing.shared', payload = ? WHERE id = ?").run(JSON.stringify({ items: [], actorIds: [] }), held);
    const security = twoFactor(user.userId, nowMs)!;
    await runMailDispatch({ nowMs });
    expect(row(held).status).toBe("queued");
    expect(Date.parse(row(held).not_before)).toBe(nowMs - 30 * 60_000 + HOUR);
    expect(row(security).status).toBe("sent");
  });

  test("invites sent synchronously are logged as sent or failed, with no address; the sweeper keeps 30/90 days", async () => {
    const sentId = logSentMail({ template: "team.invite", to: "someone@example.test", outcome: { sent: true, id: "msg_x" } });
    const failedId = logSentMail({ template: "team.invite", to: "someone@example.test", outcome: { sent: false, reason: "failed", code: "timeout" } });
    expect(row(sentId)).toMatchObject({ user_id: null, to_address: null, status: "sent", class: "account", provider_id: "msg_x", to_hash: mail.recipientHash("someone@example.test") });
    expect(row(failedId)).toMatchObject({ status: "failed", error_code: "timeout" });
    expect(JSON.stringify(row(sentId))).not.toContain("someone@");
    const later = Date.now() + 31 * 86_400_000;
    expect(sweepMail(later).outbox).toBe(1);
    expect(row(failedId).status).toBe("failed");
    expect(sweepMail(Date.now() + 91 * 86_400_000).outbox).toBe(1);
  });
});
