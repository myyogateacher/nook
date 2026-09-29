import { useCallback, useEffect, useState } from "react";
import { KeyRound, RotateCcw, ShieldCheck } from "lucide-react";
import { AccessOverview } from "../access/AccessOverview";
import { feedsAndRoutines, getMyAccess, getMyAccessPage, type AccessKind, type AccessSummary } from "../access/memberAccessApi";
import { ROLE_LABELS } from "../team/teamRoles";
import "../team/team.css";

/**
 * Settings → My access at /settings/access (Wave 33, access plan §C.6): what you can open that
 * others own, per module, and through what (shared with you directly, through a group, or with
 * everyone), plus your groups and API keys. Read-only; every role but guest.
 */
export function MyAccess() {
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    getMyAccess().then(setSummary, (reason) => setError(reason instanceof Error ? reason.message : "Could not load your access"));
  }, []);
  useEffect(load, [load]);
  const loadPage = useCallback((kind: AccessKind, cursor?: string | null) => getMyAccessPage(kind, cursor), []);

  return <section className="settings-content my-access" aria-labelledby="my-access-heading">
    <div className="settings-section-heading"><span className="settings-icon"><ShieldCheck /></span><div>
      <h3 id="my-access-heading">My access</h3>
      <p>What others share with you, and through what. Owners change their own sharing; admins decide who is in a group.</p>
    </div></div>
    {error && <div className="team-state team-error" role="alert"><p>{error}</p><button className="secondary-button" onClick={load}><RotateCcw />Try again</button></div>}
    {!error && !summary && <p className="team-loading" role="status">Loading your access…</p>}
    {summary && <>
      <section className="team-card" aria-labelledby="my-access-groups">
        <h3 id="my-access-groups">Groups</h3>
        <p className="team-muted">Team role: {ROLE_LABELS[summary.member.role]}.</p>
        {summary.groups.length === 0 ? <p className="team-muted">You are not in any group.</p> : <ul className="ma-group-chips" aria-label="Your groups">
          {summary.groups.map((group) => <li key={group.id} className="ma-group-chip ma-group-chip-static">{group.name}</li>)}
        </ul>}
      </section>
      <section className="team-card" aria-labelledby="my-access-keys">
        <h3 id="my-access-keys">API keys</h3>
        {summary.keys.length === 0 ? <p className="team-muted">No live API keys.</p> : <ul className="ma-key-list" aria-label="Your API keys">
          {summary.keys.map((key) => <li key={key.id} className="ma-key-row"><span className="team-row-copy">
            <span className="team-row-title"><KeyRound aria-hidden="true" className="group-item-hidden" /><strong>{key.name}</strong></span>
            <span className="team-row-meta"><code>{key.prefix}…</code><span>{key.modules.join(", ") || "No modules"}</span><span>{key.expiresAt ? `Expires ${new Date(key.expiresAt).toLocaleDateString()}` : "No expiry"}</span></span>
          </span></li>)}
        </ul>}
        {feedsAndRoutines(summary) && <p className="ma-summary-line">{feedsAndRoutines(summary)}</p>}
        <p className="team-muted">Manage keys in Settings → API keys.</p>
      </section>
      <AccessOverview summary={summary} loadPage={loadPage} />
    </>}
  </section>;
}
