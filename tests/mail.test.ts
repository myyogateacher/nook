import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, db, request, spareEmail, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { inviteEmail, formatExpiry } = await import("../server/team/inviteEmail");
const { resetInviteRateLimits, hashInviteToken } = await import("../server/team/invites");
const { resetTeamRateLimits } = await import("../server/team/routes");
const { config, isMailFrom } = await import("../server/config");

type Sent = Parameters<import("../server/mail").MailTransport>[0];

/** Captures console output so tests can prove no address, token, or key reaches the logs. */
function captureLogs() {
  const lines: string[] = [];
  const spies = (["info", "warn", "error", "log"] as const).map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
  return { lines, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

function fakeTransport(behaviour: "ok" | "fail" | "hang" = "ok") {
  const sent: Sent[] = [];
  const transport: import("../server/mail").MailTransport = async (message, signal) => {
    sent.push(message);
    if (behaviour === "fail") throw new mail.MailProviderError("validation_error", 422);
    if (behaviour === "hang") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return { id: `msg_${sent.length}` };
  };
  return { sent, transport };
}

beforeEach(() => {
  mail.resetMailLimits();
  resetInviteRateLimits();
  resetTeamRateLimits();
});
afterEach(() => mail.setMailTransportForTests(null));

describe("mail wrapper", () => {
  test("is off in the test configuration, and off answers not_configured without sending", async () => {
    expect(config.mail).toMatchObject({ enabled: false, apiKey: null, from: null });
    expect(mail.mailEnabled()).toBe(false);
    expect(await mail.sendMail({ to: "a@example.test", subject: "S", text: "T" }, { purpose: "test", senderId: null })).toEqual({ sent: false, reason: "not_configured" });
  });

  test("config: on only with both variables, a bad MAIL_FROM refuses to boot, and the key is never printed", () => {
    const configPath = join(import.meta.dir, "..", "server", "config.ts");
    const mailPath = join(import.meta.dir, "..", "server", "mail.ts");
    const load = (env: Record<string, string>) => {
      const result = Bun.spawnSync(["bun", "--no-env-file", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); await import(${JSON.stringify(mailPath)}); console.log(JSON.stringify({ enabled: config.mail.enabled, from: config.mail.from }));`], {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-mail-config-test"), APP_ORIGIN: "https://nook.example.com", ...env },
        stdout: "pipe",
        stderr: "pipe"
      });
      return { ok: result.exitCode === 0, out: result.stdout.toString(), err: result.stderr.toString() };
    };
    const key = "re_placeholder_not_a_real_key";
    const both = load({ RESEND_API_KEY: key, MAIL_FROM: "Nook <nook@example.com>" });
    expect(JSON.parse(both.out.trim().split("\n").at(-1)!)).toEqual({ enabled: true, from: "Nook <nook@example.com>" });
    const keyOnly = load({ RESEND_API_KEY: key });
    expect(JSON.parse(keyOnly.out.trim().split("\n").at(-1)!)).toEqual({ enabled: false, from: null });
    expect(keyOnly.err + keyOnly.out).toContain("Email is off: set both RESEND_API_KEY and MAIL_FROM");
    expect(JSON.parse(load({ MAIL_FROM: "nook@example.com" }).out.trim().split("\n").at(-1)!)).toEqual({ enabled: false, from: "nook@example.com" });
    const bad = load({ RESEND_API_KEY: key, MAIL_FROM: "Nook" });
    expect(bad.ok).toBe(false);
    expect(bad.err).toContain("MAIL_FROM must be");
    expect(load({ RESEND_API_KEY: "has space", MAIL_FROM: "nook@example.com" }).ok).toBe(false);
    for (const run of [both, keyOnly, bad]) expect(run.out + run.err).not.toContain(key);
    // Links must work for recipients (§D.7): never localhost, http only when allowed.
    const mailOn = { RESEND_API_KEY: key, MAIL_FROM: "nook@example.com" };
    const enabled = (run: { out: string }) => (JSON.parse(run.out.trim().split("\n").at(-1)!) as { enabled: boolean }).enabled;
    expect(enabled(load({ ...mailOn, APP_ORIGIN: "http://localhost:2026" }))).toBe(false);
    expect(enabled(load({ ...mailOn, APP_ORIGIN: "http://localhost:2026", MAIL_ALLOW_HTTP_LINKS: "true" }))).toBe(false);
    expect(enabled(load({ ...mailOn, APP_ORIGIN: "http://nook.lan:2026" }))).toBe(false);
    expect(enabled(load({ ...mailOn, APP_ORIGIN: "http://nook.lan:2026", MAIL_ALLOW_HTTP_LINKS: "true" }))).toBe(true);
    // The development file transport, and the new settings' validation.
    expect(enabled(load({ MAIL_TRANSPORT: "file", MAIL_FILE_PATH: join(tmpdir(), "mynotes-mail-file-test.json"), APP_ORIGIN: "http://localhost:2026" }))).toBe(true);
    expect(load({ MAIL_TRANSPORT: "file", MAIL_FILE_PATH: "/tmp/x.json", NODE_ENV: "production" }).ok).toBe(false);
    expect(load({ MAIL_TRANSPORT: "file" }).ok).toBe(false);
    expect(load({ MAIL_TRANSPORT: "smtp" }).ok).toBe(false);
    expect(load({ MAIL_DAILY_LIMIT: "0" }).ok).toBe(false);
    expect(load({ MAIL_DAILY_LIMIT: "100" }).ok).toBe(true);
    expect(load({ MAIL_INSTANCE_NAME: "x".repeat(41) }).ok).toBe(false);
    expect(load({ MAIL_ALLOW_HTTP_LINKS: "yes" }).ok).toBe(false);
    // Webhook signing secrets use Resend's whsec_ form (placeholder values only).
    expect(load({ RESEND_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" }).ok).toBe(true);
    expect(load({ RESEND_WEBHOOK_SECRET: "not-a-secret" }).ok).toBe(false);
    expect(load({ ...mailOn, MAIL_FROM: "a@b.c <nook@example.com>" }).ok).toBe(false);
  }, 60_000);

  test("MAIL_FROM accepts an address or a display name with an address, and nothing else", () => {
    expect(isMailFrom("nook@example.com")).toBe(true);
    expect(isMailFrom("Nook <nook@example.com>")).toBe(true);
    for (const bad of ["Nook", "<nook@example.com>", "Nook <nook@example.com", "a@b.c\r\nBcc: x@y.z", "Nook <a@b.c>, Other <d@e.f>", "Nook <a b@c.d>"]) expect({ bad, ok: isMailFrom(bad) }).toEqual({ bad, ok: false });
  });

  test("sends through the transport and logs only a hashed recipient and the message id", async () => {
    const { sent, transport } = fakeTransport();
    mail.setMailTransportForTests(transport, "Nook <nook@example.test>");
    const logs = captureLogs();
    try {
      const outcome = await mail.sendMail({ to: " Someone@Example.test ", subject: "Secret subject", text: "secret body https://x/register#invite=abc", html: "<p>secret</p>" }, { purpose: "test", senderId: "sender-1" });
      expect(outcome).toEqual({ sent: true, id: "msg_1" });
    } finally {
      logs.restore();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "Someone@Example.test", from: "Nook <nook@example.test>", subject: "Secret subject", html: "<p>secret</p>" });
    expect(sent[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs.lines).toEqual([`Mail sent: purpose=test recipient=${mail.recipientHash("someone@example.test")} id=msg_1`]);
    for (const secret of ["Someone", "example.test", "Secret subject", "secret body", "invite="]) expect(logs.lines.join("\n")).not.toContain(secret);
  });

  test("provider failures and timeouts answer failed, logged without the address", async () => {
    const failing = fakeTransport("fail");
    mail.setMailTransportForTests(failing.transport);
    const logs = captureLogs();
    try {
      expect(await mail.sendMail({ to: "fail@example.test", subject: "S", text: "T" }, { purpose: "test", senderId: null })).toEqual({ sent: false, reason: "failed", code: "validation_error", retryable: false });
      const hanging = fakeTransport("hang");
      mail.setMailTransportForTests(hanging.transport);
      const started = Date.now();
      expect(await mail.sendMail({ to: "slow@example.test", subject: "S", text: "T" }, { purpose: "test", senderId: null, timeoutMs: 50 })).toEqual({ sent: false, reason: "failed", code: "timeout", retryable: true });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      logs.restore();
    }
    expect(logs.lines).toEqual([
      `Mail failed: purpose=test recipient=${mail.recipientHash("fail@example.test")} error=validation_error status=422`,
      `Mail failed: purpose=test recipient=${mail.recipientHash("slow@example.test")} error=timeout`
    ]);
    expect(mail.MAIL_TIMEOUT_MS).toBe(10_000);
  });

  test("the Resend SDK never logs a provider error body; only status and a hashed recipient are logged (L3)", async () => {
    // A fake provider that fails the way Resend does, quoting the recipient in its error body.
    const provider = Bun.serve({
      port: 0,
      fetch: () => Response.json({ name: "validation_error", statusCode: 422, message: "Invalid `to` field: leak@example.test" }, { status: 422 })
    });
    mail.setMailTransportForTests(mail.resendTransport("re_placeholder", `http://localhost:${provider.port}`));
    expect(process.env.NODE_ENV).not.toBe("production");
    const logs = captureLogs();
    try {
      expect(await mail.sendMail({ to: "leak@example.test", subject: "S", text: "T" }, { purpose: "test", senderId: null })).toEqual({ sent: false, reason: "failed", code: "validation_error", retryable: false });
    } finally {
      logs.restore();
      provider.stop(true);
    }
    expect(logs.lines).toEqual([`Mail failed: purpose=test recipient=${mail.recipientHash("leak@example.test")} error=validation_error status=422`]);
    for (const secret of ["leak@example.test", "Resend API Error", "re_placeholder"]) expect(logs.lines.join("\n")).not.toContain(secret);
  });

  test("rate limits: 5 an hour per bare address, 20 per account address, 20 per sender, MAIL_DAILY_LIMIT per instance", async () => {
    const { sent, transport } = fakeTransport();
    mail.setMailTransportForTests(transport);
    const logs = captureLogs();
    const send = (to: string, senderId: string | null, recipient: "user" | "address" = "address") => mail.sendMail({ to, subject: "S", text: "T" }, { purpose: "test", senderId, recipient });
    try {
      for (let index = 0; index < 5; index += 1) expect((await send("same@example.test", "s1")).sent).toBe(true);
      expect(await send("SAME@example.test", "s2")).toEqual({ sent: false, reason: "rate_limited" });
      for (let index = 0; index < 20; index += 1) expect((await send("member@example.test", null, "user")).sent).toBe(true);
      expect(await send("member@example.test", null, "user")).toEqual({ sent: false, reason: "rate_limited" });
      for (let index = 5; index < 20; index += 1) expect((await send(`r${index}@example.test`, "s1")).sent).toBe(true);
      expect(await send("fresh@example.test", "s1")).toEqual({ sent: false, reason: "rate_limited" });
      expect((await send("fresh@example.test", "s2")).sent).toBe(true);
      // A refused attempt takes no slot from the other limits.
      mail.resetMailLimits();
      expect(mail.MAIL_LIMITS.perInstanceDay).toBe(config.mail.dailyLimit);
      for (let index = 0; index < config.mail.dailyLimit; index += 1) expect((await send(`bulk${index}@example.test`, null)).sent).toBe(true);
      expect(await send("last@example.test", null)).toEqual({ sent: false, reason: "rate_limited" });
    } finally {
      logs.restore();
    }
    expect(sent).toHaveLength(41 + config.mail.dailyLimit);
    expect(logs.lines.filter((line) => line.includes("rate_limited")).every((line) => !line.includes("@"))).toBe(true);
  });

  test("the idempotency key is the caller's, so a retry reuses it; headers pass through", async () => {
    const { sent, transport } = fakeTransport();
    mail.setMailTransportForTests(transport);
    const logs = captureLogs();
    try {
      await mail.sendMail({ to: "k@example.test", subject: "S", text: "T", headers: { "List-Unsubscribe": "<https://nook.test/x>" } }, { purpose: "test", senderId: null, idempotencyKey: "row-1" });
      await mail.sendMail({ to: "k@example.test", subject: "S", text: "T" }, { purpose: "test", senderId: null, idempotencyKey: "row-1" });
    } finally {
      logs.restore();
    }
    expect(sent.map((item) => item.idempotencyKey)).toEqual(["row-1", "row-1"]);
    expect(sent[0]!.headers).toEqual({ "List-Unsubscribe": "<https://nook.test/x>" });
  });

  test("the file transport appends each message to a JSON array", async () => {
    const path = join(tmpdir(), `mynotes-mail-file-${crypto.randomUUID()}.json`);
    const transport = mail.fileTransport(path);
    await transport({ to: "a@example.test", from: "Nook <n@example.test>", subject: "One", text: "T", idempotencyKey: "k1" }, new AbortController().signal);
    await transport({ to: "b@example.test", from: "Nook <n@example.test>", subject: "Two", text: "T", idempotencyKey: "k2" }, new AbortController().signal);
    const list = JSON.parse(await Bun.file(path).text()) as Array<{ subject: string; idempotencyKey: string }>;
    expect(list.map((item) => item.subject)).toEqual(["One", "Two"]);
    await Bun.file(path).delete();
  });

  test("the invite template: link in fragment form, role, expiry, inviter name only, escaped, no tracking", () => {
    const url = `http://localhost/register#invite=${"a".repeat(43)}`;
    const message = inviteEmail({ to: "dana@example.test", url, role: "viewer", expiresAt: "2026-10-05T10:00:00.000Z", inviterName: "Asha <script>\r\nBcc: x" });
    expect(message.to).toBe("dana@example.test");
    expect(message.subject).toBe("Asha <script> Bcc: x invited you to Nook");
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text).toContain(url);
    expect(message.text).toContain("as a Viewer");
    expect(message.text).toContain("expires on Mon 5 Oct 2026, 10:00 (UTC)");
    expect(formatExpiry("2026-10-05T10:00:00.000Z")).toBe("5 October 2026 at 10:00 UTC");
    expect(message.html).toContain(`href="${url}"`);
    expect(message.html).toContain("Asha &lt;script&gt;");
    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toMatch(/<img|<link|src=|\?invite=/i);
    // The invite link is the only link (the invitee has no settings to open).
    expect([...message.html!.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([url, url, url]);
  });
});

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body: unknown = {}) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}
// Never a registered address: spares come from the end of the list, past the sequential block.
const bound = spareEmail;

describe("emailing invites", () => {
  beforeEach(() => { db.query("DELETE FROM team_invites").run(); });

  test("with email off, create still succeeds and says so; the list reports emailEnabled", async () => {
    const admin = await user("Mail off admin", "admin");
    const created = await call(admin, "POST", "/team/invites", { role: "viewer", email: bound(), sendEmail: true });
    expect(created.status).toBe(201);
    expect(created.body.email).toEqual({ sent: false, reason: "not_configured" });
    expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call(admin, "GET", "/team/invites")).body.emailEnabled).toBe(false);
    const resent = await call(admin, "POST", `/team/invites/${created.body.invite.id}/email`, {});
    expect(resent.status).toBe(200);
    expect(resent.body.email).toEqual({ sent: false, reason: "not_configured" });
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'team.invite_emailed'").get()).toEqual({ count: 0 });
  });

  test("sendEmail needs a bound email; the mail goes only to that address, with the link", async () => {
    const admin = await user("Mail admin", "admin");
    const { sent, transport } = fakeTransport();
    mail.setMailTransportForTests(transport);
    const logs = captureLogs();
    try {
      expect((await call(admin, "POST", "/team/invites", { role: "viewer", sendEmail: true })).body.code).toBe("EMAIL_REQUIRED");
      expect(db.query("SELECT COUNT(*) AS count FROM team_invites").get()).toEqual({ count: 0 });
      const email = bound();
      const created = await call(admin, "POST", "/team/invites", { role: "member", email: email.toUpperCase(), sendEmail: true, note: "Label stays private" });
      expect(created.status).toBe(201);
      expect(created.body.email).toEqual({ sent: true, id: "msg_1" });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(email);
      expect(sent[0]!.text).toContain(created.body.url);
      expect(sent[0]!.text).toContain("Mail admin invited you");
      expect(sent[0]!.text).not.toContain("Label stays private");
      expect((await call(admin, "GET", "/team/invites")).body.emailEnabled).toBe(true);
      const audits = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'team.invite_emailed'").all() as Array<{ actor_id: string; metadata_json: string }>;
      expect(audits).toEqual([{ actor_id: admin.userId, metadata_json: JSON.stringify({ inviteId: created.body.invite.id, role: "member" }) }]);
      expect(logs.lines.join("\n")).not.toContain(email);
      expect(logs.lines.join("\n")).not.toContain(created.body.token);
    } finally {
      logs.restore();
    }
  });

  test("Resend email mails a fresh link to the bound address and retires the old one; failures keep the old link", async () => {
    const admin = await user("Resend admin", "admin");
    const email = bound();
    const created = await call(admin, "POST", "/team/invites", { role: "guest", email });
    const id = created.body.invite.id as string;
    const oldHash = hashInviteToken(created.body.token);

    const failing = fakeTransport("fail");
    mail.setMailTransportForTests(failing.transport);
    const logs = captureLogs();
    try {
      const failed = await call(admin, "POST", `/team/invites/${id}/email`, {});
      expect(failed.body.email).toEqual({ sent: false, reason: "failed", code: "validation_error", retryable: false });
      expect((db.query("SELECT token_hash FROM team_invites WHERE id = ?").get(id) as { token_hash: string }).token_hash).toBe(oldHash);

      const { sent, transport } = fakeTransport();
      mail.setMailTransportForTests(transport);
      const resent = await call(admin, "POST", `/team/invites/${id}/email`, {});
      expect(resent.status).toBe(200);
      expect(resent.body.email.sent).toBe(true);
      expect(resent.body.token).toBeUndefined();
      expect(resent.body.url).toBeUndefined();
      expect(sent[0]!.to).toBe(email);
      const newToken = /#invite=([A-Za-z0-9_-]{43})/.exec(sent[0]!.text)![1]!;
      expect(newToken).not.toBe(created.body.token);
      const row = db.query("SELECT token_hash, token_prefix FROM team_invites WHERE id = ?").get(id) as { token_hash: string; token_prefix: string };
      expect(row).toEqual({ token_hash: hashInviteToken(newToken), token_prefix: newToken.slice(0, 6) });
      expect(resent.body.invite.tokenPrefix).toBe(newToken.slice(0, 6));
      // The old link is dead, the new one works.
      expect((await request("/auth/invite", { method: "POST", body: JSON.stringify({ token: created.body.token }) })).status).toBe(404);
      expect((await request("/auth/invite", { method: "POST", body: JSON.stringify({ token: newToken }) })).status).toBe(200);

      // Only live, email-bound invites can be emailed; admins only.
      const unbound = await call(admin, "POST", "/team/invites", { role: "guest" });
      expect((await call(admin, "POST", `/team/invites/${unbound.body.invite.id}/email`, {})).body.code).toBe("EMAIL_REQUIRED");
      await call(admin, "POST", `/team/invites/${unbound.body.invite.id}/revoke`, {});
      expect((await call(admin, "POST", `/team/invites/${unbound.body.invite.id}/email`, {})).body.code).toBe("INVITE_NOT_LIVE");
      const member = await user("Resend member");
      expect((await call(member, "POST", `/team/invites/${id}/email`, {})).body.code).toBe("ADMIN_ONLY");
      expect(logs.lines.join("\n")).not.toContain(email);
      expect(logs.lines.join("\n")).not.toContain(newToken);
    } finally {
      logs.restore();
    }
  });
});
