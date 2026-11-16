import { useCallback, useEffect, useMemo, useState } from "react";
import { FieldSelect, zoneOptions } from "./FieldSelect";
import { CalendarCheck2, CalendarClock, Check, Clock, Copy, Download, Link2, MapPin, Phone, PencilLine, CircleHelp, Plus, Trash2, Users, Video, X, ExternalLink, Eye, EyeOff, KeyRound } from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { BOOKINGS_SECTIONS, type BookingsSection } from "./sections";
import { EmptyState } from "../ui/EmptyState";
import { MoreMenu } from "../ui/MoreMenu";
import { KpiRow, KpiTile, InsightChart } from "../ui/insights/Insights";
import { useConfirm } from "../ui/useConfirm";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { TONE_ICONS } from "../ui/tone";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import type { Route } from "../router";
import { LOCATION_LABELS, STATUS_LABELS, STATUS_TONES, type LocationKind } from "../../shared/bookings";
import { bookingsApi, dayLabel, durationLabel, timeLabel, viewerZone, type Booking, type BookingType, type Insights, type Profile } from "./api";
import { TypeEditor } from "./TypeEditor";
import { AvailabilityView } from "./AvailabilityView";
import { BookingDetail } from "./BookingDetail";
import "./bookings.css";

/**
 * Bookings home (§D.6 UI, §E.2): Upcoming (by day, requests first with Approve / Decline), Past,
 * Cancelled, Booking types (cards with Copy link, on/off, secret links), Availability (weekly hours,
 * date overrides, outside calendars), Insights, and Profile (the public link). A booking opens at
 * /bookings/b/<id>; a type's editor at /bookings/types/<slug-id>.
 */

// The tabs are the module's sections (D1280), one list with the sidebar's.
const TABS = BOOKINGS_SECTIONS;
type TabId = BookingsSection;

export const LOCATION_ICONS: Record<LocationKind, typeof Video> = { video_link: Video, phone: Phone, in_person: MapPin, custom: PencilLine, ask: CircleHelp };

export function StatusChip({ status }: { status: Booking["status"] }) {
  const tone = STATUS_TONES[status];
  const Icon = TONE_ICONS[tone];
  return <span className="bk-status ui-tone" data-tone={tone}><Icon aria-hidden="true" />{STATUS_LABELS[status]}</span>;
}

const absolute = (path: string) => `${window.location.origin}${path}`;

export default function BookingsApp(props: WorkspaceAppProps) {
  const { route, navigate, flash, role } = props;
  const [segment, second] = route.path;
  const go = useCallback((path: string[], search = "") => navigate({ app: "bookings", path, search } as Route), [navigate]);
  const readOnly = role === "viewer" || role === "guest";
  const tab: TabId = (TABS.some((item) => item.id === segment) ? segment : "upcoming") as TabId;
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  // Opening Bookings makes the profile and working hours in the browser's zone before anything else can make them in UTC (D1129).
  useEffect(() => { if (!readOnly) void bookingsApi.profile().catch(() => undefined); }, [readOnly]);

  const createType = async () => {
    if (readOnly || creating) return;
    setCreating(true);
    try {
      const { type } = await bookingsApi.createType({ title: "New meeting", durations: [30] });
      go(["types", type.href.split("/").pop()!]);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not create a booking type");
    } finally {
      setCreating(false);
    }
  };

  const home = (content: React.ReactNode, active: TabId | null = tab, search = true) => <ModuleHome icon={CalendarClock} title="Bookings" displayName={props.displayName}
    onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    primary={readOnly ? undefined : { label: "New booking type", icon: Plus, onClick: () => void createType(), disabled: creating }}
    // D1387: the list on screen (Upcoming, Past, or Cancelled), as CSV.
    menu={tab === "upcoming" || tab === "past" || tab === "cancelled" ? [{ id: "export", label: `Export ${tab} bookings (CSV)`, icon: Download, onSelect: () => { window.location.href = `/api/bookings/export.csv?view=${tab}`; } }] : undefined}
    sections={{ module: "bookings", role, active, onSelect: (id) => go(id === "upcoming" ? [] : [id]) }}
    search={search && ["upcoming", "past", "cancelled", "types"].includes(tab) ? { value: query, onChange: setQuery, placeholder: tab === "types" ? "Search booking types" : "Search by name or type", label: "Search bookings" } : undefined}>
    {content}
  </ModuleHome>;

  if (segment === "b" && second) return home(<BookingDetail bookingRef={second} onBack={() => window.history.length > 1 ? window.history.back() : go([])} onOpenPath={props.onOpenPath} flash={flash} readOnly={readOnly} />, null, false);
  if (segment === "types" && second) return home(<TypeEditor typeRef={second} onBack={() => go(["types"])} flash={flash} readOnly={readOnly} userId={props.userId}
    onReplace={(href) => navigate({ app: "bookings", path: href.split("/").filter(Boolean).slice(1), search: "" } as Route, { replace: true })} />, "types", false);
  return home(<>
    {(tab === "upcoming" || tab === "past" || tab === "cancelled") && <BookingList view={tab} query={query} onOpen={(booking) => go(["b", booking.shortId])} flash={flash} readOnly={readOnly} onNewType={() => go(["types"])} />}
    {tab === "types" && <TypesView query={query} onOpen={(type) => go(["types", type.href.split("/").pop()!])} onCreate={() => void createType()} flash={flash} readOnly={readOnly} />}
    {tab === "availability" && <AvailabilityView flash={flash} readOnly={readOnly} />}
    {tab === "insights" && <InsightsView />}
    {tab === "profile" && <ProfileView flash={flash} readOnly={readOnly} />}
  </>);
}

// ---------------------------------------------------------------- lists

function groupByDay(items: readonly Booking[], tz: string) {
  const groups: Array<{ day: string; label: string; items: Booking[] }> = [];
  for (const item of items) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(item.start));
    let group = groups.find((entry) => entry.day === day);
    if (!group) { group = { day, label: dayLabel(item.start, tz, { weekday: "long", day: "numeric", month: "long" }), items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups;
}

function BookingList({ view, query, onOpen, flash, readOnly, onNewType }: { view: "upcoming" | "past" | "cancelled"; query: string; onOpen: (booking: Booking) => void; flash: (message: string) => void; readOnly: boolean; onNewType: () => void }) {
  const tz = viewerZone();
  const [items, setItems] = useState<Booking[] | null>(null);
  const [pending, setPending] = useState<Booking[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const load = useCallback(async (more: string | null = null) => {
    try {
      const page = await bookingsApi.bookings({ view, cursor: more });
      if (view === "upcoming" && !more) setPending((await bookingsApi.bookings({ view: "pending" })).items);
      setItems((current) => more && current ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load bookings");
    }
  }, [view]);
  useEffect(() => { setItems(null); void load(); }, [load]);
  const needle = query.trim().toLowerCase();
  const match = (item: Booking) => !needle || `${item.bookerName} ${item.bookerEmail} ${item.typeTitle}`.toLowerCase().includes(needle);
  const visible = (items ?? []).filter((item) => match(item) && !(view === "upcoming" && item.status === "pending"));
  const requests = view === "upcoming" ? pending.filter(match) : [];
  const flat = [...requests, ...visible];
  useModuleShortcuts({
    j: () => { setFocus((value) => Math.min(flat.length - 1, value + 1)); document.querySelectorAll<HTMLElement>(".bk-row-open")[Math.min(flat.length - 1, focus + 1)]?.focus(); },
    k: () => { setFocus((value) => Math.max(0, value - 1)); document.querySelectorAll<HTMLElement>(".bk-row-open")[Math.max(0, focus - 1)]?.focus(); }
  });
  const act = async (booking: Booking, action: "approve" | "decline") => {
    try {
      await bookingsApi.act(booking.id, action);
      flash(action === "approve" ? "Booking confirmed" : "Request declined");
      void load();
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not update the booking");
    }
  };
  if (error) return <p className="bk-error" role="alert">{error}</p>;
  if (items === null) return <p className="bk-muted" role="status">Loading bookings…</p>;
  if (!flat.length) return <EmptyState icon={CalendarCheck2} title={needle ? "No bookings match" : view === "upcoming" ? "No upcoming bookings" : view === "past" ? "No past bookings yet" : "Nothing cancelled"}
    action={view === "upcoming" && !needle && !readOnly ? { label: "Share a booking link", icon: Link2, onClick: onNewType } : undefined}>
    {view === "upcoming" && !needle ? "When someone books time with you, it shows up here." : undefined}
  </EmptyState>;
  const groups = groupByDay(visible, tz);
  return <div className="bk-list">
    {requests.length > 0 && <section className="bk-day" aria-labelledby="bk-requests">
      <h2 id="bk-requests" className="bk-day-title">Awaiting your approval <span className="bk-count">{requests.length}</span></h2>
      <ul>{requests.map((booking) => <BookingRow key={booking.id} booking={booking} tz={tz} onOpen={onOpen} showDate
        actions={readOnly ? null : <><button type="button" className="secondary-button ui-small-button" onClick={() => void act(booking, "approve")}><Check aria-hidden="true" />Approve</button>
          <button type="button" className="secondary-button ui-small-button" onClick={() => void act(booking, "decline")}><X aria-hidden="true" />Decline</button></>} />)}</ul>
    </section>}
    {groups.map((group) => <section key={group.day} className="bk-day" aria-label={group.label}>
      <h2 className="bk-day-title">{group.label}</h2>
      <ul>{group.items.map((booking) => <BookingRow key={booking.id} booking={booking} tz={tz} onOpen={onOpen} />)}</ul>
    </section>)}
    {cursor && <button type="button" className="secondary-button bk-more" onClick={() => void load(cursor)}>Show more</button>}
  </div>;
}

function BookingRow({ booking, tz, onOpen, actions, showDate = false }: { booking: Booking; tz: string; onOpen: (booking: Booking) => void; actions?: React.ReactNode; showDate?: boolean }) {
  const Icon = LOCATION_ICONS[booking.locationKind];
  return <li className="bk-row" style={{ "--bk-color": booking.color } as React.CSSProperties}>
    <button type="button" className="bk-row-open" onClick={() => onOpen(booking)}>
      <span className="bk-row-time">{showDate && <span>{dayLabel(booking.start, tz)}</span>}{timeLabel(booking.start, tz)}–{timeLabel(booking.end, tz)}</span>
      <span className="bk-row-main"><strong>{booking.bookerName}</strong><span>{booking.typeTitle}{booking.typeDeleted ? " (deleted type)" : ""}</span></span>
      <span className="bk-row-meta"><Icon aria-hidden="true" /><span>{booking.cohosts.length ? `${booking.hostName} +${booking.cohosts.length}` : booking.hostName}</span></span>
      <StatusChip status={booking.status} />
    </button>
    {actions && <span className="bk-row-actions">{actions}</span>}
  </li>;
}

// ---------------------------------------------------------------- types

function TypesView({ query, onOpen, onCreate, flash, readOnly }: { query: string; onOpen: (type: BookingType) => void; onCreate: () => void; flash: (message: string) => void; readOnly: boolean }) {
  const [types, setTypes] = useState<BookingType[] | null>(null);
  const { ask, confirmElement } = useConfirm();
  const load = useCallback(() => bookingsApi.types().then((result) => setTypes(result.types)).catch(() => setTypes([])), []);
  useEffect(() => { void load(); }, [load]);
  const copy = async (text: string, what = "Link copied") => { try { await navigator.clipboard.writeText(text); flash(what); } catch { flash(text); } };
  const toggle = async (type: BookingType) => {
    try { await bookingsApi.saveType(type.id, { status: type.status === "active" ? "hidden" : "active" }); void load(); } catch (error) { flash(error instanceof Error ? error.message : "Could not change it"); }
  };
  const secret = async (type: BookingType) => {
    try { const { link } = await bookingsApi.createSecretLink(type.id, { singleUse: true }); await copy(absolute(link.path), "One-time link copied (it works once, for 30 days)"); } catch (error) { flash(error instanceof Error ? error.message : "Could not make a link"); }
  };
  const remove = async (type: BookingType) => {
    if (!await ask({ title: `Delete ${type.title}?`, message: "It moves to the Bin for 30 days; bookings already made stay.", confirmLabel: "Delete", danger: true })) return;
    try { await bookingsApi.deleteType(type.id); flash("Moved to the Bin"); void load(); } catch (error) { flash(error instanceof Error ? error.message : "Could not delete it"); }
  };
  if (types === null) return <p className="bk-muted" role="status">Loading booking types…</p>;
  const needle = query.trim().toLowerCase();
  const shown = types.filter((type) => !needle || type.title.toLowerCase().includes(needle));
  if (!shown.length) return <EmptyState icon={CalendarClock} title={needle ? "No booking types match" : "No booking types yet"} action={!needle && !readOnly ? { label: "New booking type", icon: Plus, onClick: onCreate } : undefined}>
    {needle ? undefined : "A booking type is a meeting people can book with you: a length, where it happens, and when you're free."}
  </EmptyState>;
  return <>
    <ul className="bk-types">
      {shown.map((type) => {
        const Icon = LOCATION_ICONS[type.locationKind];
        const manage = ["owner", "manage"].includes(type.level) && !readOnly;
        return <li key={type.id} className={`bk-type${type.status === "hidden" ? " hidden" : ""}`} style={{ "--bk-color": type.color } as React.CSSProperties}>
          <button type="button" className="bk-type-open" onClick={() => onOpen(type)}>
            <strong>{type.title}</strong>
            <span className="bk-type-facts"><Clock aria-hidden="true" />{type.durations.map(durationLabel).join(" · ")}<Icon aria-hidden="true" />{LOCATION_LABELS[type.locationKind]}</span>
            <span className="bk-type-hosts"><Users aria-hidden="true" />{type.assignment === "single" ? type.ownerName : `${type.hosts.map((host) => host.name).join(", ")} · ${type.assignment === "round_robin" ? "round robin" : "everyone"}`}</span>
          </button>
          <div className="bk-type-actions">
            {type.publicPath ? <button type="button" className="secondary-button ui-small-button" onClick={() => void copy(absolute(type.publicPath!))}><Copy aria-hidden="true" />Copy link</button>
              : <span className="bk-muted bk-type-off">{type.status === "hidden" ? "Off" : "Not public"}</span>}
            {manage && <button type="button" className="icon-button" aria-label={type.status === "active" ? `Turn off ${type.title}` : `Turn on ${type.title}`} title={type.status === "active" ? "Turn off" : "Turn on"} onClick={() => void toggle(type)}>{type.status === "active" ? <Eye /> : <EyeOff />}</button>}
            {manage && <MoreMenu label={`More actions for ${type.title}`} items={[
              { id: "edit", label: "Edit", icon: PencilLine, onSelect: () => onOpen(type) },
              ...(type.publicPath ? [{ id: "open", label: "Open the booking page", icon: ExternalLink, onSelect: () => window.open(type.publicPath!, "_blank", "noopener,noreferrer") }] : []),
              { id: "secret", label: "Copy a one-time link", icon: KeyRound, onSelect: () => void secret(type) },
              { id: "delete", label: "Delete", icon: Trash2, danger: true, onSelect: () => void remove(type) }
            ]} />}
          </div>
        </li>;
      })}
    </ul>
    {confirmElement}
  </>;
}

// ---------------------------------------------------------------- insights

function InsightsView() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Insights | null>(null);
  useEffect(() => { setData(null); bookingsApi.insights(days, viewerZone()).then(setData).catch(() => setData(null)); }, [days]);
  if (!data) return <p className="bk-muted" role="status">Loading insights…</p>;
  if (!data.total) return <EmptyState icon={CalendarCheck2} title="No bookings to measure yet">Insights fill in as people book.</EmptyState>;
  const confirmed = (data.statusCounts.confirmed ?? 0) + (data.statusCounts.completed ?? 0);
  return <div className="bk-insights ui-insights">
    <div className="bk-filter-row" role="group" aria-label="Period">
      {[30, 90, 365].map((value) => <button key={value} type="button" className="ui-filter-chip" aria-pressed={days === value} onClick={() => setDays(value)}>{value === 365 ? "12 months" : `${value} days`}</button>)}
    </div>
    <KpiRow>
      <KpiTile label="Bookings" value={data.total} hint="In the period and the next 60 days" />
      <KpiTile label="Confirmed or done" value={confirmed} />
      <KpiTile label="Cancelled or declined" value={data.cancelRate} unit="percent" />
      <KpiTile label="No-shows" value={data.noShowRate} unit="percent" />
      <KpiTile label="Booked ahead" value={data.avgLeadHours} text={data.avgLeadHours === null ? "–" : data.avgLeadHours >= 48 ? `${Math.round(data.avgLeadHours / 24)} days` : `${Math.round(data.avgLeadHours)} h`} hint="Average time between booking and meeting" />
    </KpiRow>
    <InsightChart title="Bookings per week" kind="bar" categories={data.weeks.map((week) => week.week)} series={[{ name: "Bookings", values: data.weeks.map((week) => week.count) }]} />
    <div className="bk-insight-tables">
      <table className="bk-table"><caption>By type</caption><thead><tr><th scope="col">Type</th><th scope="col">Bookings</th><th scope="col">Time booked</th></tr></thead>
        <tbody>{data.types.map((row) => <tr key={row.type}><td>{row.type}</td><td>{row.count}</td><td>{durationLabel(row.minutes)}</td></tr>)}</tbody></table>
      <table className="bk-table"><caption>By host</caption><thead><tr><th scope="col">Host</th><th scope="col">Bookings</th></tr></thead>
        <tbody>{data.hosts.map((row) => <tr key={row.host}><td>{row.host}</td><td>{row.count}</td></tr>)}</tbody></table>
    </div>
  </div>;
}

// ---------------------------------------------------------------- profile

function ProfileView({ flash, readOnly }: { flash: (message: string) => void; readOnly: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { bookingsApi.profile().then((result) => { setProfile(result.profile); setDraft(result.profile); }).catch(() => setError("Could not load your profile")); }, []);
  if (error) return <p className="bk-error" role="alert">{error}</p>;
  if (!profile || !draft) return <p className="bk-muted" role="status">Loading…</p>;
  const dirty = JSON.stringify(profile) !== JSON.stringify(draft);
  const save = async () => {
    setSaving(true);
    setError(null);
    try { const result = await bookingsApi.saveProfile({ handle: draft.handle, displayName: draft.displayName, welcome: draft.welcome, tz: draft.tz, enabled: draft.enabled }); setProfile(result.profile); setDraft(result.profile); flash("Profile saved"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save"); }
    finally { setSaving(false); }
  };
  const url = absolute(`/p/book/${profile.handle}`);
  return <form className="bk-panel bk-profile" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="bk-panel-head">
      <h2>Your booking page</h2>
      <p className="bk-muted">People see your name, this welcome, and your public booking types. Your calendar's details are never shown.</p>
    </div>
    <div className="bk-link-row">
      <code>{url}</code>
      <button type="button" className="secondary-button ui-small-button" onClick={() => void navigator.clipboard.writeText(url).then(() => flash("Link copied"), () => flash(url))}><Copy aria-hidden="true" />Copy</button>
      <a className="secondary-button ui-small-button" href={`/p/book/${profile.handle}`} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />Preview</a>
    </div>
    <div className="bk-grid">
      <label className="ui-field"><span>Link name</span><input value={draft.handle} maxLength={30} disabled={readOnly} onChange={(event) => setDraft({ ...draft, handle: event.target.value.toLowerCase() })} />
        <span className="ui-field-hint">Your old link keeps working for 90 days after a change.</span></label>
      <label className="ui-field"><span>Name shown</span><input value={draft.displayName} maxLength={80} disabled={readOnly} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
      <FieldSelect label="Time zone" value={draft.tz} disabled={readOnly} onChange={(tz) => setDraft({ ...draft, tz })} options={zoneOptions(draft.tz)} />
      <label className="bk-check"><input type="checkbox" checked={draft.enabled} disabled={readOnly} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>My booking page is on</span></label>
      <label className="ui-field bk-wide"><span>Welcome</span><textarea value={draft.welcome} maxLength={2000} rows={3} disabled={readOnly} placeholder="Pick a time that works for you." onChange={(event) => setDraft({ ...draft, welcome: event.target.value })} /></label>
    </div>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {!readOnly && <div className="bk-save-row"><button type="submit" className="action-button" disabled={!dirty || saving}>{saving ? "Saving…" : "Save"}</button>{!dirty && <span className="bk-muted">Saved</span>}</div>}
  </form>;
}
