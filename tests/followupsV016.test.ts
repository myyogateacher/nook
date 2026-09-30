import { expect, test } from "bun:test";

// Follow-ups found by QA on the released v0.16.0 (F1–F10). The scroll shells (F1, F2) are guarded in
// tests/scrollShells.test.ts, the Google card (F3) in tests/googleSignInUi.test.tsx.

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

/** The body of the first `@media (max-width: 760px)` block that contains `needle`. */
function phoneBlock(css: string, needle: string) {
  for (const match of css.matchAll(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/g)) if (match[1].includes(needle)) return match[1];
  return "";
}

test("F5: the phone note toolbar's Publish version button is a 44 px target inside the 58 px toolbar", async () => {
  const css = await read("styles.css");
  const phone = phoneBlock(css, ".publish-button {");
  expect(phone).toMatch(/\.publish-button \{ min-height: 44px; padding: 0 10px; \}/);
  expect(phone).toMatch(/\.editor-toolbar \{ height: 58px;/);
});

test("F10: Access activity details and unknown actions read as sentences, never key: value lists or codes", async () => {
  const { metaLine } = await import("../src/team/AccessActivity");
  const { activityLabel } = await import("../src/access/memberAccessApi");
  const { groupEventLabel } = await import("../src/team/groupsApi");
  const base = { id: "e", via: "web", createdAt: "", actor: { id: "a", displayName: "Ada" }, target: { id: "b", displayName: "Bo" }, group: null, key: null, item: null };
  const line = (action: string, meta: Record<string, unknown> | null) => metaLine({ ...base, action, meta });
  expect(line("access.reset", { directShares: 3, groups: 1, keys: 0, feeds: 2, routines: 0 })).toBe("Removed 3 direct shares, 1 group membership, and 2 calendar feeds (revoked).");
  expect(line("access.reset", { directShares: 0 })).toBe("Nothing needed removing.");
  expect(line("access.share_lowered", { from: "edit", to: "view" })).toBe("From “Can edit” to “Can view”.");
  expect(line("access.share_removed", { level: "comment" })).toBe("They had “Can comment”.");
  expect(line("item.access_changed", { kind: "note", audience: "selected", peopleCount: 2, groupCount: 1 })).toBe("Now shared with 2 people and 1 group.");
  expect(line("item.access_changed", { kind: "board", audience: "all_users", peopleCount: 0, groupCount: 0, asManager: true })).toBe("Now open to everyone on this Nook. Changed by a manager, not the owner.");
  expect(line("item.access_changed", { audience: "private" })).toBe("Now private.");
  expect(line("group.deleted", { memberCount: 1, grantCount: 4 })).toBe("It had 1 person and 4 items shared with it.");
  expect(line("group.member_removed", { from: "reset" })).toBe("Part of Reset access.");
  expect(line("group.member_added", { from: "template" })).toBe("Added by a template.");
  expect(line("group.member_added", { self: true })).toBeNull();
  expect(line("template.created", { role: "member", groupCount: 2 })).toBe("New people get the Member role and 2 groups.");
  expect(line("template.applied", { added: 2, skipped: 1 })).toBe("Added to 2 groups; 1 group was skipped.");
  expect(line("account.google_allowed", { reset: false, relink: true, removeCredentials: false })).toBe("The password and two-factor stay after the re-link.");
  expect(line("account.google_reset", { sessions: 1, password: 1 })).toBe("Removed 1 signed-in session and the password.");
  // No line of any known action shows a raw "key: value", an arrow list, or an underscore code.
  const metas: Array<[string, Record<string, unknown>]> = [["policy.changed", { settings: ["key_max_days"] }], ["key.policy_blocked", { reason: "surface" }], ["key.created", { grants: [], expiresInDays: 30 }], ["key.rotated", { graceHours: 24, routinesMoved: 1 }], ["template.deleted", { liveInvites: 2 }], ["group.updated", { renamed: true }]];
  for (const [action, meta] of metas) {
    const text = line(action, meta) ?? "";
    expect({ action, text, raw: /[a-z][A-Za-z]*: |_|→/.test(text) }).toEqual({ action, text, raw: false });
  }
  expect(activityLabel({ ...base, action: "future.thing", meta: null })).toBe("Ada changed access");
  expect(groupEventLabel({ id: "1", action: "group.future", createdAt: "", actor: { id: "a", displayName: "Ada" }, target: null, self: false })).toBe("Ada changed the group");
});

test("F6: End, Home, PageDown, and PageUp scroll the Notes or Files panel on screen when focus is on the page", async () => {
  const { pageKeyScrollTop, PAGE_SCROLL_KEYS } = await import("../src/ui/pageScrollKeys");
  expect([...PAGE_SCROLL_KEYS]).toEqual(["End", "Home", "PageDown", "PageUp"]);
  // A 2 000 px list in a 400 px pane: the ends, or 350 px (seven eighths of the pane) at a time.
  expect(pageKeyScrollTop("End", 0, 2000, 400)).toBe(1600);
  expect(pageKeyScrollTop("Home", 900, 2000, 400)).toBe(0);
  expect(pageKeyScrollTop("PageDown", 0, 2000, 400)).toBe(350);
  expect(pageKeyScrollTop("PageDown", 1500, 2000, 400)).toBe(1600);
  expect(pageKeyScrollTop("PageUp", 200, 2000, 400)).toBe(0);
  expect(pageKeyScrollTop("ArrowDown", 200, 2000, 400)).toBe(200);
  const source = await read("ui/pageScrollKeys.ts");
  // Text fields, the editable note editor, menus, lists, and open dialogs keep the keys.
  expect(source).toContain("[contenteditable='true']");
  expect(source).toContain("[role=listbox]");
  expect(source).toContain(`document.querySelector("[aria-modal='true']")`);
  // Focus inside a scroller, or a click or tap in one, stays the browser's own paging.
  expect(source).toContain("if (!onPage && insideScroller(target)) return;");
  expect(source).toContain("if (onPage && pointed?.isConnected && insideScroller(pointed)) return;");
  // The panel on screen: folders, the list, or the note or file preview on a phone; the note body in Notes and the list in Files on a computer.
  expect(source).toContain(`panel === "folders" ? [".folder-nav"] : panel === "editor" ? [".document-shell", ".file-text-preview", ".file-preview-body"] : ["#file-list", ".note-list"]`);
  expect(await read("App.tsx")).toContain("usePageScrollKeys(workspaceScroller);");
});
