/**
 * Test ports. Fake providers, MCP servers, and upstreams listen on port 0 and read `server.port`, so
 * several `bun test` runs can share a host (tests/testPorts.test.ts refuses a fixed listen port).
 * A server whose port must be known before it starts holds one with reservePort() (the harness), or,
 * when a child process listens on it, takes one from freePort() and retries on EADDRINUSE.
 */

/**
 * A port held for a server that must know its port before it starts (the harness: APP_ORIGIN is read
 * at import). The placeholder listens with SO_REUSEPORT, so the real server binds the same port with
 * `reusePort: true` while the placeholder still holds it; then release() stops the placeholder. The
 * OS never hands a held port to another process's bind on 0, so two runs cannot collide (freePort()
 * had a window between its stop and the server's listen). Nothing is requested in that overlap.
 */
export function reservePort() {
  const placeholder = Bun.serve({ hostname: "0.0.0.0", port: 0, reusePort: true, fetch: () => new Response(null, { status: 503 }) });
  const port = placeholder.port!;
  return { port, release: () => placeholder.stop(true) };
}

/**
 * A port the OS just handed out and released: bind 0, read it, stop. Only for a child process that
 * listens on it itself; another process can take it in between, so the caller retries on EADDRINUSE.
 */
export function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
