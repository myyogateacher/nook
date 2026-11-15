import { lazy } from "react";
import { STANDUPS_SECTIONS, standupsSectionOf } from "./sections";
import { MessageCircle, Sunrise } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule } from "../workspaceModules/types";
import type { Route } from "../router";

/**
 * Standups (module id `checkins`, docs/plan/WORKSPACE_MODULES.md §D.4, D930–D959): scheduled standups,
 * weekly updates, retros, and pulse surveys at /standups. The app is its own chunk; Today shows the
 * rounds due for you ("Standups due"), Quick actions "Answer standup", search a "Standups" section.
 */

const routeOf = (href: string): Route => ({ app: "checkins", path: href.split("/").filter(Boolean).slice(1), search: "" } as never);

export const module: WorkspaceClientModule = {
  id: "checkins",
  segment: WORKSPACE_MODULE_LABELS.checkins.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.checkins.label,
  icon: Sunrise,
  description: WORKSPACE_MODULE_LABELS.checkins.description,
  ready: true,
  app: lazy(() => import("./StandupsApp")),
  launcher: true,
  sections: STANDUPS_SECTIONS,
  sectionOf: standupsSectionOf,
  todaySections: {
    checkinsDue: {
      title: "Standups due", group: "today", app: "Standups", empty: "nothing to answer",
      row: (item) => ({ key: String(item.id), label: String(item.title), meta: Date.parse(String(item.deadlineAt)) > Date.now() ? `Due by ${new Date(String(item.deadlineAt)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Late, still open", route: routeOf(String(item.href)), tone: Date.parse(String(item.deadlineAt)) > Date.now() ? "today" : "overdue" })
    }
  },
  quickActions: [{ id: "checkins.answer", label: "Answer standup", icon: MessageCircle, href: "/standups" }],
  notificationTopics: [
    { id: "checkins.open", label: "Rounds opening", description: "When a standup you take part in opens for you" },
    { id: "checkins.remind", label: "Reminders", description: "Before your answer is due" },
    { id: "checkins.nudge", label: "Nudges", description: "Someone running the standup is waiting on your answer" },
    { id: "checkins.summary", label: "Round summaries", description: "When a round closes" },
    { id: "checkins.blocked", label: "Blockers on your cards", description: "When a standup names a card you're assigned to as a blocker" }
  ],
  searchRenderer: {
    scope: "standups", label: "Standups", icon: Sunrise,
    row: (result) => ({ key: String(result.id), title: String(result.title), meta: typeof result.snippet === "string" ? result.snippet : undefined, href: String(result.href) })
  },
  activityRenderers: {
    round_opened: (entry) => `opened the ${entry.payload.item?.label ?? ""} round`,
    round_closed: (entry) => `closed the ${entry.payload.item?.label ?? ""} round`,
    answered: () => "answered",
    answer_edited: () => "edited their answer",
    summary_posted: (entry) => `added the ${entry.payload.item?.label ?? ""} round to its note`,
    settings_changed: () => "changed the settings",
    questions_published: () => "published new questions",
    participants_changed: () => "changed who takes part"
  },
  shortcuts: [
    { keys: "n", label: "New standup" },
    { keys: "a", label: "Answer the open round" },
    { keys: "[ / ]", label: "Previous / next round" },
    { keys: "j / k", label: "Move through standups" },
    { keys: "⌘/Ctrl + Enter", label: "Post your answer" }
  ]
};
