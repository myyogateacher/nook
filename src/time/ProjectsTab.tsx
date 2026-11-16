import { useCallback, useEffect, useId, useState } from "react";
import { Archive, ArrowLeft, Check, FolderClock, Lock, Pencil, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { ApiError } from "../api";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { EmptyState } from "../ui/EmptyState";
import { MoreMenu } from "../ui/MoreMenu";
import { ProgressBar } from "../ui/progress/Progress";
import { MoneyInput, MoneyText } from "../ui/money/Money";
import { KpiRow, KpiTile } from "../ui/insights/Insights";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { useUnitPreferences, useWorkspaceSettings } from "../ui/units";
import { formatDuration } from "../../shared/duration";
import { PROJECT_COLORS, type TimeEntry, type TimeProject } from "../../shared/time";
import { timeApi, type Approval, type ClientOption, type ProjectBody } from "./api";
import { invalidateProjects, projectDot } from "./fields";
import { WorkspaceAccess } from "../access/WorkspaceAccess";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { canCommentAtLevel } from "../ui/activity/activityAccess";
import { module as timeModule } from "./module";
import { EntrySheet } from "./EntrySheet";
import { clock, dayLabel, localDay } from "./format";
import { errorText, onTimeChanged, timeChanged } from "./timerStore";

/**
 * Projects (§D.2 "Projects"): the list with each budget's progress, the project sheet (client from
 * any company you can read or a new one in your own Clients book, linked board, billable default,
 * rate, currency, budget, private entries), and the project page: totals, budget, entries, the team
 * with levels and rates (managers), and week approvals (D874).
 */

const COLOR_LABELS: Record<string, string> = { amber: "Amber", blue: "Blue", green: "Green", purple: "Purple", pink: "Pink", red: "Red", orange: "Orange", teal: "Teal", slate: "Slate" };

export function budgetText(project: TimeProject, format: "hm" | "colon") {
  if (project.budget.kind === "none" || project.budget.value === null || !project.used) return null;
  if (project.budget.kind === "hours") return { value: project.used.seconds / (project.budget.value * 3600), text: `${formatDuration(project.used.seconds, format)} of ${project.budget.value}h` };
  if (project.used.amountMinor === null) return null;
  return { value: project.used.amountMinor / project.budget.value, text: null };
}

export function ProjectsTab({ onProject, canCreate, onNew }: { onProject: (project: TimeProject) => void; canCreate: boolean; onNew: () => void }) {
  const prefs = useUnitPreferences();
  const [projects, setProjects] = useState<TimeProject[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { timeApi.projects().then((body) => setProjects(body.projects), (reason) => setError(errorText(reason, "Could not load projects"))); }, []);
  useEffect(() => { load(); return onTimeChanged(load); }, [load]);
  if (error) return <p className="ui-field-error" role="alert">{error}</p>;
  if (!projects) return <p className="time-loading" role="status">Loading projects…</p>;
  const shown = projects.filter((project) => showArchived || !project.archived);
  const archivedCount = projects.filter((project) => project.archived).length;
  return <div className="time-tab time-projects-tab">
    {shown.length === 0
      ? <EmptyState icon={FolderClock} title="No projects yet." action={canCreate ? { label: "New project", icon: Plus, onClick: onNew } : undefined}>Projects group time for a client or a piece of work, with rates and budgets.</EmptyState>
      : <ul className="time-project-list">
        {shown.map((project) => {
          const budget = budgetText(project, prefs.durationFormat);
          return <li key={project.id}>
            <button type="button" className="time-project-row" onClick={() => onProject(project)}>
              <span className="time-project-name">{projectDot(project.color)}<strong>{project.name}</strong>{project.code && <span className="time-code">{project.code}</span>}{project.archived && <span className="ui-health" data-tone="neutral"><Archive aria-hidden="true" />Archived</span>}</span>
              <span className="time-project-meta">{[project.client?.name, project.board?.name ? `Board: ${project.board.name}` : null, project.owner.name].filter(Boolean).join(" · ")}</span>
              <span className="time-project-used ui-tabular">{formatDuration(project.used?.seconds ?? 0, prefs.durationFormat)}</span>
              {budget && <span className="time-project-budget"><ProgressBar value={budget.value} label={`${project.name} budget`} valueText={budget.text ?? `${Math.round(budget.value * 100)}%`} meter thin tone={budget.value > 1 ? "danger" : budget.value >= 0.8 ? "warning" : "accent"} /></span>}
            </button>
          </li>;
        })}
      </ul>}
    {archivedCount > 0 && <button type="button" className="ui-text-button time-archived-toggle" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "Hide archived" : `Show ${archivedCount} archived`}</button>}
  </div>;
}

// ---------------------------------------------------------------------------

export function ProjectSheet({ project, onClose, onSaved }: { project: TimeProject | null; onClose: () => void; onSaved: (project: TimeProject) => void }) {
  const workspace = useWorkspaceSettings();
  const formId = useId();
  const [name, setName] = useState(project?.name ?? "");
  const [code, setCode] = useState(project?.code ?? "");
  const [color, setColor] = useState<string>(project?.color ?? "amber");
  const [clientId, setClientId] = useState<string>(project?.client?.id ?? "");
  const [newClient, setNewClient] = useState("");
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [boards, setBoards] = useState<Array<{ id: string; name: string }>>([]);
  const [boardId, setBoardId] = useState<string>(project?.board?.id ?? "");
  const [billableDefault, setBillableDefault] = useState(project?.billableDefault ?? true);
  const [currency, setCurrency] = useState(project?.currency ?? workspace.defaultCurrency);
  const [rate, setRate] = useState<number | null>(project?.rateMinor ?? null);
  const [budgetKind, setBudgetKind] = useState<"none" | "hours" | "money">(project?.budget.kind ?? "none");
  const [budgetValue, setBudgetValue] = useState<number | null>(project?.budget.value ?? null);
  const [budgetPeriod, setBudgetPeriod] = useState<"total" | "monthly">(project?.budget.period ?? "total");
  const [privateEntries, setPrivateEntries] = useState(project?.settings.privateEntries ?? false);
  const [requireDescription, setRequireDescription] = useState(project?.settings.requireDescription ?? false);
  const [everyone, setEveryone] = useState(project ? project.visibility === "all_users" : false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => {
    void timeApi.clients().then((body) => setClients(body.clients), () => undefined);
    void timeApi.boards().then((body) => setBoards(body.boards.map((board) => ({ id: board.id, name: board.name }))), () => undefined);
  }, []);
  const canSeeRates = !project || project.canSeeRates;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError("Give the project a name"); return; }
    setBusy(true);
    setError(null);
    const body: ProjectBody = {
      name: name.trim(), code: code.trim() || null, color, boardId: boardId || null, billableDefault, currency,
      ...(clientId === "__new" ? { newClient: newClient.trim() || null, clientId: null } : { clientId: clientId || null }),
      ...(canSeeRates ? { rateMinor: rate, budget: { kind: budgetKind, value: budgetKind === "none" ? null : budgetValue, period: budgetPeriod } } : {}),
      settings: { privateEntries, requireDescription },
      ...(!project || project.level === "owner" ? (everyone ? { visibility: "all_users" as const } : project?.visibility === "all_users" ? { visibility: "private" as const } : {}) : {}),
      ...(project ? { expectedRevision: project.revision } : {})
    };
    try {
      const result = project ? await timeApi.updateProject(project.id, body) : await timeApi.createProject(body);
      invalidateProjects();
      timeChanged();
      notify.success(project ? "Project saved" : "Project created");
      onSaved(result.project);
    } catch (reason) {
      setError(errorText(reason, "Could not save the project"));
      setBusy(false);
    }
  };

  return <ModalDialog title={project ? "Edit project" : "New project"} onClose={onClose} variant="sheet" busy={busy} className="time-sheet">
    <form noValidate id={formId} className="time-sheet-body" onSubmit={(event) => { void save(event); }}>
      <div className="time-sheet-grid">
        <div className="ui-field"><label htmlFor={`${formId}-name`}>Name</label><input id={`${formId}-name`} value={name} maxLength={120} autoFocus onChange={(event) => setName(event.target.value)} /></div>
        <div className="ui-field"><label htmlFor={`${formId}-code`}>Code</label><input id={`${formId}-code`} value={code} maxLength={12} placeholder="ACME" onChange={(event) => setCode(event.target.value.toUpperCase())} /></div>
      </div>
      <div className="time-sheet-grid">
        <div className="ui-field"><span>Client</span>
          <Select label="Client" value={clientId} searchable="auto" onChange={setClientId}
            options={[{ value: "", label: "No client" }, ...clients.map((client) => ({ value: client.id, label: client.name, description: client.domain ?? undefined })), { value: "__new", label: "New client…" }]} />
        </div>
        <div className="ui-field"><span>Color</span>
          <Select label="Color" value={color} onChange={setColor} options={PROJECT_COLORS.map((value) => ({ value, label: COLOR_LABELS[value]!, icon: projectDot(value) }))} />
        </div>
      </div>
      {clientId === "__new" && <div className="ui-field"><label htmlFor={`${formId}-client`}>New client's name</label><input id={`${formId}-client`} value={newClient} maxLength={200} autoFocus onChange={(event) => setNewClient(event.target.value)} /><small className="ui-field-hint">Saved as a company in your own Clients list.</small></div>}
      <div className="ui-field"><span>Linked board</span>
        <Select label="Linked board" value={boardId} searchable="auto" onChange={setBoardId} options={[{ value: "", label: "No board" }, ...boards.map((board) => ({ value: board.id, label: board.name }))]} />
        <small className="ui-field-hint">Time on this board's cards goes to this project.</small>
      </div>
      <div className="time-sheet-row">
        <Toggle label="Billable by default" value={billableDefault} onChange={setBillableDefault} />
        <Toggle label="Card readers see totals only" value={privateEntries} onChange={setPrivateEntries} />
        <Toggle label="Require a description" value={requireDescription} onChange={setRequireDescription} />
      </div>
      {canSeeRates && <>
        <MoneyInput label="Hourly rate" value={rate === null ? null : { amount: rate, currency }} currencyEditable onChange={(money, nextCurrency) => { setRate(money?.amount ?? null); setCurrency(nextCurrency); }} />
        <fieldset className="time-budget">
          <legend>Budget</legend>
          <div className="ui-segmented" role="group" aria-label="Budget kind">
            {(["none", "hours", "money"] as const).map((kind) => <button key={kind} type="button" aria-pressed={budgetKind === kind} onClick={() => setBudgetKind(kind)}>{kind === "none" ? "No budget" : kind === "hours" ? "Hours" : "Money"}</button>)}
          </div>
          {budgetKind === "hours" && <div className="ui-field"><label htmlFor={`${formId}-hours`}>Hours</label><input id={`${formId}-hours`} inputMode="numeric" value={budgetValue ?? ""} onChange={(event) => setBudgetValue(event.target.value.trim() ? Math.max(0, Math.round(Number(event.target.value) || 0)) : null)} /></div>}
          {budgetKind === "money" && <MoneyInput label="Amount" value={budgetValue === null ? null : { amount: budgetValue, currency }} onChange={(money) => setBudgetValue(money?.amount ?? null)} />}
          {budgetKind !== "none" && <div className="ui-segmented" role="group" aria-label="Budget period">
            <button type="button" aria-pressed={budgetPeriod === "total"} onClick={() => setBudgetPeriod("total")}>In total</button>
            <button type="button" aria-pressed={budgetPeriod === "monthly"} onClick={() => setBudgetPeriod("monthly")}>Each month</button>
          </div>}
        </fieldset>
      </>}
      {(!project || project.level === "owner") && <Toggle label="Everyone signed in can log time on it" value={everyone} onChange={setEveryone} />}
      {error && <p className="ui-field-error" role="alert">{error}</p>}
    </form>
    <footer className="time-sheet-footer">
      <span className="time-sheet-spacer" />
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form={formId} className="action-button" disabled={busy}>{project ? "Save" : "Create project"}</button>
    </footer>
  </ModalDialog>;
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" className="ui-switch" aria-checked={value} onClick={() => onChange(!value)}><span className="ui-switch-track"><span className="ui-switch-thumb" /></span><span>{label}</span></button>;
}

// ---------------------------------------------------------------------------

type Access = { etag?: string; audience: "private" | "selected" | "all_users"; audienceLevel: string; people: Array<{ id: string; displayName: string; level: string }>; yourLevel: string };

export function ProjectPage({ projectId, initialTab, onBack, onOpen, flashMissing }: { projectId: string; initialTab?: string | null; onBack: () => void; onOpen: (href: string) => void; flashMissing: () => void }) {
  const prefs = useUnitPreferences();
  const [project, setProject] = useState<TimeProject | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [tab, setTab] = useState<"entries" | "team" | "approvals" | "activity">(initialTab === "team" || initialTab === "approvals" || initialTab === "activity" ? initialTab : "entries");
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<TimeEntry | null>(null);
  const load = useCallback(() => {
    timeApi.project(projectId).then((body) => setProject(body.project), (reason) => { if (reason instanceof ApiError && reason.status === 404) flashMissing(); });
    timeApi.entries({ project: projectId, user: "all", limit: "100" }).then((body) => setEntries(body.entries), () => undefined);
  }, [projectId, flashMissing]);
  useEffect(() => { load(); return onTimeChanged(load); }, [load]);
  if (!project) return <p className="time-loading" role="status">Loading the project…</p>;
  const manager = project.level === "owner" || project.level === "manage";
  const budget = budgetText(project, prefs.durationFormat);
  const archive = async (archived: boolean) => {
    try { const body = await timeApi.updateProject(project.id, { archived }); setProject(body.project); invalidateProjects(); notify.success(archived ? "Project archived" : "Project unarchived"); }
    catch (reason) { notify.error(errorText(reason, "Could not change it")); }
  };
  const bin = async () => {
    try { await timeApi.binProject(project.id); invalidateProjects(); notify.success("Project moved to the Bin; its entries stay"); onBack(); }
    catch (reason) { notify.error(errorText(reason, "Could not move it to the Bin")); }
  };
  return <div className="time-tab time-project-page">
    <div className="time-project-head">
      <button type="button" className="secondary-button ui-small-button" onClick={onBack}><ArrowLeft aria-hidden="true" />Projects</button>
      <h2>{projectDot(project.color)}{project.name}{project.code && <span className="time-code">{project.code}</span>}</h2>
      <div className="time-project-actions">
        {manager && <button type="button" className="secondary-button ui-small-button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" />Edit</button>}
        {manager && <MoreMenu label="More project actions" items={[
          { id: "archive", label: project.archived ? "Unarchive" : "Archive", icon: project.archived ? RotateCcw : Archive, onSelect: () => { void archive(!project.archived); } },
          ...(project.level === "owner" ? [{ id: "bin", label: "Move to Bin", icon: Trash2, danger: true, onSelect: () => { void bin(); } }] : [])
        ]} />}
      </div>
    </div>
    <p className="time-project-sub">{[project.client ? `Client: ${project.client.name}` : null, project.board ? `Board: ${project.board.name}` : null, `Owner: ${project.owner.name}`, project.billableDefault ? "Billable" : "Not billable by default"].filter(Boolean).join(" · ")}</p>
    <KpiRow>
      <KpiTile label={project.budget.period === "monthly" ? "This month" : "Logged"} value={project.used?.seconds ?? 0} unit="duration" />
      {project.canSeeRates && <KpiTile label="Billable amount" value={project.used?.amountMinor ?? null} unit="money" currency={project.currency} />}
      {project.canSeeRates && <KpiTile label="Rate" value={project.rateMinor} unit="money" currency={project.currency} text={project.rateMinor === null ? "No rate" : undefined} />}
      {budget && <div className="ui-kpi time-budget-kpi"><ProgressBar value={budget.value} label="Budget" valueText={budget.text ?? `${Math.round(budget.value * 100)}%`} meter tone={budget.value > 1 ? "danger" : budget.value >= 0.8 ? "warning" : "accent"} /></div>}
    </KpiRow>
    <div className="ui-segmented time-project-tabs" role="group" aria-label="Project views">
      <button type="button" aria-pressed={tab === "entries" || (tab === "approvals" && !manager)} onClick={() => setTab("entries")}>Entries</button>
      <button type="button" aria-pressed={tab === "team"} onClick={() => setTab("team")}>Team{manager ? " and rates" : ""}</button>
      {manager && <button type="button" aria-pressed={tab === "approvals"} onClick={() => setTab("approvals")}>Approvals</button>}
      <button type="button" aria-pressed={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
    </div>
    {(tab === "entries" || (tab === "approvals" && !manager)) && (entries.length === 0
      ? <EmptyState icon={FolderClock} title="No time on this project yet." compact />
      : <ul className="time-entries flat">
        {entries.map((item) => <li key={item.id} className="time-entry">
          <button type="button" className="time-entry-main" onClick={() => setEntry(item)}>
            <span className="time-entry-text"><strong className={item.description ? "" : "muted"}>{item.description || "No description"}</strong><span className="time-entry-meta">{item.user.name} · {dayLabel(localDay(item.startedAt))} {clock(item.startedAt)}{item.locked ? " · locked" : ""}</span></span>
          </button>
          <span className="time-entry-duration ui-tabular">{formatDuration(item.durationS, prefs.durationFormat)}</span>
          {item.amountMinor !== null && item.currency && <span className="time-entry-amount ui-tabular"><MoneyText money={{ amount: item.amountMinor, currency: item.currency }} /></span>}
        </li>)}
      </ul>)}
    {tab === "team" && <TeamPanel project={project} onChanged={load} />}
    {tab === "approvals" && manager && <ApprovalsPanel projectId={project.id} />}
    {/* The project's history (created, renamed, weeks submitted and decided) and comments (D1375). */}
    {tab === "activity" && <ItemTimeline kind="time_project" id={project.id} title="Activity" renderers={timeModule.activityRenderers} canComment={canCommentAtLevel(project.level)} refreshKey={String(project.revision)} />}
    {editing && <ProjectSheet project={project} onClose={() => setEditing(false)} onSaved={(saved) => { setProject(saved); setEditing(false); }} />}
    {entry && <EntrySheet entry={entry} onOpen={onOpen} onClose={() => setEntry(null)} />}
  </div>;
}

const LEVEL_WORDS: Record<string, string> = { view: "Can see it", comment: "Can see it", edit: "Logs time", manage: "Manager" };

/**
 * The project's team: who has access is the shared Access sheet over `/api/access/time_project/:id`
 * (D891, D1050); this panel keeps what the sheet does not cover, each member's hourly rate (managers).
 */
function TeamPanel({ project, onChanged }: { project: TimeProject; onChanged: () => void }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [rates, setRates] = useState<Awaited<ReturnType<typeof timeApi.rates>> | null>(null);
  const manager = project.level === "owner" || project.level === "manage";
  const load = useCallback(async () => {
    if (!manager) return;
    api<Access>(`/access/time_project/${project.id}`).then(setAccess, () => setAccess(null));
    void timeApi.rates(project.id).then(setRates, () => undefined);
  }, [manager, project.id]);
  useEffect(() => { void load(); }, [load]);
  if (!manager) return <p className="time-note">Only the project's managers see the team and rates.</p>;
  return <div className="time-team">
    <WorkspaceAccess kind="time_project" id={project.id} title={project.name} canManage label="Change who's on it"
      onSaved={() => { notify.success("Team saved"); void load(); onChanged(); invalidateProjects(); }} />
    {!access && <p className="time-loading" role="status">Loading the team…</p>}
    {access && <>
      {rates && <p className="time-note">Rates are per hour in {rates.currency}; an empty rate uses the project's rate{rates.projectRateMinor === null ? " (none set)" : ""}. Only managers see them.</p>}
      <ul className="time-team-list">
        <li><span className="time-team-name">{project.owner.name}</span><span className="ui-health" data-tone="accent">Owner</span>
          {rates && <RateCell projectId={project.id} userId={project.owner.id} rate={rates.members.find((member) => member.id === project.owner.id)?.rateMinor ?? null} currency={rates.currency} />}</li>
        {access.people.map((person) => <li key={person.id}>
          <span className="time-team-name">{person.displayName}</span>
          <span className="ui-health" data-tone="neutral">{LEVEL_WORDS[person.level] ?? person.level}</span>
          {rates && <RateCell projectId={project.id} userId={person.id} rate={rates.members.find((member) => member.id === person.id)?.rateMinor ?? null} currency={rates.currency} />}
        </li>)}
      </ul>
    </>}
  </div>;
}

function RateCell({ projectId, userId, rate, currency }: { projectId: string; userId: string; rate: number | null; currency: string }) {
  const [value, setValue] = useState(rate);
  return <span className="time-rate"><MoneyInput label="Their rate" value={value === null ? null : { amount: value, currency }} onChange={(money) => {
    const next = money?.amount ?? null;
    if (next === value) return;
    setValue(next);
    void timeApi.setRate(projectId, userId, next).then(() => notify.success(next === null ? "Uses the project's rate" : "Rate saved"), (reason) => notify.error(errorText(reason, "Could not save the rate")));
  }} /></span>;
}

function ApprovalsPanel({ projectId }: { projectId: string }) {
  const prefs = useUnitPreferences();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const load = useCallback(() => { timeApi.approvals({ project: projectId }).then((body) => setApprovals(body.approvals), () => setApprovals([])); }, [projectId]);
  useEffect(() => { load(); }, [load]);
  const decide = async (approval: Approval, decision: "approve" | "reject" | "unlock") => {
    try {
      const result = await timeApi.decide(approval.id, decision);
      notify.success(decision === "approve" ? `Approved; ${result.entries} entries locked` : decision === "reject" ? "Returned to them" : "Unlocked");
      load();
      timeChanged();
    } catch (reason) {
      notify.error(errorText(reason, "Could not do that"));
    }
  };
  if (!approvals) return <p className="time-loading" role="status">Loading approvals…</p>;
  if (!approvals.length) return <EmptyState icon={Check} title="No weeks submitted for approval." compact>People submit their week from the Timesheet tab.</EmptyState>;
  return <ul className="time-approval-list">
    {approvals.map((approval) => <li key={approval.id}>
      <span className="time-team-name">{approval.user.name}</span>
      <span>Week of {approval.weekStart}</span>
      <span className="ui-tabular">{formatDuration(approval.seconds, prefs.durationFormat)}</span>
      <span className="ui-health" data-tone={approval.status === "approved" ? "success" : approval.status === "rejected" ? "danger" : "info"}>{approval.status === "approved" ? <><Lock aria-hidden="true" />Approved</> : approval.status === "rejected" ? "Returned" : "Waiting"}</span>
      <span className="time-approval-actions">
        {approval.status === "submitted" && <>
          <button type="button" className="action-button ui-small-action" onClick={() => { void decide(approval, "approve"); }}><Check aria-hidden="true" />Approve</button>
          <button type="button" className="secondary-button ui-small-action" onClick={() => { void decide(approval, "reject"); }}><Undo2 aria-hidden="true" />Return</button>
        </>}
        {approval.status === "approved" && <button type="button" className="secondary-button ui-small-action" onClick={() => { void decide(approval, "unlock"); }}>Unlock</button>}
      </span>
    </li>)}
  </ul>;
}
