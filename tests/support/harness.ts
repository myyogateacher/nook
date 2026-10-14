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
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort } from "./ports";

export const dataDir = mkdtempSync(join(tmpdir(), "mynotes-test-"));
// MYNOTES_TEST_PORT pins the shared server's port; without it the run takes a free one, so two runs never collide.
// The reservation holds the port until the server below listens on it (tests/support/ports.ts).
const reservation = process.env.MYNOTES_TEST_PORT ? null : reservePort();
export const port = reservation ? reservation.port : Number(process.env.MYNOTES_TEST_PORT);
export const origin = `http://localhost:${port}`;
export const tailscaleOrigin = "https://notes.example-tailnet.ts.net";
/**
 * The first SEQUENTIAL_TEST_EMAILS go to register()/createUser() in order (the whole suite shares one
 * process and counter); the rest are spares, handed out from the end by spareEmail(), for tests that
 * need an address no account uses.
 */
export const SEQUENTIAL_TEST_EMAILS = 3000;
export const allowedTestEmails = Array.from({ length: 4000 }, (_, index) => `allowed-${index + 1}@example.test`);

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
// The Vault (Wave 25) is on in the shared server; tests/vaultStartup.test.ts covers it off and misconfigured.
process.env.VAULT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
// Agent chat (Wave 40) is on in the shared server; the fake provider listens on 127.0.0.1, which the
// egress guard allows only through this list (tests/agentsEgress.test.ts covers the refusal).
process.env.AGENT_SECRETS_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.AGENT_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
process.env.ALLOWED_EMAILS = allowedTestEmails.join(",");
// Small limits keep the upload tests fast. Bun's maxRequestBodySize becomes
// max(MAX_UPLOAD_BYTES, 2_100_000) + 1 MiB, which stays above the 2.1 MB JSON
// limit so the body-limit tests prove the bounded reader, not Bun, rejects.
process.env.MAX_UPLOAD_BYTES = "4194304";
process.env.USER_STORAGE_QUOTA_BYTES = "12582912";
process.env.MIN_FREE_DISK_BYTES = "0";

// S3 storage slice: `MYNOTES_TEST_STORAGE=s3 bun test <files>` runs the shared server against an
// in-process fake S3 (tests/support/fakeS3.ts) instead of DATA_DIR; the default run stays on the local
// backend. A test-only switch, not STORAGE_BACKEND itself: Bun.spawn without `env` hands children the
// environment the process started with, and probe children must keep the local backend (a spawnSync
// child could never reach the in-process fake while this process waits for it).
export const s3Backend = process.env.MYNOTES_TEST_STORAGE?.trim() === "s3";
if (process.env.STORAGE_BACKEND?.trim() === "s3") throw new Error("Run the server tests on S3 with MYNOTES_TEST_STORAGE=s3, not STORAGE_BACKEND=s3 (probe children inherit it)");
export const fakeS3 = s3Backend ? (await import("./fakeS3")).startFakeS3() : null;
const s3Env = fakeS3 ? { STORAGE_BACKEND: "s3", S3_ENDPOINT: fakeS3.url, S3_BUCKET: fakeS3.bucket, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: fakeS3.accessKeyId, S3_SECRET_ACCESS_KEY: fakeS3.secretAccessKey, S3_PREFIX: "nook-test" } : {};
Object.assign(process.env, s3Env);

const serverModule = await import("../../server/index");
// Children given `{ ...process.env }` keep the local backend too.
for (const name of Object.keys(s3Env)) delete process.env[name];
export const serverOptions = serverModule.default;
// Every test request comes from one address: the per-client sign-in, registration, and invite
// buckets (S7) are covered in tests/authLimits.test.ts and off everywhere else.
(await import("../../server/authLimits")).setClientLimitsForTests(false);
// New password hashes use a cheap argon2id cost: the production cost made auth-flow tests CPU-bound
// enough to time out under host load (server/passwords.ts).
(await import("../../server/passwords")).setPasswordCostForTests(true);
export const { db } = await import("../../server/db");
// The test database is thrown away after the run, so it skips fsync: under host load (Docker verify
// beside other suites) a commit's fsync on overlayfs stalled ordinary tests past Bun's 5 s timeout.
db.exec("PRAGMA synchronous = OFF");
// A pinned MYNOTES_TEST_PORT binds plainly, so a port another process holds fails loudly (EADDRINUSE).
export const server = Bun.serve({ ...serverOptions, port, reusePort: reservation !== null });
reservation?.release();

(globalThis as { __mynotesHarnessCleanup?: () => void }).__mynotesHarnessCleanup = () => {
  server.stop(true);
  fakeS3?.stop();
  rmSync(dataDir, { recursive: true, force: true });
};

/** Whether a document object exists in the configured store (local disk or the fake S3). */
export async function storedObjectExists(id: string, namespace: "documents" | "avatars" = "documents") {
  const { objectStore } = await import("../../server/objectStore");
  return (await objectStore().stat(namespace, id)) !== null;
}

/** A stored object's bytes from the configured store. */
export async function storedObjectBytes(id: string, namespace: "documents" | "avatars" = "documents") {
  const { objectStore } = await import("../../server/objectStore");
  return Buffer.from(await (await objectStore().open(namespace, id)).bytes());
}

/** Writes an object straight into the configured store (fixtures for sweeper tests). */
export async function putStoredObject(id: string, bytes: Uint8Array | string, namespace: "documents" | "avatars" = "documents") {
  const { objectStore } = await import("../../server/objectStore");
  await objectStore().put(namespace, id, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
}

/** Makes a stored object look `ms` old to the sweepers. */
export function ageStoredObject(id: string, ms: number, namespace: "documents" | "avatars" = "documents") {
  if (fakeS3) return fakeS3.age(`nook-test/${namespace}/${id}`, ms);
  const when = (Date.now() - ms) / 1000;
  utimesSync(namespace === "documents" ? join(dataDir, "documents", "objects", id) : join(dataDir, "avatars", id), when, when);
}

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
