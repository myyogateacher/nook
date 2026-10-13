/**
 * Every module id a client may turn off in Settings → Modules (D92). `team` is the Team
 * module (Wave 14); `inbox` the agent inbox (Wave 21); `whiteboards` Wave 23 (D206); `vault` Wave 25 (D229); `agents` the Chat module, Wave 40; `reports` analytics reports, Wave 45 (D418). Keep in step with `MODULE_IDS` in src/modules.ts
 * (tests/modules.test.tsx). A pure module with no imports, so client-side tests can load it.
 */
export const MODULE_IDS = ["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault", "agents", "reports", "search", "bin", "notifications", "team", "inbox"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
