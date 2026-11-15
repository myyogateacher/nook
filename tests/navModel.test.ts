import { expect, test } from "bun:test";
import "../src/workspaceModules";
import { buildNavTree, navItemForSection, navItems } from "../src/shell/navModel";
import { MODULES, normalizeDisabledModules, unavailableModules, type ModuleId } from "../src/modules";
import { enabledTodayApps } from "../src/today/todayApps";
import { WORKSPACE_MODULE_IDS } from "../shared/workspaceModules";
import type { Role } from "../src/team/teamRoles";

/**
 * The global sidebar's tree (docs/plan/LEFT_NAV.md §2.1, D1270): the apps are exactly Home's launcher
 * tiles today, for every role and module set, and the Home / Inbox / Notifications / Settings rows
 * follow the old account row's rules.
 */

const appIds = (tree: ReturnType<typeof buildNavTree>) => tree.apps.map((item) => item.id);
/** What Home's launcher shows for the same person (App.tsx's disabledModules: preferences plus unavailable). */
const launcher = (disabled: readonly ModuleId[], features?: Parameters<typeof unavailableModules>[0]) =>
  enabledTodayApps(normalizeDisabledModules([...disabled, ...unavailableModules(features)])).map((app) => app.section);

const SERVER_FEATURES = {
  // An admin on a server with every optional feature.
  admin: { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true },
  member: { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true },
  // A server without VAULT_ENCRYPTION_KEY or AGENT_SECRETS_KEY: hidden from everyone but admins.
  viewer: { vault: false, agents: false, reports: true, time: true, crm: true, bookings: true },
  // Guests: no Vault, Chat, Reports, Contacts, or Bookings; Time only on a time project (D1192).
  guest: { vault: false, agents: false, reports: false, time: false, crm: false, bookings: false }
} as const;

test("every role sees exactly the apps Home's launcher shows, in MODULES order", () => {
  const sets: ModuleId[][] = [[], ["notes", "files"], ["tasks", "calendar", "forms", "townhall"], ["whiteboards", "vault", "agents", "reports", "crm"], [...WORKSPACE_MODULE_IDS]];
  for (const role of ["admin", "member", "viewer", "guest"] as Role[]) {
    for (const disabled of sets) {
      const features = SERVER_FEATURES[role as keyof typeof SERVER_FEATURES];
      const tree = buildNavTree({ disabledModules: disabled, features, role, active: "home" });
      expect(appIds(tree)).toEqual(launcher(disabled, features));
    }
  }
  const all = buildNavTree({ disabledModules: [], features: SERVER_FEATURES.admin, role: "admin", active: "home" });
  expect(appIds(all)).toEqual(MODULES.flatMap((module) => module.launcher ? [module.launcher.section] : []));
  expect(appIds(all)).toEqual(["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault", "chat", "reports", ...WORKSPACE_MODULE_IDS]);
});

test("guests never see Vault, Chat, Reports, Contacts, Bookings, or the Inbox; Time once on a time project", () => {
  const guest = buildNavTree({ disabledModules: [], features: SERVER_FEATURES.guest, role: "guest", active: "home" });
  for (const hidden of ["vault", "chat", "reports", "crm", "bookings", "time"]) expect(appIds(guest)).not.toContain(hidden);
  expect(guest.primary.map((item) => item.id)).toEqual(["home", "notifications"]);
  const onProject = buildNavTree({ disabledModules: [], features: { ...SERVER_FEATURES.guest, time: true }, role: "guest", active: "home" });
  expect(appIds(onProject)).toContain("time");
});

test("a workspace module whose lane has not shipped stays hidden", () => {
  const tree = buildNavTree({ disabledModules: [], features: SERVER_FEATURES.admin, role: "admin", active: "home", readyModules: ["forms"] });
  expect(appIds(tree).filter((id) => (WORKSPACE_MODULE_IDS as readonly string[]).includes(id))).toEqual(["forms"]);
});

test("Home, Inbox, Notifications, Search, and Settings follow their modules and the role", () => {
  const member = buildNavTree({ disabledModules: [], features: SERVER_FEATURES.member, role: "member", active: "home" });
  expect(member.primary.map((item) => [item.id, item.href])).toEqual([["home", "/"], ["inbox", "/inbox"], ["notifications", "/notifications"]]);
  expect(member.search?.href).toBe("/notes");
  expect(member.notesSearch).toBe(true);
  expect(member.settings.href).toBe("/settings");
  const quiet = buildNavTree({ disabledModules: ["inbox", "notifications", "search"], features: SERVER_FEATURES.member, role: "member", active: "home" });
  expect(quiet.primary.map((item) => item.id)).toEqual(["home"]);
  // Phase 4 (D1293): Search opens the ⌘K palette, so it stays; only "Search notes" needs Notes and Search.
  expect(quiet.search?.kind).toBe("search");
  expect(quiet.notesSearch).toBe(false);
  expect(buildNavTree({ disabledModules: ["notes"], role: "member", active: "home" }).notesSearch).toBe(false);
  // Before /api/auth/me answers the role is unknown: no Inbox yet.
  expect(buildNavTree({ disabledModules: [], role: undefined, active: "home" }).primary.map((item) => item.id)).toEqual(["home", "notifications"]);
});

test("exactly one item is current: the app on screen, Settings for Team and the Bin", () => {
  const current = (active: Parameters<typeof buildNavTree>[0]["active"]) => navItems(buildNavTree({ disabledModules: [], features: SERVER_FEATURES.admin, role: "admin", active })).filter((item) => item.current).map((item) => item.id);
  expect(current("home")).toEqual(["home"]);
  expect(current("tasks")).toEqual(["tasks"]);
  expect(current("crm")).toEqual(["crm"]);
  expect(current("chat")).toEqual(["chat"]);
  expect(current("inbox")).toEqual(["inbox"]);
  expect(current("team")).toEqual(["settings"]);
  expect(current("bin")).toEqual(["settings"]);
  // Search opens Notes but is never the current page; Notes is.
  expect(current("notes")).toEqual(["notes"]);
  expect(navItemForSection("settings")).toBe("settings");
});

test("each app links to its own URL (middle-click and Copy link work)", () => {
  const tree = buildNavTree({ disabledModules: [], features: SERVER_FEATURES.admin, role: "admin", active: "home" });
  const hrefs = Object.fromEntries(tree.apps.map((item) => [item.id, item.href]));
  expect(hrefs).toMatchObject({ notes: "/notes", chat: "/chat", crm: "/contacts", checkins: "/standups", forms: "/forms" });
  for (const item of tree.apps) expect(item.section).toBe(item.id as typeof item.section);
});
