/**
 * Every module id a client may turn off in Settings → Modules (D92). `team` is the Team
 * module (Wave 14); `inbox` the agent inbox (Wave 21); `whiteboards` Wave 23 (D206). Keep in step with `MODULE_IDS` in src/modules.ts
 * (tests/modules.test.tsx). A pure module with no imports, so client-side tests can load it.
 */
export const MODULE_IDS = ["notes", "files", "tasks", "collections", "calendar", "whiteboards", "search", "bin", "notifications", "team", "inbox"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
