import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MentionTextarea } from "../ui/mentions/MentionTextarea";
import { MentionText } from "../ui/mentions/Mentions";
import {
  ArrowLeft, BellRing, Building2, CalendarClock, Check, Contact, Download, Handshake, Loader2, Mail, MessageSquareText, Phone, PhoneCall, Plus, SquareCheck, StickyNote, Trash2, Trophy, Users, XCircle
} from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { ModalDialog } from "../files/Dialog";
import { Avatar } from "../ui/Avatar";
import { MoreMenu } from "../ui/MoreMenu";
import { Select } from "../ui/Select";
import { MoneyInput } from "../ui/money/Money";
import { PersonPicker } from "../ui/people/People";
import { LinkedItemsPanel } from "../ui/links/WorkLinks";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { ItemSectionsOutlet } from "../ui/ItemSlotOutlet";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { useConfirm } from "../ui/useConfirm";
import { notify } from "../ui/notify";
import { searchPeople } from "../ui/workspaceApi";
import type { PersonSummary } from "../../shared/people";
import {
  INTERACTION_LABELS, type CrmBook, type CrmCompanyDetail, type CrmContactDetail, type CrmDealDetail, type CrmEntity, type CrmFieldDef, type CrmFieldValue, type CrmInteraction, type CrmList, type InteractionKind
} from "../../shared/crm";
import {
  binCompany, binContact, binDeal, changeListMembers, deleteInteraction, errorMessage, getCompany, getContact, getDeal, listCompanies, listContacts, listLists, logInteraction, mergeCompany, mergeContact,
  recordTimeline, undo, updateCompany, updateContact, updateDeal, updateFollowup, vcardUrl, type CrmTimeline
} from "./crmApi";
import { CRM_ACTIVITY_RENDERERS, activityPlain } from "./activityText";
import { FollowupSheet, LostReasonSheet, NewDealSheet, TaskSheet } from "./Sheets";
import { DealCard } from "./DealsView";
import { dateTime, fieldText, isPast, money, relative, shortDate } from "./format";
import { cachedPerson, rememberPerson, useRelationNames } from "./relationNames";

/**
 * A contact, company, or deal page (§D.5 "Record page", §E.4): a header with the quick actions (Log,
 * Remind me, Create task, Email, vCard, Merge, Move to Bin), a fields column (built-in and custom,
 * saved as you leave each field), and the timeline (log composer, interactions, activity, linked
 * items, your follow-ups) with deals, contacts, lists, linked work, and comments. Deals add the stage
 * stepper.
 */

type Detail = CrmContactDetail | CrmCompanyDetail | CrmDealDetail;
const titleOf = (kind: CrmEntity, detail: Detail) => kind === "contact" ? (detail as CrmContactDetail).displayName : kind === "company" ? (detail as CrmCompanyDetail).name : (detail as CrmDealDetail).title;

let teamCache: Promise<Array<{ id: string; name: string }>> | null = null;
const loadTeam = () => teamCache ??= searchPeople("", ["user"]).then(({ people }) => people.filter((person) => person.kind === "user").map((person) => ({ id: (person as { id: string }).id, name: (person as { name: string }).name })), () => { teamCache = null; return []; });

export function RecordPage({ kind, refId, books, canWriteRole, onOpen, onBack, onGone, onReplacePath }: {
  kind: CrmEntity; refId: string; books: readonly CrmBook[]; canWriteRole: boolean;
  onOpen: (href: string) => void; onBack: () => void; onGone: () => void; onReplacePath: (href: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<CrmTimeline | null>(null);
  const [sheet, setSheet] = useState<"followup" | "task" | "deal" | "merge" | "lost" | null>(null);
  const [lostStage, setLostStage] = useState<string | null>(null);
  const [team, setTeam] = useState<Array<{ id: string; name: string }>>([]);
  const [lists, setLists] = useState<CrmList[]>([]);
  const [composerKind, setComposerKind] = useState<InteractionKind>("note");
  const [composer, setComposer] = useState("");
  const [logging, setLogging] = useState(false);
  const [show, setShow] = useState<"all" | "interactions" | "activity" | "links">("all");
  const [tick, setTick] = useState(0);
  const { ask, confirmElement } = useConfirm();

  const load = useCallback(async () => {
    try {
      const next = kind === "contact" ? (await getContact(refId)).contact : kind === "company" ? (await getCompany(refId)).company : (await getDeal(refId)).deal;
      setDetail(next);
      setError(null);
      if (!window.location.pathname.endsWith(next.href.split("/").pop()!)) onReplacePath(next.href);
      setTimeline(await recordTimeline(kind, next.id));
    } catch (reason) { setError(errorMessage(reason, "Could not open this")); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, refId]);
  useEffect(() => { setDetail(null); setTimeline(null); void load(); }, [load]);
  useEffect(() => { void loadTeam().then(setTeam); }, []);
  useEffect(() => { if (detail) listLists(detail.bookId, kind).then(({ lists: found }) => setLists(found), () => setLists([])); }, [detail?.bookId, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useModuleShortcuts({ l: () => { document.getElementById("crm-composer")?.focus(); } });

  if (error) return <div className="crm-record"><button type="button" className="ui-text-button crm-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back</button><EmptyState icon={Contact} title="Not found">{error}</EmptyState></div>;
  if (!detail) return <p className="ui-panel-loading" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading…</p>;

  const title = titleOf(kind, detail);
  const book = books.find((item) => item.id === detail.bookId) ?? null;
  const canEdit = detail.canEdit && canWriteRole;
  const subject = { kind, id: detail.id, name: title };
  const refresh = () => { setTick((value) => value + 1); void load(); };
  const save = async (patch: Record<string, unknown>) => {
    try {
      if (kind === "contact") await updateContact(detail.id, patch); else if (kind === "company") await updateCompany(detail.id, patch); else await updateDeal(detail.id, patch);
      await load();
      setTick((value) => value + 1);
    } catch (reason) { notify.error(errorMessage(reason, "Could not save")); }
  };
  const logIt = async () => {
    if (!composer.trim()) return;
    setLogging(true);
    try {
      const firstLine = composer.trim().split("\n")[0]!.slice(0, 120);
      await logInteraction({ kind: composerKind, title: composerKind === "note" ? "" : firstLine, body: composer.trim(), subjects: [{ kind, id: detail.id }] });
      setComposer(""); refresh();
    } catch (reason) { notify.error(errorMessage(reason, "Could not log it")); } finally { setLogging(false); }
  };
  const removeInteraction = async (interaction: CrmInteraction) => {
    try {
      const { undoTicket } = await deleteInteraction(interaction.id);
      refresh();
      notify.success("Interaction deleted", { action: { label: "Undo", onClick: () => { void undo(undoTicket).then(refresh); } } });
    } catch (reason) { notify.error(errorMessage(reason, "Could not delete")); }
  };
  const bin = async () => {
    if (!(await ask({ title: `Move ${title} to the Bin?`, message: "You can restore it from the Bin for 30 days.", confirmLabel: "Move to Bin", danger: true }))) return;
    try { if (kind === "contact") await binContact(detail.id); else if (kind === "company") await binCompany(detail.id); else await binDeal(detail.id); notify.success(`Moved ${title} to the Bin`); onGone(); }
    catch (reason) { notify.error(errorMessage(reason, "Could not move it to the Bin")); }
  };
  const moveStage = async (stageId: string, lostReason?: string) => {
    const deal = detail as CrmDealDetail;
    const stage = deal.pipeline.stages.find((item) => item.id === stageId);
    if (stage?.kind === "lost" && lostReason === undefined) { setLostStage(stageId); setSheet("lost"); return; }
    await save({ stageId, ...(lostReason !== undefined ? { lostReason: lostReason || null } : {}) });
  };
  const email = kind === "contact" ? (detail as CrmContactDetail).email : null;
  const phoneNumber = kind === "contact" ? (detail as CrmContactDetail).phone : null;
  const inLists = new Set(detail.lists.map((list) => list.id));

  const header = <header className="crm-record-header">
    {kind === "contact" ? <Avatar className="crm-avatar large" name={title} url={null} /> : <span className="crm-avatar large square" aria-hidden="true">{kind === "deal" ? <Handshake /> : <Building2 />}</span>}
    <div className="crm-record-title">
      <h2 tabIndex={-1}>{title}</h2>
      <p className="crm-record-sub">
        {kind === "contact" && <>{(detail as CrmContactDetail).jobTitle}{(detail as CrmContactDetail).jobTitle && (detail as CrmContactDetail).companyName ? " at " : ""}
          {(detail as CrmContactDetail).companyName && <button type="button" className="ui-text-button" onClick={() => { const company = (detail as CrmContactDetail).companyId; if (company) onOpen(`/contacts/companies/${company}`); }}><Building2 aria-hidden="true" />{(detail as CrmContactDetail).companyName}</button>}</>}
        {kind === "company" && <>{(detail as CrmCompanyDetail).domain ?? "No domain"} · {(detail as CrmCompanyDetail).contactCount} contacts · {(detail as CrmCompanyDetail).openDeals} open deals</>}
        {kind === "deal" && <><span className="ui-tone crm-stage-chip" data-tone={(detail as CrmDealDetail).status === "won" ? "success" : (detail as CrmDealDetail).status === "lost" ? "danger" : "info"}>{(detail as CrmDealDetail).stageName}</span>
          {(detail as CrmDealDetail).value && <strong className="ui-tabular"> {money((detail as CrmDealDetail).value!.amount, (detail as CrmDealDetail).currency)}</strong>}
          {(detail as CrmDealDetail).companyName && <> · {(detail as CrmDealDetail).companyName}</>}
          {(detail as CrmDealDetail).rotting && <span className="crm-rot-label"><span className="crm-rot" aria-hidden="true" />No recent activity</span>}</>}
        {kind === "contact" && (detail as CrmContactDetail).lifecycle && <span className="ui-tone crm-stage-chip" data-tone="accent">{(detail as CrmContactDetail).lifecycle}</span>}
      </p>
    </div>
    <div className="crm-record-actions">
      {canEdit && <button type="button" className="action-button" onClick={() => document.getElementById("crm-composer")?.focus()} aria-keyshortcuts="l"><PhoneCall aria-hidden="true" />Log</button>}
      <button type="button" className="action-button secondary" onClick={() => setSheet("followup")}><BellRing aria-hidden="true" />Remind me</button>
      {canEdit && <button type="button" className="action-button secondary" onClick={() => setSheet("task")}><SquareCheck aria-hidden="true" />Create task</button>}
      {email && <a className="action-button secondary" href={`mailto:${email}`}><Mail aria-hidden="true" />Email</a>}
      <MoreMenu label={`More actions for ${title}`} items={[
        ...(phoneNumber ? [{ id: "call", label: `Call ${phoneNumber}`, icon: Phone, onSelect: () => { window.location.href = `tel:${phoneNumber}`; } }] : []),
        ...(kind === "contact" ? [{ id: "vcard", label: "Download vCard", icon: Download, onSelect: () => { window.location.href = vcardUrl(detail.id); } }] : []),
        ...(canEdit && kind !== "deal" ? [{ id: "deal", label: "New deal", icon: Handshake, onSelect: () => setSheet("deal") }] : []),
        ...(canEdit && kind !== "deal" ? [{ id: "merge", label: "Merge with…", icon: Users, onSelect: () => setSheet("merge") }] : []),
        ...(canEdit ? lists.filter((list) => !inLists.has(list.id)).slice(0, 8).map((list) => ({ id: `list-${list.id}`, label: `Add to ${list.name}`, icon: Plus, onSelect: () => { void changeListMembers(list.id, { add: [detail.id] }).then(() => { notify.success(`Added to ${list.name}`); void load(); }, (reason) => notify.error(errorMessage(reason, "Could not add"))); } })) : []),
        ...(canEdit ? [{ id: "bin", label: "Move to Bin", icon: Trash2, danger: true, onSelect: () => void bin() }] : [])
      ]} />
    </div>
  </header>;

  const stepper = kind === "deal" && <ol className="crm-stepper" aria-label="Stage">
    {(detail as CrmDealDetail).pipeline.stages.map((stage) => {
      const deal = detail as CrmDealDetail;
      const current = stage.id === deal.stageId;
      const index = deal.pipeline.stages.findIndex((item) => item.id === deal.stageId);
      const passed = deal.pipeline.stages.indexOf(stage) < index && stage.kind === "open";
      return <li key={stage.id}><button type="button" className={`crm-step${current ? " current" : ""}${passed ? " passed" : ""} ${stage.kind}`} aria-current={current ? "step" : undefined} disabled={!canEdit || current} onClick={() => void moveStage(stage.id)}>
        {stage.kind === "won" ? <Trophy aria-hidden="true" /> : stage.kind === "lost" ? <XCircle aria-hidden="true" /> : passed || current ? <Check aria-hidden="true" /> : null}{stage.name}
      </button></li>;
    })}
  </ol>;

  const entries: Array<{ at: string; key: string; node: ReactNode; type: "interactions" | "activity" | "links" }> = [];
  for (const interaction of timeline?.interactions ?? []) entries.push({ at: interaction.occurredAt, key: `i:${interaction.id}`, type: "interactions", node: <InteractionRow interaction={interaction} onDelete={() => void removeInteraction(interaction)} self={kind} /> });
  for (const entry of timeline?.activity ?? []) if (!["crm_interaction", "linked", "unlinked"].includes(entry.kind)) entries.push({ at: entry.createdAt, key: `a:${entry.id}`, type: "activity", node: <p className="crm-activity"><strong>{entry.actorName}</strong> {CRM_ACTIVITY_RENDERERS[entry.kind]?.(entry) ?? activityPlain(entry)} <time dateTime={entry.createdAt}>{relative(entry.createdAt)}</time></p> });
  for (const link of timeline?.links ?? []) if (link.createdAt) entries.push({ at: link.createdAt, key: `l:${link.id}`, type: "links", node: <p className="crm-activity">Linked {"hidden" in link.other ? "an item you can't open" : <a href={link.other.href} onClick={(event) => { event.preventDefault(); onOpen((link.other as { href: string }).href); }}>{link.other.title}</a>} <time dateTime={link.createdAt}>{relative(link.createdAt)}</time></p> });
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const shown = entries.filter((entry) => show === "all" || entry.type === show);

  return <div className="crm-record">
    <button type="button" className="ui-text-button crm-back" onClick={onBack}><ArrowLeft aria-hidden="true" />{kind === "contact" ? "Contacts" : kind === "company" ? "Companies" : "Deals"}</button>
    {header}
    {stepper}
    {kind === "contact" && (detail as CrmContactDetail).duplicates.length > 0 && <p className="crm-banner" role="note">Possible duplicate: {(detail as CrmContactDetail).duplicates.map((item, index) => <span key={item.id}>{index ? ", " : ""}<button type="button" className="ui-text-button" onClick={() => onOpen(`/contacts/${item.id}`)}>{item.displayName}</button> ({item.reason.toLowerCase()})</span>)}.{canEdit && <> <button type="button" className="ui-text-button" onClick={() => setSheet("merge")}>Merge…</button></>}</p>}
    <div className="crm-record-layout">
      <aside className="crm-fields" aria-label="Details">
        <Fields kind={kind} detail={detail} book={book} team={team} canEdit={canEdit} onSave={save} />
        {timeline && timeline.followups.length > 0 && <section className="crm-panel-mini" aria-label="Your follow-ups">
          <h3><BellRing aria-hidden="true" />Your follow-ups</h3>
          <ul className="crm-followups">{timeline.followups.map((followup) => <li key={followup.id} className={isPast(followup.dueAt.slice(0, 10)) ? "overdue" : undefined}>
            <span><span className="crm-followup-when"><CalendarClock aria-hidden="true" />{dateTime(followup.dueAt)}</span>{followup.note && <small>{followup.note}</small>}</span>
            <button type="button" className="ui-small-button secondary-button" onClick={() => void updateFollowup(followup.id, { done: true }).then(refresh)}><Check aria-hidden="true" />Done</button>
          </li>)}</ul>
        </section>}
        {detail.lists.length > 0 && <section className="crm-panel-mini" aria-label="Lists"><h3>Lists</h3><p className="crm-tags">{detail.lists.map((list) => <span key={list.id} className="crm-tag">{list.name}</span>)}</p></section>}
      </aside>
      <section className="crm-main" aria-label="Timeline">
        {canEdit && <div className="crm-composer">
          <div className="ui-segmented" role="group" aria-label="Log a">{(["note", "call", "meeting", "email"] as const).map((item) => <button key={item} type="button" aria-pressed={composerKind === item} onClick={() => setComposerKind(item)}>{INTERACTION_LABELS[item]}</button>)}</div>
          <label className="ui-visually-hidden" htmlFor="crm-composer">{`Log a ${INTERACTION_LABELS[composerKind].toLowerCase()}`}</label>
          <MentionTextarea id="crm-composer" rows={3} maxLength={20000} value={composer} target={{ kind, id: detail.id }} noun={kind} placeholder={composerKind === "note" ? "Write a note… @ to mention someone" : `What happened on the ${INTERACTION_LABELS[composerKind].toLowerCase()}?`} onValueChange={setComposer}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void logIt(); } }} />
          <div className="crm-composer-actions"><small>⌘/Ctrl + Enter to log</small><button type="button" className="action-button" disabled={logging || !composer.trim()} onClick={() => void logIt()}>{logging ? "Logging…" : `Log ${INTERACTION_LABELS[composerKind].toLowerCase()}`}</button></div>
        </div>}
        <div className="crm-chips" role="group" aria-label="Show">
          {([["all", "All"], ["interactions", "Notes and calls"], ["activity", "Changes"], ["links", "Links"]] as const).map(([id, label]) => <button key={id} type="button" className="ui-filter-chip" aria-pressed={show === id} onClick={() => setShow(id)}>{label}</button>)}
        </div>
        {timeline === null ? <p className="ui-panel-loading" role="status">Loading the timeline…</p> : shown.length === 0 ? <p className="crm-muted">Nothing here yet. Log a note or a call to start the history.</p>
          : <ol className="crm-timeline">{shown.map((entry) => <li key={entry.key}>{entry.node}</li>)}</ol>}

        {kind !== "deal" && <section className="crm-panel-mini" aria-label="Deals">
          <h3><Handshake aria-hidden="true" />Deals <span className="ui-panel-count">{(detail as CrmContactDetail).deals.length}</span>{canEdit && <button type="button" className="ui-text-button" onClick={() => setSheet("deal")}><Plus aria-hidden="true" />New deal</button>}</h3>
          {(detail as CrmContactDetail).deals.length === 0 ? <p className="crm-muted">No deals yet.</p> : <ul className="crm-mini-cards">{(detail as CrmContactDetail).deals.map((deal) => <li key={deal.id}><button type="button" className="crm-mini-card" onClick={() => onOpen(deal.href)}><DealCard deal={deal} /><span className="crm-mini-stage">{deal.stageName}</span></button></li>)}</ul>}
        </section>}
        {kind === "company" && <section className="crm-panel-mini" aria-label="People">
          <h3><Contact aria-hidden="true" />People <span className="ui-panel-count">{(detail as CrmCompanyDetail).contacts.length}</span></h3>
          {(detail as CrmCompanyDetail).contacts.length === 0 ? <p className="crm-muted">No contacts at this company yet.</p> : <ul className="crm-people">{(detail as CrmCompanyDetail).contacts.map((contact) => <li key={contact.id}><button type="button" className="crm-list-row" onClick={() => onOpen(contact.href)}><Avatar className="crm-avatar" name={contact.displayName} url={null} /><span className="crm-list-text"><strong>{contact.displayName}</strong><small>{contact.jobTitle ?? contact.email ?? ""}</small></span></button></li>)}</ul>}
        </section>}
        <ItemSectionsOutlet kind={kind} id={detail.id} readOnly={!canWriteRole} onOpen={onOpen} person={kind === "contact" ? { name: title, email } : null} />
        <LinkedItemsPanel item={{ kind, id: detail.id }} canEdit={canEdit} onOpen={onOpen} title="Linked work" />
        {/* The record timeline above already shows the history (changes, links, interactions), so the
            comments come alone here (D988), the same on contact, company, and deal pages. */}
        <ItemTimeline kind={kind} id={detail.id} canComment={canWriteRole && detail.canEdit} renderers={CRM_ACTIVITY_RENDERERS} title="Comments" refreshKey={String(tick)} history={false} />
      </section>
    </div>
    {sheet === "followup" && <FollowupSheet subject={subject} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); notify.success("We'll remind you"); refresh(); }} />}
    {sheet === "task" && <TaskSheet subject={subject} onClose={() => setSheet(null)} onCreated={() => { setSheet(null); notify.success("Task created and linked"); refresh(); }} />}
    {sheet === "deal" && book && <NewDealSheet book={book} initialContact={kind === "contact" ? { kind: "contact", id: detail.id, name: title, bookId: detail.bookId } : null} initialCompany={kind === "company" ? { id: detail.id, name: title } : null}
      onClose={() => setSheet(null)} onCreated={(created) => { setSheet(null); notify.success(`Added ${created.name}`); refresh(); }} />}
    {sheet === "lost" && lostStage && <LostReasonSheet title={title} onClose={() => setSheet(null)} onSave={(reason) => { setSheet(null); void moveStage(lostStage, reason); }} />}
    {sheet === "merge" && kind !== "deal" && <MergeSheet kind={kind} detail={detail} onClose={() => setSheet(null)} onMerged={(href) => { setSheet(null); notify.success("Merged"); onReplacePath(href); onOpen(href); }} />}
    {confirmElement}
  </div>;
}

export function InteractionRow({ interaction, onDelete, self }: { interaction: CrmInteraction; onDelete: () => void; self: CrmEntity }) {
  const Icon = interaction.kind === "call" ? PhoneCall : interaction.kind === "email" ? Mail : interaction.kind === "meeting" ? Users : interaction.kind === "note" ? StickyNote : MessageSquareText;
  const others = interaction.subjects.filter((subject) => subject.kind !== self && subject.title);
  return <article className="crm-interaction">
    <span className="crm-interaction-icon" aria-hidden="true"><Icon /></span>
    <div>
      <header><strong>{interaction.title || INTERACTION_LABELS[interaction.kind]}</strong><span className="crm-muted">{interaction.title ? ` · ${INTERACTION_LABELS[interaction.kind]}` : ""}{interaction.durationS ? ` · ${Math.round(interaction.durationS / 60)} min` : ""}{" · "}{interaction.author?.name ?? "Nook"} · <time dateTime={interaction.occurredAt}>{dateTime(interaction.occurredAt)}</time></span></header>
      {interaction.body && interaction.body !== interaction.title && <p className="crm-interaction-body"><MentionText text={interaction.body} /></p>}
      {others.length > 0 && <p className="crm-muted">Also on {others.map((subject) => subject.title).join(", ")}</p>}
    </div>
    {interaction.canEdit && <button type="button" className="icon-button" aria-label="Delete this interaction" title="Delete" onClick={onDelete}><Trash2 /></button>}
  </article>;
}

/** One editable field: saved when it changes (blur, Enter, or a pick). */
function EditText({ label, value, onSave, disabled, type = "text", multiline = false, placeholder }: { label: string; value: string | null; onSave: (value: string | null) => void; disabled: boolean; type?: string; multiline?: boolean; placeholder?: string }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);
  const commit = () => { if ((text.trim() || null) !== (value ?? null)) onSave(text.trim() || null); };
  const id = `crm-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <div className="crm-field"><label htmlFor={id}>{label}</label>
    {multiline ? <textarea id={id} rows={3} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={commit} placeholder={placeholder ?? "—"} />
      : <input id={id} type={type} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} placeholder={placeholder ?? "—"} />}
  </div>;
}

function Fields({ kind, detail, book, team, canEdit, onSave }: { kind: CrmEntity; detail: Detail; book: CrmBook | null; team: Array<{ id: string; name: string }>; canEdit: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const disabled = !canEdit;
  const owner = (detail as { owner: { id: string; name: string } | null }).owner;
  const ownerOptions = [{ value: "", label: "No owner" }, ...team.map((member) => ({ value: member.id, label: member.name })), ...(owner && !team.some((member) => member.id === owner.id) ? [{ value: owner.id, label: owner.name }] : [])];
  const ownerField = <div className="crm-field"><span id={`crm-owner-${kind}`}>Owner</span><Select labelledBy={`crm-owner-${kind}`} value={owner?.id ?? ""} disabled={disabled} options={ownerOptions} onChange={(value) => onSave({ ownerId: value || null })} /></div>;
  const tags = (detail as { tags: string[] }).tags;
  const tagsField = <EditText label="Tags" value={tags.join(", ")} disabled={disabled} placeholder="Comma separated" onSave={(value) => onSave({ tags: (value ?? "").split(",").map((tag) => tag.trim()).filter(Boolean) })} />;
  const fields = book?.fields[kind] ?? [];
  const custom = fields.map((field) => <CustomField key={field.id} field={field} value={(detail as { custom: Record<string, CrmFieldValue> }).custom[field.id]} disabled={disabled} team={team} bookId={detail.bookId} onSave={(value) => onSave({ custom: { [field.id]: value } })} />);
  if (kind === "contact") {
    const contact = detail as CrmContactDetail;
    return <>
      <div className="crm-field-pair"><EditText label="First name" value={contact.firstName} disabled={disabled} onSave={(value) => onSave({ firstName: value, lastName: contact.lastName })} /><EditText label="Last name" value={contact.lastName} disabled={disabled} onSave={(value) => onSave({ firstName: contact.firstName, lastName: value })} /></div>
      <EditText label="Email" type="email" value={contact.email} disabled={disabled} onSave={(value) => onSave({ email: value })} />
      <EditText label="Phone" type="tel" value={contact.phone} disabled={disabled} onSave={(value) => onSave({ phone: value })} />
      <EditText label="Job title" value={contact.jobTitle} disabled={disabled} onSave={(value) => onSave({ jobTitle: value })} />
      <EditText label="Company" value={contact.companyName} disabled={disabled} onSave={(value) => onSave(value ? { companyName: value } : { companyId: null })} />
      {ownerField}
      <div className="crm-field"><span id="crm-lifecycle">Lifecycle</span><Select labelledBy="crm-lifecycle" value={contact.lifecycle ?? ""} disabled={disabled} options={[{ value: "", label: "None" }, ...[...new Set([...(book?.settings.lifecycles ?? []), ...(contact.lifecycle ? [contact.lifecycle] : [])])].map((item) => ({ value: item, label: item }))]} onChange={(value) => onSave({ lifecycle: value || null })} /></div>
      <EditText label="Location" value={contact.location} disabled={disabled} onSave={(value) => onSave({ location: value })} />
      {tagsField}
      {custom}
      {contact.channels.filter((channel) => channel.kind === "email" && channel.value !== contact.email).length > 0 && <p className="crm-muted">Other emails: {contact.channels.filter((channel) => channel.kind === "email" && channel.value !== contact.email).map((channel) => channel.value).join(", ")}</p>}
      <p className="crm-muted">Source: {contact.source} · added {shortDate(contact.createdAt)} · last interaction {relative(contact.lastInteractionAt)}</p>
    </>;
  }
  if (kind === "company") {
    const company = detail as CrmCompanyDetail;
    return <>
      <EditText label="Name" value={company.name} disabled={disabled} onSave={(value) => value && onSave({ name: value })} />
      <EditText label="Domain" value={company.domain} disabled={disabled} onSave={(value) => onSave({ domain: value })} />
      <EditText label="Website" type="url" value={company.website} disabled={disabled} onSave={(value) => onSave({ website: value })} />
      {ownerField}
      <EditText label="Description" multiline value={company.description} disabled={disabled} onSave={(value) => onSave({ description: value ?? "" })} />
      {tagsField}
      {custom}
      <p className="crm-muted">Added {shortDate(company.createdAt)} · last interaction {relative(company.lastInteractionAt)}</p>
    </>;
  }
  const deal = detail as CrmDealDetail;
  return <>
    <EditText label="Title" value={deal.title} disabled={disabled} onSave={(value) => value && onSave({ title: value })} />
    <MoneyInput label="Value" value={deal.value} currencyEditable disabled={disabled} onChange={(value, currency) => onSave({ value: value?.amount ?? null, currency })} />
    <EditText label="Expected close" type="date" value={deal.expectedCloseOn} disabled={disabled} onSave={(value) => onSave({ expectedCloseOn: value })} />
    {ownerField}
    <DealCompany deal={deal} disabled={disabled} onSave={onSave} />
    <DealContacts deal={deal} disabled={disabled} onSave={onSave} />
    <EditText label="Next step" value={deal.nextStep} disabled={disabled} onSave={(value) => onSave({ nextStep: value })} />
    <EditText label="Next step date" type="date" value={deal.nextStepOn} disabled={disabled} onSave={(value) => onSave({ nextStepOn: value })} />
    {deal.status === "lost" && <EditText label="Lost reason" value={deal.lostReason} disabled={disabled} onSave={(value) => onSave({ lostReason: value })} />}
    {tagsField}
    {custom}
    <p className="crm-muted">{deal.probability}% probability · in stage since {shortDate(deal.stageEnteredAt)} · last activity {relative(deal.lastActivityAt)}</p>
  </>;
}

function DealCompany({ deal, disabled, onSave }: { deal: CrmDealDetail; disabled: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>(deal.companyId ? [{ value: deal.companyId, label: deal.companyName ?? "Company" }] : []);
  const search = useMemo(() => {
    let timer = 0;
    return (q: string) => { window.clearTimeout(timer); timer = window.setTimeout(() => { void listCompanies({ book: deal.bookId, q, limit: 30 }).then((page) => setOptions(page.items.map((company) => ({ value: company.id, label: company.name })))); }, 150); };
  }, [deal.bookId]);
  useEffect(() => { search(""); }, [search]);
  return <div className="crm-field"><span id="crm-deal-company">Company</span><Select labelledBy="crm-deal-company" searchable value={deal.companyId ?? ""} disabled={disabled} onSearch={search} options={[{ value: "", label: "No company" }, ...options]} onChange={(value) => onSave({ companyId: value || null })} /></div>;
}

function DealContacts({ deal, disabled, onSave }: { deal: CrmDealDetail; disabled: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const value: PersonSummary[] = deal.contacts.map((contact) => ({ kind: "contact", id: contact.id, name: contact.name, bookId: deal.bookId }));
  return <PersonPicker label="Contacts" value={value} allow={["contact"]} bookId={deal.bookId} disabled={disabled} onChange={(people) => onSave({ contactIds: people.filter((person) => person.kind === "contact").map((person) => (person as { id: string }).id) })} />;
}

function CustomField({ field, value, disabled, team, bookId, onSave }: { field: CrmFieldDef; value: CrmFieldValue | undefined; disabled: boolean; team: Array<{ id: string; name: string }>; bookId: string; onSave: (value: CrmFieldValue | null) => void }) {
  // Person and contact values are ids; their names come from the people resolver (D1206).
  const names = useRelationNames([field], [{ custom: value === undefined ? {} : { [field.id]: value } }]);
  const labelId = `crm-custom-${field.id}`;
  switch (field.type) {
    case "select": return <div className="crm-field"><span id={labelId}>{field.name}</span><Select labelledBy={labelId} value={typeof value === "string" ? value : ""} disabled={disabled} options={[{ value: "", label: "None" }, ...(field.options ?? []).map((option) => ({ value: option.id, label: option.label }))]} onChange={(next) => onSave(next || null)} /></div>;
    case "multi_select": return <div className="crm-field"><span id={labelId}>{field.name}</span><div className="crm-chips" role="group" aria-labelledby={labelId}>{(field.options ?? []).map((option) => {
      const chosen = Array.isArray(value) && value.includes(option.id);
      return <button key={option.id} type="button" className="ui-filter-chip" aria-pressed={chosen} disabled={disabled} onClick={() => { const current = Array.isArray(value) ? value : []; onSave(chosen ? current.filter((id) => id !== option.id) : [...current, option.id]); }}>{option.label}</button>;
    })}</div></div>;
    case "checkbox": return <div className="crm-field crm-field-check"><label><input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onSave(event.target.checked)} /> {field.name}</label></div>;
    case "person": {
      const current = typeof value === "string" ? value : "";
      // A former member stays listed by name until someone picks another.
      const extra = current && !team.some((member) => member.id === current) ? [{ value: current, label: names.get(current) ?? "Former member" }] : [];
      return <div className="crm-field"><span id={labelId}>{field.name}</span><Select labelledBy={labelId} value={current} disabled={disabled} options={[{ value: "", label: "Nobody" }, ...team.map((member) => ({ value: member.id, label: member.name })), ...extra]} onChange={(next) => onSave(next || null)} /></div>;
    }
    case "contact": {
      // Any contact of this book, searched as you type (not only the first page, D1206).
      const current = typeof value === "string" ? value : null;
      const chip: PersonSummary[] = current ? [cachedPerson(current) ?? { kind: "contact", id: current, name: names.get(current) ?? "Contact", bookId }] : [];
      return <div className="crm-field crm-field-contact"><PersonPicker label={field.name} value={chip} allow={["contact"]} bookId={bookId} multiple={false} disabled={disabled}
        onChange={(people) => { const next = people[0]; if (next) rememberPerson(next); onSave(next && "id" in next ? next.id : null); }} /></div>;
    }
    case "number": return <EditText label={field.name} type="number" value={value === undefined ? null : String(value)} disabled={disabled} onSave={(next) => onSave(next === null ? null : Number(next))} />;
    case "date": return <EditText label={field.name} type="date" value={typeof value === "string" ? value : null} disabled={disabled} onSave={(next) => onSave(next)} />;
    case "url": return <EditText label={field.name} type="url" value={typeof value === "string" ? value : null} disabled={disabled} onSave={(next) => onSave(next)} />;
    default: return <EditText label={field.name} value={value === undefined ? null : fieldText(field, value)} disabled={disabled} onSave={(next) => onSave(next)} />;
  }
}

function MergeSheet({ kind, detail, onClose, onMerged }: { kind: "contact" | "company"; detail: Detail; onClose: () => void; onMerged: (href: string) => void }) {
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [keep, setKeep] = useState<"this" | "other">("this");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useMemo(() => {
    let timer = 0;
    return (q: string) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const load = kind === "contact" ? listContacts({ book: detail.bookId, q, limit: 30 }).then((page) => page.items.map((item) => ({ value: item.id, label: `${item.displayName}${item.email ? ` · ${item.email}` : ""}` })))
          : listCompanies({ book: detail.bookId, q, limit: 30 }).then((page) => page.items.map((item) => ({ value: item.id, label: `${item.name}${item.domain ? ` · ${item.domain}` : ""}` })));
        void load.then((list) => setOptions(list.filter((item) => item.value !== detail.id)));
      }, 150);
    };
  }, [detail.bookId, detail.id, kind]);
  useEffect(() => { search(kind === "contact" ? (detail as CrmContactDetail).lastName ?? "" : ""); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const merge = async () => {
    if (!target) return;
    setBusy(true); setError(null);
    try {
      const [from, into] = keep === "this" ? [target, detail.id] : [detail.id, target];
      const href = kind === "contact" ? (await mergeContact(from, into)).contact.href : (await mergeCompany(from, into)).company.href;
      onMerged(href);
    } catch (reason) { setError(errorMessage(reason, "Could not merge")); setBusy(false); }
  };
  const name = titleOf(kind, detail);
  return <div className="crm-merge-wrap">
    <MergeDialog title={`Merge ${name}`} busy={busy} error={error} onClose={onClose} onSubmit={() => void merge()} disabled={!target}>
      <div className="ui-field"><span id="crm-merge-with">With</span><Select labelledBy="crm-merge-with" searchable value={target} options={options} onSearch={search} placeholder={`Find a ${kind}`} onChange={setTarget} /></div>
      <div className="ui-field"><span>Keep</span><div className="ui-segmented" role="group" aria-label="Which one to keep">
        <button type="button" aria-pressed={keep === "this"} onClick={() => setKeep("this")}>{name}</button>
        <button type="button" aria-pressed={keep === "other"} disabled={!target} onClick={() => setKeep("other")}>{options.find((item) => item.value === target)?.label.split(" · ")[0] ?? "The other"}</button>
      </div></div>
      <p className="ui-field-hint">The kept one takes the other's missing fields, emails, phones, tags, deals, notes, lists, and links. The other is removed. This can't be undone.</p>
    </MergeDialog>
  </div>;
}

function MergeDialog({ title, busy, error, onClose, onSubmit, disabled, children }: { title: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: () => void; disabled: boolean; children: ReactNode }) {
  return <ModalDialog title={title} onClose={onClose} variant="sheet" busy={busy} className="crm-sheet">
    <div className="crm-sheet-body">{children}</div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={onSubmit} disabled={busy || disabled}>{busy ? "Merging…" : "Merge"}</button>
    </footer>
  </ModalDialog>;
}
