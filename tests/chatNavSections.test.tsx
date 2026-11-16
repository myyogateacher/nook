import { expect, test } from "bun:test";
import "../src/workspaceModules";
import { installDom, render } from "./support/dom";
import { buildNavTree, chatUsable, navItems, type NavTree } from "../src/shell/navModel";
import { AppSidebar } from "../src/shell/AppSidebar";
import { filterPalette, flatPalette, paletteEntries, type PaletteEntry } from "../src/shell/paletteModel";
import type { Role } from "../src/team/teamRoles";

/**
 * Chat's sections in the sidebar (D1303): New chat (/chat/new) for everyone who can chat, and Audit
 * (/chat/audit) for exactly the people Chat shows its Audit log link to (`features.chatAudit`, D1304).
 * None while Chat is off, not configured, or not offered; the section on screen comes from the address.
 * As sections they get the chevron, the flyouts, the drawer, and ⌘K entries like any other app's.
 */

installDom("http://nook.test/chat/new");

const base = { vault: true, agents: true, reports: true, time: true, crm: true, bookings: true };
type Features = Parameters<typeof buildNavTree>[0]["features"];
const chatRow = (t: NavTree) => [...t.pinned, ...t.apps].find((item) => item.id === "chat");
const sections = (role: Role, features: Features, pathname = "/", active: Parameters<typeof buildNavTree>[0]["active"] = "home") =>
  chatRow(buildNavTree({ disabledModules: [], features, role, active, location: { pathname, search: "" } }))?.children?.map((child) => `${child.label} ${child.href}${child.current ? " *" : ""}`) ?? null;

test("per role: members and viewers who chat get New chat, and Audit only with the audit gate; admins once Chat is on", () => {
  expect(sections("member", { ...base, chatAudit: false })).toEqual(["New chat /chat/new"]);
  expect(sections("member", { ...base, chatAudit: true })).toEqual(["New chat /chat/new", "Audit /chat/audit"]);
  expect(sections("viewer", { ...base, chatAudit: false })).toEqual(["New chat /chat/new"]);
  expect(sections("admin", { ...base, chatAudit: true })).toEqual(["New chat /chat/new", "Audit /chat/audit"]);
  // An admin sees Chat while it is not configured (its setup screen), but no sections then.
  expect(chatRow(buildNavTree({ disabledModules: [], features: { ...base, chatAudit: false }, role: "admin", active: "home" }))?.children).toBeUndefined();
  expect(chatUsable("admin", { ...base, chatAudit: false })).toBe(false);
  // Chat not offered (features.agents false: off, no provider, a role that may not chat, guests): no row at all.
  expect(sections("member", { ...base, agents: false, chatAudit: true })).toBeNull();
  expect(sections("guest", { ...base, agents: false, vault: false, reports: false, crm: false, bookings: false })).toBeNull();
  // Turned off in Settings → Modules: no row either.
  expect(chatRow(buildNavTree({ disabledModules: ["agents"], features: { ...base, chatAudit: true }, role: "member", active: "home" }))).toBeUndefined();
});

test("the section on screen comes from the address: /chat/new, /chat/audit and a run light theirs; a chat or the list lights none", () => {
  const features = { ...base, chatAudit: true };
  expect(sections("member", features, "/chat/new", "chat")).toEqual(["New chat /chat/new *", "Audit /chat/audit"]);
  expect(sections("member", features, "/chat/audit", "chat")).toEqual(["New chat /chat/new", "Audit /chat/audit *"]);
  expect(sections("member", features, "/chat/audit/0b8d6a1e-6c55-4b8e-9d5c-0d1e8b1f3a10", "chat")).toEqual(["New chat /chat/new", "Audit /chat/audit *"]);
  expect(sections("member", features, "/chat/0b8d6a1e-6c55-4b8e-9d5c-0d1e8b1f3a10", "chat")).toEqual(["New chat /chat/new", "Audit /chat/audit"]);
  expect(sections("member", features, "/chat", "chat")).toEqual(["New chat /chat/new", "Audit /chat/audit"]);
  // On another app the address is not Chat's: nothing lit.
  expect(sections("member", features, "/chat/new", "home")).toEqual(["New chat /chat/new", "Audit /chat/audit"]);
  const tree = buildNavTree({ disabledModules: [], features, role: "member", active: "chat", location: { pathname: "/chat/audit", search: "" } });
  expect(navItems(tree).filter((item) => item.current).map((item) => item.id)).toEqual(["chat", "chat:audit"]);
});

test("the sidebar nests them under Chat with the current one marked; ⌘K finds them as Chat › New chat and Chat › Audit", async () => {
  const tree = buildNavTree({ disabledModules: [], features: { ...base, chatAudit: true }, role: "member", active: "chat", location: { pathname: "/chat/new", search: "" } });
  const noop = () => undefined;
  const view = await render(<AppSidebar tree={tree} mode="expanded" displayName="Ada" inboxCount={0} unreadCount={0} onNavigate={noop} onSearch={noop} onAccount={noop} onSignOut={noop} onToggle={noop} />);
  const links = [...view.container.querySelectorAll<HTMLAnchorElement>('a[href^="/chat/"]')];
  expect(links.map((link) => [link.textContent?.trim(), link.getAttribute("aria-current")])).toEqual([["New chat", "page"], ["Audit", null]]);

  const labelOf = (entry: PaletteEntry) => [entry.context, entry.label].filter(Boolean).join(" › ");
  const entries = paletteEntries({ tree, searchNotes: false, canCustomize: false });
  expect(flatPalette(filterPalette(entries, "new chat", true)).map(labelOf)).toContain("Chat › New chat");
  expect(flatPalette(filterPalette(entries, "audit", true)).map(labelOf)).toContain("Chat › Audit");
  const memberEntries = paletteEntries({ tree: buildNavTree({ disabledModules: [], features: { ...base, chatAudit: false }, role: "member", active: "home" }), searchNotes: false, canCustomize: false });
  expect(flatPalette(filterPalette(memberEntries, "audit", true)).map(labelOf)).not.toContain("Chat › Audit");
});
