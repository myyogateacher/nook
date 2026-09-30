import { addColumn, type Migration } from "./types";

/**
 * Key use per surface (Wave 34, access plan D279, D283): a key may be used over MCP, the REST
 * `/api/v1` surface, or both, and its owner and admins see where it was used.
 *
 * - `mcp_api_keys.last_used_mcp_at` and `last_used_rest_at`: when the key was last used on each
 *   surface (`last_used_at` stays the latest of the two). Every use before this migration was MCP,
 *   so `last_used_mcp_at` starts as `last_used_at`.
 * - `api_key_surface_usage`: the daily counters of `api_key_usage`, split by surface (the total
 *   table stays as it is). Existing counts are copied as MCP use. Trimmed to 90 days by the sweeper.
 *
 * - `mcp_api_keys.last_denied_at`, `last_denied_reason`, `last_denied_surface` (review Q1): the last
 *   refused call (address, surface, policy, expired, revoked), so the owner's key row can say so.
 *   Written at most once a minute per key.
 *
 * Everything else Wave 34 needs (surfaces, ip_allowlist, users.kind) was created by 025. Needs 025
 * only; 031 belongs to a parallel wave. Transactional and filesystem-free; re-running changes nothing.
 */
export const keySurfacesMigration: Migration = {
  id: 33,
  name: "key_surfaces",
  up(db) {
    const added = !(db.query("PRAGMA table_info(mcp_api_keys)").all() as Array<{ name: string }>).some((column) => column.name === "last_used_mcp_at");
    addColumn(db, "mcp_api_keys", "last_used_mcp_at", "TEXT");
    addColumn(db, "mcp_api_keys", "last_used_rest_at", "TEXT");
    addColumn(db, "mcp_api_keys", "last_denied_at", "TEXT");
    addColumn(db, "mcp_api_keys", "last_denied_reason", "TEXT CHECK (last_denied_reason IS NULL OR length(last_denied_reason) <= 40)");
    addColumn(db, "mcp_api_keys", "last_denied_surface", "TEXT CHECK (last_denied_surface IS NULL OR last_denied_surface IN ('mcp', 'rest'))");
    if (added) db.exec("UPDATE mcp_api_keys SET last_used_mcp_at = last_used_at WHERE last_used_at IS NOT NULL");
    const fresh = !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_key_surface_usage'").get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_key_surface_usage (
        key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        surface TEXT NOT NULL CHECK (surface IN ('mcp', 'rest')),
        calls INTEGER NOT NULL DEFAULT 0,
        writes INTEGER NOT NULL DEFAULT 0,
        denied INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, day, surface)
      ) WITHOUT ROWID
    `);
    if (fresh) db.exec("INSERT INTO api_key_surface_usage (key_id, day, surface, calls, writes, denied) SELECT key_id, day, 'mcp', calls, writes, denied FROM api_key_usage");
  }
};
