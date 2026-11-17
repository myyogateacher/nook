import { useCallback, useEffect, useId, useState } from "react";
import { Clock, Play, Plus, Square } from "lucide-react";
import { ProgressBar } from "../ui/progress/Progress";
import { DurationChip, DurationInput } from "../ui/time/Duration";
import { notify } from "../ui/notify";
import { useRole } from "../team/roleAccess";
import { useUnitPreferences } from "../ui/units";
import { formatDuration } from "../../shared/duration";
import type { TargetTime } from "../../shared/time";
import type { CardSlotCard, CardSlotProps } from "../ui/cardSlots";
import type { ItemSlotProps } from "../ui/itemSlots";
import { timeApi } from "./api";
import { dayLabel, localDay } from "./format";
import { errorText, onTimeChanged, startTimer, stopTimer, timeChanged, useTimer } from "./timerStore";
import "./time.css";

/**
 * Time on Tasks cards, through the card slots (D834, C12, C14), never by editing src/tasks:
 *
 * - the card dialog's **Time** section: logged total against the estimate on boards that estimate in
 *   hours ("3h 20m of 5h"), Start/Stop for this card, Log time inline, and the worklog (who, when,
 *   how long, what), totals only for projects that keep entries private (D872);
 * - a ▶ / ■ action in the dialog header;
 * - the card face's "1h 20m" badge once time is logged;
 * - the Timeline bar's logged-vs-estimate fill.
 *
 * Faces and bars ask for many cards at once: ids are batched into one request per frame and kept
 * until something changes time (`onTimeChanged`).
 */

type Totals = { seconds: number; estimateSeconds: number | null; running: boolean };
const cache = new Map<string, Totals>();
const waiting = new Map<string, Set<(totals: Totals | null) => void>>();
let flushTimer: number | null = null;
const totalsListeners = new Set<() => void>();
onTimeChanged(() => { cache.clear(); for (const listener of [...totalsListeners]) listener(); });

function flush() {
  flushTimer = null;
  const ids = [...waiting.keys()].slice(0, 200);
  const callbacks = new Map(ids.map((id) => [id, waiting.get(id)!]));
  for (const id of ids) waiting.delete(id);
  if (waiting.size) flushTimer = window.setTimeout(flush, 0);
  timeApi.cards(ids).then((body) => {
    for (const id of ids) {
      const totals = body.cards[id] ?? null;
      if (totals) cache.set(id, totals);
      for (const callback of callbacks.get(id) ?? []) callback(totals);
    }
  }, () => { for (const id of ids) for (const callback of callbacks.get(id) ?? []) callback(null); });
}

function requestTotals(id: string, callback: (totals: Totals | null) => void) {
  const cached = cache.get(id);
  if (cached) { callback(cached); return; }
  const set = waiting.get(id) ?? new Set();
  set.add(callback);
  waiting.set(id, set);
  flushTimer ??= window.setTimeout(flush, 30);
}

export function useCardTotals(cardId: string): Totals | null {
  const [totals, setTotals] = useState<Totals | null>(() => cache.get(cardId) ?? null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    totalsListeners.add(bump);
    return () => { totalsListeners.delete(bump); };
  }, []);
  useEffect(() => {
    let alive = true;
    requestTotals(cardId, (value) => { if (alive) setTotals(value); });
    return () => { alive = false; };
  }, [cardId, version]);
  return totals;
}

/** The card face asks this before it draws a footer line for the badge (D888, D1386): only once time is logged. */
export function useCardHasTime(card: CardSlotCard) {
  const totals = useCardTotals(card.id);
  return Boolean(totals && (totals.seconds > 0 || totals.running));
}

/** The card face badge: logged time, once there is any (and "of 5h" on hours boards). */
export function CardTimeBadge({ card }: { card: CardSlotCard }) {
  const totals = useCardTotals(card.id);
  if (!totals || (totals.seconds <= 0 && !totals.running)) return null;
  return <span className={`time-face-badge${totals.running ? " running" : ""}`}><DurationChip seconds={totals.seconds} of={totals.estimateSeconds} label={totals.running ? "Logged, timer running" : "Logged"} /></span>;
}

/** The Timeline bar's logged-vs-estimate fill (C14): a band along the bar's bottom edge. */
export function TimelineTimeFill({ card }: { card: CardSlotCard }) {
  const totals = useCardTotals(card.id);
  if (!totals || !totals.estimateSeconds || totals.seconds <= 0) return null;
  const ratio = totals.seconds / totals.estimateSeconds;
  return <span className={`time-tl-fill${ratio > 1 ? " over" : ""}`} style={{ width: `${Math.min(100, ratio * 100)}%` }}
    title={`${formatDuration(totals.seconds)} of ${formatDuration(totals.estimateSeconds)} logged`} aria-hidden="true" />;
}

const isThisCard = (entryTarget: { kind: string; id?: string; hidden?: true } | null | undefined, cardId: string) => Boolean(entryTarget && !("hidden" in entryTarget && entryTarget.hidden) && entryTarget.kind === "card" && entryTarget.id === cardId);

/** ▶ / ■ in the card dialog's header (one click starts the timer on this card). */
export function CardTimerAction({ card }: CardSlotProps) {
  const { entry, busy } = useTimer();
  const { role } = useRole();
  if (role === "viewer") return null;
  const here = isThisCard(entry?.target, card.id);
  return <button type="button" className={`icon-button time-card-action${here ? " running" : ""}`} disabled={busy}
    aria-label={here ? "Stop the timer on this card" : "Start a timer on this card"} title={here ? "Stop timer" : "Start timer"}
    onClick={() => { void (here ? stopTimer() : startTimer({ target: { kind: "card", id: card.id }, description: "" })); }}>
    {here ? <Square /> : <Play />}
  </button>;
}

/** The card dialog's Time section. */
export function CardTimeSection({ card, idPrefix }: CardSlotProps) {
  return <ItemTimePanel kind="card" id={card.id} headingId={`${idPrefix}-time`} reloadKey={card.estimate} variant="card" />;
}

/** Time on another module's item page (src/ui/itemSlots.ts, D1056): goals, contacts, companies, deals, bookings. */
export function ItemTimeSection({ kind, id, readOnly }: ItemSlotProps) {
  return <ItemTimePanel kind={kind} id={id} readOnly={readOnly} />;
}

const isThisItem = (entryTarget: { kind: string; id?: string; hidden?: true } | null | undefined, kind: string, id: string) => Boolean(entryTarget && !("hidden" in entryTarget && entryTarget.hidden) && entryTarget.kind === kind && entryTarget.id === id);
const NOUN: Record<string, string> = { card: "card", goal: "goal", key_result: "key result", contact: "contact", company: "company", deal: "deal", booking: "booking", event: "event" };

/**
 * Time on one work item (C12 cards; C15 goals, contacts, companies, deals, bookings; D1056): the total
 * logged (against the estimate on hours boards), Start/Stop on this item, Log time inline (to the
 * item's default project: a card's board project, a CRM record's client project, D1057), and the
 * worklog. `variant="card"` keeps the card dialog's frame and classes exactly; `page` is the item
 * section frame other modules' pages render through src/ui/itemSlots.ts.
 */
export function ItemTimePanel({ kind, id, headingId, reloadKey, variant = "page", readOnly = false }: { kind: string; id: string; headingId?: string; reloadKey?: unknown; variant?: "card" | "page"; readOnly?: boolean }) {
  const prefs = useUnitPreferences();
  const { entry: running, busy } = useTimer();
  const { role } = useRole();
  const [data, setData] = useState<TargetTime | null>(null);
  const [failed, setFailed] = useState(false);
  const [logging, setLogging] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [all, setAll] = useState(false);
  const fieldId = useId();
  const autoHeading = useId();
  const load = useCallback(() => { timeApi.target(kind, id).then((body) => { setData(body); setFailed(false); }, () => setFailed(true)); }, [kind, id]);
  useEffect(() => { load(); return onTimeChanged(load); }, [load, reloadKey]);
  if (failed) return null;
  const card = variant === "card";
  const small = card ? "task-small-button" : "ui-small-button";
  const here = isThisItem(running?.target, kind, id);
  const canLog = role !== "viewer" && !readOnly;
  const heading = headingId ?? `${autoHeading}-time`;
  const target = { kind, id };
  const noun = NOUN[kind] ?? "item";

  const log = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!duration) { notify.warning("Type how long, such as 1h30 or 45m"); return; }
    setSaving(true);
    try {
      await timeApi.create({ startedAt: new Date(Date.now() - duration * 1000).toISOString(), duration, description, target, ...(data?.defaultProject ? { projectId: data.defaultProject.id } : {}) });
      timeChanged();
      notify.success(`Logged ${formatDuration(duration, prefs.durationFormat)}`);
      setDuration(null);
      setDescription("");
      setLogging(false);
    } catch (reason) {
      notify.error(errorText(reason, "Could not log time"));
    } finally {
      setSaving(false);
    }
  };

  const shown = all ? data?.entries ?? [] : (data?.entries ?? []).slice(0, 5);
  const buttons = canLog && <span className="time-card-buttons">
    <button type="button" className={`secondary-button ${small}${here ? " time-running-button" : ""}`} disabled={busy} {...(card ? {} : { "aria-label": here ? `Stop the timer on this ${noun}` : `Start a timer on this ${noun}` })}
      onClick={() => { void (here ? stopTimer() : startTimer({ target })); }}>
      {here ? <><Square aria-hidden="true" />Stop</> : <><Play aria-hidden="true" />Start</>}
    </button>
    {!logging && <button type="button" className={`secondary-button ${small}`} onClick={() => setLogging(true)}><Plus aria-hidden="true" />Log time</button>}
  </span>;
  return <section className={card ? "task-card-section time-card-section" : "ui-item-section time-item-section"} aria-labelledby={heading}>
    <header className={card ? undefined : "ui-panel-header"}>
      <h3 id={heading}><Clock aria-hidden="true" />Time</h3>
      {buttons}
    </header>
    {!data && <p className={card ? "task-comment-empty" : "ui-panel-loading"} role="status">Loading time…</p>}
    {data && <>
      {data.estimateSeconds !== null
        ? <ProgressBar value={data.estimateSeconds ? data.totalSeconds / data.estimateSeconds : 0} label="Logged against the estimate" meter
          valueText={`${formatDuration(data.totalSeconds, prefs.durationFormat)} of ${formatDuration(data.estimateSeconds, prefs.durationFormat)}`}
          tone={data.estimateSeconds && data.totalSeconds > data.estimateSeconds ? "danger" : data.estimateSeconds && data.totalSeconds >= data.estimateSeconds * 0.8 ? "warning" : "accent"} />
        : <p className="time-card-total ui-tabular"><strong>{formatDuration(data.totalSeconds, prefs.durationFormat)}</strong> logged{data.mySeconds ? `, ${formatDuration(data.mySeconds, prefs.durationFormat)} by you` : ""}</p>}
      {logging && <form noValidate className="time-card-log" onSubmit={(event) => { void log(event); }}>
        <DurationInput label="How long" value={duration} onChange={setDuration} placeholder="1h 30m" />
        <div className="ui-field">
          <label htmlFor={`${fieldId}-what`}>What did you do?</label>
          <input id={`${fieldId}-what`} value={description} maxLength={500} placeholder="Optional" onChange={(event) => setDescription(event.target.value)} />
        </div>
        {data.defaultProject && <p className="time-note">Goes to {data.defaultProject.name}.</p>}
        <div className="time-card-log-actions">
          <button type="button" className={`secondary-button ${small}`} onClick={() => setLogging(false)}>Cancel</button>
          <button type="submit" className={`action-button ${small}`} disabled={saving}>Log</button>
        </div>
      </form>}
      {data.privateEntries && <p className="time-note">Some time is on a project that shows {noun} readers totals only.</p>}
      {data.entries.length > 0
        ? <ul className="time-worklog" aria-label="Worklog">
          {shown.map((item) => <li key={item.id}>
            <span className="time-worklog-who">{item.user.name}</span>
            <span className="time-worklog-when">{dayLabel(localDay(item.startedAt))}</span>
            <span className="time-worklog-duration ui-tabular">{item.running ? "running" : formatDuration(item.durationS, prefs.durationFormat)}</span>
            {item.description && <span className="time-worklog-what">{item.description}</span>}
          </li>)}
          {data.entries.length > 5 && <li><button type="button" className="ui-text-button" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${data.entries.length}`}</button></li>}
        </ul>
        : !logging && data.totalSeconds === 0 && <p className={card ? "task-comment-empty" : "time-note"}>No time logged yet.{canLog ? " Start the timer or log time." : ""}</p>}
    </>}
  </section>;
}
