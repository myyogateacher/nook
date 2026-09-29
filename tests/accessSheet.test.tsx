import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessSheet } from "../src/access/AccessSheet";
import type { ItemAccess, PickerGroup, PickerPerson } from "../src/access/accessApi";
import { accessErrorMessage, addPicked, audienceLoss, audienceLossMessage, audienceOptions, defaultLevelFor, draftFrom, groupBoost, guestRefusal, guestRefusalMessage, isDirty, keptGuestLevel, levelsUpTo, lockedForYou, pickerOptions, roleCapHint, saveBlocker, toPutBody } from "../src/access/accessModel";
import { levelAtLeast, levelDescription } from "../src/access/accessLevels";

/**
 * The Access sheet (Wave 32, access plan §C.5, §E): its model (what it offers, adds, locks, and
 * saves) and its rendered states. Back/Forward parity comes from the hosts' guards and, for Notes,
 * the sheet's own (`guardHistory`), checked in the source below; the browser pass is in TEST_PLAN.
 */

const owner = { id: "owner-1", displayName: "Olive" };

function access(overrides: Partial<ItemAccess> = {}): ItemAccess {
  return {
    etag: "\"abc\"", kind: "board", title: "Ops sprint", owner, audience: "selected", audienceLevel: "edit", audienceLevels: ["view", "comment", "edit"],
    people: [
      { id: "u-alice", displayName: "Alice", teamRole: "member", kind: "person", level: "manage", via: "direct", blocked: false },
      { id: "u-bob", displayName: "Bob", teamRole: "viewer", kind: "person", level: "edit", via: "direct", blocked: false }
    ],
    groups: [{ id: "g-ops", name: "Ops", memberCount: 6, guestCount: 2, selfAddedCount: 1, level: "edit" }],
    levels: ["view", "comment", "edit", "manage"], yourLevel: "owner", shareWithGuests: true, inheritable: false,
    ...overrides
  };
}

const people: PickerPerson[] = [
  { id: "owner-1", displayName: "Olive", role: "member" },
  { id: "u-alice", displayName: "Alice", role: "member" },
  { id: "u-carol", displayName: "Carol", role: "guest" },
  { id: "u-dan", displayName: "Dan", role: "member" }
];
const groups: PickerGroup[] = [
  { id: "g-ops", name: "Ops", memberCount: 6, guestCount: 2 },
  { id: "g-design", name: "Design", memberCount: 3, guestCount: 1 },
  { id: "g-eng", name: "Engineering", memberCount: 1, guestCount: 0 }
];

describe("Access sheet model", () => {
  test("the picker offers groups then people, without the owner or anyone already listed", () => {
    const options = pickerOptions(draftFrom(access()), access(), people, groups);
    expect(options.map((option) => option.value)).toEqual(["group:g-design", "group:g-eng", "person:u-carol", "person:u-dan"]);
    expect(options[0]).toMatchObject({ label: "Design", group: "Groups", description: "3 people · includes 1 guest", disabled: false });
    expect(options[1]!.description).toBe("1 person");
    expect(options[2]).toMatchObject({ label: "Carol", group: "People", description: "Team role: Guest · reads only" });
    // With sharing with guests off, groups that include guests are shown but cannot be picked (T213).
    const off = pickerOptions(draftFrom(access()), access({ shareWithGuests: false }), people, groups);
    expect(off.find((option) => option.value === "group:g-design")).toMatchObject({ disabled: true, description: "3 people · includes 1 guest · sharing with guests is off" });
    expect(off.find((option) => option.value === "group:g-eng")?.disabled).toBe(false);
  });

  test("picking adds at the module's default level, within what the caller may give", () => {
    const draft = draftFrom(access());
    const withDan = addPicked(draft, "person:u-dan", access(), people, groups);
    expect(withDan.people.at(-1)).toEqual({ id: "u-dan", displayName: "Dan", teamRole: "member", level: "edit" });
    const withEng = addPicked(draft, "group:g-eng", access(), people, groups);
    expect(withEng.groups.at(-1)).toMatchObject({ id: "g-eng", level: "edit", memberCount: 1 });
    expect(addPicked(draft, "person:nobody", access(), people, groups)).toBe(draft);
    expect(defaultLevelFor({ kind: "collection", levels: ["view", "edit", "manage"], audienceLevel: "view" })).toBe("view");
    expect(defaultLevelFor({ kind: "collection", levels: ["view", "edit", "manage"], audienceLevel: "edit" })).toBe("edit");
    expect(defaultLevelFor({ kind: "note", levels: ["view", "edit"], audienceLevel: null })).toBe("view");
    expect(defaultLevelFor({ kind: "board", levels: ["view"], audienceLevel: null })).toBe("view");
  });

  test("the saved body: people and groups only for a chosen audience; managers never send the audience level", () => {
    const draft = draftFrom(access());
    expect(toPutBody(draft, access())).toEqual({
      audience: "selected", audienceLevel: "edit",
      people: [{ id: "u-alice", level: "manage" }, { id: "u-bob", level: "edit" }],
      groups: [{ id: "g-ops", level: "edit" }]
    });
    expect(toPutBody({ ...draft, audience: "private" }, access())).toEqual({ audience: "private", audienceLevel: "edit", people: [], groups: [] });
    expect(toPutBody(draft, access({ yourLevel: "manage" })).audienceLevel).toBeUndefined();
    expect(saveBlocker({ ...draft, people: [], groups: [] })).toContain("at least one");
    expect(saveBlocker({ ...draft, audience: "all_users", people: [], groups: [] })).toBeNull();
    expect(isDirty(draft, access())).toBe(false);
    expect(isDirty({ ...draft, audience: "all_users" }, access())).toBe(true);
  });

  test("locks, caps, audiences, and error copy", () => {
    expect(lockedForYou(access({ yourLevel: "manage" }), "manage")).toBe(true);
    expect(lockedForYou(access({ yourLevel: "manage" }), "edit")).toBe(false);
    expect(lockedForYou(access(), "manage")).toBe(false);
    expect(roleCapHint("viewer")).toBe("Viewer role reads only");
    expect(roleCapHint("guest")).toBe("Guest role reads only");
    expect(roleCapHint("member")).toBeNull();
    expect(audienceOptions({ kind: "note", inheritable: true }).map((option) => option.value)).toEqual(["inherit", "private", "selected", "all_users"]);
    expect(audienceOptions({ kind: "board", inheritable: false }).map((option) => option.label)).toEqual(["Only me", "People and groups I choose", "Everyone signed in"]);
    expect(accessErrorMessage("ACCESS_CHANGED", "x")).toContain("Someone else changed");
    expect(accessErrorMessage("GUEST_SHARE_DISABLED", "x")).toContain("guests");
    expect(accessErrorMessage("UNKNOWN", "fallback")).toBe("fallback");
    expect(levelAtLeast("comment", "edit")).toBe(false);
    expect(levelAtLeast(undefined, "edit")).toBe(true);
    expect(levelDescription("board", "edit")).toBe("Add, change, and move cards, not columns or sharing");
  });
});

describe("Access sheet rendering", () => {
  test("the owner sees the audience, the picker, groups with their counts and who decides, people with levels and caps", () => {
    const html = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops sprint" onClose={() => undefined} onSaved={() => undefined} initial={{ access: access(), people, groups }} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Ops sprint");
    expect(html).toContain("Who can open this");
    expect(html).toContain("People and groups I choose");
    expect(html).toContain("Add people or groups");
    expect(html).toContain("6 people · includes 2 guests");
    expect(html).toContain("Admins decide who is in this group · an admin added themselves");
    expect(html).toContain("Team role: Viewer");
    // A viewer's level is capped: text with the reason, not a picker.
    expect(html).toContain("Viewer role reads only");
    expect(html).toContain('aria-label="Remove Bob"');
    expect(html).toContain('aria-label="Close access"');
    expect(html).not.toContain("<select");
  });

  test("a manager sees no audience choice, and other managers are locked", () => {
    const html = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops sprint" onClose={() => undefined} onSaved={() => undefined}
      initial={{ access: access({ yourLevel: "manage", levels: ["view", "comment", "edit"] }), people, groups }} />);
    expect(html).not.toContain("Who can open this");
    expect(html).toContain("You manage this item");
    expect(html).toContain("Only the owner changes managers");
    expect(html).not.toContain('aria-label="Remove Alice"');
    expect(html).toContain('aria-label="Remove Bob"');
  });

  test("a manager's own row says to ask the owner instead of offering a change that fails (MANAGER_CAP)", () => {
    const html = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops sprint" onClose={() => undefined} onSaved={() => undefined}
      initial={{ access: access({ yourLevel: "manage", youId: "u-alice", levels: ["view", "comment", "edit"] }), people, groups }} />);
    expect(html).toContain("Ask the owner to change your access");
    expect(html).toContain("Team role: Member · You");
    expect(html).not.toContain('aria-label="Remove Alice"');
    expect(html).not.toContain("Only the owner changes managers</small>");
  });

  test("the owner's key line (Wave 33) and the manager's own-row hint render side by side with their sheets", () => {
    const owner = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops sprint" onClose={() => undefined} onSaved={() => undefined}
      initial={{ access: access({ youId: "u-owner", keysWithAccess: 2 }), people, groups }} />);
    expect(owner).toContain("2 of your API keys can reach this");
    const manager = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops sprint" onClose={() => undefined} onSaved={() => undefined}
      initial={{ access: access({ yourLevel: "manage", youId: "u-alice", levels: ["view", "comment", "edit"] }), people, groups }} />);
    expect(manager).toContain("Ask the owner to change your access");
    expect(manager).not.toContain("of your API keys can reach this");
  });

  test("everyone signed in shows its level picker; loading shows a status", () => {
    const html = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops" onClose={() => undefined} onSaved={() => undefined}
      initial={{ access: access({ audience: "all_users", people: [], groups: [] }) }} />);
    expect(html).toContain("What everyone signed in can do");
    expect(html).not.toContain("Add people or groups");
    const loading = renderToStaticMarkup(<AccessSheet kind="note" id="n1" title="Plan" onClose={() => undefined} onSaved={() => undefined} />);
    expect(loading).toContain("Loading who has access…");
  });

  test("with guest sharing off, kept guest rows are marked and cannot be raised (QA v0.13.0 B1)", () => {
    const off = access({ shareWithGuests: false, people: [...access().people, { id: "u-gina", displayName: "Gina", teamRole: "guest", kind: "person", level: "view", via: "direct", blocked: false }],
      groups: [{ id: "g-ops", name: "Ops", memberCount: 6, guestCount: 2, selfAddedCount: 0, level: "comment" }, { id: "g-eng", name: "Engineering", memberCount: 3, guestCount: 0, selfAddedCount: 0, level: "view" }] });
    expect(keptGuestLevel(off, { type: "group", id: "g-ops" })).toBe("comment");
    expect(keptGuestLevel(off, { type: "group", id: "g-eng" })).toBeNull();
    expect(keptGuestLevel(off, { type: "person", id: "u-gina" })).toBe("view");
    expect(keptGuestLevel(off, { type: "person", id: "u-bob" })).toBeNull();
    expect(keptGuestLevel(access(), { type: "group", id: "g-ops" })).toBeNull();
    expect(levelsUpTo(["view", "comment", "edit", "manage"], "comment")).toEqual(["view", "comment"]);
    const html = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops sprint" onClose={() => undefined} onSaved={() => undefined} initial={{ access: off, people, groups }} />);
    expect(html.match(/Kept from before guest sharing was turned off/g)?.length).toBe(2);
    expect(html).toContain("Guests already listed keep their access; they cannot be added or given more.");
    // A kept row at the lowest level has nothing to choose: text with the reason.
    const lowest = access({ shareWithGuests: false, groups: [{ id: "g-ops", name: "Ops", memberCount: 6, guestCount: 2, selfAddedCount: 0, level: "view" }] });
    expect(renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops" onClose={() => undefined} onSaved={() => undefined} initial={{ access: lowest, people, groups }} />))
      .toContain("Can be lowered or removed, not raised");
    // The refusal names the rows the server pointed at.
    expect(guestRefusal({ code: "GUEST_SHARE_DISABLED", guests: { people: ["u-gina"], groups: ["g-ops"] } })).toEqual({ people: ["u-gina"], groups: ["g-ops"] });
    expect(guestRefusal({ code: "GUEST_SHARE_DISABLED" })).toBeNull();
    expect(guestRefusalMessage(["Ops", "Gina"])).toBe("Sharing with guests is turned off for this Nook, so Ops and Gina cannot be added or given more access. Remove them, or set the level back.");
    expect(guestRefusalMessage([])).toContain("Sharing with guests is turned off");
  });

  test("switching away from people and groups asks with the count before saving, and switching back restores them (B3)", () => {
    const saved = access();
    expect(audienceLoss({ audience: "all_users" }, saved)).toEqual({ people: 2, groups: 1 });
    expect(audienceLoss({ audience: "selected" }, saved)).toBeNull();
    expect(audienceLoss({ audience: "private" }, access({ people: [], groups: [] }))).toBeNull();
    expect(audienceLoss({ audience: "selected" }, access({ audience: "all_users" }))).toBeNull();
    expect(audienceLossMessage({ people: 2, groups: 1 }, "private")).toMatch(/^2 people and 1 group will lose the access you gave them here\. Only you will be able to open it\./);
    expect(audienceLossMessage({ people: 1, groups: 0 }, "all_users")).toMatch(/^1 person will lose the access you gave it here\. Everyone signed in can open it instead/);
    // The draft keeps the rows while unsaved: back to "People and groups I choose" shows them again.
    const draft = draftFrom(saved);
    const away = { ...draft, audience: "private" as const };
    expect(toPutBody(away, saved).people).toEqual([]);
    expect(toPutBody({ ...away, audience: "selected" }, saved)).toEqual(toPutBody(draft, saved));
    const sheet = readFileSync(join(import.meta.dir, "..", "src", "access", "AccessSheet.tsx"), "utf8");
    expect(sheet).toContain('title="Remove individual access?"');
    expect(sheet).toContain("const loss = audienceLoss(draft, access);");
  });

  test("unsaved changes: Close, Escape, and Back ask Discard or Keep editing through history layers (B4)", () => {
    const sheet = readFileSync(join(import.meta.dir, "..", "src", "access", "AccessSheet.tsx"), "utf8");
    expect(sheet).toContain("useHistoryDialogGuard(dirty && prompt === null, askDiscard, { blocked: busy })");
    expect(sheet).toContain("useHistoryDialogGuard(prompt !== null, keepEditing, { blocked: busy })");
    expect(sheet).toContain('confirmLabel="Discard" cancelLabel="Keep editing"');
    expect(sheet).not.toMatch(/window\.(confirm|alert|prompt)|beforeunload/);
  });

  test("single-level kinds show the level as text with their own line; task views are not described as files (B5)", () => {
    expect(levelDescription("task_view", "view")).toBe("Run the saved view; cards show only from boards they can open");
    expect(levelDescription("document", "view")).toBe("Open and download");
    expect(levelDescription("folder", "view")).not.toBe(levelDescription("note", "view"));
    const view = access({ kind: "task_view", levels: ["view"], audienceLevel: undefined, audienceLevels: undefined, groups: [],
      people: [{ id: "u-dan", displayName: "Dan", teamRole: "member", kind: "person", level: "view", via: "direct", blocked: false }] });
    const html = renderToStaticMarkup(<AccessSheet kind="task_view" id="v1" title="My view" onClose={() => undefined} onSaved={() => undefined} initial={{ access: view, people, groups }} />);
    expect(html).toContain("Run the saved view; cards show only from boards they can open");
    expect(html).not.toContain("Open and download");
    expect(html).not.toContain('aria-label="What Dan can do"');
  });

  test("a person whose group gives more says so (B9)", () => {
    const withGroup = access({ people: [{ id: "u-dan", displayName: "Dan", teamRole: "member", kind: "person", level: "comment", via: "direct", blocked: false, groupIds: ["g-ops"] },
      { id: "u-bob", displayName: "Bob", teamRole: "viewer", kind: "person", level: "view", via: "direct", blocked: false, groupIds: ["g-ops"] }] });
    const draft = draftFrom(withGroup);
    expect(groupBoost(draft.people[0]!, draft.groups)).toEqual({ level: "edit", group: "Ops" });
    // A viewer's role caps both: no hint.
    expect(groupBoost(draft.people[1]!, draft.groups)).toBeNull();
    expect(groupBoost({ ...draft.people[0]!, level: "manage" }, draft.groups)).toBeNull();
    const html = renderToStaticMarkup(<AccessSheet kind="board" id="b1" title="Ops" onClose={() => undefined} onSaved={() => undefined} initial={{ access: withGroup, people, groups }} />);
    expect(html).toContain("Also Can edit through Ops; the higher level applies");
  });

  test("every share entry point opens the Access sheet; the old panels are gone; Notes guard their own Back", () => {
    const root = join(import.meta.dir, "..", "src");
    const hosts: Array<[string, string]> = [
      ["App.tsx", 'kind="note"'], ["App.tsx", 'kind="folder"'], ["files/FilesApp.tsx", 'kind="document"'], ["tasks/BoardList.tsx", 'kind="board"'],
      ["tasks/BoardView.tsx", 'kind="board"'], ["tasks/views/ViewPage.tsx", 'kind="task_view"'], ["collections/CollectionView.tsx", 'kind="collection"'],
      ["collections/CollectionList.tsx", 'kind="collection"'], ["calendar/CalendarApp.tsx", 'kind="calendar"']
    ];
    for (const [file, marker] of hosts) {
      const source = readFileSync(join(root, file), "utf8");
      expect({ file, marker, found: source.includes(`<AccessSheet ${marker}`) }).toEqual({ file, marker, found: true });
      expect({ file, legacy: /SharePanel/.test(source) }).toEqual({ file, legacy: false });
    }
    const app = readFileSync(join(root, "App.tsx"), "utf8");
    expect(app.match(/<AccessSheet kind="(note|folder)"[^>]*guardHistory/g)?.length).toBe(2);
    const sheet = readFileSync(join(root, "access", "AccessSheet.tsx"), "utf8");
    expect(sheet).toContain("useHistoryDialogGuard(guardHistory, onClose, { blocked: busy })");
    expect(sheet).toContain("onKeyDown={trapTabKey}");
    expect(sheet).toContain("opener.focus()");
  });
});
