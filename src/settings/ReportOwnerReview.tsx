import { useCallback, useEffect, useState } from "react";
import { Crown, RotateCcw, Search } from "lucide-react";
import { relativeTime } from "../files/format";
import { ShareSheet } from "../reports/ShareSheet";
import { ownerReview } from "../reports/reportEditApi";
import { messageOf } from "../reports/reportsApi";
import type { OwnerReview, OwnerReviewOwner, OwnerReviewScope } from "../../shared/reportsEdit";
import { useLayerOpener } from "../historyDialogs";
import { HUB_TITLE_ID } from "./hubModel";
import "../reports/reports.css";
import "../reports/reportEdit.css";
import "../team/team.css";

const SCOPES: ReadonlyArray<{ value: OwnerReviewScope; label: string }> = [
  { value: "unmanaged", label: "Nobody can manage" },
  { value: "unopenable", label: "You can’t open" }
];
const LAYER = "settings.reportOwners";
const STATE_LABELS: Record<Exclude<OwnerReviewOwner["state"], "active">, string> = { blocked: "Blocked", guest: "Guest", viewer: "Viewer" };

/**
 * Settings → Report owners (D500, admins): the reports an admin may need to recover. "Nobody can manage"
 * lists live reports with no owner who is an active member or admin (blocked, now a guest or a viewer, or
 * gone); "You can’t open" lists every live report the admin cannot open. Each row is the title, folder,
 * owners and their state, and last change, never the report's content. Manage owners opens the report's
 * Owners sheet (the Share sheet's Owners section, as an admin who is not an owner gets it on the report),
 * so adding an owner is the same audited owners API.
 */
export function ReportOwnerReview() {
  const [scope, setScope] = useState<OwnerReviewScope>("unmanaged");
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<OwnerReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<{ id: string; title: string } | null>(null);
  // D480: Forward after Back went past this section reopens the sheet of the report its layer names.
  useLayerOpener(LAYER, (id) => { if (/^[0-9a-f-]{36}$/.test(id)) setManaging({ id, title: "" }); });

  const load = useCallback(async (signal?: { live: boolean }) => {
    try {
      const result = await ownerReview(scope, query);
      if (signal && !signal.live) return;
      setReview(result);
      setError(null);
    } catch (reason) {
      if (signal && !signal.live) return;
      setError(messageOf(reason, "Could not load the reports"));
    }
  }, [scope, query]);
  // The title search waits for a pause in typing.
  useEffect(() => {
    const signal = { live: true };
    const timer = window.setTimeout(() => { void load(signal); }, query ? 250 : 0);
    return () => { signal.live = false; window.clearTimeout(timer); };
  }, [load, query]);

  const shown = review?.scope === scope ? review : null;
  // A sheet Forward reopened knows only its report's id: its title comes with the list.
  const pendingTitle = managing && !managing.title ? review?.reports.find((report) => report.id === managing.id)?.title : undefined;
  useEffect(() => { if (pendingTitle) setManaging((current) => current && !current.title ? { ...current, title: pendingTitle } : current); }, [pendingTitle]);
  const empty = scope === "unmanaged" ? "Every report has an owner who can manage it." : "You can open every report.";

  return <section className="settings-content report-sources report-owner-review" aria-labelledby={HUB_TITLE_ID} aria-describedby="report-owner-review-intro">
    <div className="settings-section-heading"><span className="settings-icon"><Crown /></span><div><p id="report-owner-review-intro">Reports whose owners are all blocked, guests or viewers now, or gone, and reports you can’t open. Add an owner to recover one. You see titles and owners only, never what a report holds.</p></div></div>
    <label className="team-search">
      <Search aria-hidden="true" />
      <span className="sr-only">Search report titles</span>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search report titles" maxLength={200} />
    </label>
    <div className="team-filters" role="group" aria-label="Show">
      {SCOPES.map((item) => <button key={item.value} type="button" className={`team-chip${scope === item.value ? " active" : ""}`} aria-pressed={scope === item.value} onClick={() => setScope(item.value)}>
        {item.label}{shown && scope === item.value && <b>{shown.total}</b>}
      </button>)}
    </div>
    {error && <div className="team-state team-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button></div>}
    {!error && !shown && <p className="team-loading" role="status">Loading reports…</p>}
    {shown && shown.reports.length === 0 && <p className="file-dialog-hint">{query.trim() ? "No report matches." : empty}</p>}
    {shown && shown.reports.length > 0 && <ul className="report-source-list" aria-label="Reports">
      {shown.reports.map((report) => <li key={report.id} className="report-source">
        <div className="report-source-head">
          <strong>{report.title}{!report.managed && scope === "unopenable" && <span className="reports-status">Nobody can manage</span>}</strong>
          <small>{report.folder ? report.folder.name : "Unfiled"} · Updated {relativeTime(report.updatedAt)}{report.canOpen ? "" : " · You can’t open it"}</small>
        </div>
        <dl className="report-source-facts">
          <div><dt>{report.owners.length === 1 ? "Owner" : "Owners"}</dt><dd>{report.owners.length === 0 ? "None left" : <span className="report-owner-review-owners">
            {report.owners.map((owner) => <span key={owner.id}>{owner.name}{owner.state !== "active" && <span className="reports-status">{STATE_LABELS[owner.state]}</span>}</span>)}
          </span>}</dd></div>
        </dl>
        <div className="report-source-actions">
          <button type="button" className="secondary-button" onClick={() => setManaging(report)}><Crown />Manage owners</button>
        </div>
      </li>)}
    </ul>}
    {shown && shown.total > shown.reports.length && <p className="file-dialog-hint">Showing the {shown.reports.length} most recently changed of {shown.total.toLocaleString()}. Search by title to find others.</p>}
    {managing && <ShareSheet reportId={managing.id} title={managing.title || "Report"} canShare={false} canManageOwners layerKey={`${LAYER}:${managing.id}`} onClose={() => setManaging(null)} reopen={() => setManaging(managing)}
      onOwnersChanged={() => { void load(); }} />}
  </section>;
}
