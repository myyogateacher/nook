/**
 * Run as a separate `bun` process by tests/teamBootstrap.test.ts: an empty install with
 * ALLOW_REGISTRATION=true and no SIGNUP_ROLE at all, so the account registered after the
 * bootstrap admin shows the built-in default role. Prints one JSON line.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "mynotes-signup-default-probe-"));
const origin = "http://localhost:22037";
delete process.env.SIGNUP_ROLE;
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22037",
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
  const { config } = await import("../../server/config");
  const app = (await import("../../server/index")).default;
  const register = (email: string) => app.fetch(new Request(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, displayName: email.split("@")[0], password: "correct horse battery staple" })
  }));
  const first = await register("owner@example.test");
  const firstBody = await first.json() as { user: { role: string } };
  const second = await register("newcomer@example.test");
  const secondBody = await second.json() as { user: { role: string } };
  console.log(JSON.stringify({
    signupRole: config.signupRole,
    statuses: [first.status, second.status],
    roles: [firstBody.user.role, secondBody.user.role]
  }));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
