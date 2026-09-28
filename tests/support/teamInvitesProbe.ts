/**
 * Run as a separate `bun` process by tests/teamInvitesProbe.test.ts: invites exist to open a
 * closed instance (D162), and the shared harness runs with ALLOW_REGISTRATION=true. With
 * ALLOW_REGISTRATION=false and an allowlist, this registers the first account (with a made-up
 * token, which an empty instance ignores: bootstrap wins), then uses real invites. Prints one
 * JSON line with what it observed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "mynotes-invite-probe-"));
const origin = "http://localhost:22031";
const env = {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22031",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  ALLOW_REGISTRATION: "false",
  SIGNUP_ROLE: "member",
  TOTP_POLICY: "optional",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_EMAILS: "first@example.test,viewer@example.test,second@example.test,plain@example.test",
  MIN_FREE_DISK_BYTES: "0",
  PUSH_ENABLED: "false"
};
Object.assign(process.env, env);

try {
  const server = await import("../../server/index");
  const app = server.default;
  const { db } = await import("../../server/db");
  const post = (path: string, body: unknown, session?: { cookie: string; csrf: string }) => {
    server.resetRegistrationRateLimit();
    return app.fetch(new Request(`${origin}/api${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}) },
      body: JSON.stringify(body)
    }));
  };
  const register = (email: string, inviteToken?: string) => post("/auth/register", { email, displayName: email.split("@")[0], password: "correct horse battery staple", ...(inviteToken ? { inviteToken } : {}) });

  const first = await register("first@example.test", "t".repeat(43));
  const firstBody = await first.json() as { user: { role: string }; csrfToken: string };
  const admin = { cookie: (first.headers.get("set-cookie") ?? "").split(";", 1)[0]!, csrf: firstBody.csrfToken };

  const closed = await register("plain@example.test");
  const created = await post("/team/invites", { role: "viewer" }, admin);
  const { token } = await created.json() as { token: string };
  const bogus = await register("plain@example.test", "u".repeat(43));
  const invited = await register("viewer@example.test", token);
  const invitedBody = await invited.json() as { user: { role: string } };
  const reused = await register("second@example.test", token);
  const reusedBody = await reused.json() as { code?: string };
  const outsider = await register("outsider@example.test", token);

  console.log(JSON.stringify({
    first: { status: first.status, role: firstBody.user.role },
    closed: closed.status,
    created: created.status,
    bogus: bogus.status,
    invited: { status: invited.status, role: invitedBody.user.role },
    reused: { status: reused.status, code: reusedBody.code },
    outsider: outsider.status,
    roles: db.query("SELECT email, role FROM users ORDER BY created_at, email").all()
  }));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
