import type { Context } from "hono";
import { clientAddress } from "./clientAddress";

/**
 * In-memory attempt limits for sign-in, registration, invites, and Google sign-in (a restart clears
 * them). One-minute windows. Shared by password and Google sign-in, so both draw on the same
 * `login:*` buckets (Wave 35, D296).
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();

/** S4: the map never holds more than this many keys; the oldest scoped keys go first. */
export const AUTH_LIMIT_MAX_KEYS = 20_000;
let lastSweep = 0;

function sweep(time: number) {
  if (authAttempts.size < 500 || time - lastSweep < 1_000) return;
  lastSweep = time;
  for (const [entryKey, entry] of authAttempts) if (entry.resetAt <= time) authAttempts.delete(entryKey);
}

function makeRoom() {
  if (authAttempts.size < AUTH_LIMIT_MAX_KEYS) return;
  // Insertion order is age order; the run-wide `…:global` buckets are never dropped.
  for (const entryKey of authAttempts.keys()) {
    if (authAttempts.size < AUTH_LIMIT_MAX_KEYS) break;
    if (!entryKey.endsWith(":global")) authAttempts.delete(entryKey);
  }
}

export function rateLimited(key: string, limit = 10) {
  const time = Date.now();
  sweep(time);
  const item = authAttempts.get(key);
  if (!item || item.resetAt <= time) {
    if (!item) makeRoom();
    authAttempts.set(key, { count: 1, resetAt: time + 60_000 });
    return false;
  }
  item.count += 1;
  return item.count > limit;
}

/** Whether a bucket is already used up, without counting this attempt. */
function exhausted(key: string, limit: number) {
  const item = authAttempts.get(key);
  return item !== undefined && item.resetAt > Date.now() && item.count >= limit;
}

/**
 * The numbers (S7; THREAT_MODEL and OPERATIONS repeat them): per client address (an IPv6 client
 * counts by its /64), per email, and instance-wide, each per minute.
 */
export const AUTH_LIMITS = {
  signIn: { perClient: 20, perEmail: 10, global: 120 },
  register: { perClient: 5, global: 20 },
  invitePreview: { perClient: 10, global: 60 }
} as const;

let clientLimitsOn = true;
/**
 * Test hook: `bun test` sends every request from one address, so the harness turns the per-client
 * buckets off; tests/authLimits.test.ts turns them on to cover them.
 */
export function setClientLimitsForTests(on: boolean) {
  clientLimitsOn = on;
}

/**
 * S4, S7: a global bucket that is already full refuses at once (no per-client key is added); then
 * the scoped buckets, client first; only an attempt that passes them counts toward the global one,
 * so one address cannot use up everyone's allowance.
 */
function limitedWithin(scoped: Array<readonly [string, number] | null>, global: readonly [string, number]) {
  if (exhausted(global[0], global[1])) return true;
  for (const bucket of scoped) if (bucket && rateLimited(bucket[0], bucket[1])) return true;
  return rateLimited(global[0], global[1]);
}

const clientBucket = (c: Context, family: string, limit: number) => clientLimitsOn ? [`${family}:client:${clientAddress(c)}`, limit] as const : null;

/** Password sign-in, and the Nook code step of a Google sign-in (the same buckets, D296). */
export const signInLimited = (c: Context, email: string) =>
  limitedWithin([clientBucket(c, "login", AUTH_LIMITS.signIn.perClient), [`login:${email.toLowerCase()}`, AUTH_LIMITS.signIn.perEmail]], ["login:global", AUTH_LIMITS.signIn.global]);

/** Account creation, by password or by Google. */
export const registerLimited = (c: Context) =>
  limitedWithin([clientBucket(c, "register", AUTH_LIMITS.register.perClient)], ["register:global", AUTH_LIMITS.register.global]);

/** The pre-auth invite preview (by password or before a Google hand-off). */
export const invitePreviewLimited = (c: Context) =>
  limitedWithin([clientBucket(c, "invite", AUTH_LIMITS.invitePreview.perClient)], ["invite:global", AUTH_LIMITS.invitePreview.global]);

/** Test hook: `bun test` runs every file on one server, so the run-wide register:global bucket is shared. */
export function resetRegistrationRateLimit() {
  for (const key of authAttempts.keys()) {
    if (key.startsWith("google:") || key.startsWith("register:") || key.startsWith("invite:")) authAttempts.delete(key);
  }
}

/** Test hook: clears every sign-in bucket. */
export function resetSignInRateLimit() {
  for (const key of authAttempts.keys()) if (key.startsWith("login:")) authAttempts.delete(key);
}

export const authLimitKeyCount = () => authAttempts.size;
/** Test hook: the attempts counted in a live bucket (0 when there is none). */
export function attemptsFor(key: string) {
  const item = authAttempts.get(key);
  return item && item.resetAt > Date.now() ? item.count : 0;
}

/** Test hook: clears every bucket whose key starts with `prefix`. */
export function clearAuthLimitsForTests(prefix: string) {
  for (const key of authAttempts.keys()) if (key.startsWith(prefix)) authAttempts.delete(key);
}
