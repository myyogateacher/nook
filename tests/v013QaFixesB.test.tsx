import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerSharingLabel, roleLabel } from "../src/collections/values";
import { deleteGroupMessage } from "../src/team/groupsApi";
import { changedPolicies, sharingImpactLine } from "../src/team/TeamPolicies";
import type { Policies } from "../src/keys/keysApi";

/**
 * QA v0.13.0, fix set B: level labels (B6), Team → Policies' unsaved guard and sharing impact (B4,
 * B10), copy (B10), toast wrapping (B8), 390 px targets (B11), and accessible names (B12).
 */

const src = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...parts), "utf8");

test("a manager is labelled Manager; the owner's list claims no one level for chosen people (B6)", () => {
  expect(roleLabel("editor", "manage")).toBe("Manager");
  expect(roleLabel("editor", "edit")).toBe("Can edit");
  expect(roleLabel("editor")).toBe("Can edit");
  expect(roleLabel("viewer", "view")).toBe("View only");
  expect(roleLabel("owner", "owner")).toBe("Owner");
  expect(ownerSharingLabel("selected", "viewer")).toBe("Shared with people you chose");
  expect(ownerSharingLabel("all_users", "editor")).toBe("Shared with everyone · can edit");
  expect(ownerSharingLabel("private", "viewer")).toBe("Private");
  expect(src("collections", "CollectionList.tsx")).toContain("roleLabel(collection.role, collection.level)");
  expect(src("collections", "CollectionView.tsx")).toContain("roleLabel(role, collection.level)");
  const calendars = src("calendar", "CalendarsDialog.tsx");
  expect(calendars).toContain('"Shared with people you chose"');
  expect(calendars).not.toContain('"Shared · others can view"');
});

const policies = (change: Partial<Policies> = {}) => ({
  keyMaxDays: 90, keyDefaultDays: 30, keyRequireExpiry: false, keysPerUser: 10, mcpRoles: ["admin", "member"], restRoles: ["admin", "member"],
  keyModulesByRole: { admin: [], member: [], viewer: [] }, shareWithGuests: true, ...change
}) as unknown as Policies;

test("toggling guest sharing alone shows a sharing impact, not API keys (B10)", () => {
  expect(changedPolicies(policies(), policies({ shareWithGuests: false }))).toEqual(["shareWithGuests"]);
  expect(sharingImpactLine(policies(), policies({ shareWithGuests: false }))).toBe("New shares with guests will be refused. Shares that already reach guests stay until they are removed. No API key is affected.");
  expect(sharingImpactLine(policies({ shareWithGuests: false }), policies())).toContain("Guests can be shared with again");
  // With a key policy changed too, the key impact line applies.
  expect(sharingImpactLine(policies(), policies({ shareWithGuests: false, keyMaxDays: 30 }))).toBeNull();
  expect(sharingImpactLine(policies(), policies())).toBeNull();
});

test("Team → Policies asks Discard or Keep editing on Back and on its Team button (B4)", () => {
  const page = src("team", "TeamPolicies.tsx");
  expect(page).toContain("useHistoryDialogGuard(dirty && !leaving && !busy, askLeave)");
  expect(page).toContain("useHistoryDialogGuard(leaving, keepEditing)");
  expect(page).toContain('onClick={requestBack}><ChevronLeft />Team</button>');
  expect(page).toContain('confirmLabel="Discard" cancelLabel="Keep editing"');
  expect(page).not.toMatch(/window\.(confirm|alert|prompt)|beforeunload/);
});

test("copy: levels on the Tasks home, the phone's Filters, and deleting an empty group (B10)", () => {
  expect(src("tasks", "BoardList.tsx")).not.toContain("Everyone with access can add, edit, and move cards");
  expect(src("tasks", "views", "ViewPage.tsx")).toContain('${phone ? "Filters" : "+ Filter"}');
  expect(deleteGroupMessage(0, 0)).toBe("Nobody is in this group and nothing is shared with it. This cannot be undone.");
  expect(deleteGroupMessage(0, 2)).toBe("Nobody is in this group. The 2 items shared with it will no longer be shared with the group. This cannot be undone.");
  expect(deleteGroupMessage(3, 0)).toBe("Nothing is shared with this group, so its 3 people lose no access. This cannot be undone.");
  expect(deleteGroupMessage(1, 1)).toBe("1 person loses what owners shared with the group: 1 item. Their own and directly shared items are not affected. This cannot be undone.");
  expect(deleteGroupMessage(4, 2)).toMatch(/^4 people lose what owners shared with the group: 2 items\./);
});

test("toasts wrap within a phone's width (B8) and phone inputs are 40 px tall (B11)", () => {
  const styles = src("styles.css");
  expect(styles).toMatch(/\.toast \{ bottom: calc\(74px \+ env\(safe-area-inset-bottom\)\); width: max-content; max-width: calc\(100vw - 28px\); white-space: normal;/);
  expect(src("access", "access.css")).toContain(".access-picker .ui-combobox-field .ui-combobox-input { min-height: 40px; }");
  expect(src("team", "team.css")).toContain(".team-group-page .ui-combobox-field .ui-combobox-input { min-height: 40px; }");
  expect(src("tasks", "boardViews.css")).toContain(".task-filter-text input { min-height: 40px;");
});

test("file and Bin action sheets are named, and New event fields are labelled (B12)", () => {
  expect(src("files", "FileActionSheet.tsx")).toContain("aria-label={`Actions for ${document.name}`}");
  expect(src("bin", "BinApp.tsx")).toContain("aria-label={`Actions for ${binItemLabel(sheetItem)}`}");
  const sheet = src("calendar", "EventSheet.tsx");
  for (const label of ["Event title", "Start date", "Start time", "End date", "End time", "Location", "Notes", "All day"]) expect(sheet).toContain(`aria-label="${label}"`);
});
