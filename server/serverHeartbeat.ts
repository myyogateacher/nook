import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

/**
 * "Is a Nook server using this DATA_DIR right now?" for host commands that must run with the server
 * stopped (`vault-admin.ts rotate-kek`, vault review L3). The running server rewrites
 * `DATA_DIR/server.heartbeat` every 5 seconds and removes it when it exits normally; a host command
 * treats a file changed in the last 15 seconds as a running server.
 *
 * A heartbeat rather than a lock or a pid file: a pid is meaningless across containers (the server
 * and `docker compose run` each see their own pid 1), SQLite holds no lasting lock in WAL mode, and
 * a crashed or killed server (`docker compose stop` ends in SIGKILL after 10 seconds) leaves a file
 * that simply goes stale instead of blocking the command forever. The file holds no secrets.
 */

export const HEARTBEAT_FILE = "server.heartbeat";
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 15_000;

const heartbeatPath = (dataDir: string) => join(dataDir, HEARTBEAT_FILE);
let timer: ReturnType<typeof setInterval> | null = null;

export function startServerHeartbeat(dataDir = config.dataDir) {
  if (timer) return;
  const path = heartbeatPath(dataDir);
  const beat = () => {
    try {
      writeFileSync(path, `Nook server running (pid ${process.pid}); see docs/OPERATIONS.md, Vault.\n`, { mode: 0o600 });
    } catch (error) {
      console.error("Could not write the server heartbeat", error instanceof Error ? error.name : "Unknown error");
    }
  };
  beat();
  timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  process.once("exit", () => {
    try {
      rmSync(path, { force: true });
    } catch {
      // Stale in 15 seconds anyway.
    }
  });
}

/** Seconds since the server last wrote its heartbeat, or null when none is fresh. */
export function serverHeartbeatAge(dataDir = config.dataDir, nowMs = Date.now()): number | null {
  try {
    const age = nowMs - statSync(heartbeatPath(dataDir)).mtimeMs;
    return age < HEARTBEAT_STALE_MS ? Math.max(0, Math.round(age / 1000)) : null;
  } catch {
    return null;
  }
}
