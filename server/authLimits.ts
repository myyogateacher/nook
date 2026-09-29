import type { Context } from "hono";
import { clientAddress } from "./clientAddress";

/**
 * In-memory attempt limits for sign-in, registration, invites, Google sign-in, and a few
 * per-account actions (a restart clears them). One-minute windows. Password and Google sign-in
 * share the `login:*` buckets (Wave 35, D296).
 *
 * Every bucket belongs to a family registered below with its scope. The scope decides, by
 * construction, what the attempt map may drop when it is full (review F1): only per-client-address
 * buckets, which an attacker can mint freely by changing address. Per-email, per-account, per-admin,
 * and instance-wide buckets are never dropped, so flooding the map cannot reset a victim's counter.
 * A new bucket must be added here; `hit` takes only a registered family.
 */

/** client: per client address (evictable). email: per typed email. account / admin: per signed-in
 * account. global: one per instance. */
export type BucketScope = "client" | "email" | "account" | "admin" | "global";

export const BUCKET_FAMILIES = {
  // Password sign-in, and the Nook code step after Google (S7).
  "login:client": { scope: "client", limit: 20 },
  "login:email": { scope: "email", limit: 10 },
  "login:global": { scope: "global", limit: 120 },
  // Account creation, password or Google.
  "register:client": { scope: "client", limit: 5 },
  "register:global": { scope: "global", limit: 20 },
  // Invite preview, password or Google hand-off.
  "invite:client": { scope: "client", limit: 10 },
  "invite:global": { scope: "global", limit: 60 },
  // Google sign-in starts and callbacks (L4, N1).
  "google:start:client": { scope: "client", limit: 120 },
  "google:start:global": { scope: "global", limit: 2000 },
  "google:callback:client": { scope: "client", limit: 180 },
  "google:callback:global": { scope: "global", limit: 3000 },
  // Signed-in, per account.
  "google:link:account": { scope: "account", limit: 5 },
  "google:unlink:account": { scope: "account", limit: 5 },
  "totp-setup:account": { scope: "account", limit: 5 },
  // Team → Google actions, per acting admin.
  "google:admin:admin": { scope: "admin", limit: 10 }
} as const satisfies Record<string, { scope: BucketScope; limit: number }>;

export type BucketFamily = keyof typeof BUCKET_FAMILIES;
type Entry = { count: number; resetAt: number; family: BucketFamily };

const authAttempts = new Map<string, Entry>();

/**
 * The map holds at most this many keys before it drops per-client keys (oldest first). Protected keys
 * are bounded without it: per-email keys are created only by attempts that got past the instance-wide
 * sign-in bucket (at most 120 a minute, each gone a minute later), per-account and per-admin keys by
 * the number of accounts, and instance-wide keys by the families above.
 */
export const AUTH_LIMIT_MAX_KEYS = 20_000;
let lastSweep = 0;

const evictable = (family: BucketFamily) => BUCKET_FAMILIES[family].scope === "client";
const keyOf = (family: BucketFamily, id: string | null) => id === null ? family : `${family}:${id}`;

function sweep(time: number, force = false) {
  if (!force && (authAttempts.size < 500 || time - lastSweep < 1_000)) return;
  lastSweep = time;
  for (const [key, entry] of authAttempts) if (entry.resetAt <= time) authAttempts.delete(key);
}

/** Room for one more key: expired keys first, then per-client keys, oldest first. False when full of protected keys. */
function makeRoom(time: number) {
  if (authAttempts.size < AUTH_LIMIT_MAX_KEYS) return true;
  sweep(time, true);
  for (const [key, entry] of authAttempts) {
    if (authAttempts.size < AUTH_LIMIT_MAX_KEYS) break;
    if (evictable(entry.family)) authAttempts.delete(key);
  }
  return authAttempts.size < AUTH_LIMIT_MAX_KEYS;
}

/**
 * Counts one attempt in a bucket and answers whether it is over the limit. With the map full of
 * protected keys (should not happen, see the bound above) a new per-client key is refused and the
 * attempt fails closed (true); a new protected key is still stored, since dropping one would reset it.
 */
export function hit(family: BucketFamily, id: string | null = null) {
  const time = Date.now();
  sweep(time);
  const key = keyOf(family, id);
  const entry = authAttempts.get(key);
  if (entry && entry.resetAt > time) {
    entry.count += 1;
    return entry.count > BUCKET_FAMILIES[family].limit;
  }
  if (entry) authAttempts.delete(key); // a new window is a new key, so insertion order stays age order
  if (!makeRoom(time) && evictable(family)) return true;
  authAttempts.set(key, { count: 1, resetAt: time + 60_000, family });
  return false;
}

/** Whether a bucket is already used up, without counting this attempt or creating a key. */
function exhausted(family: BucketFamily, id: string | null = null) {
  const entry = authAttempts.get(keyOf(family, id));
  return entry !== undefined && entry.resetAt > Date.now() && entry.count >= BUCKET_FAMILIES[family].limit;
}

/** The numbers (S7; THREAT_MODEL and OPERATIONS repeat them), per minute. */
export const AUTH_LIMITS = {
  signIn: { perClient: BUCKET_FAMILIES["login:client"].limit, perEmail: BUCKET_FAMILIES["login:email"].limit, global: BUCKET_FAMILIES["login:global"].limit },
  register: { perClient: BUCKET_FAMILIES["register:client"].limit, global: BUCKET_FAMILIES["register:global"].limit },
  invitePreview: { perClient: BUCKET_FAMILIES["invite:client"].limit, global: BUCKET_FAMILIES["invite:global"].limit }
} as const;

let clientLimitsOn = true;
/**
 * Test hook: `bun test` sends every request from one address, so the harness turns the per-client
 * sign-in, registration, and invite buckets off; tests/authLimits.test.ts turns them on to cover them.
 * The Google start and callback buckets always apply.
 */
export function setClientLimitsForTests(on: boolean) {
  clientLimitsOn = on;
}
const TEST_TOGGLED: readonly BucketFamily[] = ["login:client", "register:client", "invite:client"];

type Scoped = readonly [BucketFamily, string | null];

/**
 * S4, S7, F1b: a full instance-wide bucket refuses at once, before any other key is created or
 * touched; then the narrower buckets, client first; only an attempt that passes them counts toward
 * the instance-wide one, so one address cannot use up everyone's allowance. The one implementation
 * for every limit that has an instance-wide bucket.
 */
function limitedWithin(global: BucketFamily, scoped: Scoped[]) {
  if (exhausted(global)) return true;
  for (const [family, id] of scoped) {
    if (TEST_TOGGLED.includes(family) && !clientLimitsOn) continue;
    if (hit(family, id)) return true;
  }
  return hit(global);
}

/** Password sign-in, and the Nook code step of a Google sign-in (the same buckets, D296). */
export const signInLimited = (c: Context, email: string) =>
  limitedWithin("login:global", [["login:client", clientAddress(c)], ["login:email", email.toLowerCase()]]);

/** Account creation, by password or by Google. */
export const registerLimited = (c: Context) => limitedWithin("register:global", [["register:client", clientAddress(c)]]);

/** The pre-auth invite preview (by password or before a Google hand-off). */
export const invitePreviewLimited = (c: Context) => limitedWithin("invite:global", [["invite:client", clientAddress(c)]]);

/** Google sign-in: a start (`/api/auth/google/start`) or a callback. */
export const googleStartLimited = (c: Context) => limitedWithin("google:start:global", [["google:start:client", clientAddress(c)]]);
export const googleCallbackLimited = (c: Context) => limitedWithin("google:callback:global", [["google:callback:client", clientAddress(c)]]);

/** Test hook: `bun test` runs every file on one server, so the run-wide register:global bucket is shared. */
export function resetRegistrationRateLimit() {
  for (const [key, entry] of authAttempts) {
    if (entry.family.startsWith("google:") || entry.family.startsWith("register:") || entry.family.startsWith("invite:")) authAttempts.delete(key);
  }
}

/** Test hook: clears every sign-in bucket. */
export function resetSignInRateLimit() {
  for (const [key, entry] of authAttempts) if (entry.family.startsWith("login:")) authAttempts.delete(key);
}

/** Test hooks. */
export const authLimitKeyCount = () => authAttempts.size;
export function attemptsFor(family: BucketFamily, id: string | null = null) {
  const entry = authAttempts.get(keyOf(family, id));
  return entry && entry.resetAt > Date.now() ? entry.count : 0;
}
export function clearAuthLimitsForTests() {
  authAttempts.clear();
}
