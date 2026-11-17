import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { registerTestModule, unregisterTestModule } from "./support/workspaceTestModule";

const { issueRenderNonce, resetPublicLimits, setPublicPause } = await import("../server/public/limits");
const { revokePublicLink, readPublicLink } = await import("../server/public/links");
const { tokenHash } = await import("../server/public/links");
const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { PUBLIC_NOT_FOUND } = await import("../shared/publicPages");

/**
 * Public pages (docs/plan/WORKSPACE_MODULES.md §B.8, D810, T506, T507): strict headers, no session,
 * one uniform 404, the per-address limits, the honeypot, the minimum fill time, single-use nonces,
 * members-only questions refused, the admin policies (on by default, §G.1 Q2), and email verification.
 */

let owner: Session;
let admin: Session;
let widget: { id: string; token: string };

const page = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, init);
const submit = (token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${origin}/api/public/test/${token}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const nonceFor = (itemId: string, agoMs = 5_000) => issueRenderNonce("test", itemId, Date.now() - agoMs);
const answers = { name: "Pat Public", email: "pat@outside.test", score: 9 };

beforeAll(async () => {
  registerTestModule();
  owner = await createUser("Public owner");
  admin = await createUser("Public admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  const response = await request("/test-widgets", { method: "POST", body: JSON.stringify({ name: "Public widget" }) }, owner);
  widget = await response.json() as { id: string; token: string };
  resetPublicLimits();
});
afterAll(() => {
  unregisterTestModule();
  resetPublicLimits();
});

describe("public pages", () => {
  test("a page and its JSON carry the strict headers and never touch a session", async () => {
    const response = await page(`/p/test/${widget.token}`, { headers: { Cookie: owner.cookie } });
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "script-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(csp).toContain(directive);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
    const json = await page(`/api/public/test/${widget.token}`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await json.json()).toMatchObject({ title: "Public widget", questions: { version: 1 } });
  });

  test("unknown, malformed, revoked, and policy-off links are one uniform 404", async () => {
    const bodies: string[] = [];
    const created = await (await request("/test-widgets", { method: "POST", body: JSON.stringify({ name: "Revoked widget" }) }, owner)).json() as { id: string; token: string };
    const link = db.query("SELECT id FROM public_links WHERE token_hash = ?").get(tokenHash(created.token)) as { id: string };
    expect(revokePublicLink(link.id, owner.userId)).toBe(true);
    for (const token of ["A".repeat(43), "short", created.token]) {
      const pageResponse = await page(`/p/test/${token}`);
      expect(pageResponse.status).toBe(404);
      const response = await page(`/api/public/test/${token}`);
      expect(response.status).toBe(404);
      bodies.push(await response.text());
    }
    // The admin turns public forms off: the live link 404s at once, and its row stays.
    const settings = await (await request("/workspace/settings", {}, admin)).json() as { settings: { publicForms: boolean }; revision: number };
    expect(settings.settings.publicForms).toBe(true);
    expect((await request("/workspace/settings", { method: "PUT", body: JSON.stringify({ settings: { publicForms: false }, revision: settings.revision }) }, owner)).status).toBe(403);
    const off = await request("/workspace/settings", { method: "PUT", body: JSON.stringify({ settings: { publicForms: false }, revision: settings.revision }) }, admin);
    expect(off.status).toBe(200);
    const policyOff = await page(`/api/public/test/${widget.token}`);
    expect(policyOff.status).toBe(404);
    bodies.push(await policyOff.text());
    expect((await page(`/p/test/${widget.token}`)).status).toBe(404);
    expect(readPublicLink("form", widget.token)).toBeNull();
    const revision = ((await off.json()) as { revision: number }).revision;
    expect((await request("/workspace/settings", { method: "PUT", body: JSON.stringify({ settings: { publicForms: true }, revision }) }, admin)).status).toBe(200);
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify(PUBLIC_NOT_FOUND)]));
    expect((await page(`/api/public/test/${widget.token}`)).status).toBe(200);
  });

  test("submissions: a bad nonce, the honeypot, too fast, and a replay are refused; a good one is stored once", async () => {
    resetPublicLimits();
    expect((await submit(widget.token, { answers, nonce: "v1.bogus.sig" })).status).toBe(400);
    expect((await submit(widget.token, { answers, nonce: nonceFor("someone-else") })).status).toBe(400);
    expect((await submit(widget.token, { answers, nonce: nonceFor(widget.id), website: "http://spam.example" })).status).toBe(400);
    expect((await submit(widget.token, { answers, nonce: nonceFor(widget.id, 500) })).status).toBe(400);
    const nonce = nonceFor(widget.id);
    const accepted = await submit(widget.token, { answers, nonce, website: "" });
    expect(accepted.status).toBe(201);
    const { responseId } = await accepted.json() as { responseId: string };
    expect(db.query("SELECT respondent_kind, respondent_name FROM responses WHERE id = ?").get(responseId)).toEqual({ respondent_kind: "guest", respondent_name: "Pat Public" });
    expect((await submit(widget.token, { answers, nonce })).status).toBe(400);
    // A members-only question (file) is refused on a public submission.
    const files = await submit(widget.token, { answers: { ...answers, file: ["6a1d6b7f-2c3e-4d4f-9a5b-222222222222"] }, nonce: nonceFor(widget.id) });
    expect(files.status).toBe(400);
    expect(await files.json()).toMatchObject({ code: "INVALID_ANSWERS", errors: { file: "Not available here" } });
    // Each outcome is logged with a salted address hash only.
    const outcomes = (db.query("SELECT outcome, ip_hash FROM public_submissions_log WHERE item_id = ?").all(widget.id) as Array<{ outcome: string; ip_hash: string }>);
    expect(new Set(outcomes.map((row) => row.outcome))).toEqual(new Set(["invalid", "honeypot", "too_fast", "replay"]));
    expect(outcomes.every((row) => /^[0-9a-f]{64}$/.test(row.ip_hash))).toBe(true);
  });

  test("bodies over 64 KiB and the per-address submit limit answer 413 and 429; a paused kind is a 404", async () => {
    resetPublicLimits();
    const big = await fetch(`${origin}/api/public/test/${widget.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: { name: "x".repeat(70_000) } }) });
    expect(big.status).toBe(413);
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) statuses.push((await submit(widget.token, { answers, nonce: "v1.x.y" })).status);
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    resetPublicLimits();
    setPublicPause("test", true);
    expect((await submit(widget.token, { answers, nonce: nonceFor(widget.id) })).status).toBe(404);
    setPublicPause("test", false);
  });

  test("email verification: the submission counts only after the code mailed to the address", async () => {
    resetPublicLimits();
    // Earlier files' queued mail would take the dispatch batch (MAIL_BATCH, oldest first) ahead of this code.
    db.query("DELETE FROM mail_outbox WHERE status = 'queued'").run();
    const sent: Array<{ to: string; text: string; subject: string; headers?: Record<string, string> }> = [];
    mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
    try {
      const held = await submit(widget.token, { answers: { ...answers, email: "verify@outside.test" }, nonce: nonceFor(widget.id), verify: true });
      expect(held.status).toBe(202);
      const { verificationId, mailQueued } = await held.json() as { verificationId: string; mailQueued: boolean };
      expect(mailQueued).toBe(true);
      const before = (db.query("SELECT COUNT(*) AS count FROM responses WHERE host_id = ?").get(widget.id) as { count: number }).count;
      await runMailDispatch({ nowMs: Date.now() + 1000 });
      const message = sent.find((item) => item.to === "verify@outside.test")!;
      const code = /Your code is (\d{6})/.exec(message.text)?.[1] ?? /(\d{6})/.exec(message.subject)![1]!;
      // Internal ids never appear in mail to an outside address.
      expect(message.text).not.toContain(widget.id);
      const verify = (body: unknown) => fetch(`${origin}/api/public/test/${widget.token}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect((await verify({ id: verificationId, code: code === "000000" ? "111111" : "000000" })).status).toBe(400);
      expect((await verify({ id: verificationId, code })).status).toBe(201);
      expect((await verify({ id: verificationId, code })).status).toBe(400);
      expect((db.query("SELECT COUNT(*) AS count FROM responses WHERE host_id = ?").get(widget.id) as { count: number }).count).toBe(before + 1);
      // The stop link in the mail ends further mail about the item to that address.
      // It opens a confirmation page; opening it (or the old API link) stops nothing (link scanners, D822b).
      const stop = /\/p\/mail-stop\/([A-Za-z0-9_.-]+)/.exec(message.text)?.[1];
      expect(stop).toBeTruthy();
      expect((await page(`/p/mail-stop/${stop}`)).status).toBe(200);
      const legacy = await page(`/api/public/mail-stop/${stop}`, { redirect: "manual" });
      expect(legacy.status).toBe(303);
      expect(legacy.headers.get("location")).toBe(`/p/mail-stop/${stop}`);
      const before2 = await submit(widget.token, { answers: { ...answers, email: "verify@outside.test" }, nonce: nonceFor(widget.id), verify: true });
      expect(((await before2.json()) as { mailQueued: boolean }).mailQueued).toBe(true);
      // RFC 8058 one-click: the header names the POST target; the mailbox provider's form POST stops it.
      expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      const target = /^<(.+)>$/.exec(message.headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";
      expect(new URL(target).pathname).toBe(`/api/public/mail-stop/${stop}`);
      expect((await page(new URL(target).pathname, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" })).status).toBe(200);
      expect((await page("/api/public/mail-stop/not-a-token", { method: "POST" })).status).toBe(200);
      const again = await submit(widget.token, { answers: { ...answers, email: "verify@outside.test" }, nonce: nonceFor(widget.id), verify: true });
      expect(((await again.json()) as { mailQueued: boolean }).mailQueued).toBe(false);
    } finally {
      mail.setMailTransportForTests(null);
    }
  });
});
