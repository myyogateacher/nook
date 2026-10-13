import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { origin, port as nookPort } from "./support/harness";
const { config } = await import("../server/config");
const { agentNet, assertEgressAllowed, checkEgressUrl, EgressError, egressFetch, readEgressText } = await import("../server/agents/egress");
const { listModels, ProviderError, redactTokens } = await import("../server/agents/loop");

/**
 * Wave 40 security review: the egress guard under a wider SSRF matrix than tests/agentsEgress.test.ts
 * (IP spellings the URL parser canonicalises, mapped and translated IPv6 forms, loopback aliases),
 * the check-then-connect gap (T307) made visible, a chunk-flooding provider against the byte cap,
 * every 3xx refused, and what a provider's error body can carry into Nook's error text.
 */

/** The flood server's ephemeral port, read once it listens (beforeAll). */
let PORT = 0;
let flood: ReturnType<typeof Bun.serve>;
const caps = { maxBytes: 64 * 1024, firstByteMs: 2000, idleMs: 2000, totalMs: 5000 };

beforeAll(() => {
  flood = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 30,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/flood") {
        // A provider that never stops sending and never sends an SSE separator.
        const piece = new TextEncoder().encode("x".repeat(16 * 1024));
        return new Response(new ReadableStream({
          async pull(controller) { controller.enqueue(piece); }
        }));
      }
      if (url.pathname === "/host") return new Response(request.headers.get("host") ?? "");
      if (url.pathname.startsWith("/status/")) return new Response(null, { status: Number(url.pathname.slice(8)), headers: { Location: `http://127.0.0.1:${PORT}/ok` } });
      return new Response("ok");
    }
  });
  PORT = flood.port!;
});
afterAll(() => flood.stop(true));

const withAllowlist = async <T>(entries: string[], run: () => Promise<T>) => {
  const previous = config.agents.allowedPrivateHosts;
  config.agents.allowedPrivateHosts = entries;
  try { return await run(); } finally { config.agents.allowedPrivateHosts = previous; }
};
const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return "ok"; } catch (error) { return error instanceof EgressError ? error.code : `other:${(error as Error).message}`; }
};

describe("review: SSRF matrix (T305)", () => {
  test("every spelling of a loopback, private, link-local, CGNAT, multicast, or unspecified address is refused without the allowlist", async () => {
    await withAllowlist([], async () => {
      const refused = [
        // IPv4 literal spellings the WHATWG parser canonicalises to 127.0.0.1 and friends.
        "https://2130706433/v1", "https://0x7f000001/v1", "https://0x7f.0.0.1/v1", "https://0177.0.0.1/v1", "https://127.1/v1", "https://127.0.1/v1",
        "https://0.0.0.0/v1", "https://0/v1", "https://255.255.255.255/v1", "https://224.0.0.1/v1",
        "https://10.0.0.1/v1", "https://172.16.0.1/v1", "https://172.31.255.255/v1", "https://192.168.0.1/v1", "https://192.0.0.1/v1",
        "https://100.64.0.1/v1", "https://100.127.255.255/v1", "https://169.254.169.254/v1", "https://198.18.0.1/v1",
        // IPv6: loopback, unspecified, mapped and compatible forms, ULA, link-local, multicast, NAT64, 6to4, Teredo, documentation.
        "https://[::1]/v1", "https://[0:0:0:0:0:0:0:1]/v1", "https://[::]/v1", "https://[::ffff:127.0.0.1]/v1", "https://[::ffff:7f00:1]/v1",
        "https://[::ffff:a9fe:a9fe]/v1", "https://[::ffff:10.0.0.1]/v1", "https://[::127.0.0.1]/v1", "https://[fc00::1]/v1", "https://[fd12:3456::1]/v1",
        "https://[fe80::1]/v1", "https://[ff02::1]/v1", "https://[64:ff9b::7f00:1]/v1", "https://[2002:7f00:1::1]/v1", "https://[2001::1]/v1", "https://[2001:db8::1]/v1",
        // Names that resolve locally through /etc/hosts (no network): loopback.
        "https://localhost/v1", "https://localhost./v1", "https://LOCALHOST/v1"
      ];
      for (const url of refused) {
        const code = await codeOf(assertEgressAllowed(url));
        expect({ url, code }).toEqual({ url, code: code === "DNS_FAILED" ? "DNS_FAILED" : "PRIVATE_ADDRESS" });
        // A literal must never be DNS_FAILED: the guard must have judged the address itself.
        if (!url.includes("localhost")) expect({ url, code }).toEqual({ url, code: "PRIVATE_ADDRESS" });
      }
      // Plain http is refused for anything not listed, private or not.
      expect(await codeOf(assertEgressAllowed("http://203.0.113.9/v1"))).toBe("URL_REFUSED");
    });
  });

  test("Nook's own listener under an alias (127.0.0.1:<port>) is refused even when the alias is listed (L2)", async () => {
    // APP_ORIGINS is http://localhost:<port>; the same listener is also 127.0.0.1:<port>.
    expect(() => checkEgressUrl(`${origin}/v1`)).toThrow(/this Nook/);
    const alias = `http://127.0.0.1:${nookPort}/v1`;
    await withAllowlist(["127.0.0.1"], async () => {
      expect(await codeOf(assertEgressAllowed(alias))).toBe("URL_REFUSED");
      expect(await codeOf(assertEgressAllowed(`http://localhost:${nookPort}/v1`))).toBe("URL_REFUSED");
      // Another port on the same address is fine (the fake providers), and a public address on Nook's port is not Nook.
      expect(await codeOf(assertEgressAllowed(`http://127.0.0.1:${PORT}/v1`))).toBe("ok");
    });
    await withAllowlist([], async () => {
      expect(await codeOf(assertEgressAllowed(alias))).toBe("URL_REFUSED");
    });
    const resolve = agentNet.resolve;
    agentNet.resolve = async () => ["203.0.113.10"];
    try {
      expect(await codeOf(assertEgressAllowed(`https://public.example.test:${nookPort}/v1`))).toBe("ok");
    } finally {
      agentNet.resolve = resolve;
    }
  });

  test("T307: the connection is pinned to the address the check saw (Host and SNI carry the name), so a second resolution never happens (L1)", async () => {
    const resolve = agentNet.resolve;
    const fetchWas = agentNet.fetch;
    const answers = [["203.0.113.10"], ["10.0.0.1"]];
    const fetched: Array<{ url: string; init: RequestInit & { tls?: { serverName?: string } } }> = [];
    agentNet.resolve = async () => answers.shift() ?? ["10.0.0.1"];
    agentNet.fetch = async (url, init) => { fetched.push({ url, init }); return new Response("ok"); };
    try {
      await withAllowlist([], async () => {
        const response = await egressFetch("https://rebind.example.test/v1/models?x=1", { method: "GET", headers: { Accept: "application/json" } }, caps);
        expect(response.status).toBe(200);
      });
      expect(fetched).toHaveLength(1);
      expect(fetched[0]!.url).toBe("https://203.0.113.10/v1/models?x=1");
      expect(fetched[0]!.init.headers).toMatchObject({ Host: "rebind.example.test", Accept: "application/json" });
      expect(fetched[0]!.init.tls).toEqual({ serverName: "rebind.example.test" });
      expect(fetched[0]!.init.redirect).toBe("manual");
      // Exactly one resolution happened; the private second answer was never used.
      expect(answers).toEqual([["10.0.0.1"]]);
      // IPv6 answers go in brackets, with the port kept; an IP-literal endpoint needs no pin.
      agentNet.resolve = async () => ["2001:4860:4860::8888"];
      await withAllowlist([], async () => { await egressFetch("https://six.example.test:8443/v1", { method: "GET" }, caps); });
      expect(fetched[1]!.url).toBe("https://[2001:4860:4860::8888]:8443/v1");
      expect(fetched[1]!.init.headers).toMatchObject({ Host: "six.example.test:8443" });
      await withAllowlist([], async () => { await egressFetch("https://203.0.113.7/v1", { method: "GET" }, caps); });
      expect(fetched[2]!.url).toBe("https://203.0.113.7/v1");
      expect((fetched[2]!.init.headers as Record<string, string>).Host).toBeUndefined();
      expect(fetched[2]!.init.tls).toBeUndefined();
    } finally {
      agentNet.resolve = resolve;
      agentNet.fetch = fetchWas;
    }
  });

  test("against a real local server: the request reaches the pinned address with the configured name in Host (L1)", async () => {
    const resolve = agentNet.resolve;
    // The name resolves to the local server once; a second lookup would point elsewhere and must never happen.
    const answers = [["127.0.0.1"], ["203.0.113.99"]];
    agentNet.resolve = async (host) => host === "pinned.example.test" ? answers.shift() ?? ["203.0.113.99"] : resolve(host);
    try {
      await withAllowlist(["pinned.example.test"], async () => {
        const response = await egressFetch(`http://pinned.example.test:${PORT}/host`, { method: "GET" }, caps);
        expect(response.status).toBe(200);
        expect(await readEgressText(response, 1024)).toBe(`pinned.example.test:${PORT}`);
      });
      expect(answers).toEqual([["203.0.113.99"]]);
    } finally {
      agentNet.resolve = resolve;
    }
  });

  test("every 3xx is refused, and a chunk-flooding provider hits the byte cap", async () => {
    await withAllowlist(["127.0.0.1"], async () => {
      for (const status of [301, 302, 303, 307, 308]) {
        expect({ status, code: await codeOf(egressFetch(`http://127.0.0.1:${PORT}/status/${status}`, { method: "GET" }, caps)) }).toEqual({ status, code: "REDIRECT_REFUSED" });
      }
      const started = Date.now();
      const code = await codeOf((async () => { const response = await egressFetch(`http://127.0.0.1:${PORT}/flood`, { method: "GET" }, caps); await readEgressText(response, caps.maxBytes); })());
      expect(code).toBe("TOO_LARGE");
      expect(Date.now() - started).toBeLessThan(caps.totalMs);
    });
  });

  test("a provider's error message reaches a chat's owner with sk- tokens and long tokens elided; admins keep the fuller excerpt (L3)", async () => {
    const fetchWas = agentNet.fetch;
    const resolve = agentNet.resolve;
    agentNet.resolve = async () => ["203.0.113.10"];
    agentNet.fetch = async () => Response.json({ error: { message: "Incorrect API key provided: sk-proj-****************************************kAAA. Visit https://platform.example/keys" } }, { status: 401 });
    try {
      let message = "";
      let adminMessage = "";
      try {
        await listModels({ id: "p", baseUrl: "https://provider.example.test/v1", apiKey: "sk-test-fake", model: "m", compat: { tokenParam: "max_tokens", streamUsage: true, supportsTools: true, contextTokens: 128_000 } });
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        message = (error as Error).message;
        adminMessage = (error as InstanceType<typeof ProviderError>).adminMessage;
      }
      expect(message).toContain("refused the API key");
      expect(message).not.toContain("sk-");
      expect(message).not.toMatch(/[A-Za-z0-9_-]{12,}/);
      expect(message).toContain("Incorrect API key provided: …");
      expect(adminMessage).toContain("sk-proj-kAAA");
      for (const text of [message, adminMessage]) {
        expect(text).not.toContain("sk-test-fake");
        expect(text.length).toBeLessThan(260);
      }
      expect(redactTokens("Unauthorized sk-abc token-that-is-long-enough ok")).toBe("… ok");
    } finally {
      agentNet.fetch = fetchWas;
      agentNet.resolve = resolve;
    }
  });
});
