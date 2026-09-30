import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MODULE_IDS as SERVER_MODULE_IDS } from "../server/moduleIds";
import { AccountActions, TeamNavContext } from "../src/AppShell";
import { ModulesSettings } from "../src/ModulesSettings";
import {
  DEFAULT_PREFERENCES,
  hiddenEntryStep,
  hiddenModuleForApp,
  hiddenTodaySections,
  isAppEnabled,
  isModuleEnabled,
  MODULE_IDS,
  MODULES,
  ModulesContext,
  moduleOffHint,
  normalizeDisabledModules,
  openTeamViaSettings,
  parsePreferences,
  recordPopDepth,
  SETTINGS_MODULES,
  settingsModulesFor,
  withModuleEnabled,
  type ModuleId
} from "../src/modules";
import { dialogPopDirection } from "../src/historyDialogs";
import { parseRoute } from "../src/router";
import { TodayHome } from "../src/today/TodayHome";
import { enabledTodayApps, TODAY_APPS } from "../src/today/todayApps";
import { TODAY_SECTIONS } from "../src/today/todaySections";

describe("module registry (D92)", () => {
  test("client and server know the same module ids, in the same order, including team", () => {
    expect([...MODULE_IDS]).toEqual([...SERVER_MODULE_IDS]);
    expect(MODULES.map((module) => module.id)).toEqual([...MODULE_IDS]);
    expect(MODULE_IDS).toContain("team");
  });

  test("Settings lists every module, Team included, but never shows Team to guests", () => {
    expect(SETTINGS_MODULES.map((module) => module.id)).toEqual(["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault", "search", "bin", "notifications", "team", "inbox"]);
    expect(settingsModulesFor("admin").map((module) => module.id)).toContain("team");
    expect(settingsModulesFor("viewer").map((module) => module.id)).toContain("team");
    expect(settingsModulesFor("guest").map((module) => module.id)).not.toContain("team");
  });

  test("every Today section belongs to exactly one module", () => {
    const owned = MODULES.flatMap((module) => module.todaySections);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual(Object.keys(TODAY_SECTIONS).sort());
  });

  test("unknown ids, duplicates, and non-arrays are ignored, and order follows the registry", () => {
    expect(normalizeDisabledModules(["bin", "home", "calendar", "bin", 7, null, "Calendar"])).toEqual(["calendar", "bin"]);
    expect(normalizeDisabledModules("calendar")).toEqual([]);
    expect(normalizeDisabledModules(undefined)).toEqual([]);
  });

  test("toggling keeps registry order and never duplicates", () => {
    expect(withModuleEnabled([], "bin", false)).toEqual(["bin"]);
    expect(withModuleEnabled(["bin"], "notes", false)).toEqual(["notes", "bin"]);
    expect(withModuleEnabled(["notes", "bin"], "notes", false)).toEqual(["notes", "bin"]);
    expect(withModuleEnabled(["notes", "bin"], "notes", true)).toEqual(["bin"]);
    expect(isModuleEnabled(["bin"], "bin")).toBe(false);
    expect(isModuleEnabled(["bin"], "calendar")).toBe(true);
  });

  test("malformed preferences from the server mean every module is on", () => {
    expect(parsePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ disabledModules: "calendar", revision: -2 })).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ disabledModules: ["calendar", "retired"], revision: 3, updatedAt: "2026-09-26T00:00:00.000Z" })).toEqual({ disabledModules: ["calendar"], revision: 3, updatedAt: "2026-09-26T00:00:00.000Z" });
  });

  test("the hint names the module and where to turn it on", () => {
    expect(moduleOffHint("tasks")).toBe("Tasks is turned off. Turn it on in Settings → Modules.");
  });
});

describe("Settings → Modules", () => {
  type Props = Parameters<typeof ModulesSettings>[0];
  const render = (disabled: Props["disabledModules"], status: Props["status"] = null, role: Props["role"] = "member") =>
    renderToStaticMarkup(<ModulesSettings disabledModules={disabled} status={status} onToggle={() => undefined} role={role} />);

  test("every module is a labelled switch that is on by default", () => {
    const markup = render([]);
    const switches = [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(([tag]) => tag);
    expect(switches).toHaveLength(SETTINGS_MODULES.length);
    for (const tag of switches) expect(tag).toContain('aria-checked="true"');
    expect(markup).toContain('aria-labelledby="module-label-calendar"');
    expect(markup).toContain('id="module-label-calendar">Calendar</strong>');
    expect(markup).toContain('id="module-label-team">Team</strong>');
    expect(markup).not.toContain("Team stays available from Settings");
  });

  test("guests get no Team row, and admins are told Team stays in Settings", () => {
    const guest = render([], null, "guest");
    expect(guest).not.toContain("module-label-team");
    // Guests have no inbox either (agent inbox D152), nor a vault (V-O3).
    expect(guest).not.toContain("module-label-inbox");
    expect(guest).not.toContain("module-label-vault");
    expect([...guest.matchAll(/role="switch"/g)]).toHaveLength(SETTINGS_MODULES.length - 3);
    expect(render(["team"], null, "admin")).toContain("You are an admin: Team stays available from Settings.");
  });

  test("a disabled module shows as off, and the Bin and Notifications help says what keeps working", () => {
    const markup = render(["calendar"]);
    expect(markup).toMatch(/<li class="modules-row off">.*?module-label-calendar/);
    expect(markup).toMatch(/aria-checked="false" aria-labelledby="module-label-calendar"/);
    expect(markup).toContain("Deleting still moves items to the Bin");
    expect(markup).toContain("Reminders and push notifications still arrive");
    expect(markup).toContain("MCP keys and links from other people keep working");
  });

  test("a conflict is a status message and a failure is an alert", () => {
    expect(render([], { kind: "conflict", message: "Changed elsewhere" })).toContain('<p class="modules-notice" role="status">Changed elsewhere</p>');
    expect(render([], { kind: "error", message: "Offline" })).toContain('<p class="form-error" role="alert">Offline</p>');
  });
});

describe("gating (client only)", () => {
  const account = { displayName: "Ada Lovelace", onSettings: () => undefined, onSignOut: () => undefined };
  const home = (disabled: ModuleId[]) => renderToStaticMarkup(<ModulesContext.Provider value={disabled}>
    <TodayHome {...account} userId="u1" onOpen={() => undefined} onOpenRoute={() => undefined} />
  </ModulesContext.Provider>);
  const launcher = (markup: string) => [...markup.matchAll(/class="today-app today-app-([a-z]+)"/g)].map(([, section]) => section);

  test("the launcher is derived from the registry and drops modules that are off", () => {
    expect(TODAY_APPS.map((app) => app.section)).toEqual(["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault"]);
    expect(enabledTodayApps(["calendar", "search"]).map((app) => app.section)).toEqual(["notes", "files", "tasks", "collections", "whiteboards", "vault"]);
    expect(launcher(home([]))).toEqual(["notes", "files", "tasks", "collections", "calendar", "whiteboards", "vault"]);
    expect(launcher(home(["calendar", "tasks", "vault"]))).toEqual(["notes", "files", "collections", "whiteboards"]);
  });

  test("Bin off removes the Bin button from Home and from any header, even when the app passes onBin", () => {
    expect(home([])).toContain('title="Bin"');
    expect(home(["bin"])).not.toContain('title="Bin"');
    const header = renderToStaticMarkup(<ModulesContext.Provider value={["bin"]}><AccountActions {...account} onBin={() => undefined} binCount={2} /></ModulesContext.Provider>);
    expect(header).not.toContain('title="Bin"');
    expect(header).toContain('title="Settings"');
  });

  test("Team off removes the Team button from the account row", () => {
    const teamNav = { role: "member" as const, openTeam: () => undefined, onTeam: false };
    const row = (disabled: ModuleId[]) => renderToStaticMarkup(<ModulesContext.Provider value={disabled}><TeamNavContext.Provider value={teamNav}><AccountActions {...account} /></TeamNavContext.Provider></ModulesContext.Provider>);
    expect(row([])).toContain('title="Team"');
    expect(row(["team"])).not.toContain('title="Team"');
  });

  test("the Today sections of modules that are off are hidden", () => {
    expect(hiddenTodaySections([])).toEqual([]);
    expect(hiddenTodaySections(["calendar", "tasks", "bin"])).toEqual(["tasksDue", "tasksMine", "upcoming", "binSoon"]);
    const markup = home(["tasks", "calendar"]);
    expect(markup).not.toContain("today-section-tasksDue");
    expect(markup).not.toContain("today-section-upcoming");
    expect(markup).toContain("today-section-notesRecent");
  });

  test("a hidden module's routes redirect, and Home, Search, and unknown ids never do", () => {
    const eventId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(hiddenModuleForApp(["calendar"], parseRoute(`/calendar/event/${eventId}`).app)).toBe("calendar");
    expect(hiddenModuleForApp(["calendar"], parseRoute("/calendar/month/2026-09").app)).toBe("calendar");
    expect(hiddenModuleForApp(["tasks"], parseRoute("/tasks").app)).toBe("tasks");
    expect(hiddenModuleForApp(["bin"], parseRoute("/bin").app)).toBe("bin");
    expect(hiddenModuleForApp(["notifications"], parseRoute("/notifications").app)).toBe("notifications");
    expect(hiddenModuleForApp(["team"], parseRoute("/team").app)).toBe("team");
    expect(hiddenModuleForApp(["notes"], parseRoute("/notes").app)).toBe("notes");
    expect(hiddenModuleForApp(["calendar"], parseRoute("/tasks").app)).toBeNull();
    expect(hiddenModuleForApp([...MODULE_IDS], parseRoute("/").app)).toBeNull();
    expect(hiddenModuleForApp(normalizeDisabledModules(["home", "settings"]), parseRoute("/").app)).toBeNull();
    expect(isAppEnabled(["search"], "notes")).toBe(true);
  });

  test("Back and Forward onto a hidden module skip its entry instead of adding a second Home", () => {
    // A browser stack of paths; each entry's depth is its index, as the app writes them.
    function walk(paths: string[], start: number, move: -1 | 1) {
      const entries = [...paths];
      let from = start;
      let index = start + move;
      for (;;) {
        if (!hiddenModuleForApp(["calendar"], parseRoute(entries[index]!).app)) return { entries, at: entries[index] };
        const step = hiddenEntryStep(dialogPopDirection(from, index), index);
        if (step === "replace") { entries[index] = "/"; return { entries, at: "/" }; }
        // history.go(-1) back to where Forward came from; that popstate is ignored.
        if (step === "undo") return { entries, at: entries[from] };
        // history.back(): another Back popstate, one entry lower.
        from = index;
        index -= 1;
      }
    }
    // Forward from Home onto /calendar: back on Home, the stack is untouched (no duplicate `/`).
    expect(walk(["/", "/calendar"], 0, 1)).toEqual({ entries: ["/", "/calendar"], at: "/" });
    // Back from /tasks onto /calendar steps on to Home below it.
    expect(walk(["/", "/calendar", "/tasks"], 2, -1)).toEqual({ entries: ["/", "/calendar", "/tasks"], at: "/" });
    // Two hidden entries in a row are both stepped past.
    expect(walk(["/", "/calendar", "/calendar/month/2026-09", "/tasks"], 3, -1).at).toBe("/");
    // A hidden entry at depth 0 has nothing below: it is replaced with Home.
    expect(hiddenEntryStep("back", 0)).toBe("replace");
    expect(hiddenEntryStep(null, 2)).toBe("replace");
    expect(hiddenEntryStep("forward", 3)).toBe("undo");
    expect(hiddenEntryStep("back", 3)).toBe("back");
  });

  test("consecutive Forwards onto a hidden entry are each undone, with no duplicate Home", () => {
    // A browser whose go() fires popstate later, as real browsers do, and the popstate handler in
    // App's order: record the depth first (every popstate), then skip ignored ones, then gate.
    const entries = [{ path: "/", depth: 0 }, { path: "/team", depth: 1 }];
    let index = 1;
    const depthRef = { current: 1 };
    const queued: number[] = [];
    let ignoring = 0;
    const onPopState = () => {
      const entry = entries[index]!;
      const previousDepth = recordPopDepth(depthRef, entry.depth);
      if (ignoring > 0) { ignoring -= 1; return; }
      if (!hiddenModuleForApp(["team"], parseRoute(entry.path).app)) return;
      const step = hiddenEntryStep(dialogPopDirection(previousDepth, entry.depth), entry.depth);
      if (step === "replace") { entries[index] = { path: "/", depth: entry.depth }; return; }
      if (step === "undo") { depthRef.current = previousDepth; ignoring += 1; queued.push(-1); return; }
      queued.push(-1);
    };
    const go = (delta: number) => { index += delta; onPopState(); };
    const settle = () => { while (queued.length) go(queued.shift()!); };
    // Settings → Manage team pushed /team at depth 1; Team is off. Back to Home.
    go(-1); settle();
    expect(index).toBe(0);
    for (let forward = 0; forward < 3; forward += 1) {
      go(1);
      // A render while the undo is in flight must not re-read the depth: history.state is still /team.
      expect(depthRef.current).toBe(0);
      settle();
      expect(index).toBe(0);
      expect(depthRef.current).toBe(0);
      expect(entries.map((entry) => entry.path)).toEqual(["/", "/team"]);
    }
  });

  test("Manage team keeps the gate open only when Team actually opened", async () => {
    const seen: boolean[] = [];
    // Notes could not save the open note: the switch fails and the flag is cleared again.
    expect(await openTeamViaSettings((value) => seen.push(value), async () => false)).toBe(false);
    expect(seen).toEqual([true, false]);
    seen.length = 0;
    expect(await openTeamViaSettings((value) => seen.push(value), async () => true)).toBe(true);
    expect(seen).toEqual([true]);
  });
});
