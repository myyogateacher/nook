import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The harness sets the environment config reads (the guard's module imports the database).
import "./support/harness";
const { config, parseAgentSecretsKey, parseAllowedPrivateHosts } = await import("../server/config");
const { agentNet, assertEgressAllowed, checkEgressUrl, EgressError, egressFetch, privateHostAllowed, readEgressText } = await import("../server/agents/egress");

/**
 * The egress guard (agent chat plan §3.2, D347, T305–T307): https only, no credentials or
 * fragments, private and local addresses refused unless listed in AGENT_ALLOWED_PRIVATE_HOSTS, no
 * redirects, byte and time caps, Nook's own origin refused, and no cookie or Nook key in anything
 * that leaves. A local HTTP server on 127.0.0.1 is the private target.
 */

// The harness allows 127.0.0.1 for the fake provider; each test here sets the allowlist it needs.
/** The fake upstream's ephemeral port, read once it listens (beforeAll). */
let PORT = 0;
const received: Array<{ path: string; headers: Record<string, string> }> = [];
let server: ReturnType<typeof Bun.serve>;
const caps = { maxBytes: 64 * 1024, firstByteMs: 2000, idleMs: 2000, totalMs: 5000 };

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      received.push({ path: url.pathname, headers });
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${PORT}/ok` } });
      if (url.pathname === "/big") return new Response("x".repeat(200 * 1024));
      if (url.pathname === "/slow") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("a")); setTimeout(() => { try { controller.close(); } catch { /* closed */ } }, 4000); } }));
      if (url.pathname === "/never") return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("late")), 4000));
      return new Response("ok");
    }
  });
  PORT = server.port!;
});
afterAll(() => server.stop(true));

const withAllowlist = async <T>(entries: string[], run: () => Promise<T>) => {
  const previous = config.agents.allowedPrivateHosts;
  config.agents.allowedPrivateHosts = entries;
  try { return await run(); } finally { config.agents.allowedPrivateHosts = previous; }
};
const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return "ok"; } catch (error) { return error instanceof EgressError ? error.code : `other:${(error as Error).message}`; }
};

describe("the egress guard (T305–T307)", () => {
  test("refuses the wrong shapes before any DNS lookup", () => {
    const code = (value: string) => { try { checkEgressUrl(value, { appOrigins: new Set(["https://nook.example.test"]) }); return "ok"; } catch (error) { return (error as EgressError).code; } };
    expect(code("ftp://api.example.test/v1")).toBe("URL_REFUSED");
    expect(code("https://user:pass@api.example.test/v1")).toBe("URL_REFUSED");
    expect(code("https://api.example.test/v1#frag")).toBe("URL_REFUSED");
    expect(code("not a url")).toBe("URL_REFUSED");
    expect(code("https://nook.example.test/v1")).toBe("URL_REFUSED");
    expect(code("https://api.example.test/v1")).toBe("ok");
    // http passes the shape check; the allowlist decides after resolution.
    expect(code("http://ollama:11434/v1")).toBe("ok");
  });

  test("refuses private, loopback, link-local, and mapped addresses unless the host is listed", async () => {
    const resolve = agentNet.resolve;
    const table: Record<string, string[]> = {
      "api.example.test": ["203.0.113.10"], "inner.example.test": ["10.1.2.3"], "meta.example.test": ["169.254.169.254"], "ula.example.test": ["fd00::1"],
      "mapped.example.test": ["::ffff:127.0.0.1"], "mixed.example.test": ["203.0.113.10", "192.168.1.1"], "loop.example.test": ["127.0.0.1"], "cg.example.test": ["100.64.0.1"], "zero.example.test": ["0.0.0.0"]
    };
    agentNet.resolve = async (host) => table[host] ?? [];
    try {
      await withAllowlist([], async () => {
        expect(await codeOf(assertEgressAllowed("https://api.example.test/v1"))).toBe("ok");
        for (const host of ["inner", "meta", "ula", "mapped", "mixed", "loop", "cg", "zero"]) expect({ host, code: await codeOf(assertEgressAllowed(`https://${host}.example.test/v1`)) }).toEqual({ host, code: "PRIVATE_ADDRESS" });
        expect(await codeOf(assertEgressAllowed("https://127.0.0.1/v1"))).toBe("PRIVATE_ADDRESS");
        expect(await codeOf(assertEgressAllowed("https://[::1]/v1"))).toBe("PRIVATE_ADDRESS");
        expect(await codeOf(assertEgressAllowed("https://[fe80::1]/v1"))).toBe("PRIVATE_ADDRESS");
        expect(await codeOf(assertEgressAllowed("https://nowhere.example.test/v1"))).toBe("DNS_FAILED");
        expect(await codeOf(assertEgressAllowed("http://api.example.test/v1"))).toBe("URL_REFUSED");
      });
      await withAllowlist(["inner.example.test", "10.0.0.0/8"], async () => {
        expect(await codeOf(assertEgressAllowed("https://inner.example.test/v1"))).toBe("ok");
        expect(await codeOf(assertEgressAllowed("http://inner.example.test/v1"))).toBe("ok");
        expect(await codeOf(assertEgressAllowed("https://10.9.9.9/v1"))).toBe("ok");
        // A listed name never widens to other private hosts; a CIDR covers only addresses inside it.
        expect(await codeOf(assertEgressAllowed("https://meta.example.test/v1"))).toBe("PRIVATE_ADDRESS");
        expect(await codeOf(assertEgressAllowed("https://mixed.example.test/v1"))).toBe("PRIVATE_ADDRESS");
      });
    } finally {
      agentNet.resolve = resolve;
    }
    expect(privateHostAllowed("ollama", ["10.0.0.2"], ["ollama"])).toBe(true);
    expect(privateHostAllowed("ollama", ["10.0.0.2"], ["other"])).toBe(false);
    expect(privateHostAllowed("x", ["10.0.0.2", "10.0.0.3"], ["10.0.0.0/24"])).toBe(true);
    expect(privateHostAllowed("x", ["10.0.0.2", "172.16.0.1"], ["10.0.0.0/24"])).toBe(false);
    expect(privateHostAllowed("x", [], [])).toBe(false);
  });

  test("a local HTTP server is refused until 127.0.0.1 is listed; then redirects, oversize, and stalls are still caught", async () => {
    await withAllowlist([], async () => {
      expect(await codeOf(egressFetch(`http://127.0.0.1:${PORT}/ok`, { method: "GET" }, caps))).toBe("URL_REFUSED");
      expect(await codeOf(egressFetch(`https://127.0.0.1:${PORT}/ok`, { method: "GET" }, caps))).toBe("PRIVATE_ADDRESS");
    });
    expect(received.length).toBe(0);
    await withAllowlist(["127.0.0.1"], async () => {
      const response = await egressFetch(`http://127.0.0.1:${PORT}/ok?token=abc`, { method: "GET", headers: { Authorization: "Bearer sk-test-provider-key", Accept: "application/json" } }, caps);
      expect(response.status).toBe(200);
      expect(await readEgressText(response, 1024)).toBe("ok");
      expect(await codeOf(egressFetch(`http://127.0.0.1:${PORT}/redirect`, { method: "GET" }, caps))).toBe("REDIRECT_REFUSED");
      expect(await codeOf((async () => { const big = await egressFetch(`http://127.0.0.1:${PORT}/big`, { method: "GET" }, caps); await readEgressText(big, caps.maxBytes); })())).toBe("TOO_LARGE");
      expect(await codeOf((async () => { const slow = await egressFetch(`http://127.0.0.1:${PORT}/slow`, { method: "GET" }, { ...caps, idleMs: 300 }); await readEgressText(slow, caps.maxBytes); })())).toBe("TIMEOUT");
      expect(await codeOf(egressFetch(`http://127.0.0.1:${PORT}/never`, { method: "GET" }, { ...caps, firstByteMs: 300 }))).toBe("TIMEOUT");
      // An outer abort ends the request with the caller's reason.
      const controller = new AbortController();
      const pending = egressFetch(`http://127.0.0.1:${PORT}/never`, { method: "GET", signal: controller.signal }, caps);
      controller.abort(new Error("stop"));
      expect(await codeOf(pending)).toBe("other:stop");
    });
    // Only the headers the caller set, plus the User-Agent, left Nook: no cookie, no CSRF, no Nook key (T306).
    const first = received.find((call) => call.path === "/ok")!;
    expect(first.headers.authorization).toBe("Bearer sk-test-provider-key");
    expect(first.headers["user-agent"]).toMatch(/^Nook\//);
    for (const call of received) {
      expect(call.headers.cookie).toBeUndefined();
      expect(call.headers["x-csrf-token"]).toBeUndefined();
      expect(Object.keys(call.headers).some((name) => /nook|mynotes|session/.test(name))).toBe(false);
    }
  });

  test("the config parses the allowlist and refuses a key equal to the TOTP or vault key", () => {
    expect(parseAllowedPrivateHosts(" Ollama, 10.0.0.0/8 ,litellm.internal")).toEqual(["ollama", "10.0.0.0/8", "litellm.internal"]);
    expect(() => parseAllowedPrivateHosts("http://x")).toThrow(/AGENT_ALLOWED_PRIVATE_HOSTS/);
    const totp = Buffer.alloc(32, 1);
    const vault = Buffer.alloc(32, 2);
    const fresh = Buffer.alloc(32, 3).toString("base64");
    expect(parseAgentSecretsKey({ AGENT_SECRETS_KEY: fresh }, totp, vault).key?.length).toBe(32);
    expect(parseAgentSecretsKey({}, totp, vault)).toEqual({ key: null, source: null });
    expect(() => parseAgentSecretsKey({ AGENT_SECRETS_KEY: totp.toString("base64") }, totp, vault)).toThrow(/differ from TOTP_ENCRYPTION_KEY/);
    expect(() => parseAgentSecretsKey({ AGENT_SECRETS_KEY: vault.toString("base64") }, totp, vault)).toThrow(/differ from VAULT_ENCRYPTION_KEY/);
    expect(() => parseAgentSecretsKey({ AGENT_SECRETS_KEY: "short" }, totp, vault)).toThrow(/32-byte/);
    expect(() => parseAgentSecretsKey({ AGENT_SECRETS_KEY: fresh, AGENT_SECRETS_KEY_FILE: "/x" }, totp, vault)).toThrow(/not both/);
    expect(() => parseAgentSecretsKey({ AGENT_SECRETS_KEY_FILE: "relative" }, totp, vault)).toThrow(/absolute/);
    expect(() => parseAgentSecretsKey({ AGENT_SECRETS_KEY_FILE: "/data/agent.key" }, totp, vault, "/data")).toThrow(/outside DATA_DIR/);
  });
});
