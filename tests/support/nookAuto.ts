import { afterAll, beforeAll } from "bun:test";
import { db } from "./harness";

/**
 * C2: agents get Nook's tools automatically by default (each runner's internal key). Files written
 * for the linked-key model (no key, no Nook tools; exact tool lists sent to the fake provider) turn
 * the admin setting off for their own run and restore it after, so the shared server's default
 * holds for every other file. tests/agentsNookAuto.test.ts covers the setting on.
 */
export function withoutNookAutoTools() {
  let previous: { value_json: string; revision: number } | null = null;
  beforeAll(() => {
    previous = db.query("SELECT value_json, revision FROM agent_settings WHERE key = 'nook_auto_tools'").get() as typeof previous;
    db.query(`INSERT INTO agent_settings (key, value_json, revision, updated_by, updated_at) VALUES ('nook_auto_tools', 'false', 1, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = 'false', revision = agent_settings.revision + 1`).run(new Date().toISOString());
  });
  afterAll(() => {
    if (previous) db.query("UPDATE agent_settings SET value_json = ?, revision = revision + 1 WHERE key = 'nook_auto_tools'").run(previous.value_json);
    else db.query("DELETE FROM agent_settings WHERE key = 'nook_auto_tools'").run();
  });
}
