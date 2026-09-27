// The card composer's draft (WAVE_13_TASK_CARD_UX.md §4.3): everything a new card will have, kept
// locally until one POST /boards/:b/cards writes it all. Pure, so it can be unit tested.
import { canEnterColumn, columnFullMessage, viewerTimeZone, wallTimeInstant } from "./taskActions";
import type { BoardColumn, CardAssignee, CardCreate, CardDetail, CardSearchResult, RelationType, UploadedAttachment } from "./tasksApi";
import { parentRequired, parentRequiredMessage, type BoardStructure } from "../../shared/boardStructure";

export type StagedRelation = { key: string; type: RelationType; card: CardSearchResult };

export type ComposerDraft = {
  columnId: string;
  title: string;
  description: string;
  dueOn: string | null;
  dueTime: string | null;
  dueTz: string | null;
  assignees: CardAssignee[];
  tagIds: string[];
  flags: string[];
  relations: StagedRelation[];
  attachments: UploadedAttachment[];
  /** Hierarchy (17A): the parent one level up, and the level; null level means the board's work level. */
  parentId: string | null;
  level: number | null;
  /** The sprint a work-level card is planned in (17B), or null for the backlog. */
  sprintId: string | null;
};

export const MAX_COMPOSER_ATTACHMENTS = 50;
export const MAX_COMPOSER_RELATIONS = 50;

export function emptyDraft(columnId: string, placement: { parentId?: string | null; level?: number | null; sprintId?: string | null } = {}): ComposerDraft {
  return {
    columnId, title: "", description: "", dueOn: null, dueTime: null, dueTz: null, assignees: [], tagIds: [], flags: [], relations: [], attachments: [],
    parentId: placement.parentId ?? null, level: placement.level ?? null, sprintId: placement.sprintId ?? null
  };
}

/**
 * The column the composer starts in: the one asked for when it can take a card, otherwise the
 * first open (not done) column with room, then any column with room, then the first column.
 */
export function defaultColumnId(columns: readonly BoardColumn[], cards: readonly { id: string; column_id: string }[], preferred?: string | null) {
  const room = (column: BoardColumn) => canEnterColumn(cards, column, null);
  const asked = preferred ? columns.find((column) => column.id === preferred) : undefined;
  if (asked && room(asked)) return asked.id;
  return (columns.find((column) => column.is_done !== 1 && room(column)) ?? columns.find(room) ?? asked ?? columns[0])?.id ?? "";
}

/** Anything typed, picked, staged, or uploaded: closing then asks "Discard this card?". */
export function composerDirty(draft: ComposerDraft) {
  return Boolean(draft.title.trim() || draft.description.trim() || draft.dueOn || draft.assignees.length || draft.tagIds.length
    || draft.flags.length || draft.relations.length || draft.attachments.length);
}

/** Context a field passes with its change (the assignee picker knows the names). */
export type FieldContext = { assignees?: CardAssignee[] };

/**
 * Applies one `CardFields` change (the shape `PATCH /cards/:k` takes) to the draft, with the same
 * rules the server applies: clearing the date clears the time, and a time carries its zone (D101).
 * List fields replace the whole set. Unknown keys are ignored.
 */
export function applyFieldChange(draft: ComposerDraft, change: Record<string, unknown>, context: FieldContext = {}): ComposerDraft {
  const next = { ...draft };
  if ("dueOn" in change) {
    if (change.dueOn === null) Object.assign(next, { dueOn: null, dueTime: null, dueTz: null });
    else if (typeof change.dueOn === "string") next.dueOn = change.dueOn;
  }
  if ("dueTime" in change) {
    if (change.dueTime === null) Object.assign(next, { dueTime: null, dueTz: null });
    else if (typeof change.dueTime === "string" && next.dueOn) {
      next.dueTime = change.dueTime;
      next.dueTz = typeof change.dueTz === "string" ? change.dueTz : viewerTimeZone();
    }
  }
  if (Array.isArray(change.assigneeIds)) {
    const known = new Map([...draft.assignees, ...(context.assignees ?? [])].map((person) => [person.id, person]));
    next.assignees = (change.assigneeIds as string[]).map((id) => known.get(id) ?? { id, display_name: "Someone", can_read: 1 });
  }
  if (Array.isArray(change.tagIds)) next.tagIds = [...change.tagIds as string[]];
  if (Array.isArray(change.flags)) next.flags = [...change.flags as string[]];
  return next;
}

/** A card-shaped view of the draft, so the composer reuses `CardFields` as the dialog does. */
export function draftCard(draft: ComposerDraft, boardId: string): CardDetail {
  const card = {
    id: "", board_id: boardId, column_id: draft.columnId, position: 0, title: draft.title, has_description: draft.description.trim() ? 1 : 0, revision: 0,
    created_by: null, creator_name: null, due_on: draft.dueOn, due_time: draft.dueTime, due_tz: draft.dueTz,
    // The instant the server will derive, so the due summary shows the time as the card dialog does.
    due_at: draft.dueOn && draft.dueTime && draft.dueTz ? wallTimeInstant(draft.dueOn, draft.dueTime, draft.dueTz) : null,
    assignees: draft.assignees,
    comment_count: 0, attachment_count: draft.attachments.length, created_at: "", updated_at: "", description: draft.description,
    tag_ids: draft.tagIds, flags: draft.flags
  };
  return card as CardDetail;
}

/** The one create request: only what was set, so an empty field never overrides a server default. */
export function createBody(draft: ComposerDraft, title: string): CardCreate {
  const body: CardCreate = { columnId: draft.columnId, title };
  if (draft.description.trim()) body.description = draft.description;
  if (draft.dueOn) {
    body.dueOn = draft.dueOn;
    if (draft.dueTime && draft.dueTz) Object.assign(body, { dueTime: draft.dueTime, dueTz: draft.dueTz });
  }
  if (draft.assignees.length) body.assigneeIds = draft.assignees.map((person) => person.id);
  if (draft.tagIds.length) body.tagIds = draft.tagIds;
  if (draft.flags.length) body.flags = draft.flags;
  if (draft.relations.length) body.relations = draft.relations.map((relation) => ({ targetCardId: relation.card.id, type: relation.type }));
  if (draft.attachments.length) body.attachmentIds = draft.attachments.map((file) => file.id);
  if (draft.parentId) body.parentId = draft.parentId;
  if (draft.level !== null) body.level = draft.level;
  if (draft.sprintId) body.sprintId = draft.sprintId;
  return body;
}

export type ComposerError = { field: "column" | "relations" | "parent" | "form"; message: string };

/**
 * A subtask needs its parent before Create (operator QA 0.9.1): the inline message under the parent
 * field, or null when the draft can be created.
 */
export function composerParentError(structure: BoardStructure, draft: Pick<ComposerDraft, "level" | "parentId">): ComposerError | null {
  const level = draft.level ?? structure.workLevel;
  return parentRequired(structure, level) && !draft.parentId ? { field: "parent", message: `${parentRequiredMessage(structure, level)}.` } : null;
}

/** Where a refused create is explained, next to the field it concerns (§4.3). */
export function composerError(reason: { status?: number; code?: unknown; wipLimit?: unknown; message?: string }, column: BoardColumn | undefined, hasRelations = false): ComposerError {
  const { status, code } = reason;
  if (code === "COLUMN_FULL") {
    return { field: "column", message: columnFullMessage(column?.name ?? "This column", typeof reason.wipLimit === "number" ? reason.wipLimit : column?.wip_limit) };
  }
  if (code === "PARENT_REQUIRED") return { field: "parent", message: reason.message || "Pick a parent for it first." };
  if (code === "RELATION_EXISTS") return { field: "relations", message: "Two of the links point to the same card. Keep one." };
  if (code === "LIMIT_REACHED") return { field: "form", message: reason.message || "A limit was reached, so the card was not created." };
  if (code === "ATTACHMENT_LINKED") return { field: "form", message: "One of the files is already on another card. Remove it and attach it again." };
  if (code === "ASSIGNEE_NOT_MEMBER") return { field: "form", message: "Someone you assigned can no longer open this board. Remove them and try again." };
  if (code === "STALE_POSITION") return { field: "form", message: "The column changed meanwhile. Try again." };
  if (status === 404) return { field: hasRelations ? "relations" : "form", message: "The column, a linked card, a tag, or a file is no longer available (it may be in the Bin or no longer shared). Check them and try again." };
  return { field: "form", message: reason.message || "Could not create the card" };
}
