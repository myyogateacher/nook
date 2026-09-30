import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Flag, Tag, UsersRound } from "lucide-react";
import { Combobox } from "../ui/Combobox";
import { Avatar } from "../ui/Avatar";
import { initials } from "./CardFace";
import type { Option } from "../ui/Listbox";
import {
  assigneeLabel,
  assigneeSentence,
  cardAssignees,
  dueStatus,
  dueTimeNote,
  localDateString,
  pickerDetail,
  sameIds,
  viewerTimeZone
} from "./taskActions";
import { getBoardReaders, type BoardTag, type CardAssignee, type CardChange, type CardDetail } from "./tasksApi";
import { FLAG_LABELS, type TagChange } from "./cardTags";
import { FlagPicker, TagPicker } from "./TagPicker";
import { DuePicker } from "./DuePicker";

export const MAX_ASSIGNEES = 20;

type CardFieldsProps = {
  card: CardDetail;
  userId: string;
  /** Prefix for the fields' ids (the dialog's title id). */
  idPrefix: string;
  /** The card sits in a done column: no due chip. */
  done: boolean;
  /** A save is in flight: the fields wait. */
  saving: boolean;
  /** Saves one change with the card's revision; false when it was not saved (a conflict or an error). */
  onSave: (change: CardChange, success: string, context?: { assignees?: CardAssignee[] }) => Promise<boolean>;
  /** The board's tags (13C); without them the Tags field is left out. */
  tags?: BoardTag[];
  /** The caller owns the board: they also manage its tags. */
  owner?: boolean;
  /** A tag was created, renamed, recoloured, or deleted. */
  onTagsChange?: (change: TagChange) => void;
  /** A read-only Team role (viewer, guest): the values show as text, with no controls (the server refuses the writes). */
  readOnly?: boolean;
};

/**
 * The card's fields (WAVE_13_TASK_CARD_UX.md §4.3): the due date with an optional time, the
 * assignees, the tags, and the flags. The card dialog uses it today; the composer and the full
 * page (13D) join here, so each adds a field with a small diff.
 */
export function CardFields({ card, userId, idPrefix, done, saving, onSave, tags, owner = false, onTagsChange, readOnly = false }: CardFieldsProps) {
  if (readOnly) return <StaticCardFields card={card} idPrefix={idPrefix} done={done} tags={tags} />;
  return <div className="task-card-details">
    <DueField card={card} idPrefix={idPrefix} done={done} saving={saving} onSave={onSave} />
    <div className="task-card-field">
      <label htmlFor={`${idPrefix}-assignees`}><UsersRound aria-hidden="true" />Assignees</label>
      <AssigneePicker boardId={card.board_id} userId={userId} inputId={`${idPrefix}-assignees`} assignees={cardAssignees(card)} disabled={saving}
        onCommit={(ids, names, avatars, integrations) => onSave({ assigneeIds: ids }, ids.length ? `Assigned to ${assigneeSentence(names)}` : "Unassigned",
          { assignees: ids.map((id, index) => ({ id, display_name: names[index] ?? "", can_read: 1, avatar_url: avatars[index] ?? null, ...(integrations[index] ? { is_integration: true } : {}) })) })} />
    </div>
    {tags && <div className="task-card-field">
      <label htmlFor={`${idPrefix}-tags`}><Tag aria-hidden="true" />Tags</label>
      <TagPicker boardId={card.board_id} inputId={`${idPrefix}-tags`} tags={tags} tagIds={card.tag_ids ?? []} owner={owner} disabled={saving}
        onTagsChange={onTagsChange ?? (() => undefined)}
        onCommit={(ids, names) => onSave({ tagIds: ids }, ids.length ? `Tagged ${assigneeSentence(names)}` : "Tags removed")} />
    </div>}
    <div className="task-card-field task-card-field-wide">
      <span id={`${idPrefix}-flags`} className="task-card-field-label"><Flag aria-hidden="true" />Flags</span>
      <FlagPicker labelId={`${idPrefix}-flags`} flags={card.flags ?? []} disabled={saving}
        onCommit={(flags, flag, on) => onSave({ flags }, `${FLAG_LABELS[flag]} flag ${on ? "added" : "removed"}`)} />
    </div>
  </div>;
}

/** The fields as text for a read-only role: Due, Assignees, Tags, and Flags, no inputs. */
function StaticCardFields({ card, idPrefix, done, tags }: Pick<CardFieldsProps, "card" | "idPrefix" | "done" | "tags">) {
  const due = dueStatus(card.due_on, localDateString(), done, { dueAt: card.due_at });
  const note = dueTimeNote(card, viewerTimeZone());
  const assignees = cardAssignees(card);
  const tagNames = (card.tag_ids ?? []).map((id) => tags?.find((tag) => tag.id === id)?.name).filter((name): name is string => Boolean(name));
  const flags = card.flags ?? [];
  const field = (key: string, icon: ReactNode, label: string, value: string, extra?: ReactNode) => <div className="task-card-field">
    <span id={`${idPrefix}-${key}-label`} className="task-card-field-label">{icon}{label}</span>
    <p className="task-card-static" aria-labelledby={`${idPrefix}-${key}-label`}>{value}</p>
    {extra}
  </div>;
  return <div className="task-card-details">
    {field("due", <CalendarDays aria-hidden="true" />, "Due", card.due_on ? [card.due_on, card.due_time && note ? note : null].filter(Boolean).join(" · ") : "No due date",
      <small className={due ? `task-due-text ${due.tone}` : "task-due-text"}>{due ? due.description : card.due_on ? "In a done column" : ""}</small>)}
    {field("assignees", <UsersRound aria-hidden="true" />, "Assignees", assignees.length ? assignees.map(assigneeLabel).join(", ") : "Nobody")}
    {tags && field("tags", <Tag aria-hidden="true" />, "Tags", tagNames.length ? tagNames.join(", ") : "No tags")}
    {field("flags", <Flag aria-hidden="true" />, "Flags", flags.length ? flags.map((flag) => FLAG_LABELS[flag]).join(", ") : "No flags")}
  </div>;
}

/** The due date and optional time: a trigger with the value that opens the Apply/Cancel editor (DuePicker). */
function DueField({ card, idPrefix, done, saving, onSave }: Omit<CardFieldsProps, "userId">) {
  return <div className="task-card-field">
    <label htmlFor={`${idPrefix}-due-input`}><CalendarDays aria-hidden="true" />Due</label>
    <DuePicker card={card} idPrefix={idPrefix} done={done} disabled={saving} onApply={(change, success) => onSave(change, success)} />
  </div>;
}

type AssigneePickerProps = {
  boardId: string;
  userId: string;
  inputId: string;
  assignees: ReturnType<typeof cardAssignees>;
  disabled: boolean;
  /** Saves the whole list (D102); resolves once the save settled. */
  onCommit: (ids: string[], names: string[], avatars: Array<string | null>, integrations: boolean[]) => Promise<unknown>;
};

/**
 * Multiple assignees in a type-to-search Combobox backed by `GET /boards/:b/readers?q=` (D102, T92).
 * Chips are the chosen people; someone who lost access to the board is marked and can only be
 * removed. Choices made while the list is open are saved together when it closes (§4.3), and a
 * chip removed while it is closed saves at once.
 */
export function AssigneePicker({ boardId, userId, inputId, assignees, disabled, onCommit }: AssigneePickerProps) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const names = useRef(new Map<string, string>());
  const avatars = useRef(new Map<string, string | null>());
  const integrations = useRef(new Set<string>());
  for (const assignee of assignees) {
    names.current.set(assignee.id, assignee.display_name);
    if (assignee.avatar_url !== undefined) avatars.current.set(assignee.id, assignee.avatar_url);
    if (assignee.is_integration) integrations.current.add(assignee.id);
  }
  const saved = assignees.map((assignee) => assignee.id);
  const value = draft ?? saved;

  const committing = useRef(false);
  const commit = async (next: string[]) => {
    if (committing.current) return;
    if (sameIds(next, saved)) {
      setDraft(null);
      return;
    }
    committing.current = true;
    try {
      await onCommit(next, next.map((id) => names.current.get(id) ?? "them"), next.map((id) => avatars.current.get(id) ?? null), next.map((id) => integrations.current.has(id)));
    } finally {
      // Saved or not (a conflict shows the other person's version), the chips follow the card.
      draftRef.current = null;
      committing.current = false;
      setDraft(null);
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const isOpen = () => Boolean(wrapRef.current?.querySelector(".ui-popup, .ui-sheet-layer"));
  // The popup (or the phone sheet) closing commits what was chosen while it was open.
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
  }, []);
  // Another field's save hid the list meanwhile: commit the choices once it is done.
  useEffect(() => {
    if (!disabled && draftRef.current && !isOpen()) void commitRef.current(draftRef.current);
  }, [disabled]);

  const loadOptions = useCallback(async (query: string, signal: AbortSignal): Promise<Option[]> => {
    const q = query.trim().slice(0, 64);
    const { users } = await getBoardReaders(boardId, q ? { q, limit: MAX_ASSIGNEES, signal } : { signal });
    for (const user of users) {
      names.current.set(user.id, user.displayName);
      avatars.current.set(user.id, user.avatarUrl ?? null);
      if (user.isIntegration) integrations.current.add(user.id);
    }
    return users.map((user) => {
      const detail = user.isIntegration ? "Integration" : pickerDetail(user, users);
      // Q7: each person's picture beside the name (the initial only when there is none); Q-L4: an integration's icon.
      const icon = <Avatar className="task-avatar picker-avatar" name={user.displayName} url={user.avatarUrl ?? null} fallback={initials(user.displayName)} integration={user.isIntegration === true} />;
      return { value: user.id, label: user.id === userId ? `${user.displayName} (me)` : user.displayName, icon, ...(detail ? { description: detail } : {}) };
    });
  }, [boardId, userId]);

  return <div ref={wrapRef} className="task-assignee-picker">
    <Combobox
      multiple
      id={inputId}
      label="Assignees"
      placeholder="Add people…"
      emptyText="Nobody who can open this board matches"
      value={value}
      maxSelected={MAX_ASSIGNEES}
      loadOptions={loadOptions}
      selectedOptions={assignees.map((assignee) => ({ value: assignee.id, label: assigneeLabel(assignee),
        // Q-L4: an integration's chip carries its icon, as on the card face (people's chips stay text).
        ...(assignee.is_integration ? { icon: <Avatar className="task-avatar picker-avatar" name={assignee.display_name} integration /> } : {}) }))}
      disabled={disabled}
      onChange={(next) => {
        setDraft(next);
        if (!isOpen() && !disabled) void commit(next);
      }}
    />
    {value.length >= MAX_ASSIGNEES && <small className="task-due-text">A card can have up to {MAX_ASSIGNEES} assignees.</small>}
    {assignees.some((assignee) => assignee.can_read === 0) && <small className="task-due-text">Marked “no access”: they can no longer open this board. Remove them, or share the board with them again.</small>}
  </div>;
}
