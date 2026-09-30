import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Avatar } from "../ui/Avatar";
import { IntegrationBadge } from "../ui/IntegrationBadge";
import { initials } from "./CardFace";
import { ArrowRightLeft, Copy, Download, File as FileIcon, Maximize2, MessageSquare, Minimize2, Paperclip, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { imageAltText, imageContentUrl, IMAGE_REJECTED_MESSAGE, isInsertableImageType } from "../editor/imageUpload";
import { contentUrl, formatBytes } from "../files/filesApi";
import { ApiError } from "../api";
import { CardTitleField } from "./CardTitleField";
import { NoteEditor } from "../editor/NoteEditor";
import { ConfirmDialog, trapTabKey } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { attachmentsFor, binConfirmMessage, canRetryTitle, canUnlink, columnEyebrow, descriptionDirty, commentBodyError, isInlineImage, unlinkConfirmMessage, validateCardTitle } from "./taskActions";
import { CardFields } from "./CardFields";
import { CardBreadcrumb, CardParentFields, SubtasksSection } from "./CardHierarchySection";
import { CardSprintField } from "./SprintField";
import { childrenOf, levelEyebrow, levelOf } from "./hierarchyModel";
import type { CardHierarchyContext } from "./useBoardHierarchy";
import type { TagChange } from "./cardTags";
import { RelationsSection, type RelatedCardTarget } from "./RelationsSection";
import { openBlockerCount, relationRow } from "./relationsModel";
import {
  createCommentWithFiles,
  deleteComment,
  linkAttachment,
  unlinkAttachment,
  uploadAttachment,
  type CardAttachment,
  type UploadedAttachment,
  getCard,
  listComments,
  taskErrorCode,
  taskErrorMessage,
  updateCard,
  updateComment,
  type BoardColumn,
  type BoardTag,
  type CardChange,
  type CardComment,
  type CardDetail,
  type CardRelation,
  type CardView,
  type SprintSummary
} from "./tasksApi";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";
import { CopyCardLinkButton } from "./cardLink";
import { CommentReactions } from "./CommentReactions";
import type { TaskNotify } from "./taskActions";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { levelAtLeast, type ItemLevel } from "../access/accessLevels";

type CardDialogProps = {
  userId: string;
  cardId: string;
  columns: BoardColumn[];
  /** The card's column as the board knows it (moves happen on the board). */
  columnId?: string;
  /** The caller owns the board (may delete anyone's comment). */
  boardOwner: boolean;
  onClose: () => void;
  onMissing: () => void;
  onChanged: (card: CardDetail) => void;
  onMove: (card: CardDetail) => void;
  /** Moves the card to the Bin (the dialog confirms first) and closes it. */
  onDelete: (cardId: string) => Promise<void>;
  notify: TaskNotify;
  /** The board's tags for the Tags field, and how the board hears of a tag change (13C). */
  tags?: BoardTag[];
  onTagsChange?: (change: TagChange) => void;
  /** Opens a related card (pushes its route). */
  onOpenRelated?: (card: RelatedCardTarget) => void;
  /** The relations changed: the board's counts for this card follow (13D). */
  onRelationsChanged?: (cardId: string, counts: { relation_count: number; open_blockers: number }) => void;
  /**
   * "dialog" (over the board) or "page" (/card/:k/full, §4.3): no scrim, not modal, no focus trap,
   * and two columns above 1024 px. The page sets the document title to the card's.
   */
  layout?: "dialog" | "page";
  /** Dialog only: opens the card as a page (pushes /full). Hidden at ≤760 px, where the dialog is full screen (§11 Q6). */
  onExpand?: () => void;
  /** Page only: back to the dialog. */
  onCollapse?: () => void;
  /** Hierarchy (17A, §7.2): the breadcrumb, Parent and Level, and the Subtasks checklist. */
  hierarchy?: CardHierarchyContext;
  /** The caller's level on the board (Wave 32): below edit the card is read-only; commenters still comment. */
  boardLevel?: ItemLevel;
  /** The board's sprints (17B), for the Sprint field; only on boards with sprints on. */
  sprints?: SprintSummary[];
  /**
   * The card's data when the caller already has it (render tests); the dialog still loads the
   * current version on open.
   */
  initialView?: CardView;
};

/** Live children and grandchildren on the board: they go to the Bin with the card (D129). */
function descendantTotal(context: CardHierarchyContext, cardId: string) {
  const children = childrenOf(context.cards, context.columns, cardId);
  return children.length + children.reduce((sum, child) => sum + childrenOf(context.cards, context.columns, child.id).length, 0);
}

const payloadCard = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { card?: CardDetail }).card ?? null
  : null;

/**
 * The card at /tasks/:boardId/card/:cardId. It is a view with its own history entry, so Back
 * closes it; the dialogs inside it (delete a comment) push nothing and Back only closes them.
 * The description is Markdown shown through the notes renderer read-only (D44) and edited with
 * an explicit Save; a revision conflict offers Reload or Copy my text.
 */
export function CardDialog({ userId, cardId, columns, columnId, boardOwner, boardLevel, onClose, onMissing, onChanged, onMove, onDelete, notify, tags, onTagsChange, onOpenRelated, onRelationsChanged, layout = "dialog", onExpand, onCollapse, hierarchy, sprints, initialView }: CardDialogProps) {
  const page = layout === "page";
  // Viewers and guests read the card: every write control is left out or shown as text, since the
  // server's write gate refuses those writes (403 ROLE_READ_ONLY), comments included. Members below
  // `edit` on this board read the card too, and commenters still comment and react (D272).
  const { readOnly: roleReadOnly } = useRole();
  const readOnly = roleReadOnly || !levelAtLeast(boardLevel, "edit");
  const commentReadOnly = roleReadOnly || !levelAtLeast(boardLevel, "comment");
  const [card, setCard] = useState<CardDetail | null>(initialView?.card ?? null);
  const [comments, setComments] = useState<CardComment[]>(initialView?.comments ?? []);
  const [hasMore, setHasMore] = useState(initialView?.hasMoreComments ?? false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState(initialView?.card.title ?? "");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<CardDetail | null>(null);
  const [composer, setComposer] = useState("");
  const [posting, setPosting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null);
  const [deletingComment, setDeletingComment] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [attachments, setAttachments] = useState<CardAttachment[]>(initialView?.attachments ?? []);
  const [relations, setRelations] = useState<CardRelation[]>(initialView?.relations ?? []);
  const [attaching, setAttaching] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<UploadedAttachment[]>([]);
  const [unlinking, setUnlinking] = useState<CardAttachment | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsConflict, setDetailsConflict] = useState<string | null>(null);
  const cardFileRef = useRef<HTMLInputElement>(null);
  const commentFileRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<CardDetail | null>(null);
  cardRef.current = card;
  const titleId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const view = await getCard(cardId);
      setCard(view.card);
      setTitle(view.card.title);
      setComments(view.comments);
      setHasMore(view.hasMoreComments);
      setAttachments(view.attachments);
      setRelations(view.relations ?? []);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) onMissing();
      else setLoadError(taskErrorMessage(reason, "Could not load this card"));
    }
  }, [cardId, onMissing]);
  useEffect(() => { void load(); }, [load]);

  const closeSubDialog = useCallback(() => { setDeletingComment(null); setUnlinking(null); setConfirmDelete(false); setDiscardPrompt(false); }, []);
  const subDialogOpen = deletingComment !== null || unlinking !== null || confirmDelete || discardPrompt;
  useHistoryDialogGuard(subDialogOpen, closeSubDialog);

  // An unsaved description: Back, Escape, and Close ask "Discard changes?" first. Back is caught
  // with the dialog guard (the browser's step is undone), so the card stays open behind the prompt.
  const dirty = descriptionDirty(editing, draft, card?.description ?? "");
  const askToDiscard = useCallback(() => setDiscardPrompt(true), []);
  useHistoryDialogGuard(dirty && !subDialogOpen, askToDiscard);
  const requestClose = useCallback(() => {
    if (dirty) setDiscardPrompt(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The page is not a dialog: Escape does not leave it.
      if (page || event.key !== "Escape" || event.defaultPrevented || subDialogOpen || editingComment) return;
      // A dialog opened over the card (Move to…) handles its own Escape.
      if (window.document.querySelector(".file-dialog, .side-panel")) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, subDialogOpen, editingComment, requestClose]);

  // The page names the card in the tab; the app's own title comes back when it closes.
  const pageTitle = page ? card?.title ?? null : null;
  useEffect(() => {
    if (pageTitle === null) return undefined;
    const previous = document.title;
    document.title = `${pageTitle || "Card"} · Tasks · Nook`;
    return () => { document.title = previous; };
  }, [pageTitle]);

  function applyCard(next: CardDetail) {
    setCard(next);
    onChanged(next);
  }

  // The title saves on blur. On CARD_CHANGED, retry at the new revision only when the title on the
  // server is still the one this edit started from (someone changed the description); if someone
  // renamed the card, show their title and say so instead of overwriting it.
  async function saveTitle() {
    const current = cardRef.current;
    if (!current) return;
    const check = validateCardTitle(title, current.title);
    if (!check.ok) {
      setTitleError(check.error);
      return;
    }
    setTitleError(null);
    if (!check.changed) {
      setTitle(current.title);
      return;
    }
    try {
      applyCard((await updateCard(current.id, { title: check.name, revision: current.revision })).card);
    } catch (reason) {
      const latest = taskErrorCode(reason) === "CARD_CHANGED" ? payloadCard(reason) : null;
      if (latest && !canRetryTitle(current.title, latest.title)) {
        applyCard(latest);
        setTitle(latest.title);
        setTitleError(`Someone else renamed this card to “${latest.title}”. Your title “${check.name}” was not saved.`);
        return;
      }
      if (latest) {
        try {
          applyCard((await updateCard(current.id, { title: check.name, revision: latest.revision })).card);
          return;
        } catch (retry) {
          reason = retry;
        }
      }
      setTitle(current.title);
      notify(taskErrorMessage(reason, "Could not rename the card"));
    }
  }

  // The fields (due date and time, assignees) save when committed. On CARD_CHANGED the card
  // reloads to the current version and says so, as the title does, instead of overwriting someone
  // else's change.
  async function saveDetails(change: Omit<CardChange, "title" | "description">, success: string) {
    const current = cardRef.current;
    if (!current) return false;
    setSavingDetails(true);
    setDetailsConflict(null);
    try {
      applyCard((await updateCard(current.id, { ...change, revision: current.revision })).card);
      notify(success);
      return true;
    } catch (reason) {
      const latest = taskErrorCode(reason) === "CARD_CHANGED" ? payloadCard(reason) : null;
      if (latest) {
        applyCard(latest);
        setTitle(latest.title);
        setDetailsConflict("Someone else changed this card, so your change was not saved. The card now shows their version; make your change again if it is still needed.");
        return false;
      }
      notify(taskErrorCode(reason) === "ASSIGNEE_NOT_MEMBER"
        ? "That person can no longer open this board"
        : taskErrorMessage(reason, "Could not save the change"));
      return false;
    } finally {
      setSavingDetails(false);
    }
  }

  function startEditing() {
    if (!card) return;
    setDraft(card.description);
    setConflict(null);
    setEditing(true);
  }

  async function saveDescription() {
    const current = cardRef.current;
    if (!current) return;
    setSaving(true);
    try {
      applyCard((await updateCard(current.id, { description: draft, revision: current.revision })).card);
      setEditing(false);
      setConflict(null);
      notify("Description saved");
    } catch (reason) {
      const latest = taskErrorCode(reason) === "CARD_CHANGED" ? payloadCard(reason) : null;
      if (latest) setConflict(latest);
      else notify(taskErrorMessage(reason, "Could not save the description"));
    } finally {
      setSaving(false);
    }
  }

  function reloadFromConflict() {
    if (!conflict) return;
    applyCard(conflict);
    setTitle(conflict.title);
    setDraft(conflict.description);
    setConflict(null);
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      notify("Your text is on the clipboard");
    } catch {
      notify("Could not copy. Select the text and copy it yourself.");
    }
  }

  async function loadEarlier() {
    const first = comments[0];
    if (!first) return;
    setLoadingMore(true);
    try {
      const page = await listComments(cardId, first.id);
      setComments((current) => [...page.comments, ...current]);
      setHasMore(page.hasMore);
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not load earlier comments"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function post() {
    const error = commentBodyError(composer);
    if (error) {
      notify(error);
      return;
    }
    setPosting(true);
    try {
      const files = pendingFiles;
      const { comment } = await createCommentWithFiles(cardId, composer, files.map((file) => file.id));
      setComments((current) => [...current, comment]);
      setComposer("");
      setPendingFiles([]);
      if (files.length) {
        const timestamp = comment.created_at;
        setAttachments((current) => [...current, ...files.map((file): CardAttachment => ({ document_id: file.id, card_id: cardId, comment_id: comment.id, linked_by: userId, linker_name: comment.author_name, name: file.name, mime_type: file.mime_type, preview_kind: file.preview_kind, size_bytes: file.size_bytes, created_at: timestamp }))]);
      }
      if (card) {
        const next = { ...card, comment_count: card.comment_count + 1, attachment_count: card.attachment_count + files.length };
        setCard(next);
        onChanged(next);
      }
    } catch (reason) {
      notify(taskErrorCode(reason) === "LIMIT_REACHED" ? taskErrorMessage(reason, "This card is full") : taskErrorMessage(reason, "Could not post the comment"));
    } finally {
      setPosting(false);
    }
  }

  async function saveComment() {
    if (!editingComment) return;
    const error = commentBodyError(editingComment.body);
    if (error) {
      notify(error);
      return;
    }
    try {
      const { comment } = await updateComment(editingComment.id, editingComment.body);
      setComments((current) => current.map((item) => item.id === comment.id ? comment : item));
      setEditingComment(null);
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not edit the comment"));
    }
  }

  // Reactions change only their comment's list (Wave 20): no card revision, no onChanged.
  const updateReactions = useCallback((commentId: string, update: (current: NonNullable<CardComment["reactions"]>) => NonNullable<CardComment["reactions"]>) => {
    setComments((current) => current.map((item) => item.id === commentId ? { ...item, reactions: update(item.reactions ?? []) } : item));
  }, []);

  async function removeComment(commentId: string) {
    setDeleteBusy(true);
    try {
      await deleteComment(commentId);
      const removed = attachments.filter((item) => item.comment_id === commentId).length;
      setComments((current) => current.filter((item) => item.id !== commentId));
      setAttachments((current) => current.filter((item) => item.comment_id !== commentId));
      if (card) {
        const next = { ...card, comment_count: Math.max(0, card.comment_count - 1), attachment_count: Math.max(0, card.attachment_count - removed) };
        setCard(next);
        onChanged(next);
      }
      setDeletingComment(null);
      notify("Comment deleted");
    } catch (reason) {
      setDeletingComment(null);
      notify(taskErrorMessage(reason, "Could not delete the comment"));
    } finally {
      setDeleteBusy(false);
    }
  }

  function countChanged(delta: number) {
    const current = cardRef.current;
    if (!current) return;
    const next = { ...current, attachment_count: Math.max(0, current.attachment_count + delta) };
    setCard(next);
    onChanged(next);
  }

  /** Uploads a file as a task attachment and links it to the card. */
  async function attachFile(file: File) {
    const uploaded = await uploadAttachment(file);
    const { attachment } = await linkAttachment(cardId, uploaded.id);
    setAttachments((current) => current.some((item) => item.document_id === attachment.document_id) ? current : [...current, attachment]);
    countChanged(1);
    return { uploaded, attachment };
  }

  async function attachFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setAttaching(true);
    try {
      for (const file of files) {
        try {
          await attachFile(file);
        } catch (reason) {
          notify(`${file.name}: ${taskErrorCode(reason) === "LIMIT_REACHED" ? "this card has reached its attachment limit" : taskErrorMessage(reason, "could not attach")}`);
        }
      }
    } finally {
      setAttaching(false);
    }
  }

  // Images pasted, dropped, or picked into the description become attachments of this card and
  // are shown inline through the same content URL (never a data: or external URL).
  async function uploadDescriptionImage(file: File) {
    if (!isInsertableImageType(file.type)) throw new Error(IMAGE_REJECTED_MESSAGE);
    const { uploaded } = await attachFile(file);
    if (uploaded.preview_kind !== "image" || !isInsertableImageType(uploaded.mime_type.split(";")[0]!.trim())) {
      throw new Error("Attached as a file: only PNG, JPEG, GIF, and WebP images show inline");
    }
    return { src: imageContentUrl(uploaded.id), alt: imageAltText(uploaded.name || file.name) };
  }

  async function pickCommentFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setAttaching(true);
    try {
      for (const file of files) {
        try {
          const uploaded = await uploadAttachment(file);
          setPendingFiles((current) => [...current, uploaded]);
        } catch (reason) {
          notify(`${file.name}: ${taskErrorMessage(reason, "could not upload")}`);
        }
      }
    } finally {
      setAttaching(false);
    }
  }

  async function unlink(attachment: CardAttachment) {
    setDeleteBusy(true);
    try {
      const result = await unlinkAttachment(cardId, attachment.document_id);
      setAttachments((current) => current.filter((item) => item.document_id !== attachment.document_id));
      countChanged(-1);
      notify(result.movedToBin ? `Removed “${attachment.name}”; it is in ${attachment.linked_by === userId ? "your" : "its uploader's"} Bin` : `Removed “${attachment.name}” from this card`);
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not remove the attachment"));
    } finally {
      setDeleteBusy(false);
      setUnlinking(null);
    }
  }

  const attachmentList = (items: CardAttachment[]) => items.length > 0 && <ul className="task-attachments">
    {items.map((item) => <li key={item.document_id} className="task-attachment">
      {isInlineImage(item)
        ? <a className="task-attachment-thumb" href={contentUrl(item.document_id, "inline")} target="_blank" rel="noopener noreferrer"><img src={contentUrl(item.document_id, "inline")} alt="" loading="lazy" /></a>
        : <span className="task-attachment-icon" aria-hidden="true"><FileIcon /></span>}
      <span className="task-attachment-copy"><span title={item.name}>{item.name}</span><small>{formatBytes(item.size_bytes)}{item.linker_name ? ` · ${item.linker_name}` : ""}</small></span>
      <a className="icon-button" href={contentUrl(item.document_id, "attachment")} download aria-label={`Download ${item.name}`} title="Download"><Download /></a>
      {!readOnly && canUnlink(item, userId, boardOwner) && <button className="icon-button" onClick={() => setUnlinking(item)} aria-haspopup="dialog" aria-label={`Remove ${item.name}`} title="Remove"><Trash2 /></button>}
    </li>)}
  </ul>;

  const column = card ? columns.find((item) => item.id === (columnId ?? card.column_id)) : undefined;
  const composerKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => void) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return <>
    {!page && <button className="panel-scrim task-card-scrim" onClick={requestClose} aria-label="Close card" tabIndex={-1} />}
    <section className={page ? "task-card-dialog task-card-page" : "task-card-dialog task-card-modal"} role={page ? undefined : "dialog"} aria-modal={page ? undefined : true} aria-labelledby={titleId} onKeyDown={page ? undefined : trapTabKey}>
      <header className="task-card-dialog-header">
        <div className="task-card-dialog-heading">
          <span className="eyebrow">{[card && hierarchy ? levelEyebrow(hierarchy.structure, levelOf(card)) : null, column ? columnEyebrow(column.name) : "Card"].filter(Boolean).join(" · ")}</span>
          {card && hierarchy && <CardBreadcrumb card={card} context={hierarchy} />}
          {card && readOnly
            ? <h2 id={titleId} className="task-card-title-static">{card.title}</h2>
            : card
            ? <CardTitleField
              id={titleId}
              className="task-card-title-input task-card-title-field"
              value={title}
              onValueChange={(value) => { setTitle(value); setTitleError(null); }}
              onBlur={() => { void saveTitle(); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.preventDefault(); setTitle(card.title); setTitleError(null); }
              }}
              aria-label="Card title"
              aria-invalid={titleError ? true : undefined}
              maxLength={200}
            />
            : <h2 id={titleId}>Loading…</h2>}
          {titleError && <p className="file-dialog-error" role="alert">{titleError}</p>}
        </div>
        {card && <CopyCardLinkButton boardId={card.board_id} cardId={card.id} notify={notify} />}
        {card && !readOnly && <button className="icon-button" onClick={() => onMove(card)} aria-haspopup="dialog" aria-label="Move card" title="Move to…"><ArrowRightLeft /></button>}
        {card && !readOnly && <button className="icon-button" onClick={() => setConfirmDelete(true)} aria-haspopup="dialog" aria-label="Delete card" title="Move to the Bin"><Trash2 /></button>}
        {!page && onExpand && <button className="icon-button task-card-expand" onClick={onExpand} aria-label="Open as page" title="Open as page"><Maximize2 /></button>}
        {page && onCollapse && <button className="icon-button" onClick={onCollapse} aria-label="Collapse to a dialog" title="Collapse"><Minimize2 /></button>}
        {!page && <button className="icon-button" onClick={requestClose} aria-label="Close card" title="Close"><X /></button>}
      </header>
      <ReadOnlyBanner />

      <div className="task-card-dialog-body">
        {loadError && <div className="bin-state bin-error" role="alert">
          <h2>Could not load this card</h2><p>{loadError}</p>
          <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
        </div>}
        {!loadError && !card && <p className="bin-loading" role="status">Loading the card…</p>}
        {card && <>
          <div className="task-card-side">
          <p className="task-card-byline">{card.creator_name ? <>Added by {card.creator_name}{card.creator_is_integration === 1 && <IntegrationBadge />}</> : "Added"} · <time dateTime={card.created_at}>{relativeTime(card.created_at)}</time>{card.updated_at !== card.created_at && <> · Updated <time dateTime={card.updated_at}>{relativeTime(card.updated_at)}</time></>}</p>

          <CardFields card={card} userId={userId} idPrefix={titleId} done={column?.is_done === 1} saving={savingDetails} onSave={saveDetails} tags={tags} owner={boardOwner} onTagsChange={onTagsChange} readOnly={readOnly} />
          {hierarchy && <div className="task-card-details"><CardParentFields card={card} context={hierarchy} idPrefix={titleId} saving={savingDetails} onSave={saveDetails} readOnly={readOnly} />
            {sprints && <CardSprintField card={card} structure={hierarchy.structure} cards={hierarchy.cards} sprints={sprints} idPrefix={titleId} saving={savingDetails} onSave={saveDetails} readOnly={readOnly} />}</div>}
          {detailsConflict && <p className="file-dialog-error" role="alert">{detailsConflict}</p>}

          <RelationsSection cardId={card.id} boardId={card.board_id} idPrefix={titleId} relations={relations} notify={notify} readOnly={readOnly}
            onOpen={(target) => onOpenRelated?.(target)}
            onChange={(next) => {
              setRelations(next);
              onRelationsChanged?.(card.id, { relation_count: next.length, open_blockers: openBlockerCount(next.map(relationRow)) });
            }} />
          </div>

          <div className="task-card-main">
          {hierarchy && <SubtasksSection card={card} context={hierarchy} idPrefix={titleId} readOnly={readOnly} />}
          <section className="task-card-section" aria-labelledby={`${titleId}-description`}>
            <header><h3 id={`${titleId}-description`}>Description</h3>{!editing && !readOnly && <button className="secondary-button task-small-button" onClick={startEditing}><Pencil />Edit</button>}</header>
            {editing && !readOnly
              ? <div className="task-description-editor">
                <NoteEditor
                  markdown={draft}
                  editable={!saving}
                  autoFocus
                  onChange={setDraft}
                  onNotice={notify}
                  label="Card description"
                  placeholder="Describe the work… Type / for commands"
                  uploadImage={uploadDescriptionImage}
                />
                {conflict && <div className="task-conflict" role="alert">
                  <p>Someone else changed this card while you were editing. Reload shows their version and replaces your text.</p>
                  <span>
                    <button className="secondary-button task-small-button" onClick={reloadFromConflict}><RotateCcw />Reload</button>
                    <button className="secondary-button task-small-button" onClick={() => { void copyDraft(); }}><Copy />Copy my text</button>
                  </span>
                </div>}
                <footer className="task-description-actions">
                  <button className="secondary-button" onClick={() => { setEditing(false); setConflict(null); }} disabled={saving}>Cancel</button>
                  <button className="primary-button" onClick={() => { void saveDescription(); }} disabled={saving || conflict !== null}>{saving ? "Saving…" : "Save"}</button>
                </footer>
              </div>
              : card.description.trim()
                ? <div className="task-description-view"><NoteEditor key={`${card.id}:${card.revision}`} markdown={card.description} editable={false} onChange={() => undefined} label="Card description" /></div>
                : readOnly
                  ? <p className="task-comment-empty">No description.</p>
                  : <button className="task-description-empty" onClick={startEditing}>Add a description…</button>}
          </section>

          <section className="task-card-section" aria-labelledby={`${titleId}-files`}>
            <header>
              <h3 id={`${titleId}-files`}><Paperclip aria-hidden="true" />Attachments</h3>
              {!readOnly && <>
                <button className="secondary-button task-small-button" onClick={() => cardFileRef.current?.click()} disabled={attaching}><Paperclip />{attaching ? "Uploading…" : "Attach"}</button>
                <input ref={cardFileRef} type="file" multiple hidden onChange={(event) => { void attachFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
              </>}
            </header>
            {attachmentList(attachmentsFor(attachments, null)) || <p className="task-comment-empty">{readOnly ? "No files." : "No files yet. Pasted images in the description are attached here too."}</p>}
          </section>

          <section className="task-card-section" aria-labelledby={`${titleId}-comments`}>
            <header><h3 id={`${titleId}-comments`}><MessageSquare aria-hidden="true" />Comments</h3></header>
            {hasMore && <button className="task-load-earlier" onClick={() => { void loadEarlier(); }} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load earlier comments"}</button>}
            <ol className="task-comments">
              {comments.map((comment) => <li key={comment.id} className="task-comment">
                <header>
                  <Avatar className="task-avatar task-comment-avatar" name={comment.author_name ?? "?"} url={comment.author_avatar_url} fallback={initials(comment.author_name ?? "?")} integration={comment.author_is_integration === 1} />
                  <strong>{comment.author_name ?? "Former member"}{comment.author_is_integration === 1 && <IntegrationBadge />}</strong>
                  <time dateTime={comment.created_at}>{relativeTime(comment.created_at)}</time>
                  {comment.edited_at && <span className="task-comment-edited">edited</span>}
                  <span className="task-comment-actions">
                    {!commentReadOnly && comment.is_author === 1 && editingComment?.id !== comment.id && <button className="icon-button" onClick={() => setEditingComment({ id: comment.id, body: comment.body })} aria-label="Edit comment" title="Edit"><Pencil /></button>}
                    {!commentReadOnly && (comment.is_author === 1 || boardOwner) && <button className="icon-button" onClick={() => setDeletingComment(comment.id)} aria-haspopup="dialog" aria-label="Delete comment" title="Delete"><Trash2 /></button>}
                  </span>
                </header>
                {!commentReadOnly && editingComment?.id === comment.id
                  ? <div className="task-comment-edit">
                    <textarea value={editingComment.body} onChange={(event) => setEditingComment({ id: comment.id, body: event.target.value })} onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); setEditingComment(null); }
                      composerKey(event, () => { void saveComment(); });
                    }} aria-label="Edit comment" autoFocus rows={3} />
                    <span><button className="secondary-button task-small-button" onClick={() => setEditingComment(null)}>Cancel</button><button className="primary-button task-small-button" onClick={() => { void saveComment(); }}>Save</button></span>
                  </div>
                  : <p className="task-comment-body">{comment.body}</p>}
                {attachmentList(attachmentsFor(attachments, comment.id))}
                <CommentReactions commentId={comment.id} reactions={comment.reactions ?? []} readOnly={commentReadOnly} onUpdate={updateReactions} notify={notify} />
              </li>)}
              {!comments.length && <li className="task-comment-empty">No comments yet.</li>}
            </ol>
            {commentReadOnly
              ? <p className="task-comment-empty" role="note">{roleReadOnly ? "View only: your Team role can read comments but not post them." : "View only: you can read this board's comments but not post them."}</p>
              : <div className="task-comment-composer">
              <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => composerKey(event, () => { void post(); })} placeholder="Write a comment" aria-label="Write a comment" rows={2} disabled={posting} />
              {pendingFiles.length > 0 && <ul className="task-pending-files" aria-label="Files to attach">
                {pendingFiles.map((file) => <li key={file.id}><Paperclip aria-hidden="true" /><span title={file.name}>{file.name}</span><button className="icon-button" onClick={() => setPendingFiles((current) => current.filter((item) => item.id !== file.id))} aria-label={`Don't attach ${file.name}`}><X /></button></li>)}
              </ul>}
              <span className="task-composer-actions">
                <button className="secondary-button task-small-button" onClick={() => commentFileRef.current?.click()} disabled={attaching || posting || pendingFiles.length >= 10}><Paperclip />{attaching ? "Uploading…" : "Attach"}</button>
                <input ref={commentFileRef} type="file" multiple hidden onChange={(event) => { void pickCommentFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
                <button className="primary-button" onClick={() => { void post(); }} disabled={posting || attaching || !composer.trim()}>{posting ? "Posting…" : "Comment"}</button>
              </span>
            </div>}
          </section>
          </div>
        </>}
      </div>
    </section>
    {discardPrompt && <ConfirmDialog title="Discard changes?" message="Your changes to the description have not been saved." confirmLabel="Discard" danger onConfirm={() => {
      setDiscardPrompt(false);
      setEditing(false);
      setConflict(null);
      onClose();
    }} onCancel={() => setDiscardPrompt(false)} />}
    {confirmDelete && card && <ConfirmDialog title="Move to the Bin?" message={binConfirmMessage("card", card.title, hierarchy ? descendantTotal(hierarchy, card.id) : 0)} confirmLabel="Move to Bin" danger busy={deleteBusy} onConfirm={() => {
      // Close the confirm first: closing the card then steps back in history, and an open
      // dialog's guard would otherwise swallow that step.
      setConfirmDelete(false);
      setEditing(false);
      onDelete(card.id).catch((reason) => notify(taskErrorMessage(reason, "Could not delete the card")));
    }} onCancel={closeSubDialog} />}
    {unlinking && <ConfirmDialog title="Remove this attachment?" message={unlinkConfirmMessage(unlinking.name, unlinking.linked_by === userId)} confirmLabel="Remove" danger busy={deleteBusy} onConfirm={() => { void unlink(unlinking); }} onCancel={closeSubDialog} />}
    {deletingComment && <ConfirmDialog title="Delete this comment?" message="The comment is deleted for everyone. This cannot be undone." confirmLabel="Delete comment" danger busy={deleteBusy} onConfirm={() => { void removeComment(deletingComment); }} onCancel={closeSubDialog} />}
  </>;
}
