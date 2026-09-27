import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { Ban, CirclePause, Eye, Flame, Plus, Trash2 } from "lucide-react";
import { ApiError } from "../api";
import { ModalDialog } from "../files/Dialog";
import { Combobox, type ComboboxHandle } from "../ui/Combobox";
import { Select } from "../ui/Select";
import type { Option } from "../ui/Listbox";
import { deleteTagMessage, FLAG_LABELS, MAX_TAGS_PER_CARD, TAG_NAME_MAX, toggleFlag, type TagChange } from "./cardTags";
import { cardCountLabel, sameIds, validateTagName } from "./taskActions";
import { CARD_FLAGS, createTag, deleteTag, TAG_COLORS, taskErrorCode, taskErrorMessage, updateTag, type BoardTag, type CardFlag, type TagColor } from "./tasksApi";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";

const FLAG_ICONS = { urgent: Flame, blocked: Ban, needs_review: Eye, on_hold: CirclePause } as const;

/** A flag's icon, toned by the flag (urgent red, blocked amber, needs review blue, on hold grey). */
export function FlagIcon({ flag }: { flag: CardFlag }) {
  const Icon = FLAG_ICONS[flag];
  return <Icon className={`task-flag-icon flag-${flag}`} aria-hidden="true" />;
}

const colourName = (color: string) => color[0]!.toUpperCase() + color.slice(1);
const colourOptions: Option<TagColor>[] = TAG_COLORS.map((color) => ({ value: color, label: colourName(color), swatch: color }));

const existingTag = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { tag?: BoardTag }).tag ?? null
  : null;

/**
 * A list field that saves when its popup (or phone sheet) closes, not on every chip (§4.3), and at
 * once when a chip is removed while it is closed. Mirrors the assignee picker.
 */
function useCommitOnClose(wrapRef: RefObject<HTMLDivElement | null>, saved: string[], disabled: boolean, onCommit: (ids: string[]) => Promise<unknown>) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const committing = useRef(false);
  const commit = async (next: string[]) => {
    if (committing.current) return;
    if (sameIds(next, saved)) {
      setDraft(null);
      return;
    }
    committing.current = true;
    try {
      await onCommit(next);
    } finally {
      // Saved or not (a conflict shows the other person's version), the chips follow the card.
      draftRef.current = null;
      committing.current = false;
      setDraft(null);
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const isOpen = useCallback(() => Boolean(wrapRef.current?.querySelector(".ui-popup, .ui-sheet-layer")), [wrapRef]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof MutationObserver === "undefined") return undefined;
    let open = isOpen();
    const observer = new MutationObserver(() => {
      const now = isOpen();
      if (open && !now && draftRef.current && !disabledRef.current) void commitRef.current(draftRef.current);
      open = now;
    });
    observer.observe(wrap, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [wrapRef, isOpen]);
  // Another field's save hid the list meanwhile: commit the choices once it is done.
  useEffect(() => {
    if (!disabled && draftRef.current && !isOpen()) void commitRef.current(draftRef.current);
  }, [disabled, isOpen]);

  return {
    value: draft ?? saved,
    change: (next: string[]) => {
      setDraft(next);
      if (!isOpen() && !disabled) void commit(next);
    }
  };
}

type TagPickerProps = {
  boardId: string;
  inputId: string;
  /** The board's tags, by name. */
  tags: BoardTag[];
  /** The card's tags, in tagging order. */
  tagIds: string[];
  /** The board owner also renames, recolours, and deletes tags (D109). */
  owner: boolean;
  disabled: boolean;
  /** Saves the whole set; resolves once the save settled. */
  onCommit: (ids: string[], names: string[]) => Promise<unknown>;
  /** A tag was created, renamed, recoloured, or deleted: the board updates its list. */
  onTagsChange: (change: TagChange) => void;
};

/** The list's hint before anything is typed on a board with no tags, and when nothing matches. */
export const TAG_HINT_EMPTY = "Type a name to create a tag";
export const TAG_HINT_NO_MATCH = "No tag matches. Type a new name to create it.";

/**
 * The card's tags (D109): a multiple Combobox over the board's tags with colour swatches and a
 * "Create" row, so any reader adds a tag in passing. The list opens on focus or a click with every
 * tag (or, on a board with none, the hint to type a name); the Create row leads the list as soon as
 * a character is typed, and Enter or a click creates and applies it. "+ New tag" opens the same flow
 * with focus in the field. The owner also gets "Manage tags" to rename, recolour, or delete them;
 * Back closes that dialog (D69).
 */
export function TagPicker({ boardId, inputId, tags, tagIds, owner, disabled, onCommit, onTagsChange }: TagPickerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const manageRef = useRef<HTMLButtonElement>(null);
  const comboRef = useRef<ComboboxHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  // A tag deleted meanwhile has left the board; the card's stale id is not shown or sent back.
  const saved = tagIds.filter((id) => byId.has(id));
  const names = useRef(new Map<string, string>());
  for (const tag of tags) names.current.set(tag.id, tag.name);
  const { value, change } = useCommitOnClose(wrapRef, saved, disabled, (ids) => onCommit(ids, ids.map((id) => names.current.get(id) ?? "a tag")));

  const closeManage = useCallback(() => {
    setManaging(false);
    window.setTimeout(() => { if (manageRef.current?.isConnected) manageRef.current.focus(); }, 0);
  }, []);
  useHistoryDialogGuard(managing, closeManage);

  async function create(label: string): Promise<Option> {
    setError(null);
    const check = validateTagName(label);
    if (!check.ok) {
      setError(check.error);
      throw new Error(check.error);
    }
    let tag: BoardTag;
    try {
      ({ tag } = await createTag(boardId, check.name));
    } catch (reason) {
      // Someone made it meanwhile (another case of the name): use theirs.
      const existing = taskErrorCode(reason) === "TAG_EXISTS" ? existingTag(reason) : null;
      if (!existing) {
        setError(taskErrorMessage(reason, "Could not create the tag"));
        throw reason;
      }
      tag = existing;
    }
    names.current.set(tag.id, tag.name);
    onTagsChange({ kind: "saved", tag });
    return { value: tag.id, label: tag.name, swatch: tag.color };
  }

  return <div ref={wrapRef} className="task-tag-picker">
    <Combobox
      multiple
      id={inputId}
      label="Tags"
      placeholder="Add tags…"
      emptyText={tags.length ? TAG_HINT_NO_MATCH : TAG_HINT_EMPTY}
      openOnFocus
      handleRef={comboRef}
      value={value}
      maxSelected={MAX_TAGS_PER_CARD}
      options={tags.map((tag) => ({ value: tag.id, label: tag.name, swatch: tag.color }))}
      onCreate={create}
      disabled={disabled}
      onChange={(next) => { setError(null); change(next); }}
    />
    {error && <small className="file-dialog-error" role="alert">{error}</small>}
    {value.length >= MAX_TAGS_PER_CARD && <small className="task-due-text">A card can have up to {MAX_TAGS_PER_CARD} tags.</small>}
    <span className="task-tag-actions">
      <button type="button" className="task-add-time" disabled={disabled || value.length >= MAX_TAGS_PER_CARD} aria-controls={inputId}
        onClick={() => comboRef.current?.open()}><Plus aria-hidden="true" />New tag</button>
      {owner && <button ref={manageRef} type="button" className="task-add-time" aria-haspopup="dialog" onClick={() => setManaging(true)}>Manage tags…</button>}
    </span>
    {managing && <ManageTagsDialog tags={tags} onChange={onTagsChange} onClose={closeManage} />}
  </div>;
}

type FlagPickerProps = {
  labelId: string;
  flags: CardFlag[];
  disabled: boolean;
  onCommit: (flags: CardFlag[], flag: CardFlag, on: boolean) => Promise<unknown>;
};

/** The four fixed flags (D110) as toggle chips; each press saves. */
export function FlagPicker({ labelId, flags, disabled, onCommit }: FlagPickerProps) {
  return <div className="task-flag-picker" role="group" aria-labelledby={labelId}>
    {CARD_FLAGS.map((flag) => {
      const on = flags.includes(flag);
      return <button key={flag} type="button" className={`task-flag-toggle flag-${flag}${on ? " on" : ""}`} aria-pressed={on} disabled={disabled}
        onClick={() => { void onCommit(toggleFlag(flags, flag), flag, !on); }}>
        <FlagIcon flag={flag} />{FLAG_LABELS[flag]}
      </button>;
    })}
  </div>;
}

type ManageTagsDialogProps = {
  tags: BoardTag[];
  onChange: (change: TagChange) => void;
  onClose: () => void;
};

/**
 * The owner's tag list (D109): rename (saves on Enter or leaving the field), recolour, and delete,
 * which unlinks the tag from every card with no Bin. A full-screen sheet on phones; it pushes no
 * history entry and the opener's guard closes it on Back.
 */
export function ManageTagsDialog({ tags, onChange, onClose }: ManageTagsDialogProps) {
  const [busy, setBusy] = useState(false);
  return <ModalDialog title="Manage tags" eyebrow="Board" onClose={onClose} variant="sheet" busy={busy}>
    {tags.length
      ? <ul className="task-tag-list" aria-label="Tags">
        {tags.map((tag) => <TagRow key={tag.id} tag={tag} onChange={onChange} onBusy={setBusy} />)}
      </ul>
      : <p className="file-dialog-copy">No tags yet. Add one from a card’s Tags field.</p>}
    <p className="file-dialog-copy task-tag-note">Renaming or recolouring a tag changes it on every card. Anyone who can open the board can add new tags.</p>
    <footer className="file-dialog-actions">
      <button type="button" className="primary-button" onClick={onClose} disabled={busy}>Done</button>
    </footer>
  </ModalDialog>;
}

function TagRow({ tag, onChange, onBusy }: { tag: BoardTag; onChange: (change: TagChange) => void; onBusy: (busy: boolean) => void }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      const code = taskErrorCode(reason);
      if (reason instanceof ApiError && reason.status === 404) {
        onChange({ kind: "deleted", tagId: tag.id });
        return;
      }
      setError(code === "TAG_EXISTS" ? "Another tag already has this name." : taskErrorMessage(reason, "Could not change the tag"));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  function saveName() {
    if (name === null) return;
    const check = validateTagName(name, tag.name);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (!check.changed) {
      setName(null);
      return;
    }
    void run(async () => {
      onChange({ kind: "saved", tag: (await updateTag(tag.id, { name: check.name })).tag });
      setName(null);
    });
  }

  return <li className="task-tag-row">
    <Select variant="compact" swatchOnly value={tag.color} label={`Colour of ${tag.name}`} options={colourOptions} disabled={busy}
      onChange={(color) => { void run(async () => onChange({ kind: "saved", tag: (await updateTag(tag.id, { color })).tag })); }} />
    <input
      className="task-tag-name"
      value={name ?? tag.name}
      maxLength={TAG_NAME_MAX}
      aria-label={`Name of ${tag.name}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      disabled={busy}
      onChange={(event) => { setName(event.target.value); setError(null); }}
      onBlur={saveName}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        // Escape undoes the edit first; a second Escape closes the dialog.
        if (event.key === "Escape" && name !== null) { event.preventDefault(); setName(null); setError(null); }
      }}
    />
    <small className="task-tag-count">{cardCountLabel(tag.card_count)}</small>
    <button type="button" className="icon-button" aria-label={`Delete ${tag.name}`} title="Delete tag" disabled={busy} onClick={() => setConfirming(true)}><Trash2 /></button>
    {error && <p id={errorId} className="file-dialog-error task-tag-row-note" role="alert">{error}</p>}
    {confirming && <div className="task-tag-confirm task-tag-row-note" role="alertdialog" aria-label={`Delete ${tag.name}?`}>
      <p>{deleteTagMessage(tag)}</p>
      <span>
        <button type="button" className="secondary-button task-small-button" autoFocus disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className="danger-button task-small-button" disabled={busy} onClick={() => {
          void run(async () => {
            await deleteTag(tag.id);
            onChange({ kind: "deleted", tagId: tag.id });
          });
        }}>{busy ? "Deleting…" : "Delete tag"}</button>
      </span>
    </div>}
  </li>;
}
