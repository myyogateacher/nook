import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
// server/config.ts reads the environment once for the whole run: the harness must set it first.
import "./support/harness";
const { addressBucket, clientAddress, forwardedWarningLogged, normalizeIp, resetForwardedWarning } = await import("../server/clientAddress");

/**
 * TRUSTED_PROXY_HOPS (Wave 35 review N1): the client address for rate limits and audits. Requests go
 * through `app.fetch` without a Bun server, so there is no socket address and the fallback is
 * "unknown": whatever the helper returns other than that came from X-Forwarded-For.
 */
function addressFor(hops: number, forwarded?: string, extra: Record<string, string> = {}) {
  const app = new Hono();
  app.get("/", (c) => c.text(clientAddress(c, hops)));
  return Promise.resolve(app.fetch(new Request("http://nook.test/", { headers: { ...(forwarded !== undefined ? { "X-Forwarded-For": forwarded } : {}), ...extra } }))).then((response) => response.text());
}

describe("client address behind trusted proxies (N1b)", () => {
  test("hops 0 ignores every forwarding header", async () => {
    expect(await addressFor(0, "203.0.113.9")).toBe("unknown");
    expect(await addressFor(0, undefined, { "X-Real-IP": "203.0.113.9", Forwarded: "for=203.0.113.9" })).toBe("unknown");
  });

  test("hops 1 takes the right-most entry, so a client-supplied left entry cannot spoof", async () => {
    expect(await addressFor(1, "203.0.113.9")).toBe("203.0.113.9");
    expect(await addressFor(1, "198.51.100.66, 203.0.113.9")).toBe("203.0.113.9");
    expect(await addressFor(1, undefined, { "X-Real-IP": "198.51.100.66" })).toBe("unknown");
  });

  test("hops 2 takes the second entry from the right", async () => {
    expect(await addressFor(2, "198.51.100.66, 203.0.113.9, 10.0.0.2")).toBe("203.0.113.9");
  });

  test("a short or malformed header falls back to the socket address", async () => {
    expect(await addressFor(2, "203.0.113.9")).toBe("unknown");
    expect(await addressFor(1, "not-an-address")).toBe("unknown");
    expect(await addressFor(1, "203.0.113.9, ")).toBe("203.0.113.9");
    expect(await addressFor(1, "")).toBe("unknown");
  });

  test("S3: every spelling of one address is one canonical form", () => {
    const pairs: Array<[string, string]> = [
      ["2001:DB8::1", "2001:db8::1"],
      ["2001:db8:0:0:0:0:0:1", "2001:db8::1"],
      ["2001:0db8:0000:0000::0001", "2001:db8::1"],
      ["[2001:db8::1]", "2001:db8::1"],
      ["fe80::1%eth0", "fe80::1"],
      ["[fe80::1%25eth0]", "fe80::1"],
      ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
      ["::ffff:192.0.2.7", "192.0.2.7"],
      ["::FFFF:c000:0207", "192.0.2.7"],
      ["0:0:0:0:0:ffff:192.0.2.7", "192.0.2.7"],
      ["0000:0000:0000:0000:0000:FFFF:C000:0207", "192.0.2.7"],
      ["::ffff:10.1.2.3", "10.1.2.3"]
    ];
    for (const [spelling, canonical] of pairs) expect([spelling, normalizeIp(spelling)]).toEqual([spelling, canonical]);
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("not-an-address")).toBeNull();
  });

  test("S3: IPv6 counts by its /64; IPv4 by the address", async () => {
    expect(addressBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressBucket("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(await addressFor(1, "2001:DB8::1")).toBe("2001:db8::/64");
    expect(await addressFor(1, "[2001:db8::2]")).toBe("2001:db8::/64");
    expect(await addressFor(1, "::ffff:192.0.2.7")).toBe("192.0.2.7");
  });

  test("S8: with hops 0, a forwarded request logs one warning per process, without the address", async () => {
    resetForwardedWarning();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      await addressFor(0);
      expect(forwardedWarningLogged()).toBe(false);
      await addressFor(0, "203.0.113.9");
      await addressFor(0, "198.51.100.1");
      await addressFor(1, "203.0.113.9");
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TRUSTED_PROXY_HOPS is 0");
    expect(warnings[0]).not.toContain("203.0.113.9");
  });

  test("TRUSTED_PROXY_HOPS is validated at startup (integer 0–5)", () => {
    const configPath = join(import.meta.dir, "..", "server", "config.ts");
    const load = (value: string) => Bun.spawnSync(["bun", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(config.trustedProxyHops);`], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), TRUSTED_PROXY_HOPS: value },
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(load("").stdout.toString().trim()).toBe("0");
    expect(load("2").stdout.toString().trim()).toBe("2");
    for (const bad of ["6", "-1", "1.5", "one"]) {
      const result = load(bad);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("TRUSTED_PROXY_HOPS must be an integer between 0 and 5");
    }
  }, 30_000);
});
