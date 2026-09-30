/**
 * Run as a separate `bun` process by tests/teamBootstrap.test.ts: the first-admin rule (D76) needs
 * an empty database, which the shared harness cannot give. Two "first" registrations race with
 * ALLOW_REGISTRATION=false, then the host CLI (server/team-admin.ts) runs against the same data
 * directory. Prints one JSON line with what it observed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "mynotes-team-probe-"));
const origin = "http://localhost:22029";
const env = {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22029",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  ALLOW_REGISTRATION: "false",
  TOTP_POLICY: "optional",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_EMAILS: "",
  MIN_FREE_DISK_BYTES: "0",
  PUSH_ENABLED: "false"
};
Object.assign(process.env, env);

function cli(...args: string[]) {
  const result = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "..", "..", "server", "team-admin.ts"), ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

try {
  const app = (await import("../../server/index")).default;
  const { db } = await import("../../server/db");
  const register = (email: string) => app.fetch(new Request(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, displayName: email.split("@")[0], password: "correct horse battery staple" })
  }));
  const [first, second] = await Promise.all([register("first@example.test"), register("second@example.test")]);
  const statuses = [first.status, second.status].sort();
  const winnerEmail = first.status === 201 ? "first@example.test" : "second@example.test";
  const winner = await (first.status === 201 ? first : second).json() as { user: { id: string; role: string } };
  const roles = db.query("SELECT role, COUNT(*) AS count FROM users GROUP BY role").all();
  const bootstrap = db.query("SELECT via, action, to_role, actor_id FROM team_events").all();

  // A second account, added the way an operator would with ALLOW_REGISTRATION briefly on.
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, 'member@example.test', 'Member', 'x', ?)").run(crypto.randomUUID(), new Date().toISOString());

  const list = cli("list");
  const lastAdmin = cli("set-role", winnerEmail, "member");
  const promote = cli("set-role", "member@example.test", "admin");
  const viewer = cli("set-role", "member@example.test", "viewer");
  const unknown = cli("set-role", "nobody@example.test", "admin");
  const notBlocked = cli("unblock", "member@example.test");
  const usage = cli("delete", "member@example.test");

  const cliEvents = db.query("SELECT via, action, from_role, to_role, actor_id FROM team_events WHERE via = 'cli'").all();
  const cliAudit = db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'team.role_changed' AND actor_id IS NULL").get();

  console.log(JSON.stringify({
    statuses,
    winnerRole: winner.user.role,
    roles,
    bootstrap,
    list: list.out.split("\n").map((line) => line.split("\t").slice(0, 3)),
    lastAdmin: { code: lastAdmin.code, err: lastAdmin.err },
    promote: { code: promote.code, out: promote.out },
    viewer: viewer.code,
    unknown: unknown.code,
    notBlocked: { code: notBlocked.code, err: notBlocked.err },
    usage: usage.code,
    cliEvents,
    cliAudit
  }));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
