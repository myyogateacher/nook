import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientAddress, normalizeIp } from "../server/clientAddress";

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

  test("IPv6 and IPv4-mapped forms are normalised", async () => {
    expect(await addressFor(1, "2001:DB8::1")).toBe("2001:db8::1");
    expect(await addressFor(1, "[2001:db8::2]")).toBe("2001:db8::2");
    expect(await addressFor(1, "::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(normalizeIp("::FFFF:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("999.1.1.1")).toBeNull();
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
