import { useEffect, useId, useMemo, useState } from "react";
import { Crown, Trash2, Users } from "lucide-react";
import { listPeople, listPickerGroups, type PickerGroup, type PickerPerson } from "../access/accessApi";
import { PrincipalPicker } from "../access/PrincipalPicker";
import { ModalDialog } from "../files/Dialog";
import { errorText, notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportOwner, ReportShare, ReportVisibility, ShareLevel } from "../../shared/reportsEdit";
import { addOwner, getOwners, getSharing, removeOwner, saveSharing } from "./reportEditApi";
import { messageOf } from "./reportsApi";
import { CopyLinkRow } from "./reportLink";

const AUDIENCES: Array<{ value: ReportVisibility; label: string; hint: string }> = [
  { value: "private", label: "Only the owners", hint: "Nobody else sees this report." },
  { value: "selected", label: "Chosen people and groups", hint: "They see the report and its results; with “Can comment” they can also ask the AI for changes, which an owner reviews." },
  { value: "all_users", label: "Everyone on the team", hint: "Every member and viewer can see the report and its results (never guests)." }
];

const LAST_OWNER = "A report always keeps at least one owner. Add another owner first.";

/**
 * Phase 2 (D482): the report's owners, each with every owner right. Owners and admins add people (members
 * and admins only) and remove owners; each change applies at once and is audited. The last owner can't
 * be removed (T390): its button is disabled, with the reason beside the list.
 */
function OwnersSection({ reportId, people, onLeft, onChanged }: { reportId: string; people: PickerPerson[]; onLeft: () => void; onChanged?: () => void }) {
  const [owners, setOwners] = useState<ReportOwner[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  useEffect(() => {
    let alive = true;
    getOwners(reportId).then((result) => { if (alive) setOwners(result.owners); }, (reason) => { if (alive) setError(messageOf(reason, "Could not load the owners")); });
    return () => { alive = false; };
  }, [reportId]);
  const options = useMemo(() => {
    const taken = new Set((owners ?? []).map((owner) => owner.id));
    return people.filter((person) => !taken.has(person.id) && (person.role === "admin" || person.role === "member"))
      .map((person) => ({ value: `user:${person.id}`, label: person.displayName, description: person.role ?? undefined, group: "People" }));
  }, [owners, people]);

  async function change(work: () => Promise<{ owners: ReportOwner[]; canManage: boolean }>, done: (result: { owners: ReportOwner[]; canManage: boolean }) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      done(result);
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason, "Could not change the owners"));
    } finally {
      setBusy(false);
    }
  }
  const add = (value: string) => {
    const id = value.slice("user:".length);
    const name = people.find((person) => person.id === id)?.displayName ?? "They";
    void change(() => addOwner(reportId, id), (result) => { setOwners(result.owners); notify.success(`${name} is now an owner`); });
  };
  const remove = (owner: ReportOwner) => void change(() => removeOwner(reportId, owner.id), (result) => {
    if (!result.canManage) { notify.success("You are no longer an owner of this report"); onLeft(); return; }
    setOwners(result.owners);
    notify.success(`${owner.name} is no longer an owner`);
  });
  const last = owners?.length === 1;

  return <section className="report-owners" aria-labelledby={`${reasonId}-title`}>
    <h3 id={`${reasonId}-title`}>Owners</h3>
    <p className="file-dialog-hint">Every owner can change, share, file, and delete the report. Changes here apply at once.</p>
    {!owners && !error && <p className="reports-loading" role="status">Loading…</p>}
    {owners && <>
      <PrincipalPicker options={options} onPick={add} disabled={busy} emptyText="No other member to add" label="Add an owner" />
      <ul className="report-share-list report-owner-list">
        {owners.map((owner) => <li key={owner.id}>
          <span className="report-share-name"><Crown aria-hidden="true" />{owner.name}
            {owner.primary && <small className="report-owner-tag" title="Scheduled refreshes run as this owner">Primary</small>}
            {!owner.active && <small className="report-owner-tag report-owner-tag-off">Can’t sign in</small>}
          </span>
          <button type="button" className="icon-button" aria-label={`Remove ${owner.name} as owner`} disabled={busy || last} aria-describedby={last ? reasonId : undefined}
            title={last ? LAST_OWNER : undefined} onClick={() => remove(owner)}><Trash2 /></button>
        </li>)}
      </ul>
      {last && <p id={reasonId} className="file-dialog-hint report-owner-last">{LAST_OWNER}</p>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

/**
 * Sharing a report (plan wave 48; phase 2: any of its owners): view-only, the collections pattern.
 * People and groups see the report, its results, and how each block was built (never the doc); "Can
 * comment" adds asking the edit agent for changes. Only owners refresh, schedule, apply, restore, or
 * edit. Phase 2: the Owners section on top, for owners and admins; an admin who is not an owner gets
 * the Owners section alone (`canShare` false).
 */
export function ShareSheet({ reportId, title, onClose, reopen, link, copyFailed = false, flash = () => undefined, canShare = true, canManageOwners = false, onOwnersChanged, onLeft, layerKey = "reports.share" }: {
  reportId: string; title: string; onClose: () => void; reopen?: () => void;
  /** The report's URL (the Copy link row); none in tests. */ link?: string;
  /** The clipboard refused the Share click's copy: the field starts selected. */ copyFailed?: boolean; flash?: (message: string) => void;
  /** An owner: the sharing below the owners. False for an admin who manages owners only. */ canShare?: boolean;
  /** Phase 2: an owner or an admin sees the Owners section. */ canManageOwners?: boolean;
  onOwnersChanged?: () => void;
  /** The caller removed themselves as an owner: they may no longer read the report. */ onLeft?: () => void;
  /** The history layer's key (D480): Settings → Report owners names the report, `settings.reportOwners:<id>`. */ layerKey?: string;
}) {
  const [visibility, setVisibility] = useState<ReportVisibility>("private");
  const [shares, setShares] = useState<ReportShare[]>([]);
  const [people, setPeople] = useState<PickerPerson[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [sharing, directory, groupList] = await Promise.all([canShare ? getSharing(reportId).then((result) => result.sharing) : null, listPeople().catch(() => ({ users: [] as PickerPerson[] })), canShare ? listPickerGroups().catch(() => ({ groups: [] as PickerGroup[] })) : { groups: [] as PickerGroup[] }]);
        if (!alive) return;
        if (sharing) {
          setVisibility(sharing.visibility);
          setShares(sharing.shares);
        }
        setPeople(directory.users.filter((person) => person.kind !== "service" && person.role !== "guest"));
        setGroups(groupList.groups);
        setLoaded(true);
      } catch (reason) {
        if (alive) setError(messageOf(reason, "Could not load the sharing"));
      }
    })();
    return () => { alive = false; };
  }, [canShare, reportId]);

  const options = useMemo(() => {
    const taken = new Set(shares.map((share) => `${share.kind}:${share.id}`));
    return [
      ...groups.filter((group) => !taken.has(`group:${group.id}`)).map((group) => ({ value: `group:${group.id}`, label: group.name, description: `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`, group: "Groups" })),
      ...people.filter((person) => !taken.has(`user:${person.id}`)).map((person) => ({ value: `user:${person.id}`, label: person.displayName, description: person.role ?? undefined, group: "People" }))
    ];
  }, [groups, people, shares]);

  const pick = (value: string) => {
    const [kind, id] = value.split(":") as ["user" | "group", string];
    const label = kind === "group" ? groups.find((group) => group.id === id)?.name : people.find((person) => person.id === id)?.displayName;
    setShares((current) => [...current, { kind, id, name: label ?? "Unknown", level: "view" }]);
  };
  const setLevel = (share: ReportShare, level: ShareLevel) => setShares((current) => current.map((item) => item.kind === share.kind && item.id === share.id ? { ...item, level } : item));
  const remove = (share: ReportShare) => setShares((current) => current.filter((item) => !(item.kind === share.kind && item.id === share.id)));

  async function save() {
    setBusy(true);
    try {
      await saveSharing(reportId, { visibility, shares: visibility === "selected" ? shares.map(({ kind, id, level }) => ({ kind, id, level })) : [] });
      notify.success(visibility === "private" ? "Only the owners can see this report" : "Sharing saved");
      onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not save the sharing"));
      setBusy(false);
    }
  }

  return <ModalDialog title={canShare ? "Share" : "Owners"} eyebrow={title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-edit-sheet report-share">
    <div className="report-edit-sheet-body">
      {link && canShare && <CopyLinkRow url={link} selectFirst={copyFailed} flash={flash} />}
      {!loaded && !error && <p className="reports-loading" role="status">Loading…</p>}
      {loaded && canManageOwners && <OwnersSection reportId={reportId} people={people} onChanged={onOwnersChanged} onLeft={() => { onClose(); onLeft?.(); }} />}
      {loaded && canShare && <>
        <fieldset className="report-share-audience">
          <legend>Who can see it</legend>
          {AUDIENCES.map((audience) => <label key={audience.value} className="report-share-option">
            <input type="radio" name={name} value={audience.value} checked={visibility === audience.value} onChange={() => setVisibility(audience.value)} />
            <span><strong>{audience.label}</strong><small>{audience.hint}</small></span>
          </label>)}
        </fieldset>
        {visibility === "selected" && <>
          <PrincipalPicker options={options} onPick={pick} />
          {!shares.length && <p className="file-dialog-hint">Add people or groups to share with.</p>}
          <ul className="report-share-list">
            {shares.map((share) => <li key={`${share.kind}:${share.id}`}>
              <span className="report-share-name">{share.kind === "group" && <Users aria-hidden="true" />}{share.name}</span>
              <Select<ShareLevel> label={`${share.name}'s access`} value={share.level} onChange={(next) => setLevel(share, next)}
                options={[{ value: "view", label: "Can view" }, { value: "comment", label: "Can comment" }]} />
              <button type="button" className="icon-button" aria-label={`Remove ${share.name}`} onClick={() => remove(share)}><Trash2 /></button>
            </li>)}
          </ul>
        </>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="file-dialog-actions report-edit-sheet-actions">
      {canShare ? <>
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy || !loaded}>{busy ? "Saving…" : "Save sharing"}</button>
      </> : <button type="button" className="primary-button" onClick={onClose}>Done</button>}
    </footer>
  </ModalDialog>;
}
