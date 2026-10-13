/**
 * Test ports. Fake providers, MCP servers, and upstreams listen on port 0 and read `server.port`, so
 * several `bun test` runs can share a host (tests/testPorts.test.ts refuses a fixed listen port).
 * Only a server whose port must be known before it starts (the harness origin, a child run's
 * MYNOTES_TEST_PORT) takes one from freePort().
 */

/** A port the OS just handed out and released: bind 0, read it, stop. */
export function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
