import { useEffect, useRef, useState } from "react";
import { Paperclip, RotateCcw, X } from "lucide-react";
import { formatBytes, deleteFile } from "../files/filesApi";
import { AttachmentList, AttachmentPreview, AttachSheet, linkToHost, unlinkFromHost, uploadForHost, useFileDrop, type HostAttachment } from "../ui/attachments";
import { useConfirm } from "../ui/useConfirm";
import type { DocumentSummary } from "../types";
import type { EventResponse } from "./calendarApi";

/**
 * Event attachments (uploads everywhere U1). Files belong to the event's whole series: every
 * occurrence of a repeating event shows the same ones, and skipping a date changes nothing.
 *
 * - The event view attaches and removes at once (`EventAttachmentsSection`): editors attach through
 *   the shared AttachSheet (Take photo on phones, Choose files, From Files) or by dropping files on
 *   the section; the file's owner and the calendar's owner or managers remove.
 * - The event sheet stages its changes (`SheetAttachmentsField`, state in CalendarApp): files upload
 *   to the person's Attachments folder at once, so Save does not wait on them, but they are linked
 *   (and removals unlinked) only when the event is saved. Discarding the sheet moves the uploads it
 *   made back out of the way (to the Bin); files picked from Files are never touched.
 *
 * Who can open a file is decided on the server through the event's calendar (T340); nothing here
 * widens it. Feeds and mail never carry them (D407).
 */

export const DEFAULT_EVENT_ATTACHMENT_LIMIT = 20;

/** An upload or Files pick waiting in the event sheet for Save. */
export type StagedAttachment = {
  key: string;
  name: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  /** Bytes sent so far while uploading, as a fraction 0–1. */
  progress: number;
  error: string | null;
  documentId: string | null;
  mimeType: string;
  previewKind: string;
  /** A Files item outside the Attachments folder, confirmed in the From Files dialog (D396). */
  confirmed: boolean;
  /** Uploaded by this sheet: discarding the sheet moves it to the Bin again. */
  uploadedHere: boolean;
  /** The file, kept for Retry. */
  file: File | null;
};

/** The event sheet's attachment changes: the event's current files, the ones to unlink, and the ones to link. */
export type SheetAttachmentState = { existing: HostAttachment[]; removed: string[]; added: StagedAttachment[] };

export const emptySheetAttachments = (existing: readonly HostAttachment[] = []): SheetAttachmentState => ({ existing: [...existing], removed: [], added: [] });

export const sheetAttachmentsDirty = (state: SheetAttachmentState) => state.removed.length > 0 || state.added.length > 0;
export const sheetUploading = (state: SheetAttachmentState) => state.added.some((item) => item.status === "uploading");

/** How many more files fit (D400: the server counts every link, a removed file's too). */
export function attachmentRoom(state: SheetAttachmentState, limit: number) {
  const kept = state.existing.filter((item) => !state.removed.includes(item.documentId)).length;
  return Math.max(0, limit - kept - state.added.filter((item) => item.status !== "failed").length);
}

/** A staged file as the shared list draws it (a thumbnail once uploaded). */
export function stagedAsAttachment(item: StagedAttachment): HostAttachment {
  return { documentId: item.documentId ?? item.key, removed: false, name: item.name, mimeType: item.mimeType, previewKind: item.previewKind, sizeBytes: item.sizeBytes, partId: null, position: 0, linkedAt: "", isOwner: true, inAttachmentsFolder: !item.confirmed };
}

/** What the sheet lists: the kept files, then the ready additions. Uploads in flight and failures get their own rows. */
export function sheetAttachmentItems(state: SheetAttachmentState): HostAttachment[] {
  return [...state.existing.filter((item) => !state.removed.includes(item.documentId)), ...state.added.filter((item) => item.status === "ready").map(stagedAsAttachment)];
}

/**
 * Whether a file may be removed from the event (U0 `canUnlink`): the file's owner always, even when
 * they can now only view the event (U0 review M1); editors otherwise only as a calendar owner or
 * manager, who may remove anyone's.
 */
export function canRemoveAttachment(item: HostAttachment, rights: { canEdit: boolean; canManage: boolean }) {
  if (!item.removed && item.isOwner) return true;
  if (!rights.canEdit) return false;
  // A removed file's owner is not shown; the server decides, and refuses anyone but the linker or a manager.
  return rights.canManage || item.removed || item.isOwner;
}

/** The caller's rights on an event's files, from the event response. */
export function attachmentRights(data: EventResponse, canWrite: boolean) {
  const canEdit = canWrite && data.role !== "viewer";
  const level = data.calendar.level;
  return { canEdit, canManage: canEdit && (data.calendar.is_owner === 1 || level === "owner" || level === "manage") };
}

export const limitMessage = (limit: number) => `An event can have up to ${limit} files.`;

const errorText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
const isAbort = (reason: unknown) => reason instanceof DOMException && reason.name === "AbortError";

export function stagedFromFile(file: File): StagedAttachment {
  return { key: crypto.randomUUID(), name: file.name || "Pasted file", sizeBytes: file.size, status: "uploading", progress: 0, error: null, documentId: null, mimeType: file.type || "application/octet-stream", previewKind: "none", confirmed: false, uploadedHere: true, file };
}

export function stagedFromDocument(document: DocumentSummary, confirmed: boolean): StagedAttachment {
  return { key: crypto.randomUUID(), name: document.name, sizeBytes: document.size_bytes, status: "ready", progress: 1, error: null, documentId: document.id, mimeType: document.mime_type, previewKind: document.preview_kind, confirmed, uploadedHere: false, file: null };
}

/**
 * Uploads a staged file to the Attachments folder, reporting progress and the result through
 * `update`. The Idempotency-Key is the staged key, so Retry never stores the same file twice.
 */
export function uploadStaged(item: StagedAttachment, signal: AbortSignal, update: (key: string, patch: Partial<StagedAttachment>) => void) {
  if (!item.file) return Promise.resolve();
  return uploadForHost(item.file, "event", { signal, idempotencyKey: item.key, onProgress: (loaded, total) => update(item.key, { progress: total ? loaded / total : 0 }) })
    .then(({ document }) => update(item.key, { status: "ready", progress: 1, documentId: document.id, name: document.name, sizeBytes: document.size_bytes, mimeType: document.mime_type, previewKind: document.preview_kind, file: null }))
    .catch((reason) => { if (!isAbort(reason)) update(item.key, { status: "failed", error: errorText(reason, "Could not upload this file") }); });
}

/**
 * Applies the sheet's staged changes to a saved event: unlinks the removed files, then links the
 * additions in the order they were added. Returns the names that failed, with why.
 */
export async function applySheetAttachments(eventId: string, state: SheetAttachmentState) {
  const failures: string[] = [];
  for (const documentId of state.removed) {
    try { await unlinkFromHost("event", eventId, documentId); } catch (reason) {
      const item = state.existing.find((existing) => existing.documentId === documentId);
      failures.push(`${item && !item.removed ? item.name : "A file"}: ${errorText(reason, "could not be removed")}`);
    }
  }
  for (const item of state.added) {
    if (item.status !== "ready" || !item.documentId) continue;
    try { await linkToHost("event", eventId, item.documentId, { confirmed: item.confirmed }); } catch (reason) {
      failures.push(`${item.name}: ${errorText(reason, "could not be attached")}`);
    }
  }
  return failures;
}

/** Discarded sheet: the uploads it made go to the Bin (best effort; the hourly sweep catches the rest). */
export function discardSheetUploads(state: SheetAttachmentState) {
  for (const item of state.added) if (item.uploadedHere && item.status === "ready" && item.documentId) void deleteFile(item.documentId).catch(() => undefined);
}

/** A row for a file still uploading, or one that failed (Retry and Remove). */
function PendingRow({ item, onRetry, onRemove }: { item: StagedAttachment; onRetry?: () => void; onRemove: () => void }) {
  const percent = Math.round(item.progress * 100);
  return <li className={`attachment-item calendar-attachment-pending${item.status === "failed" ? " failed" : ""}`}>
    <span className="attachment-thumb"><Paperclip aria-hidden="true" /></span>
    <span className="attachment-copy">
      <strong title={item.name}>{item.name}</strong>
      {item.status === "failed"
        ? <small role="alert">{item.error ?? "Could not upload this file"}</small>
        : <small><progress max={100} value={percent} aria-label={`Uploading ${item.name}`} /> {percent}% of {formatBytes(item.sizeBytes)}</small>}
    </span>
    {item.status === "failed" && onRetry && item.file && <button type="button" className="icon-button" onClick={onRetry} aria-label={`Retry ${item.name}`}><RotateCcw /></button>}
    <button type="button" className="icon-button" onClick={onRemove} aria-label={item.status === "uploading" ? `Cancel uploading ${item.name}` : `Remove ${item.name}`}><X /></button>
  </li>;
}

type SheetFieldProps = {
  state: SheetAttachmentState;
  limit: number;
  /** Whether the person can add files at all (the sheet's calendar is writable). */
  canAttach: boolean;
  /** May the person remove this existing file (their own, or as a manager)? */
  canRemoveExisting: (item: HostAttachment) => boolean;
  onAttach: () => void;
  onOpen: (item: Extract<HostAttachment, { removed: false }>) => void;
  onRemove: (item: HostAttachment) => void;
  onRetry: (key: string) => void;
  onRemoveStaged: (key: string) => void;
};

/** The Attachments field of the event sheet: staged until Save. */
export function SheetAttachmentsField({ state, limit, canAttach, canRemoveExisting, onAttach, onOpen, onRemove, onRetry, onRemoveStaged }: SheetFieldProps) {
  const items = sheetAttachmentItems(state);
  const pending = state.added.filter((item) => item.status !== "ready");
  const room = attachmentRoom(state, limit);
  const stagedKeys = new Set(state.added.map((item) => item.documentId ?? item.key));
  return <div className="calendar-field calendar-event-attachments" role="group" aria-label="Attachments">
    <span>Attachments</span>
    <AttachmentList items={items} label="Files on this event" onOpen={onOpen}
      canRemove={(item) => stagedKeys.has(item.documentId) || canRemoveExisting(item)}
      onRemove={(item) => {
        const staged = state.added.find((added) => (added.documentId ?? added.key) === item.documentId);
        if (staged) onRemoveStaged(staged.key);
        else onRemove(item);
      }} />
    {pending.length > 0 && <ul className="attachment-list" aria-label="Uploads">
      {pending.map((item) => <PendingRow key={item.key} item={item} onRetry={() => onRetry(item.key)} onRemove={() => onRemoveStaged(item.key)} />)}
    </ul>}
    {canAttach && <div className="calendar-attach-row">
      <button type="button" className="action-button secondary calendar-attach-button" onClick={onAttach} aria-haspopup="dialog" disabled={room === 0}><Paperclip aria-hidden="true" />Attach files</button>
      <small className="calendar-hint">{room === 0 ? limitMessage(limit) : "Or drop or paste files here. They are attached when you save."}</small>
    </div>}
  </div>;
}

type SectionProps = {
  data: EventResponse;
  canEdit: boolean;
  canManage: boolean;
  /** Called after a change, to read the event again. */
  onChanged: () => void;
  flash: (message: string) => void;
};

type Upload = StagedAttachment;

/**
 * The event view's Attachments section: thumbnails, the preview sheet, and, for editors, Attach
 * (the shared sheet) and drop. Changes apply at once. Readers who can open the event see the files;
 * nobody else ever does (the content route answers 404).
 */
export function EventAttachmentsSection({ data, canEdit, canManage, onChanged, flash }: SectionProps) {
  const attachments = data.attachments ?? [];
  const limit = data.attachmentLimit ?? DEFAULT_EVENT_ATTACHMENT_LIMIT;
  const eventId = data.event.id;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [preview, setPreview] = useState<{ documentId: string; name: string } | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const cancelled = useRef(new Set<string>());
  const { ask, confirmElement } = useConfirm();

  // Leaving the event cancels uploads in flight; an upload that never got linked is swept after a day.
  useEffect(() => () => { for (const controller of controllers.current.values()) controller.abort(); }, []);

  const inFlight = uploads.filter((item) => item.status !== "failed").length;
  const room = Math.max(0, limit - attachments.length - inFlight);

  const update = (key: string, patch: Partial<Upload>) => setUploads((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));

  async function run(item: Upload) {
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    let documentId: string | null = null;
    await uploadStaged(item, controller.signal, (key, patch) => {
      if (patch.documentId) documentId = patch.documentId;
      if (patch.status === "ready") return;
      update(key, patch);
    });
    controllers.current.delete(item.key);
    if (!documentId) return;
    if (cancelled.current.delete(item.key)) {
      // Cancelled after every byte was sent: stored, but never attached; out of the way it goes.
      void deleteFile(documentId).catch(() => undefined);
      return;
    }
    try {
      await linkToHost("event", eventId, documentId);
      setUploads((current) => current.filter((upload) => upload.key !== item.key));
      onChanged();
    } catch (reason) {
      update(item.key, { status: "failed", error: errorText(reason, "Could not attach this file"), file: null });
      void deleteFile(documentId).catch(() => undefined);
    }
  }

  function addFiles(files: File[]) {
    if (!canEdit || !files.length) return;
    if (files.length > room) {
      flash(room === 0 ? limitMessage(limit) : `${limitMessage(limit)} Only the first ${room} ${room === 1 ? "was" : "were"} added.`);
    }
    const accepted = files.slice(0, room).map(stagedFromFile);
    if (!accepted.length) return;
    setUploads((current) => [...current, ...accepted]);
    for (const item of accepted) void run(item);
  }

  async function addDocument(document: DocumentSummary, options: { confirmed: boolean }) {
    if (room === 0) {
      flash(limitMessage(limit));
      return;
    }
    try {
      await linkToHost("event", eventId, document.id, options);
      flash(`Attached “${document.name}”`);
      onChanged();
    } catch (reason) {
      flash(errorText(reason, "Could not attach the file"));
    }
  }

  async function remove(item: HostAttachment, trigger: HTMLElement | null) {
    const name = item.removed ? "this file" : `“${item.name}”`;
    if (!await ask({ title: "Remove from this event?", message: `Remove ${name} from “${data.event.title}”? ${item.removed ? "" : item.inAttachmentsFolder ? "If nothing else uses it, it moves to its owner's Bin." : "It stays in its folder in Files."}`.trim(), confirmLabel: "Remove", danger: true, opener: trigger })) return;
    try {
      const result = await unlinkFromHost("event", eventId, item.documentId);
      flash(result.documentBinned ? `Removed ${name}. The file moved to ${!item.removed && item.isOwner ? "your" : "its owner's"} Bin.` : `Removed ${name}`);
    } catch (reason) {
      flash(errorText(reason, "Could not remove the file"));
    }
    onChanged();
  }

  function cancelUpload(key: string) {
    const item = uploads.find((upload) => upload.key === key);
    // Bytes still going up are aborted; a fully sent upload finishes and is binned instead of linked.
    if (item && item.status === "uploading" && item.progress >= 1) cancelled.current.add(key);
    else controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setUploads((current) => current.filter((item) => item.key !== key));
  }

  const drop = useFileDrop(addFiles, { enabled: canEdit });
  if (!attachments.length && !uploads.length && !canEdit) return null;
  return <section className={`calendar-event-section calendar-event-attachments${drop.dragging ? " dragging" : ""}`} aria-labelledby="calendar-attachments-title" {...drop.bind}>
    <h2 id="calendar-attachments-title"><Paperclip />Attachments{attachments.length > 0 && <small className="calendar-count">{attachments.length}</small>}</h2>
    {!attachments.length && !uploads.length && <p className="calendar-note">{data.event.repeat ? "Add the agenda, slides, or tickets. Every repeat of this event shows them." : "Add the agenda, slides, or tickets. Everyone who can see this event can open them."}</p>}
    <AttachmentList items={attachments} label="Files on this event" onOpen={(item) => setPreview({ documentId: item.documentId, name: item.name })}
      canRemove={(item) => canRemoveAttachment(item, { canEdit, canManage })}
      onRemove={(item) => { void remove(item, typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null); }} />
    {uploads.length > 0 && <ul className="attachment-list" aria-label="Uploads">
      {uploads.map((item) => <PendingRow key={item.key} item={item} onRetry={() => { update(item.key, { status: "uploading", progress: 0, error: null }); void run({ ...item, status: "uploading" }); }} onRemove={() => cancelUpload(item.key)} />)}
    </ul>}
    {canEdit && <div className="calendar-attach-row">
      <button type="button" className="action-button secondary calendar-attach-button" onClick={() => setSheetOpen(true)} aria-haspopup="dialog" disabled={room === 0}><Paperclip aria-hidden="true" />Attach files</button>
      {room === 0 ? <small className="calendar-hint">{limitMessage(limit)}</small> : <small className="calendar-hint calendar-drop-hint">Or drop files here.</small>}
    </div>}
    {drop.dragging && <div className="calendar-drop-overlay" aria-hidden="true"><Paperclip />Drop to attach to this event</div>}
    {sheetOpen && <AttachSheet hostNoun="event" closeOnPick onClose={() => setSheetOpen(false)} onFiles={addFiles} onPickDocument={(document, options) => { void addDocument(document, options); }}
      disabledReason={room === 0 ? limitMessage(limit) : null} />}
    {preview && <AttachmentPreview documentId={preview.documentId} name={preview.name} onClose={() => setPreview(null)} />}
    {confirmElement}
  </section>;
}
