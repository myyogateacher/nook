/**
 * Run as a separate `bun` process by tests/twoFactorAvailability.test.ts. The shared harness sets a
 * TOTP key once per test run, so an instance without one needs its own process. It calls the app's
 * fetch handler directly (no listening socket) and prints one JSON line: what /api/about says.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "mynotes-no-totp-probe-"));
const origin = "http://localhost:22028";
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22028",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  TOTP_POLICY: "optional",
  TOTP_ENCRYPTION_KEY: "",
  MAX_UPLOAD_BYTES: "4194304",
  MIN_FREE_DISK_BYTES: "0"
});

try {
  const app = (await import("../../server/index")).default;
  const about = await (await app.fetch(new Request(`${origin}/api/about`))).json() as Record<string, unknown>;
  console.log(JSON.stringify({ twoFactor: about.twoFactor, keys: Object.keys(about).sort() }));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
