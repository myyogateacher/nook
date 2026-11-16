import { lazy, Suspense } from "react";
import { TOWNHALL_SECTIONS } from "./sections";
import { MessageCircleQuestion, Plus, Presentation } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule } from "../workspaceModules/types";
import type { Route } from "../router";
import { pickAndEmbed } from "../ui/embeds/openEmbedPicker";
import type { EmbedCardProps } from "../editor/moduleEmbedRegistry";
import { listSessions } from "./api";

const LiveSessionEmbed = lazy(() => import("./TownhallEmbed"));
function SessionEmbed(props: EmbedCardProps) {
  return <Suspense fallback={<div className="ui-embed" role="status" aria-label="Loading">Loading…</div>}><LiveSessionEmbed {...props} /></Suspense>;
}
/** A session page (not the home, Insights, or the presenter screen). */
const isSessionPath = (path: string) => /^\/townhall\/[a-z0-9-]+$/i.test(path.split(/[?#]/)[0]!) && !/^\/townhall\/insights$/i.test(path.split(/[?#]/)[0]!);

/**
 * Townhall (lane TOWNHALL, docs/plan/WORKSPACE_MODULES.md §D.7 Townhall): all-hands and AMA sessions
 * with audience questions, upvotes, moderation, live polls, a presenter view, and a recap. Routes:
 * `/townhall`, `/townhall/insights`, `/townhall/<slug>-<shortid>` (`?tab=`, `?filter=`, `?q=`), and
 * `…/present`; the audience link is the public page `/p/t/<token>`.
 */

const SEGMENT = /^[a-z0-9-]{1,90}$/;
const KEPT_QUERY = ["tab", "filter", "q", "new"] as const;

const sessionRoute = (href: string): Route => ({ app: "townhall", path: [href.split("/").pop() ?? ""], search: "" } as Route);

export const module: WorkspaceClientModule = {
  id: "townhall",
  segment: WORKSPACE_MODULE_LABELS.townhall.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.townhall.label,
  icon: Presentation,
  description: WORKSPACE_MODULE_LABELS.townhall.description,
  ready: true,
  launcher: true,
  sections: TOWNHALL_SECTIONS,
  app: lazy(() => import("./TownhallApp")),
  parseRoute: (segments, search) => {
    const [first, second] = segments.map((segment) => segment.toLowerCase());
    const params = new URLSearchParams(search);
    const kept = new URLSearchParams();
    for (const key of KEPT_QUERY) {
      const value = params.get(key);
      if (value && /^[a-z0-9-]{1,40}$/.test(value)) kept.set(key, value);
    }
    const query = kept.size ? `?${kept}` : "";
    if (!first) return { path: [], search: kept.get("new") ? "?new=1" : "" };
    if (first === "insights" && segments.length === 1) return { path: ["insights"] };
    if (!SEGMENT.test(first)) return { path: [] };
    return { path: second === "present" ? [first, "present"] : [first], search: query };
  },
  todaySections: {
    townhallLive: {
      title: "Townhalls", group: "today", empty: "none live or starting soon", app: "Townhall", module: "townhall",
      row: (item) => ({
        key: String(item.id), label: String(item.title),
        meta: item.state === "live" ? "Live now" : item.startsAt ? `Starts ${new Date(String(item.startsAt)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Upcoming",
        route: sessionRoute(String(item.href)), tone: item.state === "live" ? "today" : "soon"
      })
    }
  },
  quickActions: [{ id: "townhall.new", label: "New townhall", icon: Plus, href: "/townhall?new=1", hiddenFor: ["guest", "viewer"] }],
  embedRenderers: [{ kind: "townhall_session", match: isSessionPath, component: SessionEmbed }],
  slashItems: [{
    label: "Townhall", hint: "Embed a townhall session", keywords: "townhall all-hands ama questions session",
    run: (editor, range) => pickAndEmbed(editor, range, "townhall_session", {
      title: "Add a townhall", eyebrow: "Townhall", icon: Presentation, emptyTitle: "No sessions", emptyText: "Create a session in Townhall first.",
      load: () => listSessions("all").then((page) => page.items.map((item) => ({ id: item.id, title: item.title, meta: item.state === "live" ? "Live now" : item.state === "ended" ? "Ended" : "Upcoming", path: item.href })))
    })
  }],
  notificationTopics: [
    { id: "townhall.live", label: "A townhall you asked in goes live" },
    { id: "townhall.answered", label: "Your question was answered" },
    { id: "townhall.review", label: "Questions wait for your review", description: "Sessions you host with review on." },
    { id: "townhall.reminder", label: "Reminders before a townhall starts" }
  ],
  workKindRenderers: {
    townhall_session: { icon: Presentation, label: "Townhall" },
    townhall_question: { icon: MessageCircleQuestion, label: "Question" }
  },
  activityRenderers: {
    townhall_live: () => "started the session",
    townhall_ended: () => "ended the session",
    townhall_asked: () => "asked a question",
    townhall_moderated: (entry) => `marked it ${entry.payload.to?.label ?? "changed"}`,
    townhall_poll: () => "added a poll",
    townhall_card: () => "made a card from it",
    title: (entry) => `renamed it to “${entry.payload.to?.label ?? ""}”`
  },
  searchRenderer: {
    scope: "townhall", label: "Townhall", icon: Presentation,
    row: (result) => ({ key: String(result.id), title: String(result.title), meta: "Townhall", href: String(result.href) })
  },
  shortcuts: [
    { keys: "N", label: "New townhall (home)" },
    { keys: "P", label: "Present (in a session)" },
    { keys: "A", label: "Ask a question (in a session)" },
    { keys: "/", label: "Find a question or session" }
  ],
  publicPages: [{ prefix: "/p/t/", component: lazy(() => import("./PublicTownhall")) }]
};
