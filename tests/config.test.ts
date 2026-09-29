import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configPath = join(import.meta.dir, "..", "server", "config.ts");

/** Imports server/config.ts in a fresh process (outside the repository, so no .env is loaded). */
function loadConfig(env: Record<string, string>) {
  const result = Bun.spawnSync(["bun", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify({ maxUploadBytes: config.maxUploadBytes, userStorageQuotaBytes: config.userStorageQuotaBytes, minFreeDiskBytes: config.minFreeDiskBytes }));`], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

describe("upload limit configuration", () => {
  test("uses the documented defaults", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ maxUploadBytes: 104_857_600, userStorageQuotaBytes: 10_737_418_240, minFreeDiskBytes: 1_073_741_824 });
  });

  test("accepts valid values, including an unlimited quota", () => {
    const result = loadConfig({ MAX_UPLOAD_BYTES: "1048576", USER_STORAGE_QUOTA_BYTES: "0", MIN_FREE_DISK_BYTES: "0" });
    expect(JSON.parse(result.stdout)).toEqual({ maxUploadBytes: 1_048_576, userStorageQuotaBytes: 0, minFreeDiskBytes: 0 });
  });

  test("rejects out-of-range and non-integer values", () => {
    for (const env of [
      { MAX_UPLOAD_BYTES: "1048575" },
      { MAX_UPLOAD_BYTES: "2147483649" },
      { MAX_UPLOAD_BYTES: "10MB" },
      { MAX_UPLOAD_BYTES: "1e7" },
      { USER_STORAGE_QUOTA_BYTES: "-1" },
      { MIN_FREE_DISK_BYTES: "1.5" }
    ]) {
      const result = loadConfig(env);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(`${Object.keys(env)[0]} must be an integer between`);
    }
  });
});

describe("push configuration", () => {
  function loadPush(env: Record<string, string>) {
    const result = Bun.spawnSync(["bun", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify({ pushEnabled: config.pushEnabled, pushSubject: config.pushSubject, pushEndpointHosts: config.pushEndpointHosts }));`], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), ...env },
      stdout: "pipe",
      stderr: "pipe"
    });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
  }

  test("defaults to auto with APP_ORIGIN as the subject", () => {
    expect(JSON.parse(loadPush({ APP_ORIGIN: "https://notes.example.test" }).stdout)).toEqual({ pushEnabled: "auto", pushSubject: "https://notes.example.test", pushEndpointHosts: [] });
    expect(JSON.parse(loadPush({ PUSH_ENABLED: "false", PUSH_SUBJECT: "mailto:ops@example.test", PUSH_ENDPOINT_HOSTS: "push.example.test, *.Push.Example.org" }).stdout))
      .toEqual({ pushEnabled: "false", pushSubject: "mailto:ops@example.test", pushEndpointHosts: ["push.example.test", "*.push.example.org"] });
  });

  test("rejects invalid values", () => {
    for (const [env, message] of [
      [{ PUSH_ENABLED: "yes" }, "PUSH_ENABLED"],
      [{ PUSH_SUBJECT: "ops@example.test" }, "PUSH_SUBJECT"],
      [{ PUSH_ENDPOINT_HOSTS: "10.0.0.1" }, "PUSH_ENDPOINT_HOSTS"],
      [{ PUSH_ENDPOINT_HOSTS: "https://push.example.test" }, "PUSH_ENDPOINT_HOSTS"],
      [{ PUSH_ENDPOINT_HOSTS: "*" }, "PUSH_ENDPOINT_HOSTS"]
    ] as const) {
      const result = loadPush(env);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(message);
    }
  });
});

describe("sign-up role configuration (D80)", () => {
  function loadSignupRole(env: Record<string, string>) {
    const result = Bun.spawnSync(["bun", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(config.signupRole));`], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), ...env },
      stdout: "pipe",
      stderr: "pipe"
    });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
  }

  test("defaults to guest and accepts guest, viewer, or member", () => {
    expect(JSON.parse(loadSignupRole({}).stdout)).toBe("guest");
    for (const role of ["guest", "viewer", "member"]) expect(JSON.parse(loadSignupRole({ SIGNUP_ROLE: role }).stdout)).toBe(role);
  });

  test("never admin, and nothing unknown", () => {
    for (const value of ["admin", "Admin", "owner"]) {
      const result = loadSignupRole({ SIGNUP_ROLE: value });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("SIGNUP_ROLE must be guest, viewer, or member");
    }
  });
});

describe("mail link host check (L4)", () => {
  const hostOf = (origin: string) => new URL(origin).hostname;

  test("loopback, unspecified, and IPv4-mapped loopback hosts count as local", async () => {
    const { isLocalHost } = await import("../server/config");
    for (const origin of [
      "http://localhost:2026", "http://LOCALHOST.", "http://nook.localhost", "http://127.0.0.1", "http://127.0.0.2:2026", "http://127.255.255.254",
      "http://127.1", "http://0.0.0.0:2026", "http://[::1]", "http://[0:0:0:0:0:0:0:1]", "http://[::]", "http://[::ffff:127.0.0.1]", "http://[::ffff:127.9.9.9]", "http://[::ffff:0.0.0.0]"
    ]) expect({ origin, local: isLocalHost(hostOf(origin)) }).toEqual({ origin, local: true });
    for (const origin of [
      "http://nook.lan", "http://128.0.0.1", "http://10.0.0.5", "http://192.168.1.10", "http://100.64.0.1", "http://[::2]", "http://[::ffff:10.0.0.1]",
      "http://[2001:db8::1]", "http://localhost.example.com", "http://127.0.0.1.example.com"
    ]) expect({ origin, local: isLocalHost(hostOf(origin)) }).toEqual({ origin, local: false });
  });

  test("mail through Resend stays off for a 127.0.0.0/8, 0.0.0.0, or mapped loopback origin even with http links allowed", () => {
    const enabled = (appOrigin: string) => {
      const result = Bun.spawnSync(["bun", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify({ enabled: config.mail.enabled }));`], {
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), APP_ORIGIN: appOrigin,
          RESEND_API_KEY: "re_placeholder_not_a_real_key", MAIL_FROM: "nook@example.com", MAIL_ALLOW_HTTP_LINKS: "true"
        },
        stdout: "pipe",
        stderr: "pipe"
      });
      return (JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as { enabled: boolean }).enabled;
    };
    expect(enabled("http://127.0.0.2:2026")).toBe(false);
    expect(enabled("http://0.0.0.0:2026")).toBe(false);
    expect(enabled("http://[::ffff:127.0.0.1]:2026")).toBe(false);
    expect(enabled("http://nook.lan:2026")).toBe(true);
  }, 30_000);
});

describe("sign-in methods (Wave 35, D290)", () => {
  function loadAuth(env: Record<string, string>) {
    const result = Bun.spawnSync(["bun", "--eval", `const { config, passwordAuthEnabled, googleAuthEnabled } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify({ methods: config.auth.methods, domains: config.auth.google.allowedDomains, token: config.auth.google.endpoints.token, password: passwordAuthEnabled(), google: googleAuthEnabled() }));`], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), ...env },
      stdout: "pipe",
      stderr: "pipe"
    });
    return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim().split("\n").at(-1) ?? "", stderr: result.stderr.toString() };
  }
  const client = { GOOGLE_CLIENT_ID: "1234-abc.apps.googleusercontent.test", GOOGLE_CLIENT_SECRET: "placeholder-secret-value" };

  test("defaults to password only, as before the wave", () => {
    expect(JSON.parse(loadAuth({}).stdout)).toEqual({ methods: "password", domains: [], token: "https://oauth2.googleapis.com/token", password: true, google: false });
  });

  test("google and both need the client id and secret, or the server refuses to start", () => {
    for (const methods of ["google", "both"]) {
      const missing = loadAuth({ AUTH_METHODS: methods });
      expect(missing.ok).toBe(false);
      expect(missing.stderr).toContain("needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
      expect(loadAuth({ AUTH_METHODS: methods, GOOGLE_CLIENT_ID: client.GOOGLE_CLIENT_ID }).ok).toBe(false);
    }
    expect(JSON.parse(loadAuth({ AUTH_METHODS: "google", ...client }).stdout)).toMatchObject({ methods: "google", password: false, google: true });
    expect(JSON.parse(loadAuth({ AUTH_METHODS: "Both", ...client, GOOGLE_ALLOWED_DOMAINS: " Example.test ,corp.test" }).stdout)).toMatchObject({ methods: "both", domains: ["example.test", "corp.test"], password: true, google: true });
  }, 30_000);

  test("rejects unknown methods, bad domains, and the test issuer in production", () => {
    expect(loadAuth({ AUTH_METHODS: "saml" }).stderr).toContain("AUTH_METHODS must be password, google, or both");
    expect(loadAuth({ AUTH_METHODS: "google", ...client, GOOGLE_ALLOWED_DOMAINS: "not a domain" }).stderr).toContain("GOOGLE_ALLOWED_DOMAINS entries must be domain names");
    expect(loadAuth({ AUTH_METHODS: "google", GOOGLE_CLIENT_ID: "has spaces in it", GOOGLE_CLIENT_SECRET: "placeholder-secret-value" }).ok).toBe(false);
    const production = loadAuth({ NODE_ENV: "production", COOKIE_SECURE: "true", AUTH_METHODS: "google", ...client, GOOGLE_OIDC_TEST_BASE_URL: "http://localhost:9" });
    expect(production.ok).toBe(false);
    expect(production.stderr).toContain("GOOGLE_OIDC_TEST_BASE_URL is for tests only");
    expect(JSON.parse(loadAuth({ AUTH_METHODS: "google", ...client, GOOGLE_OIDC_TEST_BASE_URL: "http://localhost:9" }).stdout).token).toBe("http://localhost:9/token");
  }, 30_000);
});
