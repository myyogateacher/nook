import { useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarClock, CalendarDays, Inbox } from "lucide-react";
import { addDays, resolveMonth, shiftMonth } from "../calendarRoute";
import { dayHeading } from "../calendar/calendarFormat";
import { ModalDialog } from "../files/Dialog";
import { AgendaList } from "../ui/calendarGrid/AgendaList";
import { MonthGrid } from "../ui/calendarGrid/MonthGrid";
import { useIsPhone } from "../ui/Listbox";
import { CARD_DRAG_TYPE, isCardDrag, readCardDragPayload } from "./boardOrder";
import { cardsDueInMonth, displayedDay, displayedTime, dropDueOn, emptyMonthNote, keyboardDayDelta, placeCards, selectGridDay } from "./calendarPlacement";
import type { BoardCard, BoardData } from "./boardQuery";
import type { CalendarLayout } from "./boardUrl";
import { FlagIcons, KeyboardMoveHint } from "./boardViewParts";
import { useModuleEnabled } from "../modules";
import { committableDueDate } from "./taskActions";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";
import "../calendar/calendar.css";

type BoardCalendarProps = {
  board: BoardData;
  /** The cards the filters keep, in board order. */
  cards: BoardCard[];
  layout: CalendarLayout;
  /** `yyyy-mm` from the URL, or null for the current month. */
  month: string | null;
  today: string;
  viewerZone: string;
  /** Paging months replaces the history entry (§4.7); switching the layout pushes. */
  onMonth: (month: string | null) => void;
  onLayout: (layout: CalendarLayout) => void;
  onOpenCard: (card: BoardCard) => void;
  /** PATCH `{ dueOn }` with the card's revision; `null` clears the date (and its time). */
  onSetDue: (card: BoardCard, dueOn: string | null) => void;
  filtered: boolean;
  /** Below Can edit on the board, or a read-only Team role: no drag, no Alt+Arrow, no Set due date. */
  readOnly?: boolean;
};

const CHIPS_PER_DAY = 3;

type Sheet = { kind: "tray" } | { kind: "due"; cardId: string };

/**
 * The board calendar view (§4.5a, D115): this board's cards by due date on the shared month grid or
 * agenda, with an Unscheduled tray. It shows no Calendar events; those stay in Calendar. On desktop a
 * card drags to a day (its date shifts, its time and zone stay) or to the tray (no date); Alt+Arrow
 * moves a focused card a day or a week; "Set due date…" works everywhere, and is the phone's way.
 */
export function BoardCalendar({ board, cards, layout, month: routeMonth, today, viewerZone, onMonth, onLayout, onOpenCard, onSetDue, filtered, readOnly = false }: BoardCalendarProps) {
  const phone = useIsPhone();
  // Drag and Alt+Arrow change the due date: only for people who can edit cards.
  const movable = !phone && !readOnly;
  const calendarEnabled = useModuleEnabled("calendar");
  const month = resolveMonth(routeMonth, today);
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [draft, setDraft] = useState("");
  const [trayOver, setTrayOver] = useState(false);
  useHistoryDialogGuard(sheet !== null, () => setSheet(null));

  const { byDay, unscheduled } = placeCards(cards, viewerZone);
  const done = new Set(board.columns.filter((column) => column.is_done === 1).map((column) => column.id));
  const day = selected && selected.startsWith(month) ? selected : today.startsWith(month) ? today : `${month}-01`;
  const monthCount = cardsDueInMonth(byDay, month);
  const sheetCard = sheet?.kind === "due" ? cards.find((card) => card.id === sheet.cardId) ?? board.cards.find((card) => card.id === sheet.cardId) ?? null : null;

  function dropOn(target: string | null, payload: string | null) {
    const id = readCardDragPayload(payload);
    const card = id ? cards.find((item) => item.id === id) : null;
    // Only cards of this board; a foreign or malformed payload is ignored.
    if (!card) return;
    if (target === null) {
      if (card.due_on) onSetDue(card, null);
      return;
    }
    const next = dropDueOn(card, target, viewerZone);
    if (next) onSetDue(card, next);
  }

  function chipKeyDown(event: ReactKeyboardEvent<HTMLElement>, card: BoardCard) {
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      onOpenCard(card);
      return;
    }
    const delta = !readOnly && event.altKey && !event.ctrlKey && !event.metaKey ? keyboardDayDelta(event.key) : null;
    const shown = displayedDay(card, viewerZone);
    if (delta === null || !shown || !card.due_on) return;
    event.preventDefault();
    onSetDue(card, addDays(card.due_on, delta));
  }

  function openDueDialog(card: BoardCard) {
    setDraft(card.due_on ?? "");
    setSheet({ kind: "due", cardId: card.id });
  }

  const chipLabel = (card: BoardCard) => {
    const time = displayedTime(card, viewerZone);
    const home = card.due_time && card.due_tz && card.due_tz !== viewerZone ? `, set as ${card.due_time} ${card.due_tz} (${time} your time)` : "";
    return `${card.title}${time ? `, due at ${time}` : ""}${home}${done.has(card.column_id) ? ", done" : ""}`;
  };

  const chip = (card: BoardCard) => <div key={card.id} className={`task-cal-chip${done.has(card.column_id) ? " done" : ""}`} tabIndex={0} role="button"
    data-card-id={card.id} data-open-card={card.id} draggable={movable} aria-label={chipLabel(card)} aria-roledescription={readOnly ? "Card" : "Draggable card"}
    aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"} aria-describedby={readOnly ? undefined : "task-cal-keys"}
    title={chipLabel(card)}
    onDragStart={(event) => { event.dataTransfer.setData(CARD_DRAG_TYPE, card.id); event.dataTransfer.effectAllowed = "move"; }}
    onClick={() => onOpenCard(card)} onKeyDown={(event) => chipKeyDown(event, card)}>
    {card.flags.length > 0 && <span className="task-cal-flag" aria-hidden="true" />}
    {displayedTime(card, viewerZone) && <span className="task-cal-time" aria-hidden="true">{displayedTime(card, viewerZone)}</span>}
    <span className="task-cal-title" aria-hidden="true">{card.title}</span>
  </div>;

  // A full row (day list, agenda, tray): opens the card, with "Set due date…" beside it.
  const row = (card: BoardCard) => <div className={`task-cal-row${done.has(card.column_id) ? " done" : ""}`} data-card-id={card.id}>
    <button type="button" className="task-cal-row-open" data-open-card={card.id} onClick={() => onOpenCard(card)} draggable={movable}
      onDragStart={(event: ReactDragEvent<HTMLButtonElement>) => { event.dataTransfer.setData(CARD_DRAG_TYPE, card.id); event.dataTransfer.effectAllowed = "move"; }}
      onKeyDown={(event) => chipKeyDown(event, card)} aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"}>
      <span className="task-cal-row-time">{displayedTime(card, viewerZone) ?? (card.due_on ? "All day" : "")}</span>
      <span className="task-cal-row-title"><FlagIcons flags={card.flags} /><span>{card.title}</span></span>
      <small>{board.columns.find((column) => column.id === card.column_id)?.name}</small>
    </button>
    {!readOnly && <button type="button" className="icon-button task-cal-row-due" onClick={() => openDueDialog(card)} aria-haspopup="dialog" aria-label={`Set due date for “${card.title}”`} title="Set due date…"><CalendarClock /></button>}
  </div>;

  const tray = <div className="task-cal-tray-list">
    {unscheduled.length
      ? <ul>{unscheduled.map((card) => <li key={card.id}>{row(card)}</li>)}</ul>
      : <p className="task-cal-note">{filtered ? "No unscheduled cards match these filters." : "Every card has a due date."}</p>}
  </div>;

  const agendaDays = [...byDay.entries()].sort(([left], [right]) => left < right ? -1 : 1).map(([key, items]) => ({ day: key, items }));

  return <div className="task-board-calendar">
    <p className="task-cal-subtitle">Due dates of cards on this board.{calendarEnabled && " Events linked to cards are in Calendar."}</p>
    <KeyboardMoveHint id="task-cal-keys">Press Alt with the left or right arrow to move a card a day, or up and down to move it a week.</KeyboardMoveHint>
    <div className="task-cal-toolbar">
      <div className="task-cal-layout" role="radiogroup" aria-label="Calendar layout">
        {(["month", "agenda"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={layout === value} className={layout === value ? "active" : undefined}
          onClick={() => { if (layout !== value) onLayout(value); }}>{value === "month" ? "Month" : "Agenda"}</button>)}
      </div>
      {phone && <button type="button" className="secondary-button task-cal-tray-button" onClick={() => setSheet({ kind: "tray" })} aria-haspopup="dialog"><Inbox />Unscheduled ({unscheduled.length})</button>}
    </div>
    <div className="task-cal-body">
      <div className="task-cal-main">
        {layout === "month"
          ? <MonthGrid month={month} today={today} selectedDay={day} compact={phone} titleId="task-cal-title"
            countFor={(cell) => byDay.get(cell)?.length ?? 0}
            onSelectDay={(cell) => {
              const next = selectGridDay(cell, month, today);
              setSelected(next.selected);
              if (next.month !== undefined) onMonth(next.month);
            }}
            onShiftMonth={(delta) => onMonth(shiftMonth(month, delta))}
            onToday={() => { setSelected(null); onMonth(null); }}
            drop={!movable ? undefined : { accepts: (types) => isCardDrag(types), type: CARD_DRAG_TYPE, onDropOnDay: (target, payload) => dropOn(target, payload) }}
            renderDots={(cell) => (byDay.get(cell) ?? []).slice(0, 3).map((card) => <span key={card.id} className={`calendar-dot task-cal-dot${card.flags.length ? " flagged" : ""}`} />)}
            renderDay={(cell) => {
              const items = byDay.get(cell) ?? [];
              return <>
                {items.slice(0, CHIPS_PER_DAY).map(chip)}
                {items.length > CHIPS_PER_DAY && <button className="calendar-more" onClick={() => setSelected(cell)}>+{items.length - CHIPS_PER_DAY} more</button>}
              </>;
            }}>
            {monthCount === 0 && <p className="task-cal-note">{emptyMonthNote(month, filtered)}</p>}
            {(phone || (byDay.get(day)?.length ?? 0) > CHIPS_PER_DAY || selected) && <section className="calendar-day-list" aria-labelledby="task-cal-day-title">
              <header><h3 id="task-cal-day-title">{dayHeading(day, today)}</h3></header>
              {(byDay.get(day) ?? []).length
                ? <ul>{(byDay.get(day) ?? []).map((card) => <li key={card.id}>{row(card)}</li>)}</ul>
                : <p className="calendar-note">No cards due this day.</p>}
            </section>}
          </MonthGrid>
          : <AgendaList days={agendaDays} today={today} label="Cards by due date" idPrefix="task-agenda-" itemKey={(card) => card.id} renderItem={(card) => row(card)}
            empty={<p className="task-cal-note">{filtered ? "No matching cards have a due date." : "No cards have a due date yet."}</p>} />}
      </div>
      {!phone && <aside className={`task-cal-tray${trayOver ? " drop-target" : ""}`} aria-labelledby="task-cal-tray-title"
        onDragOver={(event) => { if (readOnly || !isCardDrag(event.dataTransfer.types)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setTrayOver(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTrayOver(false); }}
        onDrop={(event) => { if (readOnly || !isCardDrag(event.dataTransfer.types)) return; event.preventDefault(); setTrayOver(false); dropOn(null, event.dataTransfer.getData(CARD_DRAG_TYPE)); }}>
        <h3 id="task-cal-tray-title">Unscheduled <span className="task-group-count">{unscheduled.length}</span></h3>
        <p className="task-cal-help">{readOnly ? "Cards without a due date." : "Cards without a due date. Drag one onto a day to schedule it."}</p>
        {tray}
      </aside>}
    </div>

    {sheet?.kind === "tray" && <ModalDialog title={`Unscheduled (${unscheduled.length})`} eyebrow="Board calendar" variant="sheet" onClose={() => setSheet(null)}>
      <div className="task-cal-sheet">
        <p className="task-cal-help">{readOnly ? "Cards without a due date." : "Cards without a due date. Use Set due date to schedule one."}</p>
        {tray}
      </div>
    </ModalDialog>}
    {sheet?.kind === "due" && sheetCard && <ModalDialog title="Set due date" eyebrow={sheetCard.title} onClose={() => setSheet(null)}>
      <form className="task-cal-due-form" onSubmit={(event) => {
        event.preventDefault();
        const value = committableDueDate(draft, sheetCard.due_on);
        if (value) onSetDue(sheetCard, value);
        setSheet(null);
      }}>
        <label>
          <span><CalendarDays aria-hidden="true" />Due date</span>
          <input type="date" value={draft} autoFocus min="1900-01-01" max="2999-12-31" onChange={(event) => setDraft(event.target.value)} />
        </label>
        {sheetCard.due_time && <p className="task-cal-help">The time ({sheetCard.due_time} {sheetCard.due_tz}) stays; only the date changes.</p>}
        <div className="task-cal-due-actions">
          {sheetCard.due_on && <button type="button" className="secondary-button" onClick={() => { onSetDue(sheetCard, null); setSheet(null); }}>Remove date</button>}
          <button type="button" className="secondary-button" onClick={() => setSheet(null)}>Cancel</button>
          <button type="submit" className="primary-button" disabled={!committableDueDate(draft, sheetCard.due_on)}>Save</button>
        </div>
      </form>
    </ModalDialog>}
  </div>;
}

