import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Play, Square } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { elapsedSeconds, TimerChip } from "../ui/time/Duration";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { useRole } from "../team/roleAccess";
import { entryLabel, type TimeEntry } from "../../shared/time";
import { formatDuration } from "../../shared/duration";
import { timeApi } from "./api";
import { BillableSwitch, ProjectSelect, TagsField, WorkItemField, projectDot, type PickedTarget } from "./fields";
import { clock, instantOf, localDay } from "./format";
import { currentTimer, errorText, setRunning, startTimer, stopTimer, timeChanged, useTimer } from "./timerStore";

/**
 * The timer in every app header (§D.2 "Timer chip", D870): idle it is one click to start; running it
 * shows what it tracks and the live time with Stop, and its details open the timer sheet
 * (description, project, work item, billable, tags, start time, and recent entries to continue).
 * ⌥T (Alt+T) starts or stops it anywhere. On phones the chip is the dot, the time, and Stop.
 */

const isPhone = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches;

export function useTimerShortcut(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== "KeyT" || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      const running = currentTimer() !== null;
      if (running) void stopTimer().then((stopped) => { if (stopped) notify.success(`Stopped at ${formatDuration(stopped.durationS)}`); });
      else void startTimer({});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export function TimerTopBar() {
  const { entry, busy, loaded } = useTimer();
  const { role } = useRole();
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(isPhone);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const update = () => setCompact(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  useTimerShortcut(role !== "viewer");
  if (role === "viewer" || !loaded) return null;
  // Phones (§D.2): the running chip is the dot and the time in one button that opens the timer sheet
  // (which has Stop), so the header's account row keeps one line.
  if (compact && entry) return <span className="time-topbar" data-time-running="true">
    <button type="button" className="ui-timer running compact time-topbar-phone" onClick={() => setOpen(true)} aria-label={`Timer running on ${entryLabel(entry) || "no description"}. Open the timer`}>
      <span className="ui-timer-dot" aria-hidden="true" /><PhoneElapsed startedAt={entry.startedAt} />
    </button>
    {open && createPortal(<TimerSheet entry={entry} onClose={() => setOpen(false)} />, document.body)}
  </span>;
  return <span className="time-topbar" data-time-running={entry ? "true" : "false"}>
    <TimerChip compact={compact} disabled={busy} shortcut="Alt+T"
      running={entry ? { startedAt: entry.startedAt, label: entryLabel(entry) || "No description" } : null}
      onStart={() => { void startTimer({}).then((started) => { if (started && !compact) setOpen(true); }); }}
      onStop={() => { void stopTimer().then((stopped) => { if (stopped) notify.success(`Logged ${formatDuration(stopped.durationS)}`); }); }} />
    {entry && <button type="button" className="time-topbar-more" onClick={() => setOpen(true)} aria-label="Timer details" title="Timer details"><ChevronDown aria-hidden="true" /></button>}
    {/* To the body: the sticky header's backdrop filter would hold a fixed sheet inside it. */}
    {open && createPortal(<TimerSheet entry={entry} onClose={() => setOpen(false)} />, document.body)}
  </span>;
}

/** The phone chip's live time (TimerChip's own format and tick: once a second while visible). */
function PhoneElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === "visible") setNow(Date.now()); }, 1000);
    return () => window.clearInterval(id);
  }, []);
  // H:MM on phones: the header's account row has room for about 70 px here.
  return <time className="ui-timer-elapsed ui-tabular">{formatDuration(elapsedSeconds(startedAt, now), "colon", { seconds: true }).replace(/:\d\d$/, "")}</time>;
}

const targetOf = (entry: TimeEntry | null): PickedTarget => entry?.target && !("hidden" in entry.target) ? { kind: entry.target.kind, id: entry.target.id, summary: entry.target } : null;

/** The running timer's details, or what to start, with recent entries to continue. */
export function TimerSheet({ entry, onClose }: { entry: TimeEntry | null; onClose: () => void }) {
  const formId = useId();
  const [description, setDescription] = useState(entry?.description ?? "");
  const [projectId, setProjectId] = useState<string | null>(entry?.project?.id ?? null);
  const [target, setTargetState] = useState<PickedTarget>(targetOf(entry));
  // The running timer keeps a work item the person cannot open unless they change it here (TG1, D1140).
  const [targetTouched, setTargetTouched] = useState(entry === null);
  const setTarget = (next: PickedTarget) => { setTargetState(next); setTargetTouched(true); };
  const [billable, setBillable] = useState(entry?.billable ?? false);
  const [tags, setTags] = useState<string[]>(entry?.tags ?? []);
  const [startText, setStartText] = useState(entry ? clock(entry.startedAt) : "");
  const [recent, setRecent] = useState<TimeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => { void timeApi.recent().then((body) => setRecent(body.entries), () => undefined); }, []);

  const body = () => {
    let startedAt: string | undefined;
    if (startText && entry && startText !== clock(entry.startedAt)) {
      let at = instantOf(localDay(entry.startedAt), startText);
      if (at !== null && at > Date.now()) at -= 86_400_000;
      if (at === null) throw new Error("Write the start as HH:MM");
      startedAt = new Date(at).toISOString();
    }
    return { description, projectId, ...(targetTouched ? { target: target ? { kind: target.kind, id: target.id } : null } : {}), billable, tags, ...(startedAt ? { startedAt } : {}) };
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (entry) {
        const result = await timeApi.update(entry.id, body());
        setRunning(result.entry);
        timeChanged();
      } else {
        await startTimer(body());
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && !("status" in reason) ? reason.message : errorText(reason, "Could not save the timer"));
    } finally {
      setBusy(false);
    }
  };

  return <ModalDialog title={entry ? "Timer" : "Start a timer"} onClose={onClose} variant="sheet" busy={busy} className="time-sheet">
    <form noValidate id={formId} className="time-sheet-body" onSubmit={(event) => { void save(event); }}>
      <div className="ui-field">
        <label htmlFor={`${formId}-description`}>What are you working on?</label>
        <input id={`${formId}-description`} value={description} autoFocus maxLength={500} placeholder="Description" onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="time-sheet-grid">
        <ProjectSelect value={projectId} current={entry?.project ?? null} onChange={(id, project) => { setProjectId(id); if (!entry) setBillable(project?.billableDefault ?? false); }} />
        <WorkItemField value={target} onChange={setTarget} />
      </div>
      <div className="time-sheet-row">
        {entry && <div className="ui-field time-start-field">
          <label htmlFor={`${formId}-start`}>Started at</label>
          <input id={`${formId}-start`} value={startText} inputMode="numeric" placeholder="09:00" onChange={(event) => setStartText(event.target.value)} />
        </div>}
        <BillableSwitch value={billable} onChange={setBillable} />
      </div>
      <TagsField value={tags} onChange={setTags} />
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      {recent.length > 0 && <section className="time-recent" aria-label="Continue a recent entry">
        <h3>Continue</h3>
        <ul>
          {recent.map((item) => <li key={item.id}>
            <button type="button" disabled={busy} onClick={() => { void startTimer({ description: item.description, projectId: item.project?.id ?? null, target: item.target && !("hidden" in item.target) ? { kind: item.target.kind, id: item.target.id } : null, billable: item.billable, tags: item.tags }).then((started) => { if (started) onClose(); }); }}>
              <Play aria-hidden="true" />
              <span className="time-recent-text"><strong>{entryLabel(item) || "No description"}</strong>{item.project && <small>{projectDot(item.project.color)}{item.project.name}</small>}</span>
            </button>
          </li>)}
        </ul>
      </section>}
    </form>
    <footer className="time-sheet-footer">
      {entry && <button type="button" className="secondary-button time-stop-button" disabled={busy} onClick={() => { void stopTimer().then((stopped) => { if (stopped) { notify.success(`Logged ${formatDuration(stopped.durationS)}`); onClose(); } }); }}><Square aria-hidden="true" />Stop</button>}
      <span className="time-sheet-spacer" />
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form={formId} className="action-button" disabled={busy}>{entry ? "Save" : "Start"}</button>
    </footer>
  </ModalDialog>;
}
