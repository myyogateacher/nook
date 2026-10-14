/**
 * Probe children: a test that needs a server configured differently from the shared one runs a script
 * in tests/support/ as its own `bun --no-env-file` process and reads the JSON line it prints last.
 *
 * - The child gets a clean environment (PATH, HOME, TMPDIR, LOG_LEVEL) plus what the caller passes; the
 *   probe sets the rest itself. Inheriting the parent's environment leaked whatever the shell or a
 *   plain `bun test` (which loads .env: APP_NAME, AUTH_METHODS, ...) had set into the child's config.
 * - A probe cold-starts Bun and imports the whole server, which takes seconds on a loaded host, so a
 *   test that runs one passes PROBE_TIMEOUT_MS (Bun's 5 s default killed the child mid-run, leaving
 *   "JSON Parse error: Unexpected EOF" instead of a result).
 * - A probe that prints no JSON fails with its exit code and stderr, not a parse error.
 */
import { join } from "node:path";

export const PROBE_TIMEOUT_MS = 60_000;

export function probeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LOG_LEVEL: process.env.LOG_LEVEL ?? "silent" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return { ...env, ...extra };
}

/** The variables tests/support/harness.ts sets: a probe that reopens the shared server's data passes these on. */
const HARNESS_ENV_NAMES = ["DATA_DIR", "APP_ORIGIN", "APP_ORIGINS", "COOKIE_SECURE", "PORT", "NODE_ENV", "ALLOW_REGISTRATION", "TOTP_POLICY", "SIGNUP_ROLE",
  "TOTP_ENCRYPTION_KEY", "VAULT_ENCRYPTION_KEY", "AGENT_SECRETS_KEY", "AGENT_ALLOWED_PRIVATE_HOSTS", "ALLOWED_EMAILS", "MAX_UPLOAD_BYTES", "USER_STORAGE_QUOTA_BYTES", "MIN_FREE_DISK_BYTES"];

/** The harness's own settings, for a probe that acts as a restarted shared server (nothing else leaks in). */
export function harnessEnv(): Record<string, string> {
  return Object.fromEntries(HARNESS_ENV_NAMES.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

/** Runs tests/support/<script> with `args` and returns the last stdout line parsed as JSON. */
export function runProbe<T = Record<string, any>>(script: string, args: string[] = [], options: { env?: Record<string, string> } = {}): T {
  const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, script), ...args], { stdout: "pipe", stderr: "pipe", env: probeEnv(options.env) });
  const line = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
  let parsed: T;
  try {
    parsed = JSON.parse(line) as T;
  } catch {
    throw new Error(`${script} printed no JSON (exit ${probe.exitCode}): ${probe.stderr.toString().slice(-2000)}`);
  }
  if (probe.exitCode !== 0) throw new Error(`${script} exited ${probe.exitCode}: ${line} ${probe.stderr.toString().slice(-2000)}`);
  return parsed;
}
