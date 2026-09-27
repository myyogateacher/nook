import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarDays, Clock, X } from "lucide-react";
import { DropdownSurface, useOutsideClose, useSheet, type Presentation } from "../ui/Listbox";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { committableDueDate, committableDueTime, dueStatus, dueTimeNote, instantParts, localDateString, viewerTimeZone } from "./taskActions";
import type { CardChange } from "./tasksApi";

// The card's Due field (operator QA 0.9.1): a trigger that shows the value and opens a popover
// (desktop) or a bottom sheet (≤ 760 px) with the date, an optional time, quick picks, and explicit
// Apply and Cancel. Nothing saves until Apply, which sends one change (one PATCH with the revision);
// Cancel, Escape, a click outside, and Back discard the draft (D69, D91).

export type DueFields = { due_on: string | null; due_time?: string | null; due_tz?: string | null; due_at?: string | null };
export type DueDraft = { date: string; time: string; withTime: boolean };
export type QuickPick = "today" | "tomorrow" | "next-week";

export const QUICK_PICKS: { kind: QuickPick; label: string }[] = [
  { kind: "today", label: "Today" },
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "next-week", label: "Next week" }
];

export function initialDueDraft(card: DueFields): DueDraft {
  return { date: card.due_on ?? "", time: card.due_time ?? "", withTime: Boolean(card.due_on && card.due_time) };
}

/** A quick pick's date from the viewer's today (YYYY-MM-DD): today, tomorrow, or a week from today. */
export function quickPickDate(kind: QuickPick, today: string) {
  const [year, month, day] = today.split("-").map(Number);
  const offset = kind === "today" ? 0 : kind === "tomorrow" ? 1 : 7;
  const date = new Date(Date.UTC(year!, month! - 1, day! + offset));
  return date.toISOString().slice(0, 10);
}

/** The draft's date is empty (no due date) or a real date; Apply waits for one of those. */
export function draftDateValid(draft: DueDraft) {
  return draft.date === "" || committableDueDate(draft.date, null) !== null;
}

/**
 * The one change Apply sends, with the toast's words, or null when nothing changed. An untouched
 * time keeps its zone (a card timed elsewhere is not moved into the viewer's zone); a new or edited
 * time is set in the viewer's zone (D101). Clearing the date clears the time.
 */
export function dueChange(card: DueFields, draft: DueDraft, zone: string): { change: CardChange; success: string } | null {
  if (!draftDateValid(draft)) return null;
  if (!draft.date) return card.due_on ? { change: { dueOn: null }, success: "Due date removed" } : null;
  const change: CardChange = {};
  const dateChanged = draft.date !== card.due_on;
  if (dateChanged) change.dueOn = draft.date;
  const savedTime = card.due_on ? card.due_time ?? "" : "";
  let timeWords: "saved" | "removed" | null = null;
  if (draft.withTime && draft.time) {
    const time = draft.time === savedTime ? null : committableDueTime(draft.time, { time: null, zone: null }, zone);
    if (time) {
      Object.assign(change, { dueTime: time, dueTz: zone });
      timeWords = "saved";
    }
  } else if (savedTime) {
    change.dueTime = null;
    timeWords = "removed";
  }
  if (!dateChanged && !timeWords) return null;
  const success = dateChanged
    ? timeWords === "saved" ? "Due date and time saved" : timeWords === "removed" ? "Due date saved, time removed" : "Due date saved"
    : timeWords === "saved" ? "Due time saved" : "Due time removed";
  return { change, success };
}

/** The trigger's words: "No due date", "3 Oct", or "3 Oct at 18:45" (the viewer's local day and time). */
export function dueTriggerLabel(card: DueFields, today: string, zone = viewerTimeZone()) {
  if (!card.due_on) return "No due date";
  const at = card.due_time && card.due_at ? Date.parse(card.due_at) : Number.NaN;
  const local = Number.isFinite(at) ? instantParts(at, zone) : null;
  const day = local?.date ?? card.due_on;
  const [year, month, date] = day.split("-").map(Number);
  const words = new Date(year!, month! - 1, date!).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  const time = local?.time ?? card.due_time;
  return time ? `${words} at ${time}` : words;
}

type DuePickerProps = {
  card: DueFields;
  idPrefix: string;
  /** The card sits in a done column: no due status. */
  done: boolean;
  disabled: boolean;
  /** Saves the change; resolves once it settled (false when not saved). */
  onApply: (change: CardChange, success: string) => Promise<boolean>;
  presentation?: Presentation;
  /** Opens on mount (tests). */
  defaultOpen?: boolean;
};

export function DuePicker({ card, idPrefix, done, disabled, onApply, presentation = "auto", defaultOpen = false }: DuePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(presentation);
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<DueDraft>(() => initialDueDraft(card));
  const [applying, setApplying] = useState(false);
  const [focusTime, setFocusTime] = useState(false);
  const zone = viewerTimeZone();
  const today = localDateString();
  const due = dueStatus(card.due_on, today, done, { dueAt: card.due_at });
  const note = dueTimeNote(card, zone);
  const otherZone = Boolean(card.due_time) && card.due_tz !== zone;
  const pending = dueChange(card, draft, zone);
  const valid = draftDateValid(draft);

  function show() {
    if (disabled) return;
    setDraft(initialDueDraft(card));
    setOpen(true);
  }

  function cancel(returnFocus = true) {
    setOpen(false);
    if (returnFocus) window.setTimeout(() => { if (triggerRef.current?.isConnected) triggerRef.current.focus(); }, 0);
  }

  async function apply() {
    if (applying || !valid) return;
    if (!pending) {
      cancel();
      return;
    }
    setApplying(true);
    try {
      await onApply(pending.change, pending.success);
    } finally {
      setApplying(false);
      cancel();
    }
  }

  // Back closes the popover without saving (the phone sheet's own guard does the same).
  useHistoryDialogGuard(open && !sheet, () => cancel());
  useOutsideClose(open && !sheet, rootRef, () => cancel(false));
  // Focus moves into the editor: the date field on desktop (once the popup is placed and visible, so
  // not autoFocus), the first quick pick in the phone sheet (the date field would raise a picker).
  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(sheet ? ".task-due-quick-pick" : `#${CSS.escape(`${idPrefix}-due-date`)}`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, sheet, idPrefix]);
  useEffect(() => {
    if (!focusTime) return;
    timeRef.current?.focus();
    setFocusTime(false);
  }, [focusTime]);

  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void apply();
    }
  };

  const editor = <div className="task-due-editor" role={sheet ? undefined : "dialog"} aria-label={sheet ? undefined : "Due date"} onKeyDown={onKey}>
    <div className="task-due-quick" role="group" aria-label="Quick picks">
      {QUICK_PICKS.map((pick) => {
        const value = quickPickDate(pick.kind, today);
        return <button key={pick.kind} type="button" className={`task-due-quick-pick${draft.date === value ? " on" : ""}`} aria-pressed={draft.date === value}
          onClick={() => setDraft({ ...draft, date: value })}>{pick.label}</button>;
      })}
      <button type="button" className="task-due-quick-pick" disabled={!draft.date} onClick={() => setDraft({ date: "", time: "", withTime: false })}>Clear</button>
    </div>
    <label className="task-due-editor-row">
      <span><CalendarDays aria-hidden="true" />Date</span>
      <input id={`${idPrefix}-due-date`} type="date" value={draft.date} min="1900-01-01" max="2999-12-31"
        aria-invalid={valid ? undefined : true} onChange={(event) => setDraft({ ...draft, date: event.target.value, ...(event.target.value ? {} : { withTime: false, time: "" }) })} />
    </label>
    {draft.withTime
      ? <div className="task-due-editor-row">
        <label htmlFor={`${idPrefix}-due-time`}><Clock aria-hidden="true" />Time</label>
        <span className="task-due-editor-control">
          <input ref={timeRef} id={`${idPrefix}-due-time`} type="time" step={60} value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
          <button type="button" className="secondary-button task-small-button" onClick={() => setDraft({ ...draft, withTime: false, time: "" })}><X aria-hidden="true" />Remove time</button>
        </span>
      </div>
      : <button type="button" className="task-add-time" disabled={!draft.date} onClick={() => { setDraft({ ...draft, withTime: true }); setFocusTime(true); }}><Clock aria-hidden="true" />Add time</button>}
    {otherZone && note && <p className="task-due-text">{`Set as ${note}. Changing the time uses your zone (${zone}).`}</p>}
    {!valid && <p className="file-dialog-error" role="alert">Use a real date between 1900 and 2999.</p>}
    {!sheet && footer()}
  </div>;

  function footer() {
    return <footer className="task-due-actions">
      <button type="button" className="secondary-button" onClick={() => cancel()} disabled={applying}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void apply(); }} disabled={applying || !valid}>{applying ? "Saving…" : "Apply"}</button>
    </footer>;
  }

  return <div ref={rootRef} className="task-due-picker">
    <button ref={triggerRef} id={`${idPrefix}-due-input`} type="button" className={`task-due-trigger${card.due_on ? "" : " empty"}`} disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open} aria-describedby={`${idPrefix}-due`} onClick={() => { if (open) cancel(); else show(); }}>
      <CalendarDays aria-hidden="true" /><span>{dueTriggerLabel(card, today, zone)}</span>
    </button>
    <small id={`${idPrefix}-due`} className={due ? `task-due-text ${due.tone}` : "task-due-text"}>
      {due ? due.description : card.due_on ? "In a done column" : "No due date"}
      {otherZone && note && <><br />{`Set as ${note}.`}</>}
    </small>
    {open && <DropdownSurface sheet={sheet} anchorRef={triggerRef} title="Due date" onClose={() => cancel()}
      footer={sheet ? <div className="ui-sheet-footer task-due-sheet-footer" onKeyDown={onKey}>{footer()}</div> : undefined}>
      {editor}
    </DropdownSurface>}
  </div>;
}
