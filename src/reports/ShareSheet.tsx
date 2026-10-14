import { useEffect, useId, useMemo, useState } from "react";
import { Trash2, Users } from "lucide-react";
import { listPeople, listPickerGroups, type PickerGroup, type PickerPerson } from "../access/accessApi";
import { PrincipalPicker } from "../access/PrincipalPicker";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportShare, ReportVisibility, ShareLevel } from "../../shared/reportsEdit";
import { getSharing, saveSharing } from "./reportEditApi";
import { messageOf } from "./reportsApi";
import { CopyLinkRow } from "./reportLink";

const AUDIENCES: Array<{ value: ReportVisibility; label: string; hint: string }> = [
  { value: "private", label: "Only me", hint: "Nobody else sees this report." },
  { value: "selected", label: "Chosen people and groups", hint: "They see the report and its results; with “Can comment” they can also ask the AI for changes, which you review." },
  { value: "all_users", label: "Everyone on the team", hint: "Every member and viewer can see the report and its results (never guests)." }
];

/**
 * Sharing a report (plan wave 48, the owner): view-only, the collections pattern. People and groups see
 * the report, its results, and how each block was built (never the doc); "Can comment" adds asking the
 * edit agent for changes. Only the owner refreshes, schedules, applies, restores, or edits.
 */
export function ShareSheet({ reportId, title, onClose, reopen, link, copyFailed = false, flash = () => undefined }: { reportId: string; title: string; onClose: () => void; reopen?: () => void; /** The report's URL (the Copy link row); none in tests. */ link?: string; /** The clipboard refused the Share click's copy: the field starts selected. */ copyFailed?: boolean; flash?: (message: string) => void }) {
  const [visibility, setVisibility] = useState<ReportVisibility>("private");
  const [shares, setShares] = useState<ReportShare[]>([]);
  const [people, setPeople] = useState<PickerPerson[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey: "reports.share" });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [{ sharing }, directory, groupList] = await Promise.all([getSharing(reportId), listPeople().catch(() => ({ users: [] as PickerPerson[] })), listPickerGroups().catch(() => ({ groups: [] as PickerGroup[] }))]);
        if (!alive) return;
        setVisibility(sharing.visibility);
        setShares(sharing.shares);
        setPeople(directory.users.filter((person) => person.kind !== "service" && person.role !== "guest"));
        setGroups(groupList.groups);
        setLoaded(true);
      } catch (reason) {
        if (alive) setError(messageOf(reason, "Could not load the sharing"));
      }
    })();
    return () => { alive = false; };
  }, [reportId]);

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
      notify.success(visibility === "private" ? "Only you can see this report" : "Sharing saved");
      onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not save the sharing"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Share" eyebrow={title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-edit-sheet report-share">
    <div className="report-edit-sheet-body">
      {link && <CopyLinkRow url={link} selectFirst={copyFailed} flash={flash} />}
      {!loaded && !error && <p className="reports-loading" role="status">Loading…</p>}
      {loaded && <>
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
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy || !loaded}>{busy ? "Saving…" : "Save"}</button>
    </footer>
  </ModalDialog>;
}
