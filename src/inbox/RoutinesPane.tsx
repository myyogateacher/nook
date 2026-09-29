import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Pause, Play, Plus, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "../api";
import { trapTabKey, useDialogFocus } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { Combobox } from "../ui/Combobox";
import { Select, type Option } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import {
  createRoutine,
  deleteRoutine,
  listInboxKeys,
  listRoutines,
  listRuns,
  setRoutineEnabled,
  updateRoutine,
  type InboxKey,
  type ProposalKind,
  type Routine,
  type RoutineCadence,
  type RoutineInput,
  type RoutineTargets,
  type RunSummary
} from "./inboxApi";
import { dueText, KIND_OPTIONS, runMetrics, runStatusLabel } from "./inboxFormat";

/**
 * Routines (agent inbox Wave 22, §5, §9.2 C): the owner's stored prompts for outside agents. The
 * list is /inbox/routines; the editor (with the routine's run history) is a sheet on that entry, so
 * Back closes an open dropdown sheet first, then a confirm, then the editor (D69). Run summaries and
 * errors are agent text, rendered as text under "Written by the agent" (T127).
 */

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

const CADENCE_OPTIONS: Option<RoutineCadence>[] = [
  { value: "daily", label: "Daily" }, { value: "weekdays", label: "Weekdays (Mon–Fri)" }, { value: "weekly", label: "Weekly" },
  { value: "hourly", label: "Hourly" }, { value: "manual", label: "Manual only", description: "Never due; start it yourself" }
];
const WEEKDAY_OPTIONS: Option[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ value: String(index), label }));
const MINUTE_OPTIONS: Option[] = Array.from({ length: 12 }, (_, index) => { const minute = String(index * 5).padStart(2, "0"); return { value: minute, label: `:${minute} past each hour` }; });
const ANY_KEY = "any";

type Dialog = { kind: "edit"; routine: Routine | null } | null;

export function RoutinesPane({ canWrite, flash }: { canWrite: boolean; flash: (message: string) => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The button that opened the sheet gets focus back when it closes (2j).
  const triggerRef = useRef<HTMLElement | null>(null);
  const openSheet = (routine: Routine | null, trigger: HTMLElement) => { triggerRef.current = trigger; setDialog({ kind: "edit", routine }); };
  const closeSheet = useCallback(() => {
    setDialog(null);
    window.requestAnimationFrame(() => { if (triggerRef.current?.isConnected) triggerRef.current.focus(); });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRoutines((await listRoutines()).routines);
    } catch (reason) {
      setError(messageOf(reason, "Could not load routines"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(routine: Routine) {
    setBusy(routine.id);
    try {
      const { routine: updated } = await setRoutineEnabled(routine.id, !routine.enabled);
      setRoutines((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null);
      flash(updated.enabled ? "Routine resumed" : "Routine paused");
    } catch (reason) {
      flash(messageOf(reason, "Could not change the routine"));
    } finally {
      setBusy(null);
    }
  }

  return <section className="inbox-routines" aria-labelledby="inbox-routines-title">
    <header className="inbox-routines-header">
      <h2 id="inbox-routines-title">Routines</h2>
      {canWrite && <button type="button" className="inbox-action primary" onClick={(event) => openSheet(null, event.currentTarget)}><Plus />New routine</button>}
    </header>
    <p className="inbox-muted">A routine is a prompt an agent runs on a schedule. Nook only says when it is due; your MCP client runs it, and every change it suggests waits here for you.</p>

    {error && <div className="inbox-state inbox-error" role="alert">
      <span className="inbox-state-icon"><TriangleAlert /></span>
      <h2>Could not load routines</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !routines && <p className="inbox-loading" role="status">Loading routines…</p>}
    {!error && routines && routines.length === 0 && <div className="inbox-state">
      <span className="inbox-state-icon"><CalendarClock /></span>
      <h2>No routines yet</h2>
      <p>{canWrite ? "Create one, give an MCP key Suggest changes, and point a scheduler or Claude Desktop at it." : "Your team role is read-only, so you cannot create routines."}</p>
    </div>}

    {routines && routines.length > 0 && <ul className="inbox-list">
      {routines.map((routine) => <li key={routine.id}>
        <article className={`inbox-card routine-card${routine.enabled ? "" : " resolved"}`} aria-label={`Routine: ${routine.name}`}>
          <button type="button" className="inbox-card-open" onClick={(event) => openSheet(routine, event.currentTarget)}>
            <span className="inbox-card-top">
              <span className={`inbox-status${routine.due && !routine.running ? " due" : ""}`}>{dueText(routine)}</span>
              {routine.lastRunStatus && <span className={`inbox-status run-${routine.lastRunStatus}`}>Last run: {runStatusLabel(routine.lastRunStatus)}{routine.lastRunAt ? ` · ${relativeTime(routine.lastRunAt)}` : ""}</span>}
            </span>
            <strong className="inbox-card-title">{routine.name}</strong>
            <span className="inbox-card-digest">{routine.scheduleText}{routine.cadence !== "manual" ? ` · ${routine.tz}` : ""}{routine.scheduleNote ? ` · ${routine.scheduleNote}` : ""}</span>
            <span className="inbox-card-meta">{keyText(routine)} · {routine.outputKinds.length} kind{routine.outputKinds.length === 1 ? "" : "s"} · up to {routine.maxProposals} per run</span>
          </button>
          {canWrite && <div className="inbox-card-actions">
            <button type="button" className="inbox-action" onClick={() => { void toggle(routine); }} disabled={busy === routine.id} aria-label={`${routine.enabled ? "Pause" : "Resume"}: ${routine.name}`}>
              {routine.enabled ? <><Pause />Pause</> : <><Play />Resume</>}
            </button>
          </div>}
        </article>
      </li>)}
    </ul>}

    <ClientRecipe />

    {dialog?.kind === "edit" && <RoutineSheet routine={dialog.routine} canWrite={canWrite} onClose={closeSheet} flash={flash}
      onSaved={(saved) => {
        setRoutines((current) => {
          const list = current ?? [];
          const exists = list.some((item) => item.id === saved.id);
          return (exists ? list.map((item) => item.id === saved.id ? saved : item) : [...list, saved]).sort((a, b) => a.name.localeCompare(b.name));
        });
        setDialog({ kind: "edit", routine: saved });
      }}
      onDeleted={(id) => { setRoutines((current) => current?.filter((item) => item.id !== id) ?? null); closeSheet(); flash("Routine deleted"); }} />}
  </section>;
}

function keyText(routine: Pick<Routine, "keyId" | "keyName" | "keyRevoked">) {
  if (!routine.keyId) return "Any key with Suggest changes";
  if (routine.keyRevoked) return `Key “${routine.keyName ?? ""}” (revoked)`;
  return `Key “${routine.keyName ?? ""}”`;
}

/** The four-call loop, for a cron script or Claude Desktop (placeholders only). */
function ClientRecipe() {
  const origin = typeof window === "undefined" ? "https://nook.example" : window.location.origin;
  return <details className="inbox-recipe">
    <summary>Set up your client</summary>
    <p>Add Nook as an MCP server at <code>{origin}/mcp</code> with a key that has <b>Suggest changes</b> and the read permission for what the routine looks at. Then, on your schedule:</p>
    <ol>
      <li><code>list_due_routines</code> — what is due now</li>
      <li><code>start_run</code> with the routineId — the instructions and a two-hour lease</li>
      <li><code>submit_proposals</code> with the runId — up to the routine's limit</li>
      <li><code>finish_run</code> with a short summary</li>
    </ol>
    <p>In Claude Desktop, each routine is also a prompt named <code>routine.&lt;name&gt;</code>.</p>
  </details>;
}

type Form = {
  name: string; instructions: string; outputKinds: ProposalKind[]; pins: string[]; scopeHints: string;
  cadence: RoutineCadence; time: string; minute: string; weekday: string; tz: string; scheduleNote: string; keyId: string;
  maxProposals: string; expireDays: string; enabled: boolean;
};

function formOf(routine: Routine | null): Form {
  const pins = routine?.targets ? [
    ...(routine.targets.boardIds ?? []).map((id) => `board:${id}`), ...(routine.targets.calendarIds ?? []).map((id) => `calendar:${id}`),
    ...(routine.targets.collectionIds ?? []).map((id) => `collection:${id}`), ...(routine.targets.folderIds ?? []).map((id) => `folder:${id}`)
  ] : [];
  return {
    name: routine?.name ?? "", instructions: routine?.instructions ?? "", outputKinds: routine?.outputKinds ?? ["card_create"], pins,
    scopeHints: routine?.scopeHints ?? "", cadence: routine?.cadence ?? "daily",
    time: routine?.cadence !== "hourly" && routine?.atTime ? routine.atTime : "08:00",
    minute: routine?.cadence === "hourly" && routine.atTime ? routine.atTime.slice(3, 5) : "00",
    weekday: String(routine?.weekday ?? 1), tz: routine?.tz ?? browserZone(), scheduleNote: routine?.scheduleNote ?? "",
    keyId: routine?.keyId ?? ANY_KEY, maxProposals: String(routine?.maxProposals ?? 25), expireDays: String(routine?.expireDays ?? 14), enabled: routine?.enabled ?? true
  };
}

function inputOf(form: Form): RoutineInput {
  const targets: RoutineTargets = {};
  for (const pin of form.pins) {
    const [type, id] = pin.split(":") as [string, string];
    const field = ({ board: "boardIds", calendar: "calendarIds", collection: "collectionIds", folder: "folderIds" } as const)[type as "board"];
    if (field) (targets[field] ??= []).push(id);
  }
  return {
    name: form.name, instructions: form.instructions, outputKinds: form.outputKinds, targets: Object.keys(targets).length ? targets : null,
    scopeHints: form.scopeHints.trim() || null, cadence: form.cadence,
    atTime: form.cadence === "manual" ? null : form.cadence === "hourly" ? `00:${form.minute}` : form.time,
    weekday: form.cadence === "weekly" ? Number(form.weekday) : null, tz: form.tz, scheduleNote: form.scheduleNote.trim() || null,
    keyId: form.keyId === ANY_KEY ? null : form.keyId, maxProposals: Number(form.maxProposals), expireDays: Number(form.expireDays), enabled: form.enabled
  };
}

const moduleOfKind = (kind: ProposalKind) => kind.startsWith("card") ? "board" : kind.startsWith("event") ? "calendar" : kind.startsWith("row") ? "collection" : "folder";

/** Boards, calendars, collections, and owned folders the routine may be pinned to, loaded when the sheet opens. */
type PinnableBoard = { id: string; name: string; owner_name?: string; created_at?: string };

/**
 * Board labels for "Only in" (Friction 8): a name shared by several boards gets the owner's name, or
 * the created date when the same person owns both, so the chips and options can be told apart.
 */
export function boardPinLabels(boards: PinnableBoard[]) {
  const byName = new Map<string, PinnableBoard[]>();
  for (const board of boards) byName.set(board.name, [...(byName.get(board.name) ?? []), board]);
  return new Map(boards.map((board) => {
    const twins = byName.get(board.name)!;
    if (twins.length === 1) return [board.id, board.name];
    const ownerIsUnique = board.owner_name && twins.filter((twin) => twin.owner_name === board.owner_name).length === 1;
    if (ownerIsUnique) return [board.id, `${board.name} (${board.owner_name})`];
    const created = board.created_at ? new Date(board.created_at) : null;
    const day = created && !Number.isNaN(created.getTime()) ? created.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    const who = board.owner_name ? `${board.owner_name}, ` : "";
    return [board.id, day ? `${board.name} (${who}created ${day})` : board.name];
  }));
}

function usePinOptions(open: boolean) {
  const [options, setOptions] = useState<Option[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const safe = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
    void Promise.all([
      safe(api<{ boards: PinnableBoard[] }>("/tasks/boards"), { boards: [] }),
      safe(api<{ calendars: Array<{ id: string; name: string }> }>("/calendars"), { calendars: [] }),
      safe(api<{ collections: Array<{ id: string; name: string }> }>("/collections"), { collections: [] }),
      safe(api<{ folders: Array<{ id: string; name: string; is_owner: number }> }>("/folders"), { folders: [] })
    ]).then(([boards, calendars, collections, folders]) => {
      if (!live) return;
      const boardLabels = boardPinLabels(boards.boards);
      setOptions([
        ...boards.boards.map((item) => ({ value: `board:${item.id}`, label: boardLabels.get(item.id) ?? item.name, group: "Boards" })),
        ...calendars.calendars.map((item) => ({ value: `calendar:${item.id}`, label: item.name, group: "Calendars" })),
        ...collections.collections.map((item) => ({ value: `collection:${item.id}`, label: item.name, group: "Collections" })),
        ...folders.folders.filter((item) => item.is_owner === 1).map((item) => ({ value: `folder:${item.id}`, label: item.name, group: "Folders" }))
      ]);
    });
    return () => { live = false; };
  }, [open]);
  return options;
}

function RoutineSheet({ routine, canWrite, onClose, onSaved, onDeleted, flash }: {
  routine: Routine | null; canWrite: boolean; onClose: () => void; onSaved: (routine: Routine) => void; onDeleted: (id: string) => void; flash: (message: string) => void;
}) {
  const [form, setForm] = useState<Form>(() => formOf(routine));
  const [keys, setKeys] = useState<InboxKey[]>([]);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pinOptions = usePinOptions(true);
  const readOnly = !canWrite;
  const sheetRef = useRef<HTMLDivElement>(null);
  // D69 at every width (2i): a deep link's Back closes an open dropdown, then a confirm, then the sheet.
  useHistoryDialogGuard(true, onClose);
  useDialogFocus(sheetRef);
  useEffect(() => { setForm(formOf(routine)); setError(""); }, [routine]);
  useEffect(() => {
    listInboxKeys().then(({ keys: items }) => setKeys(items.filter((key) => (key.effectiveScopes ?? key.scopes).includes("inbox:write")))).catch(() => setKeys([]));
  }, []);
  useEffect(() => {
    if (!routine) { setRuns(null); return; }
    let live = true;
    listRuns(routine.id).then(({ runs: items }) => { if (live) setRuns(items); }).catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [routine]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy && !confirmDelete && !document.querySelector("[role=listbox]")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, confirmDelete, onClose]);

  const set = <K extends keyof Form>(field: K, value: Form[K]) => setForm((current) => ({ ...current, [field]: value }));
  const keyOptions = useMemo<Option[]>(() => {
    const items: Option[] = [{ value: ANY_KEY, label: "Any key with Suggest changes" }, ...keys.map((key) => ({ value: key.id, label: key.name }))];
    if (routine?.keyId && !keys.some((key) => key.id === routine.keyId)) items.push({ value: routine.keyId, label: `${routine.keyName ?? "Key"} (unavailable)`, disabled: true });
    return items;
  }, [keys, routine]);
  const shownPins = useMemo(() => {
    const modules = new Set<string>(form.outputKinds.map(moduleOfKind));
    return pinOptions.filter((option) => modules.has(option.value.split(":")[0]!));
  }, [pinOptions, form.outputKinds]);
  const zone = browserZone();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    if (form.outputKinds.length === 0) { setError("Choose at least one kind of change"); return; }
    setBusy(true);
    setError("");
    try {
      // Pins only for modules the routine may still touch.
      const modules = new Set<string>(form.outputKinds.map(moduleOfKind));
      const input = inputOf({ ...form, pins: form.pins.filter((pin) => modules.has(pin.split(":")[0]!)) });
      const { routine: saved } = routine ? await updateRoutine(routine.id, { ...input, revision: routine.revision }) : await createRoutine(input);
      flash(routine ? "Routine saved" : "Routine created");
      onSaved(saved);
    } catch (reason) {
      setError(messageOf(reason, "Could not save the routine"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!routine) return;
    setBusy(true);
    try {
      await deleteRoutine(routine.id);
      setConfirmDelete(false);
      onDeleted(routine.id);
    } catch (reason) {
      setError(messageOf(reason, "Could not delete the routine"));
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return <>
    <button type="button" className="panel-scrim inbox-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close" tabIndex={-1} />
    <div ref={sheetRef} tabIndex={-1} className="inbox-dialog inbox-sheet" role="dialog" aria-modal="true" aria-labelledby="routine-sheet-title" onKeyDown={trapTabKey}>
      <header>
        <h2 id="routine-sheet-title">{routine ? routine.name : "New routine"}</h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      <form onSubmit={submit}>
        <fieldset disabled={readOnly || busy} className="routine-fields">
          <label className="inbox-field">Name<input value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={80} required /></label>
          <label className="inbox-field">Instructions (the prompt your agent runs)<textarea value={form.instructions} onChange={(event) => set("instructions", event.target.value)} rows={6} required /></label>
          <div className="inbox-field"><span id="routine-kinds-label">Can suggest</span>
            <Combobox multiple label="Can suggest" placeholder="Choose kinds of change…" value={form.outputKinds} onChange={(value) => set("outputKinds", value)} options={KIND_OPTIONS} />
          </div>
          <div className="inbox-field"><span>Only in (optional; others stay open)</span>
            <Combobox multiple label="Only in" placeholder="Any board, calendar, collection, or folder" value={form.pins.filter((pin) => shownPins.some((option) => option.value === pin) || !pinOptions.length)}
              onChange={(value) => set("pins", value)} options={shownPins} emptyText="Nothing to pin for these kinds" maxSelected={20} />
          </div>
          <label className="inbox-field">Hints for the agent (optional, not enforced)<input value={form.scopeHints} onChange={(event) => set("scopeHints", event.target.value)} maxLength={500} placeholder="Only cards tagged #ops" /></label>
          <div className="routine-row">
            <div className="inbox-field"><span id="routine-cadence-label">Runs</span>
              <Select labelledBy="routine-cadence-label" label="Runs" value={form.cadence} onChange={(value) => set("cadence", value)} options={CADENCE_OPTIONS} disabled={readOnly || busy} />
            </div>
            {form.cadence === "weekly" && <div className="inbox-field"><span id="routine-weekday-label">On</span>
              <Select labelledBy="routine-weekday-label" label="On" value={form.weekday} onChange={(value) => set("weekday", value)} options={WEEKDAY_OPTIONS} disabled={readOnly || busy} />
            </div>}
            {form.cadence === "hourly" && <div className="inbox-field"><span id="routine-minute-label">At</span>
              <Select labelledBy="routine-minute-label" label="At" value={form.minute} onChange={(value) => set("minute", value)} options={MINUTE_OPTIONS} disabled={readOnly || busy} />
            </div>}
            {form.cadence !== "manual" && form.cadence !== "hourly" && <label className="inbox-field">At<input type="time" value={form.time} onChange={(event) => set("time", event.target.value)} required /></label>}
          </div>
          {form.cadence !== "manual" && <p className="inbox-muted routine-zone">Times are in {form.tz}.{form.tz !== zone && <> <button type="button" className="inbox-link-button" onClick={() => set("tz", zone)}>Use {zone}</button></>}</p>}
          <label className="inbox-field">Schedule note (optional, shown to the agent)<input value={form.scheduleNote} onChange={(event) => set("scheduleNote", event.target.value)} maxLength={120} placeholder="After the Monday stand-up" /></label>
          <div className="inbox-field"><span id="routine-key-label">Key</span>
            <Select labelledBy="routine-key-label" label="Key" value={form.keyId} onChange={(value) => set("keyId", value)} options={keyOptions} disabled={readOnly || busy} />
          </div>
          <div className="routine-row">
            <label className="inbox-field">Max proposals per run<input type="number" inputMode="numeric" min={1} max={100} value={form.maxProposals} onChange={(event) => set("maxProposals", event.target.value)} required /></label>
            <label className="inbox-field">Expire after (days)<input type="number" inputMode="numeric" min={1} max={30} value={form.expireDays} onChange={(event) => set("expireDays", event.target.value)} required /></label>
          </div>
          <label className="routine-check"><input type="checkbox" checked={form.enabled} onChange={(event) => set("enabled", event.target.checked)} />Enabled (a paused routine is never due)</label>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!readOnly && <div className="inbox-dialog-actions">
          {routine && <button type="button" className="inbox-action danger-text" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 />Delete</button>}
          <button type="button" className="inbox-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="inbox-action primary" disabled={busy}>{busy ? "Saving…" : routine ? "Save" : "Create routine"}</button>
        </div>}
      </form>

      {routine && <section className="routine-runs" aria-labelledby="routine-runs-title">
        <h3 id="routine-runs-title">Last runs</h3>
        {runs === null && <p className="inbox-loading" role="status">Loading runs…</p>}
        {runs && runs.length === 0 && <p className="inbox-muted">No runs yet. Your client starts one with start_run.</p>}
        {runs && runs.length > 0 && <ul className="routine-run-list">
          {runs.map((run) => <li key={run.id} className={`routine-run run-${run.status}`}>
            <div className="routine-run-top">
              <span className={`inbox-status run-${run.status}`}>{runStatusLabel(run.status)}</span>
              <span>{new Date(run.startedAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <p className="routine-run-metrics">{run.status === "running" ? `Lease until ${new Date(run.leaseExpiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · ` : ""}{runMetrics(run)}</p>
            <p className="inbox-card-meta">{run.keyName ? `Key “${run.keyName}”` : "A revoked key"}{run.clientLabel ? ` · ${run.clientLabel}` : ""}</p>
            {(run.summary || run.error) && <div className="inbox-rationale">
              <span className="inbox-agent-label">Written by the agent</span>
              {run.summary && <p>{run.summary}</p>}
              {run.error && <p className="routine-run-error">{run.error}</p>}
            </div>}
          </li>)}
        </ul>}
      </section>}
    </div>
    {confirmDelete && routine && <DeleteConfirm name={routine.name} busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => { void remove(); }} />}
  </>;
}

function DeleteConfirm({ name, busy, onClose, onConfirm }: { name: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return <>
    <button type="button" className="panel-scrim inbox-dialog-scrim routine-confirm-scrim" onClick={onClose} aria-label="Close" tabIndex={-1} />
    <div className="inbox-dialog routine-confirm" role="alertdialog" aria-modal="true" aria-labelledby="routine-delete-title">
      <header><h2 id="routine-delete-title">Delete “{name}”?</h2></header>
      <p>Its run history goes too. Proposals it made stay in the Inbox under their key.</p>
      <div className="inbox-dialog-actions">
        <button type="button" className="inbox-action" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="inbox-action primary danger" onClick={onConfirm} disabled={busy} autoFocus>Delete routine</button>
      </div>
    </div>
  </>;
}
