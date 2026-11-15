import { lazy } from "react";
import { FORMS_SECTIONS } from "./sections";
import { BarChart3, CalendarClock, ClipboardList, Vote } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule } from "../workspaceModules/types";
import type { TodayRow } from "../today/todaySections";
import { parseRoute } from "../router";
import { relativeTime } from "../files/format";
import { formsEmbeds } from "./embeds";
import { openFormPicker, openNewPollDialog } from "./slash";

/**
 * Forms (lane FORMS, docs/plan/WORKSPACE_MODULES.md §D.1): forms and surveys, polls, and find-a-time
 * polls. The app is its own chunk; this file only registers what the shell needs (routes, Today,
 * quick actions, embeds in notes and cards, the editor's `/poll` and `/form`, search, public pages).
 *
 * Routes (friendly URLs, D812): `/forms` (My forms), `/forms/shared`, `/forms/answer`, `/forms/insights`,
 * `/forms/<slug>-<shortid>` (respond or vote), `/forms/<…>/edit`, `/forms/<…>/results`. Public pages:
 * `/p/f/<token>`.
 */

const kindIcon = (kind: string) => kind === "poll" ? "Poll" : kind === "time_poll" ? "Find a time" : "Form";

export const module: WorkspaceClientModule = {
  id: "forms",
  segment: WORKSPACE_MODULE_LABELS.forms.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.forms.label,
  icon: ClipboardList,
  description: WORKSPACE_MODULE_LABELS.forms.description,
  ready: true,
  app: lazy(() => import("./FormsApp")),
  parseRoute: (segments, search) => {
    const path = segments.filter(Boolean).slice(0, 2).map((segment) => decodeURIComponent(segment));
    const params = new URLSearchParams(search);
    const keep = new URLSearchParams();
    for (const key of ["response", "new", "tab", "question", "option"]) { const value = params.get(key); if (value && value.length <= 80) keep.set(key, value); }
    const query = keep.toString();
    return { path, search: query ? `?${query}` : "" };
  },
  launcher: true,
  sections: FORMS_SECTIONS,
  todaySections: {
    formsResponses: {
      title: "New responses", group: "today", empty: "no new responses this week", app: "Forms", viewAll: "/forms",
      row: (item): TodayRow => ({ key: String(item.id), label: String(item.title), meta: `${item.recent} new · ${item.total} total${item.lastResponseAt ? ` · ${relativeTime(String(item.lastResponseAt))}` : ""}`, route: parseRoute(String(item.href)) })
    },
    pollsToVote: {
      title: "Polls and forms to answer", group: "today", empty: "nothing waiting for your answer", app: "Forms", viewAll: "/forms/answer",
      row: (item): TodayRow => ({ key: String(item.id), label: String(item.title), meta: `${kindIcon(String(item.kind))}${item.closesAt ? ` · closes ${relativeTime(String(item.closesAt))}` : ""}`, route: parseRoute(String(item.href)), ...(item.closesAt && Date.parse(String(item.closesAt)) - Date.now() < 86_400_000 ? { tone: "soon" as const } : {}) })
    }
  },
  quickActions: [
    { id: "new-poll", label: "New poll", icon: Vote, href: "/forms?new=poll", hiddenFor: ["guest", "viewer"] },
    { id: "find-time", label: "Find a time", icon: CalendarClock, href: "/forms?new=time_poll", hiddenFor: ["guest", "viewer"] }
  ],
  notificationTopics: [
    { id: "forms.response", label: "New responses", description: "Responses to forms you own or edit (at most one email per 15 minutes)." },
    { id: "forms.vote", label: "New votes", description: "Votes on your polls and time polls." },
    { id: "forms.action", label: "Responses sent to you", description: "A form's “Notify people” action names you." },
    { id: "forms.closed", label: "Poll closed", description: "A poll you voted on closed." },
    { id: "forms.finalized", label: "Time chosen", description: "The organizer picked a time on a time poll you voted on." },
    { id: "forms.closing", label: "Closing soon", description: "A day before one of your forms closes." }
  ],
  activityRenderers: {
    submitted: () => "submitted this response",
    published: (entry) => `published version ${entry.payload.count ?? ""}`.trim(),
    status: (entry) => entry.payload.to?.label === "closed" ? "closed the form" : entry.payload.to?.label === "open" ? (entry.payload.from?.label === "closed" ? "reopened the form" : "opened the form") : "changed the status",
    audience: (entry) => `changed who can answer to ${entry.payload.to?.label === "public" ? "anyone with the link" : entry.payload.to?.label === "selected" ? "chosen people" : "everyone in the workspace"}`,
    title: (entry) => `renamed it to “${entry.payload.to?.label ?? ""}”`,
    public_link: (entry) => entry.payload.extra?.action === "revoked" ? "turned off the public link" : "made a public link",
    finalized: () => "picked the final time"
  },
  embedRenderers: formsEmbeds,
  slashItems: [
    { label: "Poll", hint: "Ask a quick question and vote here", keywords: "poll vote survey question choice", run: (editor, range) => { editor.chain().focus().deleteRange(range).run(); openNewPollDialog((form) => editor.chain().focus().insertModuleEmbed({ kind: form.kind === "time_poll" ? "time_poll" : "poll", path: form.href }).run()); } },
    { label: "Form", hint: "Show one of your forms with a Respond button", keywords: "form survey questionnaire respond embed time find", run: (editor, range) => { editor.chain().focus().deleteRange(range).run(); openFormPicker((form) => editor.chain().focus().insertModuleEmbed({ kind: form.kind === "poll" ? "poll" : form.kind === "time_poll" ? "time_poll" : "form", path: form.href }).run()); } }
  ],
  searchRenderer: {
    scope: "forms", label: "Forms", icon: BarChart3,
    row: (result) => ({ key: String(result.id), title: String(result.title), meta: typeof result.snippet === "string" ? result.snippet : undefined, href: String(result.href) })
  },
  shortcuts: [
    { keys: "n", label: "New form" },
    { keys: "/", label: "Search forms" },
    { keys: "j / k", label: "Next / previous response" }
  ],
  publicPages: [{ prefix: "/p/f/", component: lazy(() => import("./PublicFormPage")) }]
};
