import type { Notifier } from "../ui/notify";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Columns3, Layers, Link2, Paperclip, Plus, X } from "lucide-react";
import { aLevel, FLAT_STRUCTURE, levelName, parentRequired, type BoardStructure } from "../../shared/boardStructure";
import { hasLevels, levelOf, parentCandidates } from "./hierarchyModel";
import { ApiError } from "../api";
import { imageAltText, imageContentUrl, IMAGE_REJECTED_MESSAGE, isInsertableImageType } from "../editor/imageUpload";
import { NoteEditor } from "../editor/NoteEditor";
import { ConfirmDialog, trapTabKey } from "../files/Dialog";
import { deleteFile } from "../files/filesApi";
import { AttachmentList, AttachSheet, pastedFiles, useFileDrop } from "../ui/attachments";
import type { DocumentSummary } from "../types";
import { attachZoneOf, UploadRows, useCardUploads } from "./cardUploads";
import { Select } from "../ui/Select";
import { CardFields } from "./CardFields";
import { SprintSelect } from "./SprintField";
import type { TagChange } from "./cardTags";
import {
  applyFieldChange,
  composerDirty,
  composerError,
  composerParentError,
  createBody,
  defaultColumnId,
  draftCard,
  emptyDraft,
  MAX_COMPOSER_ATTACHMENTS,
  MAX_COMPOSER_RELATIONS,
  type ComposerDraft,
  type ComposerError,
  type FieldContext
} from "./composerDraft";
import { RelationAdder, RelationList } from "./RelationsSection";
import { attachCapReason, canEnterColumn, fitToCap, validateCardTitle } from "./taskActions";
import { createCard, taskErrorCode, taskErrorMessage, uploadAttachment, type UploadedAttachment, type BoardColumn, type BoardTag, type CardDetail, type CardSearchResult, type RelationType, type SprintSummary } from "./tasksApi";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";

export type ComposerMode = "close" | "open" | "another";

type CardComposerProps = {
  boardId: string;
  boardName: string;
  userId: string;
  columns: BoardColumn[];
  /** The board's cards, to tell which columns are full (D108). */
  cards: readonly { id: string; column_id: string }[];
  /** The column it was opened from ("+ Add card"); null from "New card". */
  initialColumnId: string | null;
  onClose: () => void;
  /** The card was created; for "another" the composer stays open and starts over. */
  onCreated: (card: CardDetail, mode: ComposerMode, options: { hadRelations: boolean }) => void;
  notify: Notifier;
  /** The board's tags for the Tags field (13C), whether the caller manages them, and how the board hears of a change. */
  tags?: BoardTag[];
  owner?: boolean;
  onTagsChange?: (change: TagChange) => void;
  /** Hierarchy (17A): the board's levels, the cards that can be parents, and a parent to start with ("Add subtask"). */
  structure?: BoardStructure;
  parentCards?: ReadonlyArray<{ id: string; title: string; column_id: string; position: number; level?: number; parent_card_id?: string | null }>;
  initialParentId?: string | null;
  /** Sprints (17B): the board's sprints for the Sprint field, and the one the board shows (new cards start in it). */
  sprints?: SprintSummary[];
  initialSprintId?: string | null;
};

/**
 * Creates a card with every detail in one call (WAVE_13_TASK_CARD_UX.md §4.3): title, column,
 * `CardFields`, description, staged relations, and attachments uploaded as you add them. It is a
 * guarded dialog, not a route (D69): full screen on phones, a large modal on desktop. Back, Escape,
 * and Close ask first when anything was entered, and discarding moves the uploads to the Bin.
 */
export function CardComposer({ boardId, boardName, userId, columns, cards, initialColumnId, onClose, onCreated, notify, tags, owner = false, onTagsChange, structure = FLAT_STRUCTURE, parentCards = [], initialParentId = null, sprints, initialSprintId = null }: CardComposerProps) {
  const initialParent = initialParentId ? parentCards.find((card) => card.id === initialParentId) : undefined;
  const [draft, setDraft] = useState<ComposerDraft>(() => emptyDraft(defaultColumnId(columns, cards, initialColumnId),
    initialParent ? { parentId: initialParent.id, level: levelOf(initialParent) + 1 } : { sprintId: initialSprintId }));
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<ComposerError | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [addingRelation, setAddingRelation] = useState(false);
  // Remounts the description editor when the form starts over ("Create another").
  const [round, setRound] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const titleRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // The attach sheet (uploads everywhere U2, D398): Take photo, Choose files, From Files.
  const [attachOpen, setAttachOpen] = useState(false);
  const uploads = useCardUploads(notify);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const column = columns.find((item) => item.id === draft.columnId);

  const update = (change: (current: ComposerDraft) => ComposerDraft) => setDraft((current) => {
    const next = change(current);
    draftRef.current = next;
    return next;
  });

  const requestClose = useCallback(() => {
    if (composerDirty(draftRef.current)) setConfirmDiscard(true);
    else onClose();
  }, [onClose]);
  // Back closes the composer (or asks first); Back with the prompt open only closes the prompt.
  useHistoryDialogGuard(!confirmDiscard, requestClose);
  const keepEditing = useCallback(() => setConfirmDiscard(false), []);
  useHistoryDialogGuard(confirmDiscard, keepEditing);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || confirmDiscard) return;
      if (window.document.querySelector(".file-dialog")) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDiscard, requestClose]);

  /**
   * Moves uploads that will not be attached to the Bin (T100); the hourly sweeper catches any left
   * over. Files picked From Files are the person's own Files items and are never discarded.
   */
  const discardUploads = (files: readonly UploadedAttachment[]) => {
    for (const file of files) if (!file.fromFiles) deleteFile(file.id).catch(() => undefined);
  };

  async function submit(mode: ComposerMode) {
    if (creating || uploading > 0 || uploads.busy) return;
    const current = draftRef.current;
    const check = validateCardTitle(current.title);
    if (!check.ok) {
      setTitleError(check.error);
      titleRef.current?.focus();
      return;
    }
    // A subtask needs its parent first (operator QA 0.9.1).
    const parentError = composerParentError(structure, current);
    if (parentError) {
      setError(parentError);
      document.getElementById(`${baseId}-parent`)?.focus();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // Only a work-level card is planned in a sprint (17B); a subtask follows its parent.
      const planned = structure.sprints && (current.level ?? structure.workLevel) === structure.workLevel ? current.sprintId : null;
      // Always sent: null is the backlog (the server puts an omitted sprint on the active one, Friction 3).
      const { card } = await createCard(boardId, { ...createBody({ ...current, sprintId: planned }, check.name), sprintId: planned });
      onCreated(card, mode, { hadRelations: current.relations.length > 0 });
      if (mode === "another") {
        notify.success(`Added “${card.title}”. Add another.`);
        // "Create another" keeps the column, the level, and the parent (a run of subtasks).
        update(() => emptyDraft(current.columnId, { parentId: current.parentId, level: current.level, sprintId: current.sprintId }));
        setTitleError(null);
        setAddingRelation(false);
        setRound((value) => value + 1);
        titleRef.current?.focus();
      }
    } catch (reason) {
      const payload = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? reason.payload as { wipLimit?: unknown } : {};
      setError(composerError({
        status: reason instanceof ApiError ? reason.status : undefined,
        code: taskErrorCode(reason),
        wipLimit: payload.wipLimit,
        message: taskErrorMessage(reason, "Could not create the card")
      }, column, current.relations.length > 0));
    } finally {
      setCreating(false);
    }
  }

  // Ctrl/⌘+Enter creates from anywhere in the form; with Shift it creates and starts another. It is
  // caught on the way down, before a focused dropdown or the editor treats Enter as its own.
  function onKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void submit(event.shiftKey ? "another" : "close");
  }

  async function upload(file: File) {
    if (draftRef.current.attachments.length >= MAX_COMPOSER_ATTACHMENTS) throw new Error(`A card can have at most ${MAX_COMPOSER_ATTACHMENTS} attachments`);
    setUploading((count) => count + 1);
    try {
      const uploaded = await uploadAttachment(file);
      update((current) => ({ ...current, attachments: [...current.attachments, uploaded] }));
      return uploaded;
    } finally {
      setUploading((count) => count - 1);
    }
  }

  /** Files picked, pasted, or dropped: uploaded now with progress, attached when the card is created. */
  async function attachFiles(files: readonly File[]) {
    const { kept, notice } = fitToCap(files, draftRef.current.attachments.length + uploads.rows.length, MAX_COMPOSER_ATTACHMENTS, "card");
    if (notice) notify.warning(notice);
    await uploads.upload(kept, (uploaded) => update((current) => ({ ...current, attachments: [...current.attachments, uploaded] })));
  }

  /** From Files (D396): the person's own file, confirmed in the picker when it is outside Attachments. */
  function attachDocument(document: DocumentSummary, options: { confirmed: boolean }) {
    if (draftRef.current.attachments.some((file) => file.id === document.id)) return;
    update((current) => ({ ...current, attachments: [...current.attachments, {
      id: document.id, name: document.name, mime_type: document.mime_type, preview_kind: document.preview_kind, size_bytes: document.size_bytes, fromFiles: true, confirmed: options.confirmed
    }] }));
  }

  // Paste a screenshot anywhere in the form but the description (which inserts it inline), and drop
  // files on the form (desktop): both attach to the new card.
  const attachRef = useRef(attachFiles);
  attachRef.current = attachFiles;
  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || attachZoneOf(event.target) === "editor") return;
      const files = pastedFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      void attachRef.current(files);
    };
    element.addEventListener("paste", onPaste);
    return () => element.removeEventListener("paste", onPaste);
  }, []);
  const dropIntoEditor = useRef(false);
  const drop = useFileDrop((files) => { if (!dropIntoEditor.current) void attachRef.current(files); }, { enabled: !creating });

  // Images pasted or dropped into the description are attachments of the new card, shown inline.
  async function uploadDescriptionImage(file: File) {
    if (!isInsertableImageType(file.type)) throw new Error(IMAGE_REJECTED_MESSAGE);
    const uploaded = await upload(file);
    if (uploaded.preview_kind !== "image" || !isInsertableImageType(uploaded.mime_type.split(";")[0]!.trim())) {
      throw new Error("Attached as a file: only PNG, JPEG, GIF, and WebP images show inline");
    }
    return { src: imageContentUrl(uploaded.id), alt: imageAltText(uploaded.name || file.name) };
  }

  function removeFile(id: string) {
    const file = draftRef.current.attachments.find((item) => item.id === id);
    update((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== id) }));
    if (file) discardUploads([file]);
  }

  async function stageRelation(type: RelationType, card: CardSearchResult) {
    if (draftRef.current.relations.some((relation) => relation.card.id === card.id)) return "That card is already linked.";
    if (draftRef.current.relations.length >= MAX_COMPOSER_RELATIONS) return `A card can have at most ${MAX_COMPOSER_RELATIONS} relations.`;
    update((current) => ({ ...current, relations: [...current.relations, { key: `${type}:${card.id}`, type, card }] }));
    if (error?.field === "relations") setError(null);
    return null;
  }

  const saveField = async (change: object, _success: string, context?: FieldContext) => {
    update((current) => applyFieldChange(current, change as Record<string, unknown>, context));
    return true;
  };

  // A tag deleted from Manage tags meanwhile also leaves the draft, so the create does not name it.
  const tagsChanged = (change: TagChange) => {
    if (change.kind === "deleted") update((current) => current.tagIds.includes(change.tagId) ? { ...current, tagIds: current.tagIds.filter((id) => id !== change.tagId) } : current);
    onTagsChange?.(change);
  };

  const columnOptions = columns.map((item) => {
    const full = !canEnterColumn(cards, item, null);
    return { value: item.id, label: item.name, disabled: full, ...(full ? { description: `Full (limit ${item.wip_limit})` } : item.is_done === 1 ? { description: "Done column" } : {}) };
  });
  const busy = creating || uploading > 0 || uploads.busy;
  const uploadedCount = draft.attachments.filter((file) => !file.fromFiles).length;
  const levels = hasLevels(structure);
  const draftLevel = draft.level ?? structure.workLevel;
  const candidates = levels && draftLevel > 0 ? parentCandidates(parentCards, { id: "", title: "", column_id: "", position: 0, level: draftLevel }) : [];
  const parentLabel = draftLevel > 0 ? levelName(structure, draftLevel - 1) : "";
  // A subtask has no "No task" choice: it is created under its parent, or the level changes.
  const parentOptional = draftLevel > 0 && !parentRequired(structure, draftLevel);
  const parentOptions = [...(parentOptional ? [{ value: "", label: `No ${parentLabel.toLowerCase()}` }] : []), ...candidates.map((card) => ({ value: card.id, label: card.title }))];
  const fieldError = (field: ComposerError["field"]) => error?.field === field && <p className="file-dialog-error" role="alert">{error.message}</p>;
  const stagedRows = draft.relations.map((relation) => ({ key: relation.key, type: relation.type, restricted: false, card: relation.card }));

  return <>
    <button className="panel-scrim task-card-scrim" onClick={requestClose} aria-label="Close the new card" tabIndex={-1} />
    <section ref={sectionRef} className={`task-card-dialog task-composer${drop.dragging ? " task-card-dragging" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${baseId}-heading`} onKeyDownCapture={onKeyDownCapture} onKeyDown={trapTabKey}
      {...drop.bind} onDropCapture={(event) => { dropIntoEditor.current = attachZoneOf(event.target) === "editor"; }}>
      {drop.dragging && <div className="task-card-drop" aria-hidden="true"><Paperclip />Drop files to attach them</div>}
      <header className="task-card-dialog-header">
        <div className="task-card-dialog-heading">
          <span className="eyebrow" id={`${baseId}-heading`}>New {levels ? levelName(structure, draftLevel).toLowerCase() : "card"} · {boardName}</span>
          <input
            ref={titleRef}
            id={titleId}
            className="task-card-title-input"
            value={draft.title}
            autoFocus
            placeholder="Card title"
            aria-label="Card title"
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? `${baseId}-title-error` : undefined}
            maxLength={200}
            onChange={(event) => { const title = event.target.value; update((current) => ({ ...current, title })); setTitleError(null); }}
            onKeyDown={(event) => {
              // Enter in the one-line title creates, as Ctrl/⌘+Enter does.
              if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit(event.shiftKey ? "another" : "close");
              }
            }}
          />
          {titleError && <p id={`${baseId}-title-error`} className="file-dialog-error" role="alert">{titleError}</p>}
        </div>
        <button type="button" className="icon-button" onClick={requestClose} aria-label="Close the new card" title="Close"><X /></button>
      </header>

      <div className="task-card-dialog-body">
        <div className="task-card-details">
          <div className="task-card-field">
            <label id={`${baseId}-column-label`}><Columns3 aria-hidden="true" />Column</label>
            <Select id={`${baseId}-column`} labelledBy={`${baseId}-column-label`} label="Column" value={draft.columnId} options={columnOptions} disabled={busy}
              onChange={(columnId) => { update((current) => ({ ...current, columnId })); if (error?.field === "column") setError(null); }} />
            {fieldError("column")}
          </div>
          {levels && <div className="task-card-field">
            <label id={`${baseId}-level-label`}><Layers aria-hidden="true" />Level</label>
            <Select id={`${baseId}-level`} labelledBy={`${baseId}-level-label`} label="Level" value={String(draftLevel)} disabled={busy}
              options={structure.levels.map((level, index) => ({ value: String(index), label: level.name }))}
              onChange={(value) => update((current) => {
                const level = Number(value);
                const parent = parentCards.find((card) => card.id === current.parentId);
                return { ...current, level, parentId: parent && levelOf(parent) === level - 1 ? parent.id : null };
              })} />
          </div>}
          {levels && draftLevel > 0 && <div className="task-card-field">
            <label id={`${baseId}-parent-label`}><Layers aria-hidden="true" />{parentLabel}</label>
            <Select id={`${baseId}-parent`} labelledBy={`${baseId}-parent-label`} label={parentLabel} value={draft.parentId ?? (parentOptional ? "" : null)} disabled={busy} options={parentOptions}
              placeholder={`Choose ${aLevel(structure, draftLevel - 1)}…`}
              onChange={(parentId) => { update((current) => ({ ...current, parentId: parentId || null, level: current.level ?? structure.workLevel })); if (error?.field === "parent") setError(null); }} />
            {fieldError("parent")}
          </div>}
          {structure.sprints && sprints && draftLevel === structure.workLevel && <SprintSelect sprints={sprints} value={draft.sprintId} idPrefix={baseId} disabled={busy}
            onChange={(sprintId) => update((current) => ({ ...current, sprintId }))} />}
        </div>
        <CardFields card={draftCard(draft, boardId)} userId={userId} idPrefix={baseId} done={column?.is_done === 1} saving={creating} onSave={saveField}
          tags={tags} owner={owner} onTagsChange={tagsChanged} />

        <section className="task-card-section" aria-labelledby={`${baseId}-description`}>
          <header><h3 id={`${baseId}-description`}>Description</h3></header>
          <div className="task-description-editor" data-attach-zone="editor">
            <NoteEditor key={round} markdown={draft.description} editable={!creating} onNotice={notify} label="Card description" placeholder="Describe the work… Type / for commands"
              onChange={(description) => update((current) => ({ ...current, description }))} uploadImage={uploadDescriptionImage} />
          </div>
        </section>

        <section className="task-card-section" aria-labelledby={`${baseId}-relations`}>
          <header>
            <h3 id={`${baseId}-relations`}><Link2 aria-hidden="true" />Relations</h3>
            {!addingRelation && <button type="button" className="secondary-button task-small-button" onClick={() => setAddingRelation(true)} disabled={busy || draft.relations.length >= MAX_COMPOSER_RELATIONS}><Plus />Add relation</button>}
          </header>
          {addingRelation && <RelationAdder idPrefix={baseId} boardId={boardId} excluded={new Set(draft.relations.map((relation) => relation.card.id))} disabled={creating}
            onAdd={stageRelation} onDone={() => setAddingRelation(false)} />}
          {stagedRows.length > 0 && <RelationList rows={stagedRows} boardId={boardId}
            onRemove={(row) => update((current) => ({ ...current, relations: current.relations.filter((relation) => relation.key !== row.key) }))} />}
          {!stagedRows.length && !addingRelation && <p className="task-comment-empty">Linked when the card is created.</p>}
          {fieldError("relations")}
        </section>

        <section className="task-card-section" aria-labelledby={`${baseId}-files`}>
          <header>
            <h3 id={`${baseId}-files`}><Paperclip aria-hidden="true" />Attachments</h3>
            <button type="button" className="secondary-button task-small-button" onClick={() => setAttachOpen(true)} aria-haspopup="dialog" disabled={creating}><Paperclip />{uploading || uploads.busy ? "Uploading…" : "Attach"}</button>
          </header>
          <UploadRows rows={uploads.rows} label="Uploading for the new card" />
          {draft.attachments.length
            ? <AttachmentList label="Files to attach"
              items={draft.attachments.map((file) => ({ documentId: file.id, removed: false, name: file.name, mimeType: file.mime_type, previewKind: file.preview_kind, sizeBytes: file.size_bytes, partId: null, position: 0, linkedAt: "", isOwner: true, inAttachmentsFolder: !file.fromFiles }))}
              canRemove={() => !creating} onRemove={(item) => removeFile(item.documentId)} />
            : !uploads.busy && <p className="task-comment-empty">Files upload now and are attached when the card is created. You can also drop or paste them here.</p>}
        </section>
      </div>

      <footer className="task-composer-footer">
        {fieldError("form")}
        <span className="task-composer-hint">{/Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : navigator.platform) ? "⌘" : "Ctrl"}+Enter creates</span>
        <span className="task-composer-buttons">
          <button type="button" className="secondary-button" onClick={() => { void submit("another"); }} disabled={busy}>Create another</button>
          <button type="button" className="secondary-button" onClick={() => { void submit("open"); }} disabled={busy}>Create and open</button>
          <button type="button" className="primary-button" onClick={() => { void submit("close"); }} disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter">{creating ? "Creating…" : "Create"}</button>
        </span>
      </footer>
    </section>
    {attachOpen && <AttachSheet hostNoun="card" closeOnPick
      disabledReason={attachCapReason(draft.attachments.length, MAX_COMPOSER_ATTACHMENTS, "card")}
      onClose={() => setAttachOpen(false)}
      onFiles={(files) => { void attachFiles(files); }}
      onPickDocument={attachDocument} />}
    {confirmDiscard && <ConfirmDialog title="Discard this card?" message={uploadedCount
      ? `Nothing is saved, and the ${uploadedCount === 1 ? "uploaded file moves" : `${uploadedCount} uploaded files move`} to your Bin.`
      : "Nothing you entered is saved."} confirmLabel="Discard" danger
      onConfirm={() => {
        setConfirmDiscard(false);
        discardUploads(draftRef.current.attachments);
        onClose();
      }} onCancel={keepEditing} />}
  </>;
}
