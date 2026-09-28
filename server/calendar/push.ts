import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { config } from "../config";
import { audit, db } from "../db";
import { readPrivateFile, writePrivateFileAtomic } from "../storage";
import { onNotification, type NotificationCreated } from "./reminders";

/**
 * Payload-less Web Push (WAVES_10-12.md D65, §4.3, T62, T63).
 *
 * A push carries no body, so push services never see content and no RFC 8291 encryption is
 * needed: the service worker wakes up and fetches /api/notifications?unread=1 with the session
 * cookie. Requests are authorised with a VAPID (RFC 8292) ES256 JWT built here on WebCrypto.
 * Endpoints must be https on 443 at an allowlisted push-service host, never an IP literal, and
 * must not resolve to a private address; delivery follows no redirects and times out after 5 s.
 */

export const MAX_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_FAILURES = 5;
export const PUSH_TTL_SECONDS = 3600;
export const PUSH_TIMEOUT_MS = 5000;
/** A DNS answer that takes longer than this fails the delivery, so a dead resolver cannot stall a tick. */
export const PUSH_RESOLVE_TIMEOUT_MS = 2000;
export const TEST_PUSHES_PER_HOUR = 5;
const JWT_LIFETIME_S = 12 * 3600;
export const BUILT_IN_PUSH_HOSTS = ["*.googleapis.com", "*.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"];

export class PushError extends Error {
  constructor(public status: 400 | 404 | 409 | 429, message: string, public code?: string, public retryAfter?: number) {
    super(message);
  }

  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}) };
  }
}

// ---------------------------------------------------------------------------
// base64url and VAPID keys

export const base64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const fromBase64url = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));
const textBytes = (value: string) => new TextEncoder().encode(value);

export type VapidKeys = { publicKey: string; privateJwk: JsonWebKey };

export async function createVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { publicKey: base64url(raw), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

function validKeys(value: unknown): value is VapidKeys {
  if (!value || typeof value !== "object") return false;
  const keys = value as Partial<VapidKeys>;
  return typeof keys.publicKey === "string" && fromBase64url(keys.publicKey).length === 65 && !!keys.privateJwk && keys.privateJwk.kty === "EC" && keys.privateJwk.crv === "P-256" && typeof keys.privateJwk.d === "string";
}

/**
 * Loads DATA_DIR/push/vapid.json, creating it (0600, atomic) on first boot. If the file is lost,
 * a new pair is made and clients re-subscribe when they see a different publicKey.
 */
export async function loadOrCreateVapidKeys(directory = join(config.dataDir, "push")): Promise<VapidKeys> {
  const path = join(directory, "vapid.json");
  try {
    const parsed = JSON.parse(await readPrivateFile(path)) as unknown;
    if (validKeys(parsed)) return parsed;
    throw new Error("Stored VAPID keys are malformed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keys = await createVapidKeys();
  await writePrivateFileAtomic(path, `${JSON.stringify(keys)}\n`);
  return keys;
}

/** `vapid t=<JWT>, k=<public key>` for one push-service origin (RFC 8292). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs = Date.now()) {
  const header = base64url(textBytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(textBytes(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S, sub: subject })));
  const privateKey = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto returns the raw r||s signature JWS expects for ES256.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, textBytes(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------------------
// Endpoint allowlist (T62)

function hostMatches(host: string, pattern: string) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
  }
  return host === pattern;
}

export const allowedPushHosts = () => [...BUILT_IN_PUSH_HOSTS, ...config.pushEndpointHosts];

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 part included), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => part === "" ? [] : part.split(":").map((group) => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.some(Number.isNaN) ? null : groups;
}

const ipv4Of = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * Private, loopback, link-local, CGNAT/Tailscale, multicast, and unspecified ranges. For IPv6 also
 * unique-local fc00::/7, link- and site-local fe80::/9 (fe80::/10 and fec0::/10), and every form
 * that embeds or tunnels to an IPv4 address (L2): IPv4-mapped and -compatible (dotted or hex),
 * NAT64 64:ff9b::/96, 6to4 2002::/16, and Teredo 2001::/32.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address.replace(/%.*$/, ""));
  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    // ::ffff:0:0/96 (IPv4-mapped) is judged by its IPv4 address; ::/96 (unspecified, loopback, and
    // the deprecated IPv4-compatible form) is never a push service.
    if (leadingZero && g5 === 0xffff) return isPrivateAddress(ipv4Of(g6, g7));
    if (leadingZero && g5 === 0) return true;
    return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xff80) === 0xfe80 || (g0 & 0xff00) === 0xff00
      || (g0 === 0x64 && g1 === 0xff9b) || g0 === 0x2002 || (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8));
  }
  return true;
}

/** Network access, on an object so tests can replace DNS and fetch (and shorten the DNS bound). */
export const pushNet = {
  resolve: async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  resolveTimeoutMs: PUSH_RESOLVE_TIMEOUT_MS
};

/** pushNet.resolve, rejected once pushNet.resolveTimeoutMs passes without an answer. */
async function resolveBounded(host: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), pushNet.resolveTimeoutMs);
  });
  try {
    return await Promise.race([pushNet.resolve(host), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The shape check alone: https, port 443, no credentials, not an IP literal, an allowlisted host. */
export function endpointShapeAllowed(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || url.username || url.password || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || isIP(host) || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  return allowedPushHosts().some((pattern) => hostMatches(host, pattern));
}

/**
 * Shape plus DNS: the addresses the host resolves to, when every one is public; otherwise null.
 * A lookup that fails or outlasts the bound is null too, so delivery counts it as a failure.
 */
async function publicAddresses(endpoint: string) {
  if (!endpointShapeAllowed(endpoint)) return null;
  try {
    const addresses = await resolveBounded(new URL(endpoint).hostname);
    return addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address)) ? addresses : null;
  } catch {
    return null;
  }
}

/** Shape plus DNS: every address the host resolves to must be public. */
export async function endpointAllowed(endpoint: string) {
  return await publicAddresses(endpoint) !== null;
}

// ---------------------------------------------------------------------------
// State

export type PushReason = "insecure_origin" | "disabled";
export const pushState: { enabled: boolean; reason: PushReason | null; keys: VapidKeys | null } = { enabled: false, reason: "disabled", keys: null };

export function pushSetting(setting: "auto" | "true" | "false", appOrigin: string): { enabled: boolean; reason: PushReason | null } {
  if (setting === "false") return { enabled: false, reason: "disabled" };
  if (setting === "auto" && !appOrigin.startsWith("https://")) return { enabled: false, reason: "insecure_origin" };
  return { enabled: true, reason: null };
}

let unsubscribe: (() => void) | null = null;

/** Boot: decides whether push is on, loads or creates the VAPID keys, and hooks delivery to the dispatcher. */
export async function initPush(options: { setting?: "auto" | "true" | "false"; keys?: VapidKeys } = {}) {
  const setting = pushSetting(options.setting ?? config.pushEnabled, config.appOrigin);
  pushState.enabled = setting.enabled;
  pushState.reason = setting.reason;
  pushState.keys = setting.enabled ? options.keys ?? await loadOrCreateVapidKeys() : null;
  unsubscribe?.();
  unsubscribe = setting.enabled ? onNotification((created) => { void deliverNotifications(created); }) : null;
}

export function pushConfig() {
  return pushState.enabled && pushState.keys ? { enabled: true, publicKey: pushState.keys.publicKey } : { enabled: false, reason: pushState.reason ?? "disabled" };
}

// ---------------------------------------------------------------------------
// Subscriptions

type SubscriptionRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; label: string; created_at: string; last_success_at: string | null; failure_count: number };
export type SubscriptionSummary = { id: string; label: string; createdAt: string; lastSuccessAt: string | null; disabled: boolean };

const summary = (row: SubscriptionRow): SubscriptionSummary => ({ id: row.id, label: row.label, createdAt: row.created_at, lastSuccessAt: row.last_success_at, disabled: row.failure_count >= MAX_FAILURES });

function requireEnabled() {
  if (!pushState.enabled) throw new PushError(409, "Push notifications are not available on this server", "PUSH_DISABLED");
}

export function listSubscriptions(userId: string) {
  const rows = db.query("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at").all(userId) as SubscriptionRow[];
  return { subscriptions: rows.map(summary) };
}

export async function subscribe(userId: string, input: { endpoint: string; p256dh: string; auth: string; label: string }) {
  requireEnabled();
  if (!await endpointAllowed(input.endpoint)) throw new PushError(400, "This push service is not allowed", "ENDPOINT_NOT_ALLOWED");
  return db.transaction(() => {
    const existing = db.query("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(input.endpoint) as SubscriptionRow | null;
    if (existing && existing.user_id === userId) {
      // Re-subscribing refreshes the keys and clears earlier failures.
      db.query("UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ?, failure_count = 0 WHERE id = ?").run(input.p256dh, input.auth, input.label, existing.id);
      return { status: 200 as const, subscription: summary(db.query("SELECT * FROM push_subscriptions WHERE id = ?").get(existing.id) as SubscriptionRow) };
    }
    const count = (db.query("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?").get(userId) as { count: number }).count;
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) throw new PushError(409, `You can enable push on at most ${MAX_SUBSCRIPTIONS_PER_USER} devices`, "LIMIT_REACHED");
    // An endpoint belongs to one browser; whoever signed in there last owns it.
    if (existing) db.query("DELETE FROM push_subscriptions WHERE id = ?").run(existing.id);
    const id = crypto.randomUUID();
    db.query("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, input.endpoint, input.p256dh, input.auth, input.label, new Date().toISOString());
    audit(userId, null, "push.subscribe", { subscriptionId: id });
    return { status: 201 as const, subscription: summary(db.query("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as SubscriptionRow) };
  })();
}

export function unsubscribeDevice(userId: string, target: { id: string } | { endpoint: string }) {
  const result = "id" in target
    ? db.query("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?").run(target.id, userId)
    : db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(target.endpoint, userId);
  if (result.changes !== 1) throw new PushError(404, "Device not found");
  audit(userId, null, "push.unsubscribe", {});
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Delivery

export type DeliveryOutcome = "sent" | "gone" | "failed" | "skipped";

/** One empty push. 404/410 deletes the subscription; other failures count toward disabling it. */
export async function sendPush(row: SubscriptionRow, nowMs = Date.now()): Promise<DeliveryOutcome> {
  if (!pushState.enabled || !pushState.keys || row.failure_count >= MAX_FAILURES) return "skipped";
  let status = 0;
  try {
    const checked = await publicAddresses(row.endpoint);
    if (!checked) throw new Error("Endpoint not allowed");
    const authorization = await vapidAuthorization(row.endpoint, pushState.keys, config.pushSubject, nowMs);
    // L2: fetch() resolves the host again and cannot be pinned to the checked address, so narrow
    // the DNS-rebinding window: resolve once more right before the request, and abort (without
    // counting a failure) unless the answer is still public and shares an address with the first.
    const again = await publicAddresses(row.endpoint);
    if (!again) throw new Error("Endpoint not allowed");
    if (!again.some((address) => checked.includes(address))) return "skipped";
    const response = await pushNet.fetch(row.endpoint, {
      method: "POST",
      headers: { TTL: String(PUSH_TTL_SECONDS), Urgency: "normal", Authorization: authorization, "Content-Length": "0" },
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
    });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    status = 0;
  }
  if (status >= 200 && status < 300) {
    db.query("UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?").run(new Date(nowMs).toISOString(), row.id);
    return "sent";
  }
  if (status === 404 || status === 410) {
    db.query("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
    return "gone";
  }
  // Redirects (3xx with redirect: "manual"), timeouts, refused endpoints, and 5xx all count.
  db.query("UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?").run(row.id);
  return "failed";
}

/**
 * L5: removes every push subscription of a user whose sessions were all revoked, who was
 * disabled, or whose email is no longer allowed, so their devices stop being woken.
 */
export function revokeUserPushSubscriptions(userId: string, reason: string) {
  const removed = db.query("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId).changes;
  if (removed) audit(userId, null, "push.subscriptions_revoked", { reason, count: removed });
  return removed;
}

async function sendToUser(userId: string, parallel = true) {
  if (!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(userId)) {
    revokeUserPushSubscriptions(userId, "user_disabled");
    return { sent: 0, failed: 0 };
  }
  const rows = db.query("SELECT * FROM push_subscriptions WHERE user_id = ? AND failure_count < ?").all(userId, MAX_FAILURES) as SubscriptionRow[];
  const outcomes: DeliveryOutcome[] = [];
  if (parallel) outcomes.push(...await Promise.all(rows.map((row) => sendPush(row))));
  else for (const row of rows) outcomes.push(await sendPush(row));
  return { sent: outcomes.filter((outcome) => outcome === "sent").length, failed: outcomes.filter((outcome) => outcome === "failed" || outcome === "gone").length };
}

/** Users whose devices are being woken at once, across every dispatcher tick (L9). */
export const PUSH_CONCURRENCY = 4;
const queuedUsers = new Set<string>();
const activeUsers = new Set<string>();
let runningWorkers = 0;
let drainWaiters: Array<() => void> = [];

function nextQueuedUser() {
  for (const userId of queuedUsers) if (!activeUsers.has(userId)) return userId;
  return null;
}

/** Starts workers up to PUSH_CONCURRENCY while a queued user is not already being delivered to. */
function pumpDeliveries() {
  while (runningWorkers < PUSH_CONCURRENCY && nextQueuedUser() !== null) {
    runningWorkers += 1;
    void (async () => {
      for (let userId = nextQueuedUser(); userId !== null; userId = nextQueuedUser()) {
        queuedUsers.delete(userId);
        activeUsers.add(userId);
        try {
          await sendToUser(userId, false);
        } catch (error) {
          console.error("Push delivery failed", error instanceof Error ? error.name : "Unknown error");
        } finally {
          activeUsers.delete(userId);
        }
      }
    })().finally(() => {
      runningWorkers -= 1;
      if (runningWorkers === 0) {
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
  }
}

/**
 * Called after a dispatcher tick commits: one wake-up per user, whatever the number of
 * notifications. Deliveries are single-flight per user (a user already queued is not queued
 * twice; one being delivered to is queued once more) and at most PUSH_CONCURRENCY users are
 * served at a time, each device in turn, so a hanging push service cannot pile deliveries up.
 * Resolves when the queue has drained.
 */
export function deliverNotifications(created: NotificationCreated[]): Promise<void> {
  // A reminder set to email only (Wave 29 channels) makes a bell entry but no push.
  for (const { userId, push } of created) if (push !== false) queuedUsers.add(userId);
  pumpDeliveries();
  return runningWorkers === 0 ? Promise.resolve() : new Promise((resolve) => drainWaiters.push(resolve));
}

const testSends = new Map<string, number[]>();

/** POST /api/push/test: at most 5 per user per hour. */
export async function sendTest(userId: string, nowMs = Date.now()) {
  requireEnabled();
  const recent = (testSends.get(userId) ?? []).filter((stamp) => stamp > nowMs - 3_600_000);
  if (recent.length >= TEST_PUSHES_PER_HOUR) throw new PushError(429, "Too many test notifications. Try again later.", "RATE_LIMITED", Math.ceil((recent[0]! + 3_600_000 - nowMs) / 1000));
  recent.push(nowMs);
  testSends.set(userId, recent);
  return { ok: true as const, ...await sendToUser(userId) };
}

/** Test hook. */
export function resetPushTestLimit() {
  testSends.clear();
}
