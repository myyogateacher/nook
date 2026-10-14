/**
 * Run as a separate `bun` process by tests/teamBootstrap.test.ts: a database with accounts but no
 * active admin (an upgrade where migration 017 found only disabled accounts) needs its own data
 * directory. Seeds that state before the server boots, then registers with ALLOW_REGISTRATION=true.
 * Prints one JSON line with what it observed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "mynotes-no-admin-probe-"));
const origin = "http://localhost:22030";
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22030",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  ALLOW_REGISTRATION: "true",
  TOTP_POLICY: "optional",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_EMAILS: "",
  MIN_FREE_DISK_BYTES: "0",
  PUSH_ENABLED: "false"
});

try {
  const { db } = await import("../../server/db");
  const { warnIfNoActiveAdmin } = await import("../../server/team/service");
  const emptyWarned = warnIfNoActiveAdmin(() => undefined);
  // Only disabled accounts, and none of them an admin: what 017's backfill leaves behind.
  const timestamp = new Date().toISOString();
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, disabled_at) VALUES (?, 'old@example.test', 'Old', 'x', ?, ?)")
    .run(crypto.randomUUID(), timestamp, timestamp);

  // Boot warnings go through the logger (server/log.ts); captured here so stdout keeps one JSON line.
  const { captureLogs } = await import("../../server/log");
  const capture = captureLogs({ level: "warn" });
  const app = (await import("../../server/index")).default;
  capture.restore();
  const warnings = capture.lines.filter((entry) => entry.level === "warn").map((entry) => entry.line);

  const register = (email: string) => app.fetch(new Request(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, displayName: email.split("@")[0], password: "correct horse battery staple" })
  }));
  const first = await register("rescue@example.test");
  const firstBody = await first.json() as { user: { role: string } };
  const second = await register("later@example.test");
  const secondBody = await second.json() as { user: { role: string } };
  const events = db.query("SELECT via, action, to_role, actor_id FROM team_events").all();
  const afterWarned = warnIfNoActiveAdmin(() => undefined);

  console.log(JSON.stringify({
    emptyWarned,
    bootWarnings: warnings.filter((line) => line.includes("no active admin")),
    statuses: [first.status, second.status],
    roles: [firstBody.user.role, secondBody.user.role],
    events,
    afterWarned
  }));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
