import { useState, type FormEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select, type Option } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { cadenceText, type Cadence } from "../../shared/routineSchedule";
import { REPORT_LIMITS, type ReportRun } from "../../shared/reports";
import type { ScheduleView } from "../../shared/reportsView";
import { RUN_STATUS_TEXT, runLabel, saveSchedule, timeAgo } from "./reportViewApi";
import { codeOf, messageOf } from "./reportsApi";

type Repeat = Exclude<Cadence, "manual">;
const REPEAT_OPTIONS: Option<Repeat>[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays (Mon–Fri)" },
  { value: "weekly", label: "Once a week" }
];
const WEEKDAY_OPTIONS: Option[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ value: String(index), label }));
const MINUTE_OPTIONS: Option[] = Array.from({ length: 12 }, (_, index) => { const minute = String(index * 5).padStart(2, "0"); return { value: minute, label: `:${minute} past each hour` }; });

export const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

type Form = { enabled: boolean; cadence: Repeat; time: string; minute: string; weekday: string; tz: string };

/** The form a schedule opens with: off by default; a new one suggests every weekday at 08:00 in the browser's zone. */
export function scheduleForm(schedule: ScheduleView | null, zone = browserZone()): Form {
  const cadence: Repeat = schedule && schedule.cadence !== "manual" ? schedule.cadence as Repeat : "weekdays";
  return {
    enabled: schedule?.enabled ?? false,
    cadence,
    time: cadence !== "hourly" && schedule?.atTime ? schedule.atTime : "08:00",
    minute: cadence === "hourly" && schedule?.atTime ? schedule.atTime.slice(3, 5) : "00",
    weekday: String(schedule?.weekday ?? 1),
    tz: schedule && schedule.cadence !== "manual" ? schedule.tz : zone
  };
}

/** What a form saves: off is the chosen cadence kept but not running. */
export function scheduleInput(form: Form) {
  return {
    cadence: form.cadence,
    atTime: form.cadence === "hourly" ? `00:${form.minute}` : form.time,
    weekday: form.cadence === "weekly" ? Number(form.weekday) : null,
    tz: form.tz,
    enabled: form.enabled
  };
}

/** The page's schedule badge: "Weekdays at 08:00", "Not scheduled", or the auto-off warning. */
export function scheduleBadge(schedule: ScheduleView | null) {
  if (!schedule) return null;
  if (schedule.autoDisabled) return { text: `Schedule off after ${REPORT_LIMITS.scheduleFailures} failures`, tone: "error" as const };
  if (!schedule.enabled) return null;
  return { text: cadenceText({ cadence: schedule.cadence as Cadence, atTime: schedule.atTime, weekday: schedule.weekday }), tone: schedule.failCount ? "stale" as const : "ready" as const };
}

type Props = {
  /** Forward after Back shows the sheet again. */
  reopen?: () => void;
  reportId: string;
  schedule: ScheduleView | null;
  runs: ReportRun[];
  canWrite: boolean;
  onSaved: (schedule: ScheduleView) => void;
  onClose: () => void;
};

/**
 * Schedule and run history (plan wave 47): an optional cadence (off by default) with the time of day,
 * weekday, and zone, and the report's last 20 runs with their outcome. Back closes it.
 */
export function ScheduleSheet({ reportId, schedule, runs, canWrite, onSaved, onClose, reopen }: Props) {
  const zone = browserZone();
  const [form, setForm] = useState<Form>(() => scheduleForm(schedule, zone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen });
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.enabled && form.cadence !== "hourly" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return setError("Choose a time of day.");
    setBusy(true);
    setError(null);
    try {
      onSaved((await saveSchedule(reportId, scheduleInput(form))).schedule);
    } catch (reason) {
      setError(codeOf(reason).code === "NOT_FOUND" ? "Only the report's owner can schedule it." : messageOf(reason, "Could not save the schedule"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Schedule and runs" eyebrow="Reports" onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-schedule">
    <form className="file-dialog-form" onSubmit={submit} noValidate>
      {schedule?.autoDisabled && <p className="report-badge-line report-badge-error" role="status"><TriangleAlert aria-hidden="true" />The schedule turned itself off after {REPORT_LIMITS.scheduleFailures} failed runs in a row. Fix the cause, then turn it on again.</p>}
      <fieldset disabled={!canWrite || busy} className="report-schedule-fields">
        <label className="reports-check"><input type="checkbox" checked={form.enabled} onChange={(event) => set("enabled", event.target.checked)} />Refresh automatically</label>
        {form.enabled && <>
          <div className="report-schedule-row">
            <div className="report-field"><span id="report-repeat-label">Repeats</span>
              <Select labelledBy="report-repeat-label" label="Repeats" value={form.cadence} onChange={(value) => set("cadence", value)} options={REPEAT_OPTIONS} disabled={!canWrite || busy} />
            </div>
            {form.cadence === "weekly" && <div className="report-field"><span id="report-weekday-label">On</span>
              <Select labelledBy="report-weekday-label" label="On" value={form.weekday} onChange={(value) => set("weekday", value)} options={WEEKDAY_OPTIONS} disabled={!canWrite || busy} />
            </div>}
            {form.cadence === "hourly"
              ? <div className="report-field"><span id="report-minute-label">At</span>
                <Select labelledBy="report-minute-label" label="At" value={form.minute} onChange={(value) => set("minute", value)} options={MINUTE_OPTIONS} disabled={!canWrite || busy} />
              </div>
              : <label className="report-field">At<input type="time" value={form.time} onChange={(event) => set("time", event.target.value)} required /></label>}
          </div>
          <label className="report-field">Time zone<input value={form.tz} onChange={(event) => set("tz", event.target.value.trim())} maxLength={64} autoComplete="off" spellCheck={false} /></label>
          {form.tz !== zone && <button type="button" className="secondary-button report-zone" onClick={() => set("tz", zone)}>Use {zone}</button>}
        </>}
      </fieldset>
      {schedule?.enabled && schedule.nextDueAt && <p className="file-dialog-hint">Next refresh {new Date(schedule.nextDueAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{schedule.failCount ? ` · ${schedule.failCount} failed in a row` : ""}.</p>}
      <p className="file-dialog-hint">Scheduled refreshes re-run the saved SQL as you; no AI runs. After {REPORT_LIMITS.scheduleFailures} failures in a row the schedule turns itself off.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Close</button>
        {canWrite && <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save schedule"}</button>}
      </footer>
    </form>
    <section className="report-runs" aria-labelledby="report-runs-title">
      <h3 id="report-runs-title">Recent runs</h3>
      {runs.length === 0 ? <p className="file-dialog-hint">No runs yet.</p> : <ol className="report-run-list">
        {runs.map((run) => <li key={run.id}>
          <span className={`reports-status report-run-${run.status}`}>{RUN_STATUS_TEXT[run.status]}</span>
          <span className="report-run-copy"><strong>{runLabel(run)}</strong><small>{timeAgo(run.startedAt)}{run.finishedAt ? ` · took ${Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 100) / 10)} s` : ""}</small>{run.error && <small className="report-run-error-text">{run.error}</small>}</span>
        </li>)}
      </ol>}
    </section>
  </ModalDialog>;
}
