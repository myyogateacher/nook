import { addColumn, type Migration } from "./types";

/**
 * The sidebar's layout across devices (docs/plan/LEFT_NAV.md §4 phase 4, D1295): `user_preferences.sidebar`
 * holds `{ mode?, order?, pinned?, expanded? }` as JSON (the collapse choice, the app order, the pinned
 * apps, the apps opened by their chevron), or NULL while the person never saved one. It shares the
 * row's `revision` with `disabled_modules`, so PUT /api/preferences stays one compare-and-swap. It only
 * arranges UI; nothing reads it for access (T97). The CHECK bounds it well above the largest valid
 * value (four lists of at most 17 ids).
 *
 * Needs 016. 121 is reserved by audit lane tg (120–121). Transactional and filesystem-free;
 * re-running changes nothing.
 */
export const sidebarPreferencesMigration: Migration = {
  id: 122,
  name: "sidebar_preferences",
  up(db) {
    addColumn(db, "user_preferences", "sidebar", "TEXT CHECK (sidebar IS NULL OR (json_valid(sidebar) AND json_type(sidebar) = 'object' AND length(sidebar) <= 2048))");
  }
};
