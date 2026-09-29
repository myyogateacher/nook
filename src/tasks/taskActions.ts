// Pure helpers for the Tasks UI: name validation that mirrors the server rules.
import { levelAtLeast, type ItemLevel } from "../access/accessLevels";

/**
 * Whether cards on a board are read-only for the caller (Wave 32, §D.3): a read-only Team role, or a
 * board level below Can edit as the server returns it (`board.level`). Then no Move, drag, Alt+Arrow,
 * New card, Add a card, or due-date change is offered; commenters still comment and react.
 */
export const cardsReadOnly = (roleReadOnly: boolean, level: ItemLevel | undefined) => roleReadOnly || !levelAtLeast(level, "edit");
export type NameCheck = { ok: true; name: string; changed: boolean } | { ok: false; error: string };

// C0/C1 controls and bidi overrides, as refused by server/tasks/routes.ts.
const controlCharacters = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

function validateLabel(input: string, max: number, noun: string, current?: string): NameCheck {
  const name = input.trim();
  if (!name) return { ok: false, error: `Enter a ${noun}.` };
  if (name.length > max) return { ok: false, error: `Use at most ${max} characters.` };
  if (controlCharacters.test(name)) return { ok: false, error: "Remove control characters." };
  return { ok: true, name, changed: name !== current };
}

export const validateBoardName = (input: string, current?: string) => validateLabel(input, 120, "board name", current);
export const validateColumnName = (input: string, current?: string) => validateLabel(input, 60, "column name", current);
export const validateCardTitle = (input: string, current?: string) => validateLabel(input, 200, "card title", current);
/** A board tag's name: 1–40 characters (D109). */
export const validateTagName = (input: string, current?: string) => validateLabel(input, 40, "tag name", current);

export const sharingLabel = (visibility: "private" | "selected" | "all_users") =>
  visibility === "all_users" ? "Everyone here" : visibility === "selected" ? "Shared" : "Private";

export const cardCountLabel = (count: number) => count === 1 ? "1 card" : `${count} cards`;
export const commentCountLabel = (count: number) => count === 1 ? "1 comment" : `${count} comments`;
export const attachmentCountLabel = (count: number) => count === 1 ? "1 attachment" : `${count} attachments`;

/** The card dialog eyebrow: one “In”, even for a column already named “In progress”. */
export const columnEyebrow = (name: string) => /^in\s/i.test(name.trim()) ? name.trim() : `In ${name}`;

/** The second line in the user picker: the email, or a short id when another user has the same name. */
export function pickerDetail(user: { id: string; email?: string; displayName: string }, users: readonly { id: string; displayName: string }[]) {
  if (user.email) return user.email;
  const name = user.displayName.trim().toLowerCase();
  return users.some((other) => other.id !== user.id && other.displayName.trim().toLowerCase() === name) ? `ID ${user.id.slice(0, 8)}` : null;
}

export const COMMENT_MAX_BYTES = 16_384;

/** Why a comment body would be refused, or null. */
export function commentBodyError(body: string) {
  if (!body.trim()) return "Write a comment first.";
  if (new TextEncoder().encode(body).length > COMMENT_MAX_BYTES) return "Comments can be at most 16 KB.";
  return null;
}

type AttachmentLike = { document_id: string; comment_id: string | null; linked_by: string | null; preview_kind: string; mime_type: string };

/** Files attached to the card itself (null) or through one comment. */
export function attachmentsFor<T extends AttachmentLike>(attachments: readonly T[], commentId: string | null) {
  return attachments.filter((item) => item.comment_id === commentId);
}

/** Whether the viewer may remove an attachment: whoever linked it, or the board owner. */
export const canUnlink = (attachment: AttachmentLike, userId: string, boardOwner: boolean) => boardOwner || attachment.linked_by === userId;

/** Images the server previews inline are shown as thumbnails; everything else is a download. */
export const isInlineImage = (attachment: Pick<AttachmentLike, "preview_kind" | "mime_type">) =>
  attachment.preview_kind === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mime_type.split(";")[0]!.trim().toLowerCase());

export const unlinkConfirmMessage = (name: string, ownFile: boolean) => ownFile
  ? `Remove “${name}” from this card? If no other card uses it, it moves to your Bin for 30 days.`
  : `Remove “${name}” from this card? If no other card uses it, it moves to its uploader's Bin for 30 days.`;

/** The Files-style confirm copy for moving a card or board to the Bin. */
export const binConfirmMessage = (kind: "card" | "board", name: string, descendants = 0) => kind === "card"
  ? `Move “${name}”${descendants ? ` and ${descendants === 1 ? "the card under it" : `the ${descendants} cards under it`}` : ""} to the Bin? You can restore ${descendants ? "them together" : "it"} for 30 days.`
  : `Move the board “${name}” and all its cards to the Bin? You can restore it for 30 days.`;

/** A toast action, such as Undo after moving something to the Bin. */
/** `selectable`: the message holds text to copy by hand (a link); it wraps, and stays 15 s like one with an action. */
export type TaskNotify = (message: string, action?: { label: string; run: () => void }, options?: { selectable?: boolean }) => void;

/**
 * After CARD_CHANGED on a title save: retrying at the new revision is safe only when the server's
 * title is still the one the edit started from, so another person's rename is never overwritten.
 */
export const canRetryTitle = (baseTitle: string, serverTitle: string) => baseTitle === serverTitle;

/** Whether leaving the card would lose description edits. */
export const descriptionDirty = (editing: boolean, draft: string, saved: string) => editing && draft !== saved;

/** Today's date in the viewer's time zone as YYYY-MM-DD. */
export function localDateString(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayNumber = (isoDate: string) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Math.round(Date.UTC(year!, month! - 1, day!) / 86_400_000);
};

export type DueStatus = { tone: "overdue" | "today" | "soon" | "later"; label: string; description: string };

/** The viewer's IANA zone, as the browser reports it (sent as `dueTz`, D101). */
export function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
/** The date (YYYY-MM-DD) and 24-hour time (HH:MM) of an instant in `timeZone`. */
export function instantParts(instant: string | number, timeZone: string) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    partsFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/**
 * The instant (ISO) of wall time `time` on `date` in `timeZone`, as the server derives `due_at`
 * (server/tasks/dueTime.ts): a time in a DST gap moves forward, and the earlier instant wins in an
 * overlap. Null when the zone is unknown. Used where the client holds a time the server has not
 * stored yet (the composer's draft), so its summary reads like the saved card's.
 */
export function wallTimeInstant(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (!Number.isFinite(wall)) return null;
  try {
    const offset = (utc: number) => {
      const local = instantParts(utc, timeZone);
      const [ly, lm, ld] = local.date.split("-").map(Number);
      const [lh, lmin] = local.time.split(":").map(Number);
      return Date.UTC(ly!, lm! - 1, ld!, lh!, lmin!) - Math.floor(utc / 60_000) * 60_000;
    };
    const before = offset(wall - 86_400_000);
    const after = offset(wall + 86_400_000);
    const candidates = [...new Set([before, after])].map((value) => wall - value).filter((utc) => wall - offset(utc) === utc).sort((left, right) => left - right);
    return new Date(candidates[0] ?? wall - before).toISOString();
  } catch {
    return null;
  }
}

/** A timed due date: its exact instant, plus "now" and the viewer's zone (injectable for tests). */
export type DueTiming = { dueAt: string | null | undefined; now?: number; timeZone?: string };

/**
 * The due chip on a card. Done cards show no chip. `today` is the viewer's
 * local date (YYYY-MM-DD), so "overdue" matches what Today shows. A card with a
 * time (`timing.dueAt`) sits on the viewer's local day and time of that instant
 * and is overdue once the instant has passed (D100).
 */
export function dueStatus(dueOn: string | null, today: string, done = false, timing?: DueTiming): DueStatus | null {
  if (!dueOn || done) return null;
  const at = timing?.dueAt ? Date.parse(timing.dueAt) : Number.NaN;
  const local = Number.isFinite(at) ? instantParts(at, timing?.timeZone ?? viewerTimeZone()) : null;
  const dueDay = local?.date ?? dueOn;
  const days = dayNumber(dueDay) - dayNumber(today);
  const [year, month, day] = dueDay.split("-").map(Number);
  const short = new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(dueDay.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  if (!local) {
    if (days < 0) return { tone: "overdue", label: short, description: `Overdue, was due ${short}` };
    if (days === 0) return { tone: "today", label: "Today", description: "Due today" };
    if (days === 1) return { tone: "soon", label: "Tomorrow", description: "Due tomorrow" };
    return { tone: days <= 7 ? "soon" : "later", label: short, description: `Due ${short}` };
  }
  const named = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : null;
  const label = `${named ?? short} ${local.time}`;
  const spoken = `${named ? named.toLowerCase() : short} at ${local.time}`;
  if (at <= (timing?.now ?? Date.now())) return { tone: "overdue", label, description: `Overdue, was due ${spoken}` };
  if (days === 0) return { tone: "today", label, description: `Due ${spoken}` };
  return { tone: days <= 7 ? "soon" : "later", label, description: `Due ${spoken}` };
}

/**
 * The time to save from the time field, or null when there is nothing to save: a complete
 * `HH:MM` (00:00–23:59) that differs from the saved time or zone. Seconds of `:00` are dropped.
 */
export function committableDueTime(value: string, saved: { time: string | null | undefined; zone: string | null | undefined }, zone: string) {
  const time = value.length === 8 && value.endsWith(":00") ? value.slice(0, 5) : value;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return time === saved.time && zone === saved.zone ? null : time;
}

/**
 * The line under the due field for a card with a time: its wall time, plus its zone and the
 * viewer's local time when it was set in another zone ("17:00 Europe/Berlin (20:30 your time)").
 */
export function dueTimeNote(card: { due_time?: string | null; due_tz?: string | null; due_at?: string | null }, viewerZone = viewerTimeZone()) {
  if (!card.due_time || !card.due_tz) return null;
  if (card.due_tz === viewerZone || !card.due_at) return card.due_time;
  const local = instantParts(card.due_at, viewerZone);
  const home = instantParts(card.due_at, card.due_tz);
  const [year, month, day] = local.date.split("-").map(Number);
  const shift = local.date === home.date ? "" : `${new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { weekday: "short" })} `;
  return `${card.due_time} ${card.due_tz} (${shift}${local.time} your time)`;
}

type AssigneeLike = { id: string; display_name: string; can_read: 0 | 1; avatar_url?: string | null };

/** The card's assignees (the deprecated single-assignee fields are gone since v0.9.0, D113). */
export function cardAssignees(card: { assignees?: AssigneeLike[] }): AssigneeLike[] {
  return card.assignees ?? [];
}

/** How a chip names an assignee: someone who lost access to the board is marked (T93). */
export const assigneeLabel = (assignee: AssigneeLike) => assignee.can_read === 1 ? assignee.display_name : `${assignee.display_name} (no access)`;

/** "Asha", "Asha and Ben", "Asha, Ben, and Chen", "Asha, Ben, and 2 others". */
export function assigneeSentence(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others`;
}

/** Whether two id lists hold the same ids in the same order. */
export const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * The due date to save from the date field, or null when there is nothing to save: the value
 * must be a complete real date from 1900 to 2999 (as the server requires) and differ from the
 * saved one. Browsers report partial years such as 0202 while a date is typed.
 */
export function committableDueDate(value: string, saved: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || value === saved) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

/** WIP limits (D108): at most 1–1000 cards in a column, or no limit. */
export const WIP_LIMIT_MAX = 1000;
export type WipState = "under" | "full" | "over";

/** Where a column stands against its limit, or null without one. */
export function wipState(count: number, limit: number | null | undefined): WipState | null {
  if (!limit) return null;
  return count > limit ? "over" : count === limit ? "full" : "under";
}

/** The column's card count for screen readers: "4 of 3 cards, over the limit". */
export function wipCountLabel(count: number, limit: number | null | undefined) {
  const state = wipState(count, limit);
  if (!state) return cardCountLabel(count);
  const base = `${count} of ${limit} ${limit === 1 ? "card" : "cards"}`;
  return state === "over" ? `${base}, over the limit` : state === "full" ? `${base}, at the limit` : base;
}

/**
 * A column's count badge (QA 0.9.0): the number of cards on screen (hierarchy levels, the sprint,
 * and filters applied), with the column's full count in the label. A WIP limit keeps counting
 * every live card (the server's rule), so a limited column shows "8 / 10", or "3 · 8 / 10" when
 * only 3 of them are on screen.
 */
export function columnBadge(shown: number, total: number, limit: number | null | undefined) {
  const wip = wipState(total, limit);
  const partial = shown !== total;
  const text = wip ? `${partial ? `${shown} · ` : ""}${total} / ${limit}` : String(shown);
  const label = wip
    ? `${partial ? `${shown} shown; ` : ""}${wipCountLabel(total, limit)}`
    : partial ? `${shown} shown of ${cardCountLabel(total)}` : cardCountLabel(total);
  return { text, label, wip };
}

/**
 * Whether a card may come into a column: always within its own column (reordering) and without a
 * limit; otherwise only while the column holds fewer cards than its limit. The server decides (409
 * COLUMN_FULL); this only refuses a drop or a key move early.
 */
export function canEnterColumn(cards: readonly { id: string; column_id: string }[], column: { id: string; wip_limit?: number | null }, cardId: string | null) {
  if (!column.wip_limit) return true;
  if (cardId && cards.some((card) => card.id === cardId && card.column_id === column.id)) return true;
  return cards.filter((card) => card.column_id === column.id).length < column.wip_limit;
}

/** The message for a card refused by a full column. */
export const columnFullMessage = (name: string, limit: number | null | undefined) =>
  `“${name}” is full${limit ? ` (limit ${limit})` : ""}. Move a card out of it first.`;

/**
 * "Add a card to <column>" on a full column: the same refusal a drag gets, instead of a composer
 * that quietly starts in another column. Null when the column has room.
 */
export function addCardRefusal(cards: readonly { id: string; column_id: string }[], column: { id: string; name: string; wip_limit?: number | null }) {
  return canEnterColumn(cards, column, null) ? null : columnFullMessage(column.name, column.wip_limit);
}

/** The WIP limit dialog's field: empty means no limit, otherwise a whole number from 1 to 1000. */
export function validateWipLimit(input: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const value = input.trim();
  if (!value) return { ok: true, value: null };
  if (!/^\d+$/.test(value)) return { ok: false, error: "Enter a whole number of cards." };
  const limit = Number(value);
  if (limit < 1 || limit > WIP_LIMIT_MAX) return { ok: false, error: `Use a limit from 1 to ${WIP_LIMIT_MAX}.` };
  return { ok: true, value: limit };
}
