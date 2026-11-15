import { lazy } from "react";
import { TIME_SECTIONS } from "./sections";
import { Clock, FolderClock, Play, Timer } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule, WorkspaceRoutePart } from "../workspaceModules/types";
import { TimerTopBar } from "./TimerBar";
import { CardTimerAction, CardTimeSection, ItemTimeSection, TimelineTimeFill } from "./CardTime";
import { TodayTimeSection } from "./TodayTime";
import { startTimer } from "./timerStore";

/**
 * Time (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2): the client module. Routes `/time` (Timer),
 * `/time/timesheet?week=`, `/time/reports`, `/time/projects`, `/time/projects/<slug>-<shortid>`; the
 * timer chip in every header (⌥T), Today's `timeToday` section and a "Start timer" quick action, and
 * the card slots (Time section, ▶ header action, face badge, Timeline fill).
 */

const TABS = new Set(["timesheet", "reports", "projects"]);

export function parseTimeRoute(segments: string[], search: string): WorkspaceRoutePart {
  const [first, second] = segments;
  const params = new URLSearchParams(search);
  if (first === "timesheet") {
    const week = params.get("week");
    return { path: ["timesheet"], search: week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? `?week=${week}` : "" };
  }
  // A project's view rides in `?tab=` (the week-approval notification opens `?tab=approvals`, D1190).
  if (first === "projects" && second && segments.length === 2) {
    const view = params.get("tab");
    return view === "team" || view === "approvals" ? { path: ["projects", second], search: `?tab=${view}` } : { path: ["projects", second] };
  }
  if (first && TABS.has(first) && segments.length === 1) return { path: [first] };
  const entry = params.get("entry");
  return { path: [], search: entry && /^[0-9a-f-]{36}$/i.test(entry) ? `?entry=${entry.toLowerCase()}` : "" };
}

export const module: WorkspaceClientModule = {
  id: "time",
  segment: WORKSPACE_MODULE_LABELS.time.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.time.label,
  icon: Timer,
  description: WORKSPACE_MODULE_LABELS.time.description,
  ready: true,
  app: lazy(() => import("./TimeApp")),
  parseRoute: parseTimeRoute,
  launcher: true,
  sections: TIME_SECTIONS,
  topBarItem: TimerTopBar,
  todaySections: {
    timeToday: { title: "Time", group: "today", empty: "nothing logged yet", app: "Time", render: TodayTimeSection }
  },
  quickActions: [{ id: "start-timer", label: "Start timer", icon: Play, hiddenFor: ["viewer"], run: async () => { await startTimer({}); } }],
  cardSections: [{ id: "time.section", area: "side", order: 20, component: CardTimeSection }],
  cardHeaderActions: [{ id: "time.start", order: 10, component: CardTimerAction }],
  timelineDecorations: [{ id: "time.fill", order: 10, component: TimelineTimeFill }],
  itemSections: [{ id: "time.item", kinds: ["goal", "contact", "company", "deal", "booking"], order: 20, component: ItemTimeSection }],
  shortcuts: [{ keys: "Alt+T", label: "Start or stop the timer" }, { keys: "n", label: "Log time (in Time)" }, { keys: "j / k", label: "Move between entries" }],
  notificationTopics: [
    { id: "time.long_timer", label: "A timer has been running for hours" },
    { id: "time.reminder", label: "No time logged today (if you turned it on)" },
    { id: "time.approval", label: "A week was submitted for your approval" },
    { id: "time.approval_decided", label: "Your week was approved or returned" },
    { id: "time.budget", label: "A project reached 80% or 100% of its budget" }
  ],
  workKindRenderers: {
    time_entry: { icon: Clock, label: "Time entry" },
    time_project: { icon: FolderClock, label: "Time project" }
  },
  searchRenderer: {
    scope: "time", label: "Time", icon: Clock,
    row: (result) => ({ key: `${String(result.kind)}:${String(result.id)}`, title: String(result.title ?? ""), meta: typeof result.snippet === "string" ? result.snippet : undefined, href: String(result.href ?? "/time") })
  }
};
