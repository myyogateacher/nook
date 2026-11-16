import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, History, Link2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { relativeTime } from "../../files/format";
import { Avatar } from "../Avatar";
import { errorText } from "../notify";
import { addItemComment, deleteItemComment, editItemComment, itemActivity, itemComments } from "../workspaceApi";
import { ITEM_COMMENT_MAX, type ItemActivityEntry, type ItemComment } from "../../../shared/itemActivity";
import { WORK_KIND_LABELS, type WorkKind } from "../../../shared/workRefs";
import { MentionTextarea } from "../mentions/MentionTextarea";
import { MentionText } from "../mentions/Mentions";
import type { MentionTarget } from "../mentions/mentionsApi";
import "../workspace.css";

/**
 * An item's timeline (§B.5, §E.3, D839): comments and activity interleaved for goals, deals,
 * contacts, standup responses, bookings, and form responses, with the card dialog's controls (D746):
 * an Activity switch and newest/oldest first, remembered per person. Modules draw their own activity
 * kinds (`renderers`, the module's `activityRenderers`); a kind without one reads "updated this".
 */

export type TimelinePrefs = { showActivity: boolean; order: "asc" | "desc" };
const PREFS_KEY = "nook.itemTimeline";

export function readItemTimelinePrefs(): TimelinePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<TimelinePrefs> | null;
    return { showActivity: raw?.showActivity !== false, order: raw?.order === "desc" ? "desc" : "asc" };
  } catch { return { showActivity: true, order: "asc" }; }
}

export type ActivityRenderers = Readonly<Record<string, (entry: ItemActivityEntry) => ReactNode>>;

/** The built-in kinds every item has (shared/itemActivity.ts GENERIC_ACTIVITY_KINDS). */
const GENERIC: ActivityRenderers = {
  created: () => <>created this</>,
  linked: (entry) => <>linked <span className="ui-activity-value">{entry.payload.item?.label ?? "an item"}</span></>,
  unlinked: (entry) => <>unlinked <span className="ui-activity-value">{entry.payload.item?.label ?? "an item"}</span></>,
  binned: () => <>moved this to the Bin</>,
  restored: () => <>restored this from the Bin</>
};

const VIA_WORDS: Record<NonNullable<ItemActivityEntry["via"]>, string> = { mcp: "via an MCP key", rest: "via the API", agent: "via an agent", proposal: "via an approved proposal", system: "automatically", public: "via a public page" };

export type TimelineEntry = { type: "comment"; at: string; id: string; comment: ItemComment } | { type: "activity"; at: string; id: string; entry: ItemActivityEntry };

/** Comments (with their replies under them) and activity in one order. Pure. */
export function mergeTimeline(comments: readonly ItemComment[], activity: readonly ItemActivityEntry[], prefs: TimelinePrefs): TimelineEntry[] {
  const top = comments.filter((comment) => !comment.parentId);
  const items: TimelineEntry[] = [
    ...top.map((comment) => ({ type: "comment" as const, at: comment.createdAt, id: comment.id, comment })),
    ...(prefs.showActivity ? activity.map((entry) => ({ type: "activity" as const, at: entry.createdAt, id: entry.id, entry })) : [])
  ];
  items.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
  return prefs.order === "desc" ? items.reverse() : items;
}

function ActivityLine({ entry, renderers }: { entry: ItemActivityEntry; renderers: ActivityRenderers }) {
  const render = renderers[entry.kind] ?? GENERIC[entry.kind];
  return <li className="ui-activity">
    <span className="ui-activity-icon" aria-hidden="true">{entry.kind === "linked" || entry.kind === "unlinked" ? <Link2 /> : <History />}</span>
    <p className="ui-activity-text">
      <span className="ui-activity-actor">{entry.actorName}</span> {render ? render(entry) : <>updated this</>}
      {entry.via && <span className="ui-activity-via"> {VIA_WORDS[entry.via]}</span>}
      {" · "}<time dateTime={entry.createdAt}>{relativeTime(entry.createdAt)}</time>
    </p>
  </li>;
}

function CommentBox({ initial = "", label, submitLabel, onSubmit, onCancel, autoFocus = false, target }: { initial?: string; label: string; submitLabel: string; onSubmit: (body: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean; target: MentionTarget }) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(body.trim()); setBody(""); }
    catch (reason) { setError(errorText(reason, "Could not save the comment")); }
    finally { setBusy(false); }
  };
  return <div className="ui-comment-box">
    <MentionTextarea target={target} noun={WORK_KIND_LABELS[target.kind].toLowerCase()} aria-label={label} value={body} maxLength={ITEM_COMMENT_MAX} rows={2} autoFocus={autoFocus} placeholder="Write a comment… @ to mention, ⌘ Enter to send" disabled={busy}
      onValueChange={setBody}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        if (event.key === "Escape" && onCancel) { event.preventDefault(); event.stopPropagation(); onCancel(); }
      }} />
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    <div className="ui-comment-actions">
      {onCancel && <button type="button" className="secondary-button ui-small-button" onClick={onCancel} disabled={busy}>Cancel</button>}
      <button type="button" className="action-button ui-small-action" onClick={() => { void submit(); }} disabled={busy || !body.trim()}>{busy ? "Saving…" : submitLabel}</button>
    </div>
  </div>;
}

function CommentItem({ comment, replies, canComment, onReply, onEdit, onDelete, target }: { comment: ItemComment; replies: readonly ItemComment[]; canComment: boolean; onReply?: (body: string) => Promise<void>; onEdit: (comment: ItemComment, body: string) => Promise<void>; onDelete: (comment: ItemComment) => Promise<void>; target: MentionTarget }) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  return <li className="ui-comment">
    <header>
      <Avatar className="ui-person-avatar" name={comment.authorName} url={comment.authorAvatarUrl ?? null} />
      <strong>{comment.deleted ? "Comment deleted" : comment.authorName}</strong>
      <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
      {comment.updatedAt !== comment.createdAt && !comment.deleted && <span className="ui-comment-edited">edited</span>}
      {comment.canEdit && !comment.deleted && !editing && <span className="ui-comment-tools">
        <button type="button" className="icon-button" onClick={() => setEditing(true)} aria-label="Edit comment" title="Edit"><Pencil /></button>
        <button type="button" className="icon-button" onClick={() => { void onDelete(comment); }} aria-label="Delete comment" title="Delete"><Trash2 /></button>
      </span>}
    </header>
    {editing
      ? <CommentBox target={target} initial={comment.body} label="Edit comment" submitLabel="Save" autoFocus onCancel={() => setEditing(false)} onSubmit={async (body) => { await onEdit(comment, body); setEditing(false); }} />
      : !comment.deleted && <p className="ui-comment-body"><MentionText text={comment.body} /></p>}
    {replies.length > 0 && <ol className="ui-comment-replies" aria-label="Replies">
      {replies.map((reply) => <CommentItem key={reply.id} comment={reply} replies={[]} canComment={false} onEdit={onEdit} onDelete={onDelete} target={target} />)}
    </ol>}
    {onReply && canComment && !comment.deleted && (replying
      ? <CommentBox target={target} label="Reply" submitLabel="Reply" autoFocus onCancel={() => setReplying(false)} onSubmit={async (body) => { await onReply(body); setReplying(false); }} />
      : <button type="button" className="ui-text-button" onClick={() => setReplying(true)}>Reply</button>)}
  </li>;
}

export function ItemTimeline({ kind, id, canComment, renderers = {}, title = "Comments", refreshKey, history = true }: {
  kind: WorkKind;
  id: string;
  /** The viewer may comment (comment level and up, not a read-only role). */
  canComment: boolean;
  /** The module's activity renderers (its `activityRenderers`). */
  renderers?: ActivityRenderers;
  title?: string;
  /** Changes when the item changes, so new activity is read again. */
  refreshKey?: string;
  /**
   * Whether the item's history can be shown with the comments (the Activity switch). Pages that already
   * show that history elsewhere (Contacts' record timeline) pass false: comments only, nothing twice.
   */
  history?: boolean;
}) {
  const headingId = useId();
  const [prefs, setPrefsState] = useState(readItemTimelinePrefs);
  const [comments, setComments] = useState<ItemComment[] | null>(null);
  const [activity, setActivity] = useState<ItemActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setPrefs = (next: TimelinePrefs) => { setPrefsState(next); try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode */ } };

  const load = useCallback(() => {
    setError(null);
    itemComments(kind, id).then((body) => setComments(body.comments), (reason) => setError(errorText(reason, "Could not load comments")));
    // History is secondary: a failed read keeps what is shown.
    if (history) itemActivity(kind, id, { order: "desc" }).then((body) => { setActivity(body.entries); setCursor(body.nextCursor); }, () => undefined);
  }, [kind, id, history]);
  useEffect(load, [load, refreshKey]);

  const olderActivity = async () => {
    if (!cursor) return;
    const body = await itemActivity(kind, id, { order: "desc", cursor });
    setActivity((current) => [...current, ...body.entries]);
    setCursor(body.nextCursor);
  };
  const add = async (body: string, parentId?: string) => {
    const { comment } = await addItemComment(kind, id, body, parentId);
    setComments((current) => [...(current ?? []), comment]);
  };
  const edit = async (comment: ItemComment, body: string) => {
    const { comment: next } = await editItemComment(kind, id, comment.id, body);
    setComments((current) => current?.map((item) => item.id === next.id ? next : item) ?? null);
  };
  const remove = async (comment: ItemComment) => {
    try { await deleteItemComment(kind, id, comment.id); setComments((current) => current?.filter((item) => item.id !== comment.id) ?? null); }
    catch (reason) { setError(errorText(reason, "Could not delete the comment")); }
  };

  const showActivity = history && prefs.showActivity;
  const items = mergeTimeline(comments ?? [], activity, { ...prefs, showActivity });
  const repliesOf = (parentId: string) => (comments ?? []).filter((comment) => comment.parentId === parentId);
  const newest = prefs.order === "desc";
  const target = useMemo<MentionTarget>(() => ({ kind, id }), [kind, id]);
  const composer = canComment && <CommentBox target={target} label="Add a comment" submitLabel="Comment" onSubmit={(body) => add(body)} />;

  return <section className="ui-timeline" aria-labelledby={headingId} aria-busy={comments === null || undefined}>
    <header className="ui-panel-header">
      <h3 id={headingId}><MessageSquare aria-hidden="true" />{title}</h3>
      <div className="ui-timeline-controls">
        {history && <button type="button" role="switch" className="ui-switch" aria-checked={prefs.showActivity} onClick={() => setPrefs({ ...prefs, showActivity: !prefs.showActivity })} title={prefs.showActivity ? "Hide the history" : "Show the history with the comments"}>
          <span>Activity</span><span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span>
        </button>}
        <button type="button" className="icon-button" onClick={() => setPrefs({ ...prefs, order: newest ? "asc" : "desc" })} aria-label={`${newest ? "Newest" : "Oldest"} first. Show ${newest ? "oldest" : "newest"} first`} title={newest ? "Newest first" : "Oldest first"}>
          {newest ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
        </button>
      </div>
    </header>
    {error && <p className="ui-field-error" role="alert">{error} <button type="button" className="ui-text-button" onClick={load}>Retry</button></p>}
    {newest && composer}
    {comments === null && !error
      ? <p className="ui-panel-loading" role="status">Loading…</p>
      : <ol className="ui-timeline-list" aria-label={showActivity ? "Comments and activity" : "Comments"}>
        {items.map((item) => item.type === "activity"
          ? <ActivityLine key={item.id} entry={item.entry} renderers={renderers} />
          : <CommentItem key={item.id} comment={item.comment} replies={repliesOf(item.id)} canComment={canComment} onReply={(body) => add(body, item.id)} onEdit={edit} onDelete={remove} target={target} />)}
        {items.length === 0 && <li className="ui-timeline-empty">{canComment ? "No comments yet. Start the conversation below." : "No comments yet."}</li>}
      </ol>}
    {showActivity && cursor && <button type="button" className="ui-text-button" onClick={() => { void olderActivity().catch(() => undefined); }}>Load earlier activity</button>}
    {!newest && composer}
  </section>;
}
