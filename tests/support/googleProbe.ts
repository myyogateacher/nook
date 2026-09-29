/**
 * Run as a separate `bun` process by tests/googleAuthProbe.test.ts: AUTH_METHODS=google on an empty
 * instance with ALLOW_REGISTRATION=false (the shared harness runs password-only with open
 * registration). The first Google account becomes the admin (D76, D292); the next new address is
 * refused; password routes answer PASSWORD_SIGNIN_DISABLED. Prints one JSON line.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeGoogle } from "./fakeGoogle";

const dataDir = mkdtempSync(join(tmpdir(), "mynotes-google-probe-"));
const origin = "http://localhost:22036";
const fake = await startFakeGoogle();
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22036",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  ALLOW_REGISTRATION: "false",
  SIGNUP_ROLE: "member",
  TOTP_POLICY: "optional",
  ALLOWED_EMAILS: "first@nook.test,second@nook.test",
  MIN_FREE_DISK_BYTES: "0",
  PUSH_ENABLED: "false",
  AUTH_METHODS: "google",
  GOOGLE_CLIENT_ID: fake.clientId,
  GOOGLE_CLIENT_SECRET: fake.clientSecret,
  GOOGLE_OIDC_TEST_BASE_URL: fake.url
});

try {
  const server = await import("../../server/index");
  const app = server.default;
  const { db } = await import("../../server/db");
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${origin}${path}`, init));
  const setCookie = (response: Response, name: string) => response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? "";
  async function google(email: string) {
    const start = await call("/api/auth/google/start");
    const callback = fake.authorize(start.headers.get("location")!, { sub: `sub-${email}`, email, name: email.split("@")[0] });
    const url = new URL(callback);
    const response = await call(`${url.pathname}${url.search}`, { headers: { Cookie: setCookie(start, "nook_google_flow") } });
    return { location: response.headers.get("location"), session: setCookie(response, "mynotes_session") };
  }

  const about = await (await call("/api/about")).json() as { hasUsers: boolean; authMethods: unknown };
  const first = await google("first@nook.test");
  const firstRow = db.query("SELECT role FROM users WHERE email = ?").get("first@nook.test") as { role: string } | null;
  const bootstrap = db.query("SELECT via FROM team_events WHERE action = 'bootstrap_admin'").get() as { via: string } | null;
  const second = await google("second@nook.test");
  const login = await call("/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "first@nook.test", password: "anything at all" }) });
  const register = await call("/api/auth/register", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "second@nook.test", displayName: "S", password: "correct horse battery staple" }) });
  console.log(JSON.stringify({
    about: { hasUsers: about.hasUsers, authMethods: about.authMethods },
    first: { location: first.location, signedIn: Boolean(first.session), role: firstRow?.role ?? null, bootstrap: bootstrap?.via ?? null },
    second: { location: second.location, signedIn: Boolean(second.session), exists: Boolean(db.query("SELECT 1 FROM users WHERE email = ?").get("second@nook.test")) },
    login: { status: login.status, code: (await login.json() as { code?: string }).code },
    register: { status: register.status, code: (await register.json() as { code?: string }).code }
  }));
} finally {
  fake.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
