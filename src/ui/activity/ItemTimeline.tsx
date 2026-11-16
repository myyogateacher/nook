import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, History, Link2, Loader2, MessageSquare, Paperclip, Pencil, Trash2, X } from "lucide-react";
import { relativeTime } from "../../files/format";
import { Avatar } from "../Avatar";
import { errorText, notifier, notify } from "../notify";
import { addItemComment, deleteItemComment, editItemComment, itemActivity, itemComments, setItemCommentReaction, undoTicket } from "../workspaceApi";
import { AttachmentList, AttachmentPreview, unlinkFromHost, uploadForHost } from "../attachments";
import { CommentReactions } from "../../tasks/CommentReactions";
import { ITEM_COMMENT_FILES_MAX, ITEM_COMMENT_MAX, type ItemActivityEntry, type ItemComment } from "../../../shared/itemActivity";
import type { ReactionAggregate } from "../../../shared/reactions";
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
 * Comments carry the Tasks comment's reactions (D1362) and files (D1363), and a delete offers the
 * shared Undo toast (D813, D1364).
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

/** Comments (with their replies under them) and activity in one order; a "commented" entry is the comment itself, shown once (D1364). Pure. */
export function mergeTimeline(comments: readonly ItemComment[], activity: readonly ItemActivityEntry[], prefs: TimelinePrefs): TimelineEntry[] {
  const top = comments.filter((comment) => !comment.parentId);
  const items: TimelineEntry[] = [
    ...top.map((comment) => ({ type: "comment" as const, at: comment.createdAt, id: comment.id, comment })),
    ...(prefs.showActivity ? activity.filter((entry) => entry.kind !== "commented").map((entry) => ({ type: "activity" as const, at: entry.createdAt, id: entry.id, entry })) : [])
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

type PendingFile = { key: string; name: string; documentId: string | null };

function CommentBox({ initial = "", label, submitLabel, onSubmit, onCancel, autoFocus = false, target, files: allowFiles = false }: { initial?: string; label: string; submitLabel: string; onSubmit: (body: string, attachmentIds: string[]) => Promise<void>; onCancel?: () => void; autoFocus?: boolean; target: MentionTarget; files?: boolean }) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const uploading = files.some((file) => file.documentId === null);
  const ready = files.flatMap((file) => file.documentId ? [file.documentId] : []);
  const canSend = (body.trim().length > 0 || ready.length > 0) && !uploading;
  const submit = async () => {
    if (!canSend || busy) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(body.trim(), ready); setBody(""); setFiles([]); }
    catch (reason) { setError(errorText(reason, "Could not save the comment")); }
    finally { setBusy(false); }
  };
  /** Files go to the person's Attachments folder now and are linked when the comment is sent (D1363). */
  const pick = (list: FileList | null) => {
    const chosen = [...(list ?? [])].slice(0, Math.max(0, ITEM_COMMENT_FILES_MAX - files.length));
    if (list && list.length > chosen.length) setError(`A comment can have up to ${ITEM_COMMENT_FILES_MAX} files`);
    for (const file of chosen) {
      const key = crypto.randomUUID();
      setFiles((current) => [...current, { key, name: file.name, documentId: null }]);
      uploadForHost(file, "item_comment").then(
        (result) => setFiles((current) => current.map((item) => item.key === key ? { ...item, documentId: result.document.id } : item)),
        (reason) => { setFiles((current) => current.filter((item) => item.key !== key)); setError(errorText(reason, `Could not upload ${file.name}`)); }
      );
    }
  };
  return <div className="ui-comment-box">
    <MentionTextarea target={target} noun={WORK_KIND_LABELS[target.kind].toLowerCase()} aria-label={label} value={body} maxLength={ITEM_COMMENT_MAX} rows={2} autoFocus={autoFocus} placeholder="Write a comment… @ to mention, ⌘ Enter to send" disabled={busy}
      onValueChange={setBody}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        if (event.key === "Escape" && onCancel) { event.preventDefault(); event.stopPropagation(); onCancel(); }
      }} />
    {files.length > 0 && <ul className="ui-comment-files" aria-label="Files to attach">
      {files.map((file) => <li key={file.key}>
        {file.documentId ? <Paperclip aria-hidden="true" /> : <Loader2 className="ui-spin" aria-label="Uploading" />}
        <span>{file.name}</span>
        <button type="button" className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item.key !== file.key))} disabled={busy}><X /></button>
      </li>)}
    </ul>}
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    <div className="ui-comment-actions">
      {allowFiles && <>
        <input ref={input} type="file" multiple hidden onChange={(event) => { pick(event.currentTarget.files); event.currentTarget.value = ""; }} />
        <button type="button" className="icon-button ui-comment-attach" onClick={() => input.current?.click()} disabled={busy || files.length >= ITEM_COMMENT_FILES_MAX} aria-label="Attach files" title="Attach files"><Paperclip /></button>
      </>}
      {onCancel && <button type="button" className="secondary-button ui-small-button" onClick={onCancel} disabled={busy}>Cancel</button>}
      <button type="button" className="action-button ui-small-action" onClick={() => { void submit(); }} disabled={busy || !canSend}>{busy ? "Saving…" : uploading ? "Uploading…" : submitLabel}</button>
    </div>
  </div>;
}

type CommentHandlers = {
  onEdit: (comment: ItemComment, body: string) => Promise<void>;
  onDelete: (comment: ItemComment) => Promise<void>;
  onReactions: (commentId: string, update: (current: ReactionAggregate[]) => ReactionAggregate[]) => void;
  onOpenFile: (file: { documentId: string; name: string }) => void;
  onRemoveFile: (comment: ItemComment, documentId: string) => void;
};

function CommentItem({ comment, replies, canComment, onReply, handlers, target }: { comment: ItemComment; replies: readonly ItemComment[]; canComment: boolean; onReply?: (body: string, attachmentIds: string[]) => Promise<void>; handlers: CommentHandlers; target: MentionTarget }) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const attachments = comment.attachments ?? [];
  return <li className="ui-comment">
    <header>
      <Avatar className="ui-person-avatar" name={comment.authorName} url={comment.authorAvatarUrl ?? null} />
      <strong>{comment.deleted ? "Comment deleted" : comment.authorName}</strong>
      <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
      {comment.updatedAt !== comment.createdAt && !comment.deleted && <span className="ui-comment-edited">edited</span>}
      {comment.canEdit && !comment.deleted && !editing && <span className="ui-comment-tools">
        <button type="button" className="icon-button" onClick={() => setEditing(true)} aria-label="Edit comment" title="Edit"><Pencil /></button>
        <button type="button" className="icon-button" onClick={() => { void handlers.onDelete(comment); }} aria-label="Delete comment" title="Delete"><Trash2 /></button>
      </span>}
    </header>
    {editing
      ? <CommentBox target={target} initial={comment.body} label="Edit comment" submitLabel="Save" autoFocus onCancel={() => setEditing(false)} onSubmit={async (body) => { await handlers.onEdit(comment, body); setEditing(false); }} />
      : !comment.deleted && comment.body && <p className="ui-comment-body"><MentionText text={comment.body} /></p>}
    {!comment.deleted && attachments.length > 0 && <AttachmentList items={attachments} label="Files on this comment"
      onOpen={(file) => handlers.onOpenFile({ documentId: file.documentId, name: file.name })}
      // The server's rule (D1363): the comment's author or a manager of the item (canEdit), or the file's owner.
      canRemove={(file) => comment.canEdit || (!file.removed && file.isOwner)}
      onRemove={(file) => handlers.onRemoveFile(comment, file.documentId)} />}
    {!comment.deleted && <CommentReactions commentId={comment.id} reactions={comment.reactions ?? []} readOnly={!canComment} onUpdate={handlers.onReactions} notify={notifier} send={setItemCommentReaction} />}
    {replies.length > 0 && <ol className="ui-comment-replies" aria-label="Replies">
      {replies.map((reply) => <CommentItem key={reply.id} comment={reply} replies={[]} canComment={canComment} handlers={handlers} target={target} />)}
    </ol>}
    {onReply && canComment && !comment.deleted && (replying
      ? <CommentBox target={target} label="Reply" submitLabel="Reply" autoFocus files onCancel={() => setReplying(false)} onSubmit={async (body, files) => { await onReply(body, files); setReplying(false); }} />
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
  const add = async (body: string, parentId?: string, attachmentIds: string[] = []) => {
    const { comment } = await addItemComment(kind, id, body, parentId, attachmentIds);
    setComments((current) => [...(current ?? []), comment]);
  };
  const [preview, setPreview] = useState<{ documentId: string; name: string } | null>(null);
  const edit = async (comment: ItemComment, body: string) => {
    const { comment: next } = await editItemComment(kind, id, comment.id, body);
    setComments((current) => current?.map((item) => item.id === next.id ? next : item) ?? null);
  };
  /** Deleted at once, with the shared Undo toast (D813, D1364): Undo puts it back with its reactions and files. */
  const remove = async (comment: ItemComment) => {
    try {
      const { undoTicket: ticket } = await deleteItemComment(kind, id, comment.id);
      // A comment with replies stays as "Comment deleted"; reading again shows it the way the server keeps it.
      if (repliesOf(comment.id).length) load();
      else setComments((current) => current?.filter((item) => item.id !== comment.id) ?? null);
      notify.success("Comment deleted", {
        id: `item-comment-deleted:${comment.id}`,
        action: { label: "Undo", onClick: () => { undoTicket(ticket).then(() => { load(); notify.success("Comment restored"); }, (reason) => notify.error(errorText(reason, "Could not undo"))); } }
      });
    } catch (reason) { setError(errorText(reason, "Could not delete the comment")); }
  };
  const handlers: CommentHandlers = {
    onEdit: edit,
    onDelete: remove,
    onReactions: (commentId, update) => setComments((current) => current?.map((item) => item.id === commentId ? { ...item, reactions: update(item.reactions ?? []) } : item) ?? null),
    onOpenFile: setPreview,
    onRemoveFile: (comment, documentId) => {
      unlinkFromHost("item_comment", comment.id, documentId).then(
        () => setComments((current) => current?.map((item) => item.id === comment.id ? { ...item, attachments: item.attachments.filter((file) => file.documentId !== documentId) } : item) ?? null),
        (reason) => notify.error(errorText(reason, "Could not remove the file"))
      );
    }
  };

  const showActivity = history && prefs.showActivity;
  const items = mergeTimeline(comments ?? [], activity, { ...prefs, showActivity });
  const repliesOf = (parentId: string) => (comments ?? []).filter((comment) => comment.parentId === parentId);
  const newest = prefs.order === "desc";
  const target = useMemo<MentionTarget>(() => ({ kind, id }), [kind, id]);
  const composer = canComment && <CommentBox target={target} label="Add a comment" submitLabel="Comment" files onSubmit={(body, files) => add(body, undefined, files)} />;

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
          : <CommentItem key={item.id} comment={item.comment} replies={repliesOf(item.id)} canComment={canComment} onReply={(body, files) => add(body, item.id, files)} handlers={handlers} target={target} />)}
        {items.length === 0 && <li className="ui-timeline-empty">{canComment ? "No comments yet. Start the conversation below." : "No comments yet."}</li>}
      </ol>}
    {showActivity && cursor && <button type="button" className="ui-text-button" onClick={() => { void olderActivity().catch(() => undefined); }}>Load earlier activity</button>}
    {!newest && composer}
    {preview && <AttachmentPreview documentId={preview.documentId} name={preview.name} onClose={() => setPreview(null)} />}
  </section>;
}
