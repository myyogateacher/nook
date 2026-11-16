import { expect, test } from "bun:test";
import "../src/workspaceModules";
import { installDom, render } from "./support/dom";
import { buildNavTree } from "../src/shell/navModel";
import { CommandPalette } from "../src/shell/CommandPalette";
import { paletteEntries, type PaletteEntry } from "../src/shell/paletteModel";
import { paletteResultRenderers, resultGroups, shownApps } from "../src/shell/paletteSearch";
import { PALETTE_SEARCH_DEBOUNCE_MS } from "../src/shell/usePaletteSearch";
import { candidateOf } from "../src/ui/links/WorkLinks";
import { ApiError } from "../src/api";
import type { SearchSection } from "../shared/workspaceSearch";

/**
 * Search everywhere in the ⌘K palette (docs/plan/SEARCH_EVERYWHERE.md, D1340, D1342): results grouped
 * per app and drawn by each scope's renderer, only for apps in the person's sidebar; arrows move across
 * every group; "Search notes for …" stays last; a rate limit says so. The link picker reads every
 * built-in hit by its `ref`.
 */

installDom("http://nook.test/tasks");
const { act } = await import("react");
const features = { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const key = async (target: EventTarget, init: KeyboardEventInit) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); }); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const settle = async () => { await act(async () => { await sleep(PALETTE_SEARCH_DEBOUNCE_MS + 60); }); };

const ref = (kind: string, id: string, title: string, href: string) => ({ ref: { kind, id, title, href } });
const sections: SearchSection[] = [
  { scope: "notes", label: "Notes", truncated: false, results: [{ id: "n1", title: [{ text: "Launch plan", hit: true }], snippet: [{ text: "the launch", hit: false }], is_owner: 0, owner_name: "Ada", source: "published", ...ref("note", "n1", "Launch plan", "/notes/launch-plan-1a2b3c4d5e") }] },
  { scope: "cards", label: "Tasks", truncated: false, results: [{ id: "c1", key: "MYT-12", board_name: "Roadmap", column_name: "Doing", kind: "card", href: "/tasks/MYT-12", ...ref("card", "c1", "Launch card", "/tasks/MYT-12") }] },
  { scope: "events", label: "Calendar", truncated: false, results: [{ id: "e1", calendarName: "Team", start: "2026-12-01", allDay: true, recurring: false, ...ref("event", "e1", "Launch party", "/calendar/event/e1") }] },
  { scope: "chats", label: "Chat", truncated: false, results: [{ id: "h1", agentName: "Helper", ...ref("chat", "h1", "Launch chat", "/chat/h1") }] },
  { scope: "files", label: "Files", truncated: false, results: [{ id: "f1", name: "evil", ...ref("document", "f1", "Evil", "//evil.example/x") }] },
  { scope: "whiteboards", label: "Whiteboards", truncated: false, results: [], error: "This section could not be searched" },
  { scope: "contacts", label: "Contacts", truncated: false, results: [{ kind: "contact", id: "p1", title: "Launch Larry", snippet: "Acme", href: "/contacts/launch-larry-1a2b3c4d5e" }] },
  { scope: "goals", label: "Goals", truncated: false, results: [{ kind: "goal", id: "g1", title: "Launch v2", href: "/goals/launch-v2-1a2b3c4d5e" }] }
];

test("resultGroups: one group per shown app, in the server's order, drawn by each scope's renderer", () => {
  const tree = buildNavTree({ disabledModules: ["calendar"], features, role: "member", active: "tasks" });
  const groups = resultGroups(sections, paletteResultRenderers(), shownApps(tree));
  // Calendar is off for this person; Files' only hit has an unsafe href; Whiteboards failed.
  expect(groups.map((group) => group.label)).toEqual(["Notes", "Tasks", "Chat", "Contacts", "Goals"]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  const rows = groups.flatMap((group) => group.entries.map((entry) => [entry.label, entry.hint, entry.action.kind === "path" ? entry.action.href : null]));
  expect(rows).toEqual([
    ["Launch plan", "by Ada · the launch", "/notes/launch-plan-1a2b3c4d5e"],
    ["Launch card", "MYT-12 · Roadmap · Doing", "/tasks/MYT-12"],
    ["Launch chat", "Helper", "/chat/h1"],
    ["Launch Larry", "Contact · Acme", "/contacts/launch-larry-1a2b3c4d5e"],
    ["Launch v2", undefined, "/goals/launch-v2-1a2b3c4d5e"]
  ]);
  // A guest's sidebar has no Chat or Contacts: their sections never show.
  const guestTree = buildNavTree({ disabledModules: [], features: { ...features, agents: false, crm: false }, role: "guest", active: "tasks" });
  expect(resultGroups(sections, paletteResultRenderers(), shownApps(guestTree)).map((group) => group.label)).not.toContain("Contacts");
  expect(resultGroups(sections, paletteResultRenderers(), shownApps(guestTree)).map((group) => group.label)).not.toContain("Chat");
});

test("the palette searches after a pause, groups results per app, and arrows walk every group to the notes fallback", async () => {
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "tasks" });
  const entries = paletteEntries({ tree, searchNotes: true });
  const asked: string[] = [];

  const run = (query: string, signal: AbortSignal) => {
    asked.push(query);

    return Promise.resolve(sections);
  };
  const renderers = paletteResultRenderers();
  const apps = shownApps(tree);
  const ran: PaletteEntry[] = [];
  await render(<CommandPalette entries={entries} searchNotes search={{ run, groups: (found) => resultGroups(found, renderers, apps) }} onRun={(entry) => ran.push(entry)} onClose={() => undefined} />);
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await type(input, "l");
  await type(input, "la");
  await type(input, "laun");
  await settle();
  // One request, for the last text typed within the pause (the debounce), none for a single letter.
  expect(asked).toEqual(["laun"]);
  const headings = [...document.querySelectorAll(".palette-heading")].map((heading) => heading.textContent);
  // The local matches first, then one group per app in the server's order, then Search.
  expect(headings.slice(-7)).toEqual(["Notes", "Tasks", "Calendar", "Chat", "Contacts", "Goals", "Search"]);
  const active = () => document.getElementById(input.getAttribute("aria-activedescendant")!)!;
  // Up from the first wraps to the fallback; up again is the last result (Goals), across groups.
  await key(input, { key: "ArrowUp" });
  expect(active().textContent).toContain("Search notes for “laun”");
  await key(input, { key: "ArrowUp" });
  expect(active().textContent).toContain("Launch v2");
  await key(input, { key: "Enter" });
  expect(ran.at(-1)!.action).toEqual({ kind: "path", href: "/goals/launch-v2-1a2b3c4d5e" });
  // Deleting back to a query already asked asks nothing again.
  await type(input, "lau");
  await settle();
  await type(input, "laun");
  await settle();
  expect(asked).toEqual(["laun", "lau"]);
});

test("a rate limit or an outage is a status line; the local entries still work", async () => {
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "tasks" });
  const entries = paletteEntries({ tree, searchNotes: true });
  const run = () => Promise.reject(new ApiError("Too many searches", 429));
  await render(<CommandPalette entries={entries} searchNotes search={{ run, groups: () => [] }} onRun={() => undefined} onClose={() => undefined} initialQuery="tasks" />);
  await settle();
  expect(document.querySelector(".palette-status")!.textContent).toContain("Searching too quickly");
  expect([...document.querySelectorAll(".palette-heading")].map((heading) => heading.textContent)).toContain("Apps");
});

test("the link picker reads every built-in hit by its ref; chats are not linkable", () => {
  expect(candidateOf(sections[0]!.results[0])).toMatchObject({ kind: "note", id: "n1", title: "Launch plan", href: "/notes/launch-plan-1a2b3c4d5e" });
  expect(candidateOf(sections[1]!.results[0])).toMatchObject({ kind: "card", id: "c1", title: "Launch card", key: "MYT-12", subtitle: "Roadmap" });
  expect(candidateOf(sections[2]!.results[0])).toMatchObject({ kind: "event", subtitle: "Team" });
  expect(candidateOf(sections[3]!.results[0])).toBeNull();
  expect(candidateOf(sections[6]!.results[0])).toMatchObject({ kind: "contact", title: "Launch Larry", subtitle: "Acme" });
  expect(candidateOf({ ref: { kind: "collection", id: "k1", title: "Roadmap", href: "/collections/roadmap-1a2b3c4d5e" }, kind: "collection" })).toMatchObject({ kind: "collection", title: "Roadmap" });
  expect(candidateOf({ rowId: "r1", collectionName: "Roadmap", ...ref("row", "r1", "Row one", "/collections/x/row/r1") })).toMatchObject({ kind: "row", subtitle: "Roadmap" });
});
