/**
 * Shared server test harness.
 *
 * `server/config.ts` reads the environment at import time, so every server
 * test file must import this module instead of setting `process.env` itself.
 *
 * Verified with Bun 1.4.2: `bun test` runs every test file in one process with
 * a shared module registry and a shared `globalThis`. A second server test file
 * therefore reuses this module (and the one running `Bun.serve`) instead of
 * re-importing config or binding the port again, so there is no EADDRINUSE and
 * no differently configured server. The flip side is that an `afterAll`
 * registered here would fire at the end of whichever file imported the harness
 * first, and `process.on("exit")` hooks do not run under `bun test`. Cleanup is
 * therefore registered once for the whole run by `tests/support/preload.ts`
 * (see `bunfig.toml`), which calls `globalThis.__mynotesHarnessCleanup`.
 *
 * A configuration that needs different environment values (for example
 * `TOTP_POLICY=required`) must run in a separate `bun` subprocess.
 */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dataDir = mkdtempSync(join(tmpdir(), "mynotes-test-"));
export const port = Number(process.env.MYNOTES_TEST_PORT ?? 22026);
export const origin = `http://localhost:${port}`;
export const tailscaleOrigin = "https://notes.example-tailnet.ts.net";
/**
 * The first SEQUENTIAL_TEST_EMAILS go to register()/createUser() in order (the whole suite shares one
 * process and counter); the rest are spares, handed out from the end by spareEmail(), for tests that
 * need an address no account uses.
 */
export const SEQUENTIAL_TEST_EMAILS = 2000;
export const allowedTestEmails = Array.from({ length: 3000 }, (_, index) => `allowed-${index + 1}@example.test`);

process.env.DATA_DIR = dataDir;
process.env.APP_ORIGIN = origin;
process.env.APP_ORIGINS = `${origin},${tailscaleOrigin}`;
process.env.COOKIE_SECURE = "false";
process.env.PORT = String(port);
process.env.NODE_ENV = "test";
process.env.ALLOW_REGISTRATION = "true";
process.env.TOTP_POLICY = "optional";
// Most tests register accounts that then write; the guest default (D80) is covered in config.test.ts
// and tests/teamBootstrap.test.ts.
process.env.SIGNUP_ROLE = "member";
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.ALLOWED_EMAILS = allowedTestEmails.join(",");
// Small limits keep the upload tests fast. Bun's maxRequestBodySize becomes
// max(MAX_UPLOAD_BYTES, 2_100_000) + 1 MiB, which stays above the 2.1 MB JSON
// limit so the body-limit tests prove the bounded reader, not Bun, rejects.
process.env.MAX_UPLOAD_BYTES = "4194304";
process.env.USER_STORAGE_QUOTA_BYTES = "12582912";
process.env.MIN_FREE_DISK_BYTES = "0";

const serverModule = await import("../../server/index");
export const serverOptions = serverModule.default;
// Every test request comes from one address: the per-client sign-in, registration, and invite
// buckets (S7) are covered in tests/authLimits.test.ts and off everywhere else.
(await import("../../server/authLimits")).setClientLimitsForTests(false);
export const { db } = await import("../../server/db");
export const server = Bun.serve(serverOptions);

(globalThis as { __mynotesHarnessCleanup?: () => void }).__mynotesHarnessCleanup = () => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
};

export type Session = { cookie: string; setCookie: string; csrf: string; userId: string; email: string; password: string };
/** createUser() takes allowlisted emails from the start; spareEmail() hands them out from the end. */
let emailIndex = 0;
let spareIndex = allowedTestEmails.length;

function nextEmail() {
  if (emailIndex >= SEQUENTIAL_TEST_EMAILS) throw new Error("Test email allowlist exhausted");
  return allowedTestEmails[emailIndex++]!;
}

/**
 * An allowlisted email no account in this run has or will get, for invites bound to an address.
 * It never reaches the sequential block, so createUser() cannot take it later in the run.
 */
export function spareEmail() {
  if (spareIndex <= SEQUENTIAL_TEST_EMAILS) throw new Error("Spare test emails exhausted");
  return allowedTestEmails[--spareIndex]!;
}

export async function request(path: string, options: RequestInit = {}, session?: Session) {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!headers.has("Origin")) headers.set("Origin", origin);
  if (session) {
    headers.set("Cookie", session.cookie);
    if (options.method && options.method !== "GET" && options.method !== "HEAD" && !headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", session.csrf);
  }
  return fetch(`${origin}/api${path}`, { ...options, headers });
}

/**
 * Registers through the HTTP API. Registration is limited to 10 per minute server-wide, and every
 * test file shares one server, so the bucket is cleared first: a new `register()` call anywhere in
 * the run cannot push a later one into a 429. The limit itself is covered in tests/api.test.ts.
 */
export async function register(label: string, requestOrigin = origin): Promise<Session> {
  serverModule.resetRegistrationRateLimit();
  const email = nextEmail();
  const password = "correct horse battery staple";
  const response = await request("/auth/register", {
    method: "POST",
    headers: { Origin: requestOrigin },
    body: JSON.stringify({ email, displayName: label, password })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { csrfToken: string; user: { id: string } };
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, setCookie, csrf: body.csrfToken, userId: body.user.id, email, password };
}

let passwordHash: string | null = null;

/**
 * Creates a user and a session directly in the database, bypassing the
 * registration rate limit. Use it in tests that need many users and do not
 * exercise registration itself.
 */
export async function createUser(label: string): Promise<Session> {
  const { ensureDefaultFolder, now } = await import("../../server/db");
  const email = nextEmail();
  const password = "correct horse battery staple";
  passwordHash ??= await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 4096, timeCost: 2 });
  const userId = crypto.randomUUID();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const csrf = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const timestamp = now();
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, email, label, passwordHash, timestamp);
  ensureDefaultFolder(userId);
  db.query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, createHash("sha256").update(token).digest("hex"), csrf, timestamp, timestamp, new Date(Date.now() + 86_400_000).toISOString());
  const cookie = `mynotes_session=${token}`;
  return { cookie, setCookie: cookie, csrf, userId, email, password };
}
