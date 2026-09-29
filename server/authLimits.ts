/**
 * In-memory attempt limits for sign-in, registration, invites, and Google sign-in (a restart clears
 * them). One-minute windows. Shared by password and Google sign-in, so both draw on the same
 * `login:<email>` and `login:global` buckets (Wave 35, D296).
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();

export function rateLimited(key: string, limit = 10) {
  const time = Date.now();
  if (authAttempts.size > 500) {
    for (const [entryKey, entry] of authAttempts) if (entry.resetAt <= time) authAttempts.delete(entryKey);
  }
  const item = authAttempts.get(key);
  if (!item || item.resetAt <= time) {
    authAttempts.set(key, { count: 1, resetAt: time + 60_000 });
    return false;
  }
  item.count += 1;
  return item.count > limit;
}

/** Test hook: `bun test` runs every file on one server, so the run-wide register:global bucket is shared. */
export function resetRegistrationRateLimit() {
  authAttempts.delete("register:global");
  authAttempts.delete("invite:global");
  for (const key of authAttempts.keys()) if (key.startsWith("google:")) authAttempts.delete(key);
}
