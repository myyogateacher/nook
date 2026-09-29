import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, origin, request, type Session } from "./support/harness";

const push = await import("../server/calendar/push");
const reminders = await import("../server/calendar/reminders");
// Fixture dates sit five years ahead of the current year (C12), so they never fall into the past.
const Y = new Date().getUTCFullYear() + 5;

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

const send = (session: Session, method: string, path: string, body?: unknown) =>
  request(path, { method, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) }, session);

type Sent = { url: string; init: RequestInit };
let sent: Sent[] = [];
let responder: (url: string) => number = () => 201;
const realNet = { ...push.pushNet };

const subscription = (endpoint: string, label = "Test phone") => ({ endpoint, expirationTime: null, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }, label });
const endpoint = (suffix: string) => `https://fcm.googleapis.com/fcm/send/${suffix}`;

beforeEach(() => {
  sent = [];
  responder = () => 201;
  // No test performs real DNS: the container build has no resolver.
  push.pushNet.resolve = async () => ["142.250.1.1"];
  push.pushNet.resolveTimeoutMs = push.PUSH_RESOLVE_TIMEOUT_MS;
  push.pushNet.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: responder(url) });
  };
  push.resetPushTestLimit();
});

afterAll(async () => {
  Object.assign(push.pushNet, realNet);
  await push.initPush({ setting: "auto" });
});

describe("push configuration", () => {
  test("auto is off on a plain-http origin, with the reason", async () => {
    await push.initPush({ setting: "auto" });
    const user = await createUser("Push config");
    expect(origin.startsWith("http://localhost")).toBe(true);
    expect(await json(await send(user, "GET", "/push/config"))).toEqual({ enabled: false, reason: "insecure_origin" });
    const refused = await send(user, "POST", "/push/subscriptions", subscription(endpoint("off")));
    expect(refused.status).toBe(409);
    expect((await json<{ code: string }>(refused)).code).toBe("PUSH_DISABLED");
    await push.initPush({ setting: "false" });
    expect(await json(await send(user, "GET", "/push/config"))).toEqual({ enabled: false, reason: "disabled" });
    expect(push.pushSetting("auto", "https://notes.example-tailnet.ts.net")).toEqual({ enabled: true, reason: null });
    expect(push.pushSetting("true", "http://localhost:2026")).toEqual({ enabled: true, reason: null });
  });

  test("VAPID keys are created once, 0600, in DATA_DIR/push-style directories, and reused", async () => {
    const directory = join(dataDir, "push-keys-test");
    const first = await push.loadOrCreateVapidKeys(directory);
    const second = await push.loadOrCreateVapidKeys(directory);
    expect(second).toEqual(first);
    expect(statSync(join(directory, "vapid.json")).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(Buffer.from(first.publicKey, "base64url").length).toBe(65);
    expect(first.privateJwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  test("the VAPID JWT is ES256, scoped to the push origin, and verifies with the public key", async () => {
    const keys = await push.createVapidKeys();
    const now = Date.parse(`${Y}-01-01T00:00:00Z`);
    const header = await push.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:ops@example.test", now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, publicKey] = match!;
    expect(publicKey).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "mailto:ops@example.test" });
    const key = await crypto.subtle.importKey("raw", Buffer.from(keys.publicKey, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${head}.${claims}`);
    const signatureBytes = Buffer.from(signature!, "base64url");
    expect(signatureBytes.length).toBe(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, signed)).toBe(true);
    const tampered = new TextEncoder().encode(`${head}.${claims}x`);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, tampered)).toBe(false);
  });
});

describe("the endpoint allowlist (T62)", () => {
  test("accepts https:443 on the push-service hosts only", () => {
    for (const allowed of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://fcm.googleapis.com:443/fcm/send/abc"
    ]) expect(push.endpointShapeAllowed(allowed)).toBe(true);
    for (const refused of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://googleapis.com/abc",
      "https://fcm.googleapis.com.evil.example/abc",
      "https://evilgoogleapis.com/abc",
      "https://fcm-googleapis.com/abc",
      "https://user:pass@fcm.googleapis.com/abc",
      "https://142.250.1.1/abc",
      "https://[2607:f8b0::1]/abc",
      "https://0x8efa0101/abc",
      "https://127.0.0.1/abc",
      "https://localhost/abc",
      "ftp://fcm.googleapis.com/abc",
      "javascript:alert(1)",
      "not a url"
    ]) expect(push.endpointShapeAllowed(refused)).toBe(false);
  });

  test("private addresses are refused after DNS, and resolution failures refuse too", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.9", "172.20.0.1", "100.101.102.103", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(push.isPrivateAddress(address)).toBe(true);
    }
    for (const address of ["142.250.1.1", "2607:f8b0:4004::200e"]) expect(push.isPrivateAddress(address)).toBe(false);
    // L2: IPv4 embedded or tunnelled in IPv6, site-local, unique-local, and malformed forms.
    for (const address of [
      "::ffff:127.0.0.1", "::FFFF:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:10.1.2.3", "::127.0.0.1", "::8.8.8.8", "::",
      "2002:c0a8:101::1", "2002:8efa:101::1", "fec0::1", "feff::1", "fc00::1", "fdff:ffff::1", "fe80::1%eth0",
      "2001:0:4136:e378::1", "64:ff9b::a00:1", "2001:db8::1", "ff02::1"
    ]) expect(push.isPrivateAddress(address)).toBe(true);
    for (const address of ["::ffff:142.250.1.1", "::ffff:8efa:101", "2a00:1450:4001:80b::200a", "2001:4860:4860::8888"]) expect(push.isPrivateAddress(address)).toBe(false);
    push.pushNet.resolve = async () => ["142.250.1.1", "10.0.0.8"];
    expect(await push.endpointAllowed(endpoint("rebind"))).toBe(false);
    push.pushNet.resolve = async () => { throw new Error("ENOTFOUND"); };
    expect(await push.endpointAllowed(endpoint("missing"))).toBe(false);
    push.pushNet.resolve = async () => ["142.250.1.1"];
    expect(await push.endpointAllowed(endpoint("ok"))).toBe(true);
  });
});

describe("subscriptions and delivery", () => {
  test("subscriptions are validated, capped at 10 per user, and scoped to their owner (IDOR)", async () => {
    await push.initPush({ setting: "true", keys: await push.createVapidKeys() });
    const alice = await createUser("Push Alice");
    const bob = await createUser("Push Bob");
    const config = await json<{ enabled: boolean; publicKey: string }>(await send(alice, "GET", "/push/config"));
    expect(config.enabled).toBe(true);
    expect(Buffer.from(config.publicKey, "base64url").length).toBe(65);

    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://10.0.0.1/x"]) {
      const response = await send(alice, "POST", "/push/subscriptions", subscription(bad));
      expect(response.status).toBe(400);
      expect((await json<{ code: string }>(response)).code).toBe("ENDPOINT_NOT_ALLOWED");
    }
    expect((await send(alice, "POST", "/push/subscriptions", { ...subscription(endpoint("x")), keys: { p256dh: "bad key!", auth: "x" } })).status).toBe(400);

    const created = await send(alice, "POST", "/push/subscriptions", subscription(endpoint("alice-1"), "Pixel"));
    expect(created.status).toBe(201);
    const id = (await json<{ subscription: { id: string; label: string; disabled: boolean } }>(created)).subscription.id;
    // The same endpoint again refreshes the row.
    expect((await send(alice, "POST", "/push/subscriptions", subscription(endpoint("alice-1"), "Pixel 9"))).status).toBe(200);
    for (let index = 2; index <= 10; index += 1) expect((await send(alice, "POST", "/push/subscriptions", subscription(endpoint(`alice-${index}`)))).status).toBe(201);
    const over = await send(alice, "POST", "/push/subscriptions", subscription(endpoint("alice-11")));
    expect(over.status).toBe(409);
    expect((await json<{ code: string }>(over)).code).toBe("LIMIT_REACHED");

    const list = await json<{ subscriptions: Array<{ id: string; label: string }> }>(await send(alice, "GET", "/push/subscriptions"));
    expect(list.subscriptions.length).toBe(10);
    expect(list.subscriptions.find((item) => item.id === id)?.label).toBe("Pixel 9");
    expect(JSON.stringify(list)).not.toContain("fcm.googleapis.com");
    expect((await json<{ subscriptions: unknown[] }>(await send(bob, "GET", "/push/subscriptions"))).subscriptions).toEqual([]);
    expect((await send(bob, "DELETE", "/push/subscriptions", { id })).status).toBe(404);
    expect((await send(bob, "DELETE", "/push/subscriptions", { endpoint: endpoint("alice-2") })).status).toBe(404);
    expect((await send(alice, "DELETE", "/push/subscriptions", { id })).status).toBe(200);
    expect((await send(alice, "DELETE", "/push/subscriptions", { endpoint: endpoint("alice-2") })).status).toBe(200);
    db.query("DELETE FROM push_subscriptions WHERE user_id = ?").run(alice.userId);
  });

  test("a due reminder sends one empty, VAPID-signed push with TTL 3600 and no redirects", async () => {
    await push.initPush({ setting: "true", keys: await push.createVapidKeys() });
    const user = await createUser("Push delivery");
    expect((await send(user, "POST", "/push/subscriptions", subscription(endpoint("delivery")))).status).toBe(201);
    expect((await send(user, "POST", "/reminders", { title: "Push me", fireAt: `${Y + 1}-02-01T09:00`, tz: "UTC" })).status).toBe(201);
    expect((await send(user, "POST", "/reminders", { title: "And me", fireAt: `${Y + 1}-02-01T09:00`, tz: "UTC" })).status).toBe(201);
    // A slow resolver stands in for a loaded machine: a fixed sleep here raced delivery.
    push.pushNet.resolve = async () => { await Bun.sleep(80); return ["142.250.1.1"]; };
    expect(reminders.runDispatch({ nowMs: Date.parse(`${Y + 1}-02-01T09:00:10Z`) })?.notified).toBe(2);
    // The dispatcher starts delivery synchronously; an empty call resolves when the queue drains.
    await push.deliverNotifications([]);
    expect(sent.length).toBe(1);
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(endpoint("delivery"));
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.TTL).toBe("3600");
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect((db.query("SELECT last_success_at FROM push_subscriptions WHERE user_id = ?").get(user.userId) as { last_success_at: string | null }).last_success_at).not.toBeNull();
  });

  test("404 or 410 removes the subscription; redirects and errors count, and 5 failures disable it", async () => {
    await push.initPush({ setting: "true", keys: await push.createVapidKeys() });
    const user = await createUser("Push failures");
    expect((await send(user, "POST", "/push/subscriptions", subscription(endpoint("gone")))).status).toBe(201);
    expect((await send(user, "POST", "/push/subscriptions", subscription(endpoint("flaky")))).status).toBe(201);
    responder = (url) => url.endsWith("gone") ? 410 : 302;
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    const rows = () => db.query("SELECT endpoint, failure_count FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint").all(user.userId) as Array<{ endpoint: string; failure_count: number }>;
    expect(rows()).toEqual([{ endpoint: endpoint("flaky"), failure_count: 1 }]);
    responder = () => 500;
    for (let index = 0; index < 6; index += 1) await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    expect(rows()[0]!.failure_count).toBe(5);
    expect(sent.length).toBe(2 + 4);
    const list = await json<{ subscriptions: Array<{ disabled: boolean }> }>(await send(user, "GET", "/push/subscriptions"));
    expect(list.subscriptions[0]!.disabled).toBe(true);
    // Re-subscribing re-enables it.
    expect((await send(user, "POST", "/push/subscriptions", subscription(endpoint("flaky")))).status).toBe(200);
    expect(rows()[0]!.failure_count).toBe(0);
    // An endpoint that now resolves privately is never contacted.
    push.pushNet.resolve = async () => ["10.1.2.3"];
    sent = [];
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    expect(sent).toEqual([]);
    expect(rows()[0]!.failure_count).toBe(1);

    // L2: the host is resolved again right before the request. A private second answer is
    // refused (and counts); a public one with no address in common aborts without counting.
    const answers = (...lists: string[][]) => {
      let call = 0;
      push.pushNet.resolve = async () => lists[Math.min(call++, lists.length - 1)]!;
    };
    answers(["142.250.1.1"], ["127.0.0.1"]);
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    expect(sent).toEqual([]);
    expect(rows()[0]!.failure_count).toBe(2);
    answers(["142.250.1.1"], ["142.250.9.9"]);
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    expect(sent).toEqual([]);
    expect(rows()[0]!.failure_count).toBe(2);
    responder = () => 201;
    answers(["142.250.1.1", "142.250.1.2"], ["142.250.1.2"]);
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    expect(sent.length).toBe(1);
    expect(rows()[0]!.failure_count).toBe(0);

    // A resolver that never answers is bounded: the delivery fails (and counts) instead of stalling.
    push.pushNet.resolve = () => new Promise<string[]>(() => undefined);
    push.pushNet.resolveTimeoutMs = 20;
    sent = [];
    const started = Date.now();
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: user.userId }]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sent).toEqual([]);
    expect(rows()[0]!.failure_count).toBe(1);
  });

  test("a hanging push service cannot pile deliveries up: 4 users at a time, one delivery per user (L9)", async () => {
    await push.initPush({ setting: "true", keys: await push.createVapidKeys() });
    const users: Session[] = [];
    for (let index = 0; index < 6; index += 1) {
      const user = await createUser(`Push slow ${index}`);
      expect((await send(user, "POST", "/push/subscriptions", subscription(endpoint(`slow-${index}`)))).status).toBe(201);
      users.push(user);
    }
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    push.pushNet.fetch = async (url, init) => {
      sent.push({ url, init });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return new Response(null, { status: 201 });
    };
    const until = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await Bun.sleep(1);
      expect(condition()).toBe(true);
    };
    const notify = (user: Session) => ({ id: crypto.randomUUID(), userId: user.userId });
    const drained = push.deliverNotifications(users.map(notify));
    await until(() => inFlight === 4);
    // More ticks while the service hangs: nothing new starts, and each user is queued at most once.
    for (let tick = 0; tick < 5; tick += 1) void push.deliverNotifications([notify(users[0]!), notify(users[0]!), notify(users[5]!)]);
    await Bun.sleep(5);
    expect(inFlight).toBe(4);
    expect(sent.length).toBe(4);
    // Keep releasing until the queue drains: a worker may be between devices (signing) with
    // nothing in flight, so "nothing in flight" alone does not mean it is done.
    let done = false;
    void drained.then(() => { done = true; });
    const started = Date.now();
    while (!done) {
      release.splice(0).forEach((resolve) => resolve());
      await Bun.sleep(1);
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(peak).toBe(4);
    // Six first deliveries, then one more for user 0 (re-queued while in flight); user 5 was still queued.
    expect(sent.length).toBe(7);
    expect(sent.filter((item) => item.url === endpoint("slow-0")).length).toBe(2);
    expect(sent.filter((item) => item.url === endpoint("slow-5")).length).toBe(1);
  });

  test("disabled users and users whose email is no longer allowed lose their subscriptions (L5)", async () => {
    await push.initPush({ setting: "true", keys: await push.createVapidKeys() });
    const subscriptions = (userId: string) => (db.query("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?").get(userId) as { count: number }).count;
    const revoked = (userId: string) => db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'push.subscriptions_revoked'").all(userId) as Array<{ metadata_json: string }>;

    const disabled = await createUser("Push disabled");
    expect((await send(disabled, "POST", "/push/subscriptions", subscription(endpoint("disabled")))).status).toBe(201);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), disabled.userId);
    await push.deliverNotifications([{ id: crypto.randomUUID(), userId: disabled.userId }]);
    expect(sent).toEqual([]);
    expect(subscriptions(disabled.userId)).toBe(0);
    expect(revoked(disabled.userId).map((row) => JSON.parse(row.metadata_json))).toEqual([{ reason: "user_disabled", count: 1 }]);

    const removed = await createUser("Push removed email");
    expect((await send(removed, "POST", "/push/subscriptions", subscription(endpoint("removed")))).status).toBe(201);
    db.query("UPDATE users SET email = ? WHERE id = ?").run(`removed-${crypto.randomUUID()}@elsewhere.test`, removed.userId);
    expect((await send(removed, "GET", "/push/subscriptions")).status).toBe(401);
    expect(subscriptions(removed.userId)).toBe(0);
    expect(revoked(removed.userId).map((row) => JSON.parse(row.metadata_json))).toEqual([{ reason: "email_not_allowed", count: 1 }]);
  });

  test("Send test is limited to 5 per hour", async () => {
    await push.initPush({ setting: "true", keys: await push.createVapidKeys() });
    const user = await createUser("Push test limit");
    expect((await send(user, "POST", "/push/subscriptions", subscription(endpoint("tester")))).status).toBe(201);
    for (let index = 0; index < 5; index += 1) expect(await json(await send(user, "POST", "/push/test"))).toEqual({ ok: true, sent: 1, failed: 0 });
    const limited = await send(user, "POST", "/push/test");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
