import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldSelect } from "./FieldSelect";
import { ArrowLeft, Copy, ExternalLink, KeyRound, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { PersonPicker } from "../ui/people/People";
import { QuestionSetEditor, type SaveState } from "../ui/questions/QuestionSetEditor";
import { ASSIGNMENT_LABELS, DEFAULT_CARD_TITLE, LOCATION_KINDS, LOCATION_LABELS, SLOT_INTERVALS, type Assignment, type LocationKind } from "../../shared/bookings";
import { emptyQuestionSet, type QuestionSet } from "../../shared/questions";
import type { PersonSummary } from "../../shared/people";
import { bookingsApi, durationLabel, timeLabel, viewerZone, type BookingType, type Schedule, type SlotDays } from "./api";
import { LOCATION_ICONS } from "./BookingsApp";
import { WorkspaceAccess } from "../access/WorkspaceAccess";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { canCommentAtLevel } from "../ui/activity/activityAccess";
import { module as bookingsModule } from "./module";

/**
 * The booking type editor (§D.6 UI, §E.4 editors): sections General, When, Where, Hosts, Calendars,
 * Intake, After booking, Sharing, and Activity (its history and comments, D1375), with a left section list on desktop and a section strip on
 * phones; Save sends only what changed with the type's revision (409 when someone else saved).
 * A live preview of the next free times sits at the right on wide screens.
 */

const SECTIONS = [
  { id: "general", label: "General" }, { id: "when", label: "When" }, { id: "where", label: "Where" }, { id: "hosts", label: "Hosts" },
  { id: "calendars", label: "Calendars" }, { id: "intake", label: "Intake" }, { id: "after", label: "After booking" }, { id: "sharing", label: "Sharing" },
  { id: "activity", label: "Activity" }
] as const;
const COLORS = ["#f6c453", "#60a5fa", "#34d399", "#f472b6", "#a78bfa", "#fb923c", "#94a3b8"];
const DURATION_CHOICES = [15, 20, 30, 45, 60, 90, 120];

type Draft = BookingType;
type Option = { id: string; name: string };

export function TypeEditor({ typeRef, onBack, flash, readOnly, userId, onReplace }: { typeRef: string; onBack: () => void; flash: (message: string) => void; readOnly: boolean; userId: string; onReplace: (href: string) => void }) {
  const [saved, setSaved] = useState<BookingType | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("general");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [calendars, setCalendars] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [books, setBooks] = useState<Option[]>([]);
  const [boards, setBoards] = useState<Option[]>([]);
  const [columns, setColumns] = useState<Option[]>([]);
  const [questions, setQuestions] = useState<QuestionSet>(emptyQuestionSet());
  const [questionState, setQuestionState] = useState<SaveState>(null);
  const [publishing, setPublishing] = useState(false);
  const [hosts, setHosts] = useState<PersonSummary[]>([]);
  const questionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    bookingsApi.type(typeRef).then(({ type }) => {
      if (!live) return;
      setSaved(type);
      setDraft(type);
      setHosts(type.hosts.map((host) => ({ kind: "user", id: host.userId, name: host.name })));
      if (!typeRef.endsWith(type.shortId) || type.href.split("/").pop() !== typeRef) onReplace(type.href);
      bookingsApi.questions(type.id).then((result) => setQuestions(result.draft?.set ?? result.published?.set ?? emptyQuestionSet())).catch(() => undefined);
    }).catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : "Booking type not found"));
    bookingsApi.schedules().then((result) => setSchedules(result.schedules)).catch(() => undefined);
    bookingsApi.calendars().then((result) => setCalendars(result.calendars)).catch(() => undefined);
    api<{ books: Option[] }>("/bookings/contact-books").then((result) => setBooks(result.books)).catch(() => undefined);
    api<{ boards: Option[] }>("/tasks/boards").then((result) => setBoards(result.boards.map((board) => ({ id: board.id, name: board.name })))).catch(() => undefined);
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeRef]);
  useEffect(() => {
    if (!draft?.card?.boardId) { setColumns([]); return; }
    api<{ columns: Option[] }>(`/tasks/boards/${encodeURIComponent(draft.card.boardId)}/columns`).then((result) => setColumns(result.columns.map((column) => ({ id: column.id, name: column.name })))).catch(() => setColumns([]));
  }, [draft?.card?.boardId]);

  const changes = useMemo(() => {
    if (!saved || !draft) return {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(draft) as Array<keyof Draft>) if (!["hosts", "revision", "level", "updatedAt", "publicPath", "href", "ownerName"].includes(key) && JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) out[key] = draft[key];
    const hostIds = hosts.map((host) => host.kind === "user" ? host.id : "").filter(Boolean);
    if (JSON.stringify(hostIds.sort()) !== JSON.stringify(saved.hosts.map((host) => host.userId).sort()) && draft.assignment !== "single") out.hosts = hostIds.map((id) => ({ userId: id, priority: saved.hosts.find((host) => host.userId === id)?.priority ?? 0 }));
    return out;
  }, [saved, draft, hosts]);
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    if (!dirty) return;
    // Unsaved changes: the browser asks before the tab closes or reloads.
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!saved || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const { type } = await bookingsApi.saveType(saved.id, { ...changes, expectedRevision: saved.revision });
      setSaved(type);
      setDraft(type);
      setHosts(type.hosts.map((host) => ({ kind: "user", id: host.userId, name: host.name })));
      if (type.href !== saved.href) onReplace(type.href);
      flash("Booking type saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [saved, dirty, changes, flash, onReplace]);

  const saveQuestions = (set: QuestionSet) => {
    setQuestions(set);
    if (!saved || readOnly) return;
    if (questionTimer.current) clearTimeout(questionTimer.current);
    setQuestionState("saving");
    questionTimer.current = setTimeout(() => { bookingsApi.saveQuestions(saved.id, set, false).then(() => setQuestionState("saved"), () => setQuestionState("error")); }, 700);
  };
  const publishQuestions = async () => {
    if (!saved) return;
    setPublishing(true);
    try { await bookingsApi.saveQuestions(saved.id, questions, true); setQuestionState("saved"); flash("Questions published"); } catch (reason) { flash(reason instanceof Error ? reason.message : "Could not publish"); } finally { setPublishing(false); }
  };

  if (error && !draft) return <div className="bk-panel"><button type="button" className="text-button" onClick={onBack}><ArrowLeft aria-hidden="true" />Booking types</button><p className="bk-error" role="alert">{error}</p></div>;
  if (!draft || !saved) return <p className="bk-muted" role="status">Loading…</p>;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const manage = !readOnly && ["owner", "manage"].includes(saved.level);
  const editable = !readOnly && ["owner", "manage", "edit"].includes(saved.level);
  const ownCalendars = calendars.filter((calendar) => calendar.role === "owner");
  const sharedTarget = draft.calendarId ? calendars.find((calendar) => calendar.id === draft.calendarId) : null;

  return <div className="bk-editor">
    <div className="bk-editor-head">
      <button type="button" className="text-button bk-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Booking types</button>
      <h2 className="bk-editor-title"><span className="bk-swatch" style={{ background: draft.color }} aria-hidden="true" />{draft.title || "Untitled"}</h2>
      <div className="bk-editor-actions">
        {saved.publicPath && <button type="button" className="secondary-button ui-small-button" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${saved.publicPath}`).then(() => flash("Link copied"), () => flash(saved.publicPath!))}><Copy aria-hidden="true" />Copy link</button>}
        {saved.publicPath && <a className="secondary-button ui-small-button" href={saved.publicPath} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />Preview</a>}
        {editable && <button type="button" className="action-button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : dirty ? "Save" : "Saved"}</button>}
      </div>
    </div>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    <div className="bk-editor-body">
      <nav className="bk-editor-nav" aria-label="Sections">
        {SECTIONS.map((item) => <button key={item.id} type="button" className="bk-editor-nav-item" aria-current={section === item.id ? "true" : undefined} onClick={() => { setSection(item.id); document.getElementById(`bk-sec-${item.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{item.label}</button>)}
      </nav>
      <div className="bk-editor-sections">
        <fieldset id="bk-sec-general" className="bk-panel" disabled={!editable}>
          <legend>General</legend>
          <div className="bk-grid">
            <label className="ui-field"><span>Title</span><input value={draft.title} maxLength={120} required onChange={(event) => set("title", event.target.value)} /></label>
            <label className="ui-field"><span>Link</span><input value={draft.slug} maxLength={60} onChange={(event) => set("slug", event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /><span className="ui-field-hint">/p/book/…/{draft.slug}</span></label>
            <label className="ui-field bk-wide"><span>Description</span><textarea value={draft.description} maxLength={4000} rows={3} placeholder="What the meeting is for, and anything to prepare." onChange={(event) => set("description", event.target.value)} /></label>
            <div className="ui-field bk-wide"><span id="bk-color">Color</span><div className="bk-colors" role="radiogroup" aria-labelledby="bk-color">
              {COLORS.map((color) => <button key={color} type="button" role="radio" aria-checked={draft.color === color} aria-label={color} className="bk-color" style={{ background: color }} onClick={() => set("color", color)} />)}
            </div></div>
          </div>
        </fieldset>
        <fieldset id="bk-sec-when" className="bk-panel" disabled={!editable}>
          <legend>When</legend>
          <div className="ui-field"><span id="bk-durations">Length (the booker chooses one)</span><div className="bk-chips" role="group" aria-labelledby="bk-durations">
            {DURATION_CHOICES.map((minutes) => <button key={minutes} type="button" className="ui-filter-chip" aria-pressed={draft.durations.includes(minutes)}
              onClick={() => { const next = draft.durations.includes(minutes) ? draft.durations.filter((value) => value !== minutes) : [...draft.durations, minutes].sort((a, b) => a - b); if (next.length) set("durations", next.slice(0, 6)); }}>{durationLabel(minutes)}</button>)}
          </div></div>
          <div className="bk-grid">
            <FieldSelect label="Schedule" value={draft.scheduleId ?? ""} onChange={(value) => set("scheduleId", value || null)} options={[{ value: "", label: "My default schedule" }, ...schedules.map((schedule) => ({ value: schedule.id, label: `${schedule.name} (${schedule.tz.replace(/_/g, " ")})` }))]} />
            <FieldSelect label="Start times every" value={String(draft.slotInterval)} onChange={(value) => set("slotInterval", Number(value))} options={SLOT_INTERVALS.map((value) => ({ value: String(value), label: `${value} min` }))} />
            <NumberField label="Buffer before (min)" value={draft.bufferBefore} min={0} max={240} onChange={(value) => set("bufferBefore", value ?? 0)} />
            <NumberField label="Buffer after (min)" value={draft.bufferAfter} min={0} max={240} onChange={(value) => set("bufferAfter", value ?? 0)} />
            <NumberField label="Minimum notice (hours)" value={Math.round(draft.minNotice / 60 * 10) / 10} min={0} max={720} step={0.5} onChange={(value) => set("minNotice", Math.round((value ?? 0) * 60))} />
            <NumberField label="Book up to (days ahead)" value={draft.maxDaysAhead} min={1} max={365} onChange={(value) => set("maxDaysAhead", value ?? 60)} />
            <label className="ui-field"><span>Only from</span><input type="date" value={draft.dateFrom ?? ""} onChange={(event) => set("dateFrom", event.target.value || null)} /></label>
            <label className="ui-field"><span>Until</span><input type="date" value={draft.dateTo ?? ""} onChange={(event) => set("dateTo", event.target.value || null)} /></label>
            <NumberField label="At most a day" value={draft.dailyLimit} min={1} max={100} placeholder="No limit" onChange={(value) => set("dailyLimit", value)} />
            <NumberField label="At most a week" value={draft.weeklyLimit} min={1} max={500} placeholder="No limit" onChange={(value) => set("weeklyLimit", value)} />
          </div>
        </fieldset>
        <fieldset id="bk-sec-where" className="bk-panel" disabled={!editable}>
          <legend>Where</legend>
          <div className="bk-location-kinds" role="radiogroup" aria-label="Location">
            {LOCATION_KINDS.map((kind) => { const Icon = LOCATION_ICONS[kind]; return <button key={kind} type="button" role="radio" aria-checked={draft.locationKind === kind} className="bk-location-kind" onClick={() => set("locationKind", kind as LocationKind)}><Icon aria-hidden="true" />{LOCATION_LABELS[kind]}</button>; })}
          </div>
          {draft.locationKind !== "ask" && <label className="ui-field"><span>{draft.locationKind === "video_link" ? "Video link" : draft.locationKind === "phone" ? "Phone number (empty: the booker gives theirs)" : draft.locationKind === "in_person" ? "Address" : "Details"}</span>
            <input value={draft.locationValue} maxLength={500} placeholder={draft.locationKind === "video_link" ? "https://meet.example.com/your-room" : ""} onChange={(event) => set("locationValue", event.target.value)} /></label>}
          {draft.locationKind === "ask" && <p className="bk-muted">The booker tells you where to meet.</p>}
        </fieldset>
        <fieldset id="bk-sec-hosts" className="bk-panel" disabled={!manage}>
          <legend>Hosts</legend>
          <div className="bk-location-kinds" role="radiogroup" aria-label="Who hosts">
            {(Object.keys(ASSIGNMENT_LABELS) as Assignment[]).map((value) => <button key={value} type="button" role="radio" aria-checked={draft.assignment === value} className="bk-location-kind" onClick={() => set("assignment", value)}>{ASSIGNMENT_LABELS[value]}</button>)}
          </div>
          {draft.assignment === "single" ? <p className="bk-muted">You host every booking.</p> : <>
            <p className="bk-muted">{draft.assignment === "round_robin" ? "Each booking goes to a free host: the one with the fewest bookings of this type in the last 30 days." : "Everyone must be free; the meeting goes on every host's calendar."}</p>
            <PersonPicker label="Hosts" value={hosts} onChange={setHosts} allow={["user"]} disabled={!manage} />
          </>}
        </fieldset>
        <fieldset id="bk-sec-calendars" className="bk-panel" disabled={!manage}>
          <legend>Calendars</legend>
          <FieldSelect label="Add bookings to" value={draft.calendarId ?? ""} onChange={(value) => set("calendarId", value || null)} options={[{ value: "", label: "My first calendar" }, ...ownCalendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))]} />
          {sharedTarget && <p className="bk-warn"><TriangleAlert aria-hidden="true" />If this calendar is shared, its readers see the booker's name and answers.</p>}
          <fieldset className="bk-checks"><legend>Busy on (empty: your booking profile's choice)</legend>
            {calendars.map((calendar) => <label key={calendar.id} className="bk-check"><input type="checkbox" checked={draft.busyCalendarIds.includes(calendar.id)} onChange={(event) => set("busyCalendarIds", event.target.checked ? [...draft.busyCalendarIds, calendar.id] : draft.busyCalendarIds.filter((id) => id !== calendar.id))} /><span>{calendar.name}</span></label>)}
          </fieldset>
          <label className="bk-check"><input type="checkbox" checked={draft.includeAllDayBusy} onChange={(event) => set("includeAllDayBusy", event.target.checked)} /><span>All-day events make the day busy</span></label>
        </fieldset>
        <section id="bk-sec-intake" className="bk-panel" aria-label="Intake">
          <p className="bk-muted">Name and email are always asked first. Add questions for anything else; publish to show them on the booking page.</p>
          <QuestionSetEditor set={questions} onChange={saveQuestions} audience="public" saveState={questionState} onPublish={editable ? () => void publishQuestions() : undefined} publishing={publishing} title="Intake questions" />
        </section>
        <fieldset id="bk-sec-after" className="bk-panel" disabled={!manage}>
          <legend>After booking</legend>
          <div className="bk-location-kinds" role="radiogroup" aria-label="Confirmation">
            <button type="button" role="radio" aria-checked={draft.confirm === "auto"} className="bk-location-kind" onClick={() => set("confirm", "auto")}>Confirm right away</button>
            <button type="button" role="radio" aria-checked={draft.confirm === "manual"} className="bk-location-kind" onClick={() => set("confirm", "manual")}>I approve each request</button>
          </div>
          {draft.confirm === "manual" && <NumberField label="Requests expire after (hours)" value={draft.pendingHours} min={1} max={168} onChange={(value) => set("pendingHours", value ?? 24)} />}
          <FieldSelect label="Save bookers as contacts in" value={draft.contactBookId ?? ""} onChange={(value) => set("contactBookId", value || null)} options={[{ value: "", label: "Don't save them" }, ...books.map((book) => ({ value: book.id, label: book.name }))]} />
          <div className="ui-field"><span id="bk-reminders">Reminders</span><div className="bk-chips" role="group" aria-labelledby="bk-reminders">
            {[[10080, "1 week"], [1440, "1 day"], [120, "2 hours"], [60, "1 hour"], [15, "15 min"]].map(([minutes, label]) => <button key={minutes} type="button" className="ui-filter-chip" aria-pressed={draft.reminders.offsets.includes(minutes as number)}
              onClick={() => { const offsets = draft.reminders.offsets.includes(minutes as number) ? draft.reminders.offsets.filter((value) => value !== minutes) : [...draft.reminders.offsets, minutes as number]; if (offsets.length <= 3) set("reminders", { ...draft.reminders, offsets }); }}>{label} before</button>)}
          </div></div>
          <div className="bk-checks-row">
            <label className="bk-check"><input type="checkbox" checked={draft.reminders.booker} onChange={(event) => set("reminders", { ...draft.reminders, booker: event.target.checked })} /><span>Email the booker</span></label>
            <label className="bk-check"><input type="checkbox" checked={draft.reminders.host} onChange={(event) => set("reminders", { ...draft.reminders, host: event.target.checked })} /><span>Notify hosts</span></label>
          </div>
          <label className="bk-check"><input type="checkbox" checked={Boolean(draft.card)} onChange={(event) => set("card", event.target.checked ? { boardId: boards[0]?.id ?? "", columnId: "", titleTemplate: DEFAULT_CARD_TITLE, assignHost: true } : null)} /><span>Create a prep card</span></label>
          {draft.card && <div className="bk-grid">
            <FieldSelect label="Board" value={draft.card.boardId} onChange={(value) => set("card", { ...draft.card!, boardId: value, columnId: "" })} options={[{ value: "", label: "Choose…" }, ...boards.map((board) => ({ value: board.id, label: board.name }))]} />
            <FieldSelect label="Column" value={draft.card.columnId} onChange={(value) => set("card", { ...draft.card!, columnId: value })} options={[{ value: "", label: "Choose…" }, ...columns.map((column) => ({ value: column.id, label: column.name }))]} />
            <label className="ui-field bk-wide"><span>Card title</span><input value={draft.card.titleTemplate} maxLength={200} onChange={(event) => set("card", { ...draft.card!, titleTemplate: event.target.value })} /><span className="ui-field-hint">{"{{type}}, {{name}}, {{email}}, {{date}}"}</span></label>
          </div>}
        </fieldset>
        <fieldset id="bk-sec-sharing" className="bk-panel" disabled={!manage}>
          <legend>Sharing</legend>
          <label className="bk-check"><input type="checkbox" checked={draft.status === "active"} onChange={(event) => set("status", event.target.checked ? "active" : "hidden")} /><span>On (people can book it)</span></label>
          <label className="bk-check"><input type="checkbox" checked={draft.public} onChange={(event) => set("public", event.target.checked)} /><span>Listed on my public booking page</span></label>
          <label className="bk-check"><input type="checkbox" checked={draft.verifyEmail} onChange={(event) => set("verifyEmail", event.target.checked)} /><span>Bookers confirm their email with a code first</span></label>
          <NumberField label="At most bookings an hour from the public page" value={draft.hourlyCap} min={1} max={500} onChange={(value) => set("hourlyCap", value ?? 20)} />
          {manage && <SecretLinks typeId={saved.id} flash={flash} />}
          {/* Who in the workspace sees and edits the type and its bookings: the shared Access sheet (D1050). Booking it is not access (§B.9). */}
          {manage && <div className="bk-access"><strong>Who in the workspace can see or edit it</strong>
            <WorkspaceAccess kind="booking_type" id={saved.id} title={saved.title} canManage onSaved={() => flash("Access saved")} /></div>}
        </fieldset>
        <section id="bk-sec-activity" className="bk-panel" aria-label="Activity">
          <ItemTimeline kind="booking_type" id={saved.id} title="Activity" renderers={bookingsModule.activityRenderers} canComment={!readOnly && canCommentAtLevel(saved.level)} refreshKey={String(saved.revision)} />
        </section>
      </div>
      <SlotPreview type={saved} />
    </div>
  </div>;
}

function NumberField({ label, value, min, max, step = 1, placeholder, onChange }: { label: string; value: number | null; min: number; max: number; step?: number; placeholder?: string; onChange: (value: number | null) => void }) {
  return <label className="ui-field"><span>{label}</span><input type="number" inputMode="decimal" value={value ?? ""} min={min} max={max} step={step} placeholder={placeholder}
    onChange={(event) => { const raw = event.target.value; if (raw === "") onChange(null); else { const parsed = Number(raw); if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed))); } }} /></label>;
}

function SecretLinks({ typeId, flash }: { typeId: string; flash: (message: string) => void }) {
  const [links, setLinks] = useState<Array<{ id: string; prefix: string; expiresAt: string | null; maxUses: number | null; useCount: number; label: string }>>([]);
  const load = useCallback(() => bookingsApi.secretLinks(typeId).then((result) => setLinks(result.links)).catch(() => undefined), [typeId]);
  useEffect(() => { void load(); }, [load]);
  const make = async (singleUse: boolean) => {
    try {
      const { link } = await bookingsApi.createSecretLink(typeId, { singleUse, expiresInDays: singleUse ? 30 : 90 });
      const url = `${window.location.origin}${link.path}`;
      await navigator.clipboard.writeText(url).then(() => flash(singleUse ? "One-time link copied" : "Private link copied"), () => flash(url));
      void load();
    } catch (reason) { flash(reason instanceof Error ? reason.message : "Could not make a link"); }
  };
  return <div className="bk-secret">
    <h3 className="bk-h3">Private links</h3>
    <p className="bk-muted">Works even when the type is not listed. The link is shown once, when you copy it.</p>
    <div className="bk-checks-row">
      <button type="button" className="secondary-button ui-small-button" onClick={() => void make(true)}><KeyRound aria-hidden="true" />Copy a one-time link</button>
      <button type="button" className="secondary-button ui-small-button" onClick={() => void make(false)}><KeyRound aria-hidden="true" />Copy a 90-day link</button>
    </div>
    {links.length > 0 && <ul className="bk-feeds">{links.map((link) => <li key={link.id}>
      <code>…{link.prefix}</code>
      <span className="bk-muted">{link.maxUses === 1 ? (link.useCount ? "Used" : "One-time") : `${link.useCount} used`}{link.expiresAt ? ` · until ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(link.expiresAt))}` : ""}</span>
      <button type="button" className="icon-button" aria-label="Turn this link off" title="Turn off" onClick={() => void bookingsApi.revokeSecretLink(typeId, link.id).then(load)}><Trash2 /></button>
    </li>)}</ul>}
  </div>;
}

function SlotPreview({ type }: { type: BookingType }) {
  const [slots, setSlots] = useState<SlotDays | null>(null);
  const tz = viewerZone();
  useEffect(() => {
    const from = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    bookingsApi.typeSlots(type.id, { from, to, tz, duration: type.durations[0]! }).then(setSlots).catch(() => setSlots(null));
  }, [type.id, type.revision, tz, type.durations]);
  const days = slots ? Object.entries(slots.days).slice(0, 5) : [];
  return <aside className="bk-preview" aria-label="Next free times">
    <h3 className="bk-h3">Next free times</h3>
    <p className="bk-muted">{durationLabel(type.durations[0]!)}, in {tz.replace(/_/g, " ")}</p>
    {slots === null ? <p className="bk-muted">Loading…</p> : days.length === 0 ? <p className="bk-muted">No free times in the next two weeks.</p>
      : days.map(([day, times]) => <div key={day} className="bk-preview-day"><strong>{new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))}</strong>
        <span>{times.slice(0, 6).map((iso) => timeLabel(iso, tz)).join(" · ")}{times.length > 6 ? ` +${times.length - 6}` : ""}</span></div>)}
  </aside>;
}
