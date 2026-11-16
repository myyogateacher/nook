// The card's activity history in the comments timeline (lane ACTIVITY, D746): one compact row per
// entry, the "Activity" switch and the order button of the Comments header, and the hook that loads
// the history. Pure helpers are in cardActivityModel.ts; the kinds are in shared/cardActivity.ts.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive, ArchiveRestore, ArrowDownWideNarrow, Clock, OctagonAlert, Target, ArrowRight, ArrowRightLeft, ArrowUpNarrowWide, CalendarClock, CalendarPlus, Flag, FlagOff, Gauge, IterationCw, Layers, Link2, Network,
  Paperclip, Plus, SignalHigh, Tag, TextAlignStart, Trash2, Type, Unlink, UserMinus, UserPlus, type LucideIcon, AtSign
} from "lucide-react";
import { relativeTime, formatDateTime } from "../files/format";
import { appName } from "../appName";
import { IntegrationBadge } from "../ui/IntegrationBadge";
import type { ActivityValue, CardActivityEntry, CardActivityKind, CardActivityPayload } from "../../shared/cardActivity";
import { HISTORY_FLAG_LABELS } from "./cardTags";
import { priorityLabel } from "./priority";
import { RELATION_LABELS } from "./relationsModel";
import type { RelationType } from "./tasksApi";
import { listCardActivity, mergeActivityPage, readTimelinePrefs, writeTimelinePrefs, type ActivityPage, type TimelinePrefs } from "./cardActivityModel";

const b = (text: string) => <strong className="task-activity-value">{text}</strong>;

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (the zone in `detail`) as a short local date, as the due field shows it. */
export function dueValueLabel(value: ActivityValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value.id ?? "");
  if (!match) return value.label;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const day = date.toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  return match[4] ? `${day}, ${match[4]}:${match[5]}${value.detail ? ` (${value.detail})` : ""}` : day;
}

type Renderer = { icon: LucideIcon; text: (payload: CardActivityPayload) => ReactNode };
type Format = (value: ActivityValue) => string;
const plain: Format = (value) => value.label;

/** A field with a value: "set the X to A", "changed the X from A to B", "cleared the X". */
function change(noun: string, icon: LucideIcon, format: Format = plain): Renderer {
  return {
    icon,
    text: ({ from, to }) => from && to ? <>changed the {noun} from {b(format(from))} to {b(format(to))}</>
      : to ? <>set the {noun} to {b(format(to))}</>
      : from ? <>cleared the {noun} (was {b(format(from))})</>
      : <>changed the {noun}</>
  };
}

/** One thing added to or removed from a set: "<verb> X". */
function item(verb: string, icon: LucideIcon, format: Format = plain, after = ""): Renderer {
  return { icon, text: ({ item: value }) => <>{verb} {value ? b(format(value)) : "something"}{after}</> };
}

const flagLabel: Format = (value) => (value.id ? HISTORY_FLAG_LABELS[value.id] : undefined) ?? value.label;
/** D1314: "set the priority to High", "changed the priority from High to Urgent", "cleared the priority (was Low)". */
const priorityWords: Format = (value) => value.id ? priorityLabel(value.id) : value.label;
const relationText = (verb: string) => ({ item: value }: CardActivityPayload) => {
  const type = value?.detail ? RELATION_LABELS[value.detail as RelationType]?.toLowerCase() : null;
  return <>{verb} {value ? b(value.label) : "a card"}{type ? <> ({type})</> : null}</>;
};
/** A board the card moved from or to (D716): "Roadmap (ROA-2)", the key it had there. */
const boardLabel: Format = (value) => value.detail ? `${value.label} (${value.detail})` : value.label;
const subtasks = (count: number | undefined, verb: string) => count ? ` with ${count === 1 ? "1 subtask" : `${count} subtasks`}${verb}` : "";

/**
 * How each kind reads, after the actor's name. Adding a kind is one row here (and one in
 * shared/cardActivity.ts); TypeScript refuses a kind listed there and not drawn here. For example:
 * `start: change("start date", CalendarClock, dueValueLabel)`, `estimate: change("estimate", Gauge)`,
 * `board: change("board", ArrowRightLeft)`.
 */
export const ACTIVITY_RENDERERS: Record<CardActivityKind, Renderer> = {
  created: { icon: Plus, text: ({ to }) => <>created this card{to ? <> in {b(to.label)}</> : null}</> },
  title: { icon: Type, text: ({ from, to }) => <>renamed this card{from ? <> from {b(from.label)}</> : null}{to ? <> to {b(to.label)}</> : null}</> },
  description: { icon: TextAlignStart, text: () => <>updated the description</> },
  column: { icon: ArrowRight, text: ({ from, to }) => <>moved this{from ? <> from {b(from.label)}</> : null}{to ? <> to {b(to.label)}</> : null}</> },
  assignee_added: item("assigned", UserPlus),
  assignee_removed: item("unassigned", UserMinus),
  due: change("due date", CalendarClock, dueValueLabel),
  // Added at integration (shared/cardActivity.ts): the start date (D720), the estimate (D750, its label
  // carries the board's unit then: "5 pts", "3h"), and a move to another board (D716).
  start: change("start date", CalendarPlus, dueValueLabel),
  estimate: change("estimate", Gauge),
  board_move: {
    icon: ArrowRightLeft,
    text: ({ from, to }) => <>moved this card{from ? <> from {b(boardLabel(from))}</> : null}{to ? <> to {b(boardLabel(to))}</> : null}</>
  },
  tag_added: item("added the tag", Tag),
  tag_removed: item("removed the tag", Tag),
  flag_set: item("flagged this", Flag, flagLabel),
  flag_cleared: item("cleared the flag", FlagOff, flagLabel),
  priority: change("priority", SignalHigh, priorityWords),
  parent: change("parent", Network),
  level: change("level", Layers),
  relation_added: { icon: Link2, text: relationText("linked") },
  relation_removed: { icon: Unlink, text: relationText("unlinked") },
  sprint: change("sprint", IterationCw),
  binned: { icon: Trash2, text: ({ count }) => <>moved this card to the Bin{subtasks(count, "")}</> },
  restored: { icon: ArchiveRestore, text: ({ count, to }) => <>restored this card from the Bin{to ? <> to {b(to.label)}</> : null}{subtasks(count, "")}</> },
  archived: { icon: Archive, text: () => <>archived this card</> },
  unarchived: { icon: ArchiveRestore, text: () => <>put this card back on the board</> },
  attachment_added: item("attached", Paperclip),
  attachment_removed: item("removed the file", Paperclip),
  // Workspace modules (W1-CORE, shared/cardActivity.ts): time, goals, and standup blockers.
  time_logged: item("logged", Clock),
  goal_linked: item("linked this to the goal", Target),
  goal_unlinked: item("unlinked this from the goal", Target),
  blocked_by_checkin: item("flagged this as blocked in", OctagonAlert),
  // @mentions (docs/plan/MENTIONS.md D1332): one row per person notified.
  mentioned: item("mentioned", AtSign)
};

const VIA_LABELS: Record<string, string> = { mcp: "via MCP", rest: "via the API", agent: "via an agent", proposal: "via an approved proposal" };

/** One history row: the kind's icon, the actor in bold, the sentence, and the time (absolute on hover). */
export function ActivityRow({ entry }: { entry: CardActivityEntry }) {
  const renderer = ACTIVITY_RENDERERS[entry.kind];
  if (!renderer) return null;
  const Icon = renderer.icon;
  const actor = entry.via === "system" ? appName() : entry.actor_name || "Former member";
  const via = entry.via ? VIA_LABELS[entry.via] : undefined;
  return <li className="task-activity" data-kind={entry.kind}>
    <span className="task-activity-icon" aria-hidden="true"><Icon /></span>
    <p className="task-activity-text">
      <strong className="task-activity-actor">{actor}{entry.actor_is_integration === 1 && <IntegrationBadge />}</strong>{" "}
      {renderer.text(entry.payload)}
      {via && <span className="task-activity-via"> {via}</span>}
      <span className="task-activity-sep" aria-hidden="true"> · </span>
      <time dateTime={entry.created_at} title={formatDateTime(entry.created_at)}>{relativeTime(entry.created_at)}</time>
    </p>
  </li>;
}

/** The Comments header's right side: the "Activity" switch and the newest/oldest first button. */
export function TimelineControls({ prefs, onChange, idPrefix }: { prefs: TimelinePrefs; onChange: (next: TimelinePrefs) => void; idPrefix: string }) {
  const newest = prefs.order === "desc";
  const label = newest ? "Newest first" : "Oldest first";
  const switchLabel = `${idPrefix}-activity-switch`;
  return <div className="task-timeline-controls">
    <button type="button" role="switch" className="task-activity-switch" aria-checked={prefs.showActivity} aria-labelledby={switchLabel}
      title={prefs.showActivity ? "Hide the card's history" : "Show the card's history with the comments"}
      onClick={() => onChange({ ...prefs, showActivity: !prefs.showActivity })}>
      <span id={switchLabel}>Activity</span>
      <span className="task-activity-switch-track" aria-hidden="true"><span className="task-activity-switch-thumb" /></span>
    </button>
    <button type="button" className="icon-button task-timeline-order" aria-label={`${label}. Show ${newest ? "oldest" : "newest"} first`}
      title={`${label} (click for ${newest ? "oldest" : "newest"} first)`}
      onClick={() => onChange({ ...prefs, order: newest ? "asc" : "desc" })}>
      {newest ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
    </button>
  </div>;
}

const EMPTY: ActivityPage = { activity: [], next: null };

/**
 * The person's timeline choices and the card's history. The newest page is read when the switch is
 * on and again whenever `refreshKey` changes (a change to the card), keeping older pages already
 * loaded; `loadOlder` reads the next page. A failed read keeps what is shown: history is secondary.
 */
export function useCardTimeline(userId: string, cardId: string, refreshKey: string) {
  const [prefs, setPrefsState] = useState<TimelinePrefs>(() => readTimelinePrefs(userId));
  const [page, setPage] = useState<ActivityPage>(EMPTY);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => { setPrefsState(readTimelinePrefs(userId)); }, [userId]);
  useEffect(() => { setPage(EMPTY); }, [cardId]);
  useEffect(() => {
    if (!prefs.showActivity || !refreshKey) return;
    let cancelled = false;
    listCardActivity(cardId).then((first) => {
      if (!cancelled) setPage((current) => mergeActivityPage(current, first));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cardId, refreshKey, prefs.showActivity]);

  const setPrefs = useCallback((next: TimelinePrefs) => {
    setPrefsState(next);
    writeTimelinePrefs(userId, next);
  }, [userId]);

  const loadOlder = useCallback(async () => {
    const cursor = pageRef.current.next;
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const older = await listCardActivity(cardId, cursor);
      setPage((current) => {
        const seen = new Set(current.activity.map((entry) => entry.id));
        return { activity: [...current.activity, ...older.activity.filter((entry) => !seen.has(entry.id))], next: older.next };
      });
    } catch {
      // Keep what is shown; the button stays for another try.
    } finally {
      setLoadingOlder(false);
    }
  }, [cardId]);

  return { prefs, setPrefs, activity: page.activity, hasMoreActivity: page.next !== null, loadOlder, loadingOlder };
}
