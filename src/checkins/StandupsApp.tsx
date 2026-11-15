import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertOctagon, CalendarClock, Flame, MessagesSquare, Plus, Sunrise } from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { EmptyState } from "../ui/EmptyState";
import { ProgressRing } from "../ui/progress/Progress";
import { PersonPicker } from "../ui/people/People";
import { SchedulePicker, viewerZone, type ScheduleValue } from "../ui/schedule/SchedulePicker";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { CHECKIN_TEMPLATE_DEFS, CHECKIN_TEMPLATES, type CheckinSummary, type CheckinTemplate, type DueRound, type FeedEntry } from "../../shared/checkins";
import type { PersonSummary } from "../../shared/people";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { createStandup, dueStandups, errorText, listStandups, sendTimeZone, standupFeed } from "./api";
import { AnswerCard, cadenceText, dateText, Faces, relativeDeadline } from "./parts";
import { StandupPage } from "./StandupPage";
import "./standups.css";

/**
 * Standups (module `checkins`, docs/plan/WORKSPACE_MODULES.md §D.4): routes under /standups —
 * `/` (Due now and your standups), `/feed` (the team feed), `/new`, `/<slug>-<sid>` (latest round),
 * `/<slug>-<sid>/<date>` (a round), `/<…>/<date>/answer` (the answer sheet), `/<…>/insights`,
 * `/<…>/settings`.
 */

let zoneSent = false;

export default function StandupsApp(props: WorkspaceAppProps) {
  const { route, navigate } = props;
  const go = useCallback((path: string[], options?: { replace?: boolean }) => navigate({ app: "checkins", path, search: "" } as never, options), [navigate]);
  useEffect(() => {
    // Each person's zone follows their browser until they choose one (D946).
    if (zoneSent || props.role === undefined) return;
    zoneSent = true;
    sendTimeZone(viewerZone()).catch(() => { zoneSent = false; });
  }, [props.role]);
  const [first, second, third] = route.path;
  if (!first || first === "feed" || first === "new") return <Home {...props} tab={first === "feed" ? "feed" : "standups"} creating={first === "new"} go={go} />;
  return <StandupPage {...props} segment={first} sub={second ?? null} third={third ?? null} go={go} />;
}

type HomeProps = WorkspaceAppProps & { tab: "standups" | "feed"; creating: boolean; go: (path: string[], options?: { replace?: boolean }) => void };

function Home(props: HomeProps) {
  const { tab, go, role } = props;
  const [query, setQuery] = useState("");
  const canCreate = role === "admin" || role === "member";
  return <ModuleHome icon={Sunrise} title="Standups" displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    primary={canCreate ? { label: "New standup", icon: Plus, onClick: () => go(["new"]) } : undefined}
    sections={{ module: "checkins", role, active: tab, onSelect: (id) => go(id === "feed" ? ["feed"] : []) }}
    search={{ value: query, onChange: setQuery, placeholder: tab === "feed" ? "Search answers" : "Find a standup", label: tab === "feed" ? "Search answers" : "Find a standup" }}>
    {tab === "standups" ? <StandupList {...props} query={query} canCreate={canCreate} /> : <Feed {...props} query={query} />}
    {props.creating && canCreate && <NewStandup onClose={() => go([], { replace: true })} onCreated={(href) => props.onOpenPath(href)} flash={props.flash} userId={props.userId} displayName={props.displayName} />}
  </ModuleHome>;
}

function DueStrip({ items, onOpenPath }: { items: DueRound[]; onOpenPath: (path: string) => void }) {
  if (!items.length) return null;
  return <section className="standup-due" aria-labelledby="standup-due-title">
    <h2 id="standup-due-title" className="standup-section-title">Due now</h2>
    <ul className="standup-due-list">
      {items.map((item) => <li key={item.roundId} className="standup-due-card">
        <div className="standup-due-text">
          <strong>{item.name}</strong>
          <span className="standup-muted">{dateText(item.date)} · {relativeDeadline(item.deadlineAt)}</span>
        </div>
        <button type="button" className="action-button ui-small-action" onClick={() => onOpenPath(`${item.href}/answer`)}>Answer</button>
      </li>)}
    </ul>
  </section>;
}

export function StandupRow({ item, onOpen }: { item: CheckinSummary; onOpen: () => void }) {
  const last = item.lastRound;
  const rate = last && last.participants ? last.answered / last.participants : 0;
  return <li>
    <button type="button" className="standup-row" onClick={onOpen}>
      <span className="standup-row-main">
        <span className="standup-row-name">{item.name}{item.status === "paused" && <span className="standup-state tone-neutral">Paused</span>}{item.anonymous && <span className="standup-state tone-info">Anonymous</span>}</span>
        <span className="standup-muted"><CalendarClock aria-hidden="true" />{cadenceText(item.schedule)}</span>
      </span>
      <span className="standup-row-side">
        <Faces people={item.participants} label={`${item.participantCount} participant${item.participantCount === 1 ? "" : "s"}`} max={4} />
        {item.streak ? <span className="standup-streak" title="Your streak: rounds answered in a row"><Flame aria-hidden="true" /><span className="ui-tabular">{item.streak}</span><span className="ui-visually-hidden"> in a row</span></span> : null}
        {last ? <ProgressRing value={rate} size={34} stroke={4} label={`Last round ${dateText(last.date)}: ${last.answered} of ${last.participants} answered`} valueText={`${last.answered}/${last.participants}`} tone={rate >= 0.8 ? "success" : rate >= 0.5 ? "warning" : "neutral"} />
          : <span className="standup-muted standup-no-round">{item.nextOpensAt && item.status === "active"
            ? `First round ${new Date(item.nextOpensAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
            : "No rounds yet"}</span>}
      </span>
    </button>
  </li>;
}

function StandupList({ go, onOpenPath, query, canCreate }: HomeProps & { query: string; canCreate: boolean }) {
  const [items, setItems] = useState<CheckinSummary[] | null>(null);
  const [due, setDue] = useState<DueRound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([listStandups(), dueStandups()]).then(([list, dueList]) => { if (live) { setItems(list.items); setDue(dueList.items); } }).catch((reason) => { if (live) setError(errorText(reason, "Standups could not be loaded")); });
    return () => { live = false; };
  }, []);
  const shown = useMemo(() => (items ?? []).filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);
  const mine = shown.filter((item) => item.youParticipate);
  const others = shown.filter((item) => !item.youParticipate);
  const all = [...mine, ...others];
  useModuleShortcuts({
    j: () => setCursor((index) => Math.min(index + 1, all.length - 1)),
    k: () => setCursor((index) => Math.max(index - 1, 0)),
    Enter: () => { const item = all[cursor]; if (item) onOpenPath(item.href); }
  }, all.length > 0);
  useEffect(() => { document.querySelectorAll<HTMLButtonElement>(".standup-row")[cursor]?.focus({ preventScroll: false }); }, [cursor]);
  if (error) return <p className="standup-error" role="alert">{error}</p>;
  if (!items) return <p className="standup-muted" role="status">Loading standups…</p>;
  return <div className="standup-home">
    <DueStrip items={due} onOpenPath={onOpenPath} />
    {!items.length ? <EmptyState icon={Sunrise} title="No standups yet" action={canCreate ? { label: "New standup", icon: Plus, onClick: () => go(["new"]) } : undefined}>
      Daily standups, weekly updates, retros, and pulse surveys, answered on everyone's own time.
    </EmptyState> : <>
      {!shown.length && <p className="standup-muted">No standup matches “{query}”.</p>}
      {mine.length > 0 && <section aria-labelledby="standup-mine"><h2 id="standup-mine" className="standup-section-title">Your standups</h2>
        <ul className="standup-list">{mine.map((item) => <StandupRow key={item.id} item={item} onOpen={() => onOpenPath(item.href)} />)}</ul></section>}
      {others.length > 0 && <section aria-labelledby="standup-others"><h2 id="standup-others" className="standup-section-title">Other standups you can read</h2>
        <ul className="standup-list">{others.map((item) => <StandupRow key={item.id} item={item} onOpen={() => onOpenPath(item.href)} />)}</ul></section>}
    </>}
  </div>;
}

function Feed({ onOpenPath, query, role }: HomeProps & { query: string }) {
  const [items, setItems] = useState<FeedEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [blockers, setBlockers] = useState(false);
  const [standups, setStandups] = useState<CheckinSummary[]>([]);
  const [standup, setStandup] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listStandups().then((list) => setStandups(list.items.filter((item) => !item.anonymous))).catch(() => undefined); }, []);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      standupFeed({ blockers, q: query.trim() || undefined, checkin: standup === "all" ? undefined : standup })
        .then((page) => { if (live) { setItems(page.items); setNext(page.nextCursor); setError(null); } })
        .catch((reason) => { if (live) setError(errorText(reason, "The feed could not be loaded")); });
    }, query ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [blockers, query, standup]);
  const more = () => standupFeed({ blockers, q: query.trim() || undefined, checkin: standup === "all" ? undefined : standup, cursor: next }).then((page) => { setItems((current) => [...(current ?? []), ...page.items]); setNext(page.nextCursor); });
  return <div className="standup-feed">
    <div className="standup-feed-filters">
      <Select variant="chip" label="Standup" value={standup} onChange={setStandup} options={[{ value: "all", label: "All standups" }, ...standups.map((item) => ({ value: item.id, label: item.name }))]} />
      <button type="button" className="ui-filter-chip" aria-pressed={blockers} onClick={() => setBlockers((on) => !on)}><AlertOctagon aria-hidden="true" />Blockers only</button>
    </div>
    {error && <p className="standup-error" role="alert">{error}</p>}
    {!items ? <p className="standup-muted" role="status">Loading the feed…</p>
      : !items.length ? <EmptyState icon={MessagesSquare} title={query || blockers || standup !== "all" ? "Nothing matches" : "No answers yet"} compact>
        {query || blockers || standup !== "all" ? "Try another filter." : "Answers from the standups you can read show up here, newest first."}
      </EmptyState>
        : <ol className="standup-feed-list">
          {items.map((entry) => <li key={entry.id ?? `${entry.round.id}`}>
            <AnswerCard answer={entry} set={entry.set} onOpen={onOpenPath} canComment={role === "admin" || role === "member"}
              header={<p className="standup-feed-where"><button type="button" className="ui-text-button" onClick={() => onOpenPath(entry.round.href)}>{entry.checkin.name} · {dateText(entry.round.date)}</button>{entry.blockers > 0 && <span className="standup-state tone-danger"><AlertOctagon aria-hidden="true" />{entry.blockers} blocker{entry.blockers === 1 ? "" : "s"}</span>}</p>} />
          </li>)}
        </ol>}
    {next && <button type="button" className="action-button secondary standup-more" onClick={() => void more()}>Show more</button>}
  </div>;
}

function NewStandup({ onClose, onCreated, flash, userId, displayName }: { onClose: () => void; onCreated: (href: string) => void; flash: (message: string) => void; userId: string; displayName: string }) {
  const [template, setTemplate] = useState<CheckinTemplate>("standup");
  const def = CHECKIN_TEMPLATE_DEFS[template];
  const [name, setName] = useState(def.name);
  const [nameTouched, setNameTouched] = useState(false);
  const [schedule, setSchedule] = useState<ScheduleValue>({ ...def.schedule, tz: viewerZone() });
  const [people, setPeople] = useState<PersonSummary[]>([{ kind: "user", id: userId, name: displayName }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (next: CheckinTemplate) => {
    setTemplate(next);
    const nextDef = CHECKIN_TEMPLATE_DEFS[next];
    if (!nameTouched) setName(nextDef.name);
    setSchedule({ ...nextDef.schedule, tz: schedule.tz });
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createStandup({
        template, name: name.trim() || def.name, schedule,
        participants: { people: people.flatMap((person) => person.kind === "user" ? [person.id] : []), groups: people.flatMap((person) => person.kind === "group" ? [person.id] : []) }
      });
      flash(`${created.checkin.name} is set up`);
      onCreated(created.checkin.href);
    } catch (reason) {
      setError(errorText(reason, "The standup could not be created"));
      setBusy(false);
    }
  };
  return <ModalDialog title="New standup" onClose={onClose} variant="sheet" busy={busy} className="standup-new">
    <form noValidate className="file-dialog-body standup-new-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset className="standup-templates">
        <legend>Template</legend>
        {CHECKIN_TEMPLATES.map((key) => <label key={key} className={`standup-template${template === key ? " selected" : ""}`}>
          <input type="radio" name="template" value={key} checked={template === key} onChange={() => pick(key)} />
          <strong>{CHECKIN_TEMPLATE_DEFS[key].label}</strong>
          <span className="standup-muted">{CHECKIN_TEMPLATE_DEFS[key].description}</span>
        </label>)}
      </fieldset>
      <label className="ui-field"><span>Name</span><input value={name} maxLength={120} onChange={(event) => { setName(event.target.value); setNameTouched(true); }} required /></label>
      <SchedulePicker value={schedule} onChange={setSchedule} label="When it runs" />
      <PersonPicker label="Participants" value={people} onChange={setPeople} allow={["user", "group"]} placeholder="Add people or groups" />
      {error && <p className="standup-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="action-button secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="action-button" disabled={busy || !people.length}>{busy ? "Creating…" : "Create standup"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
