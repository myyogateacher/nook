import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// server/config.ts reads the environment once for the whole run: the harness must set it first.
import { createUser, origin, spareEmail } from "./support/harness";
const { config } = await import("../server/config");
const limits = await import("../server/authLimits");

/**
 * Sign-in, registration, and invite-preview limits (Wave 35 final round, S4 and S7). Every test
 * request comes from one socket address, so these tests trust one proxy hop and set the client
 * address with X-Forwarded-For (documentation ranges only).
 */
const savedHops = config.trustedProxyHops;
beforeEach(() => {
  config.trustedProxyHops = 1;
  limits.setClientLimitsForTests(true);
  limits.resetSignInRateLimit();
  limits.resetRegistrationRateLimit();
});
afterEach(() => {
  config.trustedProxyHops = savedHops;
  limits.setClientLimitsForTests(false);
  limits.resetSignInRateLimit();
  limits.resetRegistrationRateLimit();
});

const post = (path: string, from: string, body: unknown) => fetch(`${origin}/api${path}`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": from },
  body: JSON.stringify(body)
});
const login = (from: string, email = spareEmail()) => post("/auth/login", from, { email, password: "not the password" });

describe("password sign-in limits (S7)", () => {
  test("20 attempts a minute per address, whatever the emails; other addresses are unaffected", async () => {
    for (let index = 0; index < 20; index += 1) expect((await login("198.51.100.1")).status).toBe(401);
    expect((await login("198.51.100.1")).status).toBe(429);
    expect((await login("198.51.100.2")).status).toBe(401);
    // Only attempts that passed the address bucket counted toward the global one.
    expect(limits.attemptsFor("login:global")).toBe(21);
  });

  test("every spelling of one address, and every address in one IPv6 /64, share a bucket (S3)", async () => {
    const spellings = ["2001:db8:1:2::1", "2001:DB8:1:2:0:0:0:1", "[2001:db8:1:2::1]", "2001:db8:1:2:ffff::9", "2001:0db8:0001:0002::abcd"];
    for (let index = 0; index < 20; index += 1) expect((await login(spellings[index % spellings.length]!)).status).toBe(401);
    expect((await login("2001:db8:1:2::77")).status).toBe(429);
    expect((await login("2001:db8:1:3::1")).status).toBe(401);
    for (let index = 0; index < 20; index += 1) expect((await login(index % 2 ? "::ffff:192.0.2.9" : "192.0.2.9")).status).toBe(401);
    expect((await login("::FFFF:c000:209")).status).toBe(429);
  });

  test("10 attempts a minute per email, across addresses", async () => {
    const person = await createUser("Limited by email");
    for (let index = 0; index < 10; index += 1) expect((await login(`203.0.113.${index + 1}`, person.email)).status).toBe(401);
    expect((await login("203.0.113.50", person.email)).status).toBe(429);
  });

  test("120 a minute across the instance; a full global bucket refuses before any address key is added (S4)", async () => {
    for (let client = 0; client < 6; client += 1) {
      for (let index = 0; index < 20; index += 1) expect((await login(`198.51.100.${client + 10}`)).status).toBe(401);
    }
    expect(limits.attemptsFor("login:global")).toBe(120);
    expect((await login("198.51.100.99")).status).toBe(429);
    expect(limits.attemptsFor("login:client:198.51.100.99")).toBe(0);
  }, 30_000);
});

describe("registration and invite preview limits (S7)", () => {
  test("registration: 5 a minute per address, 20 across the instance", async () => {
    const register = (from: string) => post("/auth/register", from, { email: spareEmail(), displayName: "Limited", password: "correct horse battery staple", inviteToken: "a".repeat(43) });
    for (let index = 0; index < 5; index += 1) expect((await register("198.51.100.20")).status).not.toBe(429);
    expect((await register("198.51.100.20")).status).toBe(429);
    for (let client = 0; client < 3; client += 1) {
      for (let index = 0; index < 5; index += 1) expect((await register(`198.51.100.${client + 21}`)).status).not.toBe(429);
    }
    expect(limits.attemptsFor("register:global")).toBe(20);
    expect((await register("198.51.100.30")).status).toBe(429);
  });

  test("invite preview: 10 a minute per address, 60 across the instance", async () => {
    const preview = (from: string) => post("/auth/invite", from, { token: "a".repeat(43) });
    for (let index = 0; index < 10; index += 1) expect((await preview("198.51.100.40")).status).not.toBe(429);
    expect((await preview("198.51.100.40")).status).toBe(429);
    expect((await preview("198.51.100.41")).status).not.toBe(429);
    expect(limits.AUTH_LIMITS.invitePreview).toEqual({ perClient: 10, global: 60 });
  });
});

describe("the attempt map (S4)", () => {
  test("never holds more than its cap, and keeps the instance-wide buckets", () => {
    limits.rateLimited("probe:global", 5);
    for (let index = 0; index < limits.AUTH_LIMIT_MAX_KEYS + 50; index += 1) limits.rateLimited(`probe:client:${index}`, 5);
    expect(limits.authLimitKeyCount()).toBeLessThanOrEqual(limits.AUTH_LIMIT_MAX_KEYS);
    expect(limits.attemptsFor("probe:global")).toBe(1);
    expect(limits.attemptsFor(`probe:client:${limits.AUTH_LIMIT_MAX_KEYS + 49}`)).toBe(1);
    limits.clearAuthLimitsForTests("probe:");
  });
});
