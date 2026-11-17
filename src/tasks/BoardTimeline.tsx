import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Crosshair, Plus } from "lucide-react";
import { addDays, daysBetween } from "../calendarRoute";
import { useIsPhone } from "../ui/Listbox";
import { Select } from "../ui/Select";
import { GROUP_DIMENSIONS, type BoardCard, type BoardData, type BoardGroup } from "./boardQuery";
import { BOARD_GROUPS, type BoardGroupId } from "./boardUrl";
import { FlagIcons, KeyboardMoveHint, useFinePointer } from "./boardViewParts";
import { ColumnStatusIcon, columnStatuses, type ColumnStatus } from "./ColumnStatusIcon";
import {
  barGeometry, barLabel, barOf, createChange, dayAtOffset, dayWidthFor, dragChange, durationLabel, extendRange, headerRows, initialRange,
  keyboardDrag, offscreenSide, pixelsToDays, previewBar, RANGE_PAD, rangeHolding, rowWindow, SCALE_LABELS, TIMELINE_SCALES, timelineRows,
  visibleTitle, zoomStep, type DateChange, type DragMode, type TimelineBar, type TimelineRange, type TimelineRow, type TimelineScale
} from "./timelinePlacement";
import { byPosition } from "./boardOrder";
import { cardCountLabel } from "./taskActions";
import "./timeline.css";
import { useUnitPreferences } from "../ui/units";
import { TimelineDecorationsOutlet } from "../ui/CardSlotOutlets";

type BoardTimelineProps = {
  board: BoardData;
  /** The cards the filters (and sprint) keep, in board order. */
  cards: BoardCard[];
  /** Grouped rows (the list view's dimensions), or null for one flat list. */
  groups: BoardGroup[] | null;
  group: BoardGroupId | null;
  scale: TimelineScale;
  today: string;
  viewerZone: string;
  /** Replaces the history entry (grouping and zoom are not view changes, §4.7). */
  onGroup: (group: BoardGroupId | null) => void;
  onScale: (scale: TimelineScale) => void;
  onOpenCard: (card: BoardCard) => void;
  /** PATCH the dates (optimistic; the board rolls back and says so on failure). */
  onChangeDates: (card: BoardCard, change: DateChange) => void;
  /** Opens the composer; absent for read-only roles. */
  onAddCard?: () => void;
  filtered: boolean;
  /** Below Can edit, or a read-only Team role: no handles, no drag, no Alt+Arrow (D764). */
  readOnly?: boolean;
};

const ROW_HEIGHT = 40;
const PHONE_ROW_HEIGHT = 44;
const PANE_MIN = 180;
const PANE_MAX = 520;
const PANE_DEFAULT = 300;
const PANE_COLLAPSED = 0;
const PHONE_PANE = 132;
const DRAG_THRESHOLD = 4;
const EDGE_ZONE = 48;
const PANE_KEY = "nook.tasks.timeline.pane";

type PaneState = { width: number; collapsed: boolean };

function readPane(): PaneState {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PANE_KEY) ?? "null") as Partial<PaneState> | null;
    if (stored && typeof stored.width === "number") return { width: Math.max(PANE_MIN, Math.min(PANE_MAX, stored.width)), collapsed: stored.collapsed === true };
  } catch {
    // Storage off or a bad value: the default.
  }
  return { width: PANE_DEFAULT, collapsed: false };
}

/** A card key ("ENG-12") when the card carries one (board short codes); older payloads have none. */
const cardKeyOf = (card: BoardCard) => {
  const key = (card as BoardCard & { key?: unknown }).key;
  return typeof key === "string" && key ? key : null;
};

type Drag = {
  card: BoardCard;
  bar: TimelineBar | null;
  mode: DragMode | "create";
  pointerId: number;
  startX: number;
  startScroll: number;
  /** The day the create drag started on. */
  anchor?: string;
  el: HTMLElement;
  baseLeft: number;
  baseWidth: number;
  delta: number;
  moved: boolean;
  lastX: number;
  lastY: number;
};

/**
 * The board timeline view (Gantt, docs/plan/TASK_VIEWS.md §Timeline, D760–D769): cards as bars from
 * their start to their due day over a horizontally scrolling day grid, with a sticky card list on the
 * left. One scroll container holds both, so rows always line up; only the rows and header days on
 * screen are rendered. Bars drag (body: both dates; ends: start or due), snap to days, and clamp so a
 * start never passes its due day; Alt+Arrow does the same from the keyboard.
 */
export function BoardTimeline({ board, cards, groups, group, scale, today, viewerZone, onGroup, onScale, onOpenCard, onChangeDates, onAddCard, filtered, readOnly = false }: BoardTimelineProps) {
  const phone = useIsPhone();
  const fine = useFinePointer();
  // Drag needs a mouse or trackpad; on touch a tap opens the card and scrolling stays the browser's.
  const editable = !readOnly && !phone && fine;
  const dayWidth = dayWidthFor(scale, phone);
  const rowHeight = phone ? PHONE_ROW_HEIGHT : ROW_HEIGHT;
  const [pane, setPane] = useState<PaneState>(() => typeof window === "undefined" ? { width: PANE_DEFAULT, collapsed: false } : readPane());
  const paneWidth = phone ? PHONE_PANE : pane.collapsed ? PANE_COLLAPSED : pane.width;
  // D1383: weeks (Quarter's week columns, the first range) start on the viewer's "Week starts on".
  const { weekStart } = useUnitPreferences();
  const [range, setRange] = useState<TimelineRange>(() => initialRange(today, scale, weekStart));
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  // A scroll adjustment to apply after the next render (a prepended range, a zoom anchor, Today).
  const pendingScrollRef = useRef<{ left: number; range: TimelineRange } | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, left: 0, width: 1200 });
  const [dragging, setDragging] = useState<string | null>(null);

  const liveRef = useRef({ range, scale });
  liveRef.current = { range, scale };
  const columns = useMemo(() => [...board.columns].sort(byPosition), [board.columns]);
  const statuses = useMemo(() => columnStatuses(columns), [columns]);
  const columnNames = useMemo(() => new Map(columns.map((column) => [column.id, column.name])), [columns]);
  const bars = useMemo(() => new Map(cards.map((card) => [card.id, barOf(card, viewerZone)])), [cards, viewerZone]);
  const rows = useMemo(() => timelineRows(cards, groups, collapsedGroups), [cards, groups, collapsedGroups]);
  const gridWidth = range.days * dayWidth;
  const totalWidth = paneWidth + gridWidth;
  const footer = onAddCard ? rowHeight : 0;

  // Day window and row window on screen.
  const firstDay = Math.max(0, Math.floor(viewport.left / dayWidth));
  const lastDay = Math.min(range.days - 1, Math.ceil((viewport.left + Math.max(0, viewport.width - paneWidth)) / dayWidth));
  const visibleFrom = addDays(range.from, firstDay);
  const visibleTo = addDays(range.from, Math.max(firstDay, lastDay - 1));
  const { first, last } = rowWindow(viewport.top, viewport.height, rowHeight, rows.length);
  const header = useMemo(() => headerRows(range, scale, today, firstDay - 14, lastDay + 14, weekStart), [range, scale, today, firstDay, lastDay, weekStart]);
  const todayIndex = daysBetween(range.from, today);

  const savePane = (next: PaneState) => {
    setPane(next);
    try { window.localStorage.setItem(PANE_KEY, JSON.stringify(next)); } catch { /* storage off */ }
  };

  // The scroll position as last seen, before a zoom re-renders the grid (the browser clamps scrollLeft to the narrower canvas).
  const lastLeftRef = useRef(0);
  const readViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    lastLeftRef.current = scroller.scrollLeft;
    const next = { top: scroller.scrollTop, height: scroller.clientHeight, left: scroller.scrollLeft, width: scroller.clientWidth };
    setViewport((current) => {
      const sameRows = Math.floor(current.top / rowHeight) === Math.floor(next.top / rowHeight) && Math.abs(current.height - next.height) < 1;
      const sameDays = Math.floor(current.left / dayWidth) === Math.floor(next.left / dayWidth) && Math.abs(current.width - next.width) < 1;
      return sameRows && sameDays ? current : next;
    });
  }, [rowHeight, dayWidth]);

  // Scroll to a day, centred (or `align` px from the grid's left edge).
  const scrollToDay = useCallback((day: string, options: { smooth?: boolean; align?: number } = {}) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const grown = rangeHolding(range, day, RANGE_PAD[scale].before, weekStart);
    const from = grown.range.from;
    const visibleGrid = Math.max(0, scroller.clientWidth - paneWidth);
    const target = daysBetween(from, day) * dayWidth - (options.align ?? (visibleGrid / 2 - dayWidth / 2));
    if (grown.range !== range) {
      pendingScrollRef.current = { left: Math.max(0, target), range: grown.range };
      setRange(grown.range);
      return;
    }
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({ left: Math.max(0, target), behavior: options.smooth && !reduce ? "smooth" : "instant" as ScrollBehavior });
  }, [range, scale, paneWidth, dayWidth, weekStart]);

  // First paint: today a third of the way in.
  const placedRef = useRef(false);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || placedRef.current) return;
    placedRef.current = true;
    const visibleGrid = Math.max(0, scroller.clientWidth - paneWidth);
    scroller.scrollLeft = Math.max(0, todayIndex * dayWidth - visibleGrid / 3);
    readViewport();
    // Only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A zoom keeps the day in the middle of the screen where it was (D762).
  const scaleRef = useRef(scale);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const previous = scaleRef.current;
    scaleRef.current = scale;
    if (!scroller || previous === scale) return;
    const visibleGrid = Math.max(0, scroller.clientWidth - paneWidth);
    const centre = (lastLeftRef.current + visibleGrid / 2) / dayWidthFor(previous, phone);
    const centreDay = addDays(range.from, Math.floor(centre));
    const grown = rangeHolding(range, centreDay, RANGE_PAD[scale].after, weekStart);
    const from = grown.range.from;
    const left = Math.max(0, (daysBetween(from, centreDay) + (centre % 1)) * dayWidth - visibleGrid / 2);
    if (grown.range !== range) {
      pendingScrollRef.current = { left, range: grown.range };
      setRange(grown.range);
    } else {
      scroller.scrollLeft = left;
      readViewport();
    }
  }, [scale, dayWidth, paneWidth, range, readViewport, weekStart]);

  // After the range grew at the left, or a pending jump: put the scroll where it belongs before paint.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const pending = pendingScrollRef.current;
    // Only once the grid has the range the position was computed for (a zoom commits before its range does).
    if (!scroller || !pending || pending.range !== range) return;
    pendingScrollRef.current = null;
    scroller.scrollLeft = pending.left;
    readViewport();
  }, [range, readViewport]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => readViewport());
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [readViewport]);

  // Near an edge, the range grows (D763); at the left the scroll moves by the days added, so nothing jumps.
  const onScroll = () => {
    if (scrollerRef.current) lastLeftRef.current = scrollerRef.current.scrollLeft;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      readViewport();
      // The latest render's range and zoom: this frame may run after a re-render the event did not see.
      const live = liveRef.current;
      const width = dayWidthFor(live.scale, phone);
      if (pendingScrollRef.current) return;
      const step = RANGE_PAD[live.scale].step;
      const edge = Math.max(width * 14, scroller.clientWidth);
      if (scroller.scrollLeft < edge && !dragRef.current) {
        const grown = extendRange(live.range, "before", step);
        if (grown.added) {
          pendingScrollRef.current = { left: scroller.scrollLeft + grown.added * width, range: grown.range };
          liveRef.current = { ...live, range: grown.range };
          setRange(grown.range);
        }
      } else if (scroller.scrollLeft + scroller.clientWidth > scroller.scrollWidth - edge) {
        const grown = extendRange(live.range, "after", step);
        if (grown.added) {
          liveRef.current = { ...live, range: grown.range };
          setRange(grown.range);
        }
      }
    });
  };
  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (autoScrollRef.current !== null) window.cancelAnimationFrame(autoScrollRef.current);
  }, []);

  // Ctrl/⌘+wheel (and trackpad pinch, which browsers send as Ctrl+wheel) zooms (D762).
  const scaleChangeRef = useRef({ scale, onScale, last: 0 });
  scaleChangeRef.current = { ...scaleChangeRef.current, scale, onScale };
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const state = scaleChangeRef.current;
      if (Math.abs(event.deltaY) < 4 || event.timeStamp - state.last < 280) return;
      const next = zoomStep(state.scale, event.deltaY < 0 ? -1 : 1);
      state.last = event.timeStamp;
      if (next !== state.scale) state.onScale(next);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  // ---- Drag (D764, D765): pointer capture, transforms in rAF, one PATCH on release. ----

  const showTip = (text: string, x: number, y: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.textContent = text;
    tip.hidden = false;
    const scroller = scrollerRef.current?.getBoundingClientRect();
    const above = !scroller || y - 44 > scroller.top + 56;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(above ? y - 40 : y + 18)}px) translateX(-50%)`;
  };
  const hideTip = () => { if (tipRef.current) tipRef.current.hidden = true; };

  const paint = () => {
    frameRef.current = null;
    const drag = dragRef.current;
    if (!drag || !drag.moved) return;
    const scroller = scrollerRef.current;
    const scrolled = scroller ? scroller.scrollLeft - drag.startScroll : 0;
    if (drag.mode === "create") {
      const lane = drag.el.parentElement!;
      const x = drag.lastX - lane.getBoundingClientRect().left;
      const day = dayAtOffset(range, x, dayWidth);
      const change = createChange(drag.anchor!, day);
      const from = daysBetween(range.from, change.startOn!);
      const days = daysBetween(change.startOn!, change.dueOn!) + 1;
      drag.el.style.transform = `translateX(${from * dayWidth}px)`;
      drag.el.style.width = `${days * dayWidth}px`;
      drag.el.dataset.active = "true";
      showTip(barLabel({ kind: days > 1 ? "range" : "milestone", start: change.startOn!, end: change.dueOn! }).replace(/^Due /, ""), drag.lastX, drag.lastY);
      return;
    }
    const delta = pixelsToDays(drag.lastX - drag.startX + scrolled, dayWidth);
    drag.delta = delta;
    const preview = previewBar(drag.bar!, drag.mode, delta);
    const geometry = barGeometry(preview, range, dayWidth);
    if (geometry) {
      drag.el.style.transform = `translateX(${geometry.left - drag.baseLeft}px)`;
      drag.el.style.width = `${geometry.width}px`;
    }
    showTip(barLabel(preview), drag.lastX, drag.lastY);
  };
  const schedulePaint = () => {
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(paint);
  };

  // While a drag holds the pointer near the grid's left or right edge, the grid scrolls.
  const autoScroll = () => {
    autoScrollRef.current = null;
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag?.moved || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const left = box.left + paneWidth;
    const speed = drag.lastX < left + EDGE_ZONE ? -Math.ceil((left + EDGE_ZONE - drag.lastX) / 4) : drag.lastX > box.right - EDGE_ZONE ? Math.ceil((drag.lastX - (box.right - EDGE_ZONE)) / 4) : 0;
    if (!speed) return;
    scroller.scrollLeft += speed;
    schedulePaint();
    autoScrollRef.current = window.requestAnimationFrame(autoScroll);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, card: BoardCard, bar: TimelineBar | null, mode: Drag["mode"], el: HTMLElement, anchor?: string) => {
    if (event.button !== 0 || !scrollerRef.current) return;
    event.stopPropagation();
    if (editable) event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
    dragRef.current = {
      card, bar, mode, el, anchor, pointerId: event.pointerId, startX: event.clientX, startScroll: scrollerRef.current.scrollLeft,
      baseLeft: el.offsetLeft, baseWidth: el.offsetWidth, delta: 0, moved: false, lastX: event.clientX, lastY: event.clientY
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.moved) {
      if (!editable || Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
      drag.moved = true;
      setDragging(drag.card.id);
    }
    schedulePaint();
    if (autoScrollRef.current === null) autoScrollRef.current = window.requestAnimationFrame(autoScroll);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (frameRef.current !== null) { window.cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    hideTip();
    setDragging(null);
    if (!drag.moved) {
      // A click: the bar or row opens the card; a click on an empty day of an unscheduled row schedules it there.
      if (cancelled) return;
      if (drag.mode === "create" && editable && drag.anchor) onChangeDates(drag.card, createChange(drag.anchor, drag.anchor));
      else if (drag.mode !== "create") onOpenCard(drag.card);
      return;
    }
    const reset = () => {
      drag.el.style.transform = "";
      drag.el.style.width = "";
      delete drag.el.dataset.active;
    };
    if (cancelled) return reset();
    if (drag.mode === "create") {
      const lane = drag.el.parentElement!;
      const day = dayAtOffset(range, event.clientX - lane.getBoundingClientRect().left, dayWidth);
      reset();
      onChangeDates(drag.card, createChange(drag.anchor!, day));
      return;
    }
    const scrolled = scrollerRef.current ? scrollerRef.current.scrollLeft - drag.startScroll : 0;
    const delta = pixelsToDays(event.clientX - drag.startX + scrolled, dayWidth);
    const change = dragChange(drag.card, drag.bar!, drag.mode, delta);
    if (!change) return reset();
    // Leave the bar where it was dropped: the optimistic render sets the same left and width.
    const geometry = barGeometry(previewBar(drag.bar!, drag.mode, delta), range, dayWidth);
    drag.el.style.transform = "";
    if (geometry) {
      drag.el.style.left = `${geometry.left}px`;
      drag.el.style.width = `${geometry.width}px`;
    }
    onChangeDates(drag.card, change);
  };

  const barKeyDown = (event: ReactKeyboardEvent<HTMLElement>, card: BoardCard, bar: TimelineBar) => {
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      onOpenCard(card);
      return;
    }
    if (readOnly || !event.altKey || event.ctrlKey || event.metaKey) return;
    const step = keyboardDrag(event.key, event.shiftKey);
    if (!step) return;
    event.preventDefault();
    const change = dragChange(card, bar, step.mode, step.delta);
    if (change) onChangeDates(card, change);
  };

  const toggleGroup = (key: string) => setCollapsedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  // ---- Pane resize ----
  const resizeRef = useRef<{ x: number; width: number } | null>(null);
  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { x: event.clientX, width: pane.width };
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    setPane({ width: Math.max(PANE_MIN, Math.min(PANE_MAX, start.width + event.clientX - start.x)), collapsed: false });
  };
  const onResizeUp = () => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    savePane({ ...pane, collapsed: false });
  };
  const onResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
    if (!step) return;
    event.preventDefault();
    savePane({ width: Math.max(PANE_MIN, Math.min(PANE_MAX, pane.width + step)), collapsed: false });
  };

  const groupOptions = [{ value: "none", label: "No grouping" }, ...BOARD_GROUPS
    .filter((id) => id !== "parent" || group === "parent" || (board.structure?.levels.length ?? 1) > 1)
    .map((id) => ({ value: id, label: GROUP_DIMENSIONS[id].label }))];

  const style = { "--tl-day": `${dayWidth}px`, "--tl-pane": `${paneWidth}px`, "--tl-row": `${rowHeight}px`, "--tl-grid": `${gridWidth}px` } as CSSProperties;
  const cardCount = cards.length;
  const scheduled = useMemo(() => cards.filter((card) => bars.get(card.id)).length, [cards, bars]);

  return <div className={`task-timeline scale-${scale}${phone ? " phone" : ""}${pane.collapsed && !phone ? " pane-collapsed" : ""}${dragging ? " is-dragging" : ""}`} style={style}>
    <KeyboardMoveHint id="task-tl-keys">Press Alt with the left or right arrow to move a bar a day; add Shift to change its due date.</KeyboardMoveHint>
    <div className="task-tl-toolbar">
      <div className="task-tl-toolbar-start">
        <button type="button" className="secondary-button task-tl-today" onClick={() => scrollToDay(today, { smooth: true, align: phone ? dayWidth : undefined })}><Crosshair aria-hidden="true" />Today</button>
        <h2 className="task-tl-title" aria-live="polite">{visibleTitle(visibleFrom, visibleTo)}</h2>
      </div>
      <div className="task-tl-toolbar-end">
        {!phone && <span className="task-tl-count">{scheduled === cardCount ? cardCountLabel(cardCount) : `${scheduled} of ${cardCountLabel(cardCount)} scheduled`}</span>}
        <Select<string> variant="chip" label="Group by" value={group ?? "none"} searchable={false} className="task-tl-group"
          options={groupOptions.map((option) => ({ ...option, label: option.value === "none" ? "Group: None" : `Group: ${option.label}` }))}
          onChange={(value) => onGroup(value === "none" ? null : value as BoardGroupId)} />
        <div className="task-cal-layout task-tl-scale" role="radiogroup" aria-label="Zoom">
          {TIMELINE_SCALES.map((value) => <button key={value} type="button" role="radio" aria-checked={scale === value} className={scale === value ? "active" : undefined}
            onClick={() => { if (scale !== value) onScale(value); }}>{SCALE_LABELS[value]}</button>)}
        </div>
      </div>
    </div>

    <div className="task-tl-frame">
      <div className="task-tl-scroller" ref={scrollerRef} onScroll={onScroll} role="region" aria-label="Timeline" tabIndex={-1}>
        <div className="task-tl-canvas" style={{ width: totalWidth, height: 56 + rows.length * rowHeight + footer }}>
          <div className="task-tl-head" style={{ width: totalWidth }}>
            <div className="task-tl-head-pane">
              {paneWidth > 0 && <>
                <span className="task-tl-head-title">{phone ? "Card" : "Cards"}</span>
                {!phone && <span className="task-tl-head-duration">Duration</span>}
              </>}
              {!phone && <button type="button" className="icon-button task-tl-pane-toggle" onClick={() => savePane({ ...pane, collapsed: !pane.collapsed })}
                aria-label={pane.collapsed ? "Show the card list" : "Hide the card list"} title={pane.collapsed ? "Show the card list" : "Hide the card list"} aria-expanded={!pane.collapsed}>
                {pane.collapsed ? <ChevronsRight /> : <ChevronsLeft />}
              </button>}
            </div>
            <div className="task-tl-head-grid" aria-hidden="true">
              <div className="task-tl-months">
                {header.top.map((span) => <div key={span.key} className="task-tl-month" style={{ left: span.start * dayWidth, width: span.days * dayWidth }}><span>{span.label}</span></div>)}
              </div>
              <div className="task-tl-days">
                {header.bottom.map((tick) => <div key={tick.key} className={`task-tl-day${tick.weekend ? " weekend" : ""}${tick.today ? " today" : ""}`} style={{ left: tick.start * dayWidth, width: tick.days * dayWidth }}>
                  {scale === "quarter" ? <span className="task-tl-day-num">{tick.sub} {tick.label}</span> : <><span className="task-tl-day-initial">{tick.sub}</span><span className="task-tl-day-num">{tick.label}</span></>}
                </div>)}
              </div>
            </div>
          </div>

          <div className="task-tl-body" style={{ height: rows.length * rowHeight + footer }}>
            <div className="task-tl-grid-bg" aria-hidden="true" style={{ backgroundPosition: "0 0" }}>
              {todayIndex >= 0 && todayIndex < range.days && <div className="task-tl-today-col" style={{ left: todayIndex * dayWidth, width: dayWidth }} />}
            </div>
            {rows.slice(first, last + 1).map((row, offset) => {
              const index = first + offset;
              if (row.kind === "group") return <GroupRow key={row.key} row={row} top={index * rowHeight} onToggle={() => toggleGroup(row.key.slice(6))} />;
              const bar = bars.get(row.card.id) ?? null;
              return <CardRow key={row.key} card={row.card} bar={bar} top={index * rowHeight} range={range} dayWidth={dayWidth} today={today}
                status={statuses.get(row.card.column_id) ?? null} columnName={columnNames.get(row.card.column_id) ?? ""} showPane={paneWidth > 0} phone={phone}
                side={bar ? offscreenSide(bar, visibleFrom, visibleTo) : null} editable={editable} readOnly={readOnly} dragging={dragging === row.card.id}
                onOpen={onOpenCard} onScrollTo={(day) => scrollToDay(day, { smooth: true, align: dayWidth * 2 })}
                onBarPointerDown={(event, mode, el) => beginDrag(event, row.card, bar, mode, el)}
                onLanePointerDown={(event, el, day) => beginDrag(event, row.card, null, "create", el, day)}
                onPointerMove={moveDrag} onPointerUp={(event) => endDrag(event)} onPointerCancel={(event) => endDrag(event, true)}
                onBarKeyDown={barKeyDown} />;
            })}
            {onAddCard && <div className="task-tl-add-row" style={{ top: rows.length * rowHeight }}>
              <button type="button" className="task-tl-add" onClick={onAddCard}><Plus aria-hidden="true" /><span>Add a card</span></button>
            </div>}
          </div>
          {!rows.length && <p className="task-view-empty task-tl-empty">{filtered ? "No cards match these filters." : "No cards yet. Add one with New card."}</p>}
        </div>
      </div>
      {!phone && !pane.collapsed && <div className="task-tl-resize" role="separator" aria-orientation="vertical" aria-label="Resize the card list" tabIndex={0}
        aria-valuemin={PANE_MIN} aria-valuemax={PANE_MAX} aria-valuenow={pane.width}
        onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} onKeyDown={onResizeKey} />}
    </div>
    <div ref={tipRef} className="task-tl-tip" role="status" hidden />
  </div>;
}

const GroupRow = memo(function GroupRow({ row, top, onToggle }: { row: Extract<TimelineRow<BoardCard>, { kind: "group" }>; top: number; onToggle: () => void }) {
  return <div className="task-tl-row task-tl-group-row" style={{ top }}>
    <div className="task-tl-pane-cell task-tl-group-cell">
      <button type="button" className="task-tl-group-toggle" aria-expanded={!row.collapsed} onClick={onToggle}>
        {row.collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        <span className="task-group-name">{row.label}</span>
        <span className="task-group-count" aria-label={cardCountLabel(row.count)}>{row.count}</span>
      </button>
    </div>
    <div className="task-tl-lane task-tl-group-lane" />
  </div>;
});

type CardRowProps = {
  card: BoardCard;
  bar: TimelineBar | null;
  top: number;
  range: TimelineRange;
  dayWidth: number;
  today: string;
  status: ColumnStatus | null;
  columnName: string;
  showPane: boolean;
  phone: boolean;
  side: "before" | "after" | null;
  editable: boolean;
  readOnly: boolean;
  dragging: boolean;
  onOpen: (card: BoardCard) => void;
  onScrollTo: (day: string) => void;
  onBarPointerDown: (event: ReactPointerEvent<HTMLElement>, mode: DragMode, el: HTMLElement) => void;
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>, el: HTMLElement, day: string) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onBarKeyDown: (event: ReactKeyboardEvent<HTMLElement>, card: BoardCard, bar: TimelineBar) => void;
};

function CardRow({ card, bar, top, range, dayWidth, today, status, columnName, showPane, phone, side, editable, readOnly, dragging, onOpen, onScrollTo,
  onBarPointerDown, onLanePointerDown, onPointerMove, onPointerUp, onPointerCancel, onBarKeyDown }: CardRowProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const geometry = bar ? barGeometry(bar, range, dayWidth) : null;
  const done = status?.kind === "done";
  const overdue = !done && bar?.end !== null && bar?.end !== undefined && bar.end < today;
  const key = cardKeyOf(card);
  const label = bar ? `${card.title}, ${barLabel(bar)}${done ? ", done" : ""}` : `${card.title}, no dates`;
  // Narrow bars carry their title outside, to the right.
  const inside = geometry ? geometry.width >= Math.min(200, card.title.length * 6.6 + 26) && bar?.kind !== "milestone" : false;

  const laneMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerMove(event);
    const ghost = ghostRef.current;
    if (!ghost || bar) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    ghost.style.setProperty("--tl-ghost-x", `${Math.floor(x / dayWidth) * dayWidth}px`);
  };

  return <div className={`task-tl-row${dragging ? " dragging" : ""}${done ? " done" : ""}`} style={{ top }} data-card-id={card.id}>
    <div className="task-tl-pane-cell">
      {showPane && <>
        <button type="button" className="task-tl-open" data-open-card={card.id} onClick={() => onOpen(card)} title={card.title}>
          {status && <ColumnStatusIcon status={status} />}
          {/* Phones stack the key under the title so the narrow column shows the title, not the key. */}
          {phone
            ? <span className="task-tl-stack"><span className="task-tl-name">{card.title}</span>{key && <span className="task-tl-key">{key}</span>}</span>
            : <>{key && <span className="task-tl-key">{key}</span>}<span className="task-tl-name">{card.title}</span></>}
          {!phone && <FlagIcons flags={card.flags} priority={card.priority} />}
          <span className="sr-only">, {columnName}</span>
        </button>
        {!phone && <span className={`task-tl-duration${bar ? "" : " empty"}`}>{bar ? durationLabel(bar) : "—"}</span>}
      </>}
    </div>
    <div className={`task-tl-lane${!bar && editable ? " can-create" : ""}${side ? " offscreen" : ""}`}
      onPointerDown={!bar && editable ? (event) => {
        const el = ghostRef.current;
        if (!el) return;
        const day = addDays(range.from, Math.max(0, Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / dayWidth)));
        onLanePointerDown(event, el, day);
      } : undefined}
      onPointerMove={laneMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      {!bar && editable && <div ref={ghostRef} className="task-tl-ghost" aria-hidden="true"><Plus /></div>}
      {bar && geometry && <div ref={barRef} className={`task-tl-bar ${bar.kind} status-${status?.kind ?? "todo"}${overdue ? " overdue" : ""}${geometry.clippedStart ? " clip-start" : ""}${geometry.clippedEnd ? " clip-end" : ""}${editable ? " editable" : ""}`}
        style={{ left: geometry.left, width: geometry.width }}
        role="button" tabIndex={0} data-timeline-bar={card.id} aria-label={label} title={phone ? undefined : label}
        aria-roledescription={readOnly ? "Bar" : "Draggable bar"} aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"}
        aria-describedby={readOnly ? undefined : "task-tl-keys"}
        onPointerDown={(event) => { if (barRef.current) onBarPointerDown(event, "move", barRef.current); }}
        onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        onKeyDown={(event) => onBarKeyDown(event, card, bar)}>
        {bar.kind === "milestone" ? <span className="task-tl-diamond" aria-hidden="true" /> : <span className="task-tl-fill" aria-hidden="true" />}
        {/* Module decorations (D834, C14: Time's logged-vs-estimate fill); none while none is registered. */}
        {bar.kind !== "milestone" && <TimelineDecorationsOutlet card={card} />}
        {inside && <span className="task-tl-bar-title" aria-hidden="true">{card.title}</span>}
        {!inside && <span className="task-tl-bar-label" aria-hidden="true">{card.title}</span>}
        {editable && bar.kind !== "open" && <span className="task-tl-handle start" aria-hidden="true"
          onPointerDown={(event) => { if (barRef.current) onBarPointerDown(event, "start", barRef.current); }} />}
        {editable && <span className="task-tl-handle end" aria-hidden="true"
          onPointerDown={(event) => { if (barRef.current) onBarPointerDown(event, "end", barRef.current); }} />}
      </div>}
      {bar && side === "before" && <button type="button" className="task-tl-jump before" onClick={() => onScrollTo(bar.start)} aria-label={`Scroll to “${card.title}”, ${barLabel(bar)}`} title={barLabel(bar)}><ArrowLeft /></button>}
      {bar && side === "after" && <button type="button" className="task-tl-jump after" onClick={() => onScrollTo(bar.start)} aria-label={`Scroll to “${card.title}”, ${barLabel(bar)}`} title={barLabel(bar)}><ArrowRight /></button>}
    </div>
  </div>;
}
