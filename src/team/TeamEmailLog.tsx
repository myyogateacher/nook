import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Mail, RotateCcw, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { relativeTime } from "../files/format";

/**
 * Team → Email log at /team/email (Wave 28, outbound email §D.4, §E.5), admins only: what Nook
 * mailed, when, to whom (a name, or a short hash for an invitee), and how it went. It never shows
 * an address, subject, or content. A dead email can be retried once.
 */

export type MailLogEntry = {
  id: string; template: string; class: string; status: string; skipReason: string | null; attempts: number;
  errorCode: string | null; providerId: string | null; createdAt: string; sentAt: string | null; notBefore: string | null;
  to: { userId: string; displayName: string } | { hash: string };
  /** The recipient address's suppression now (Wave 29 webhooks), or null. */
  suppression?: "bounce" | "complaint" | "manual" | "soft" | null;
};
export type MailLog = { emailEnabled: boolean; today: { sent: number; held: number; failed: number; dead: number; limit: number }; entries: MailLogEntry[]; nextCursor: string | null };
type Filter = "all" | "sent" | "held" | "failed" | "dead" | "skipped";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" }, { value: "sent", label: "Sent" }, { value: "held", label: "Held" },
  { value: "skipped", label: "Skipped" }, { value: "failed", label: "Failed" }, { value: "dead", label: "Dead" }
];

export const TEMPLATE_LABELS: Record<string, string> = {
  "team.invite": "Invite", "account.verify": "Verify email", "account.test": "Test email", "tasks.assigned": "Assigned to you",
  "tasks.comment": "Card comments", "sharing.shared": "Shared with you", "inbox.proposals": "Proposals",
  "security.api_key_created": "New API key", "security.role_changed": "Role changed", "security.two_factor": "Two-factor", "security.account": "Account"
};
const STATUS_LABELS: Record<string, string> = { queued: "Held", sending: "Sending", sent: "Sent", failed: "Failed", suppressed: "Bounced", skipped: "Skipped", dead: "Dead" };
const SKIP_LABELS: Record<string, string> = {
  prefs_off: "Turned off in their settings", unverified: "Address not verified", access_lost: "They can no longer open it", empty: "Nothing left to send",
  blocked: "Account blocked", stale: "Too old to send", suppressed: "Address bounced", no_user: "Account removed",
  soft_bounce: "Paused after repeated soft bounces", muted: "They muted this board or calendar"
};
/** The recipient's suppression, shown on the row (never the address). */
export const SUPPRESSION_LABELS: Record<string, string> = { bounce: "Bounced", complaint: "Spam report", manual: "Suppressed", soft: "Soft bounces" };

export const fetchMailLog = (status: Filter, cursor?: string | null) => {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return api<MailLog>(`/team/mail-log${query ? `?${query}` : ""}`);
};

export function TeamEmailLog({ onBack, flash }: { onBack: () => void; flash: (message: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<MailLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (next: Filter, cursor?: string | null) => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await fetchMailLog(next, cursor);
      if (current !== generation.current) return;
      setData((previous) => cursor && previous ? { ...result, entries: [...previous.entries, ...result.entries] } : result);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load the email log");
    }
  }, []);
  useEffect(() => { void load(filter); }, [filter, load]);
  useEffect(() => { document.title = "Email log · Team · Nook"; }, []);

  async function retry(entry: MailLogEntry) {
    try {
      await api(`/team/mail-log/${entry.id}/retry`, { method: "POST", body: "{}" });
      flash("Queued to send again");
      void load(filter);
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not retry");
    }
  }

  return <article className="team-detail team-email-log" aria-labelledby="team-email-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-email-title">Email log</h2>
        <p className="team-muted">What Nook emailed and how it went. Addresses, subjects, and content are never shown or kept here.</p>
      </div>
    </header>
    {data && !data.emailEnabled && <p className="team-muted team-invites-limit" role="note">Email is not configured. See OPERATIONS → Email.</p>}
    {data && <p className="team-email-today" aria-label="Last 24 hours">
      <span><b>{data.today.sent}</b> / {data.today.limit} today</span>
      <span>Held <b>{data.today.held}</b></span>
      <span>Failed <b>{data.today.failed}</b></span>
      <span>Dead <b>{data.today.dead}</b></span>
    </p>}
    <div className="team-filters team-email-filters" role="group" aria-label="Show">
      {FILTERS.map((item) => <button key={item.value} type="button" className={`team-chip${filter === item.value ? " active" : ""}`} aria-pressed={filter === item.value} onClick={() => { setOpen(null); setFilter(item.value); }}>{item.label}</button>)}
    </div>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load the email log</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(filter); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !data && <p className="team-loading" role="status">Loading the email log…</p>}
    {!error && data && data.entries.length === 0 && <div className="team-state">
      <span className="team-state-icon"><Mail /></span>
      <h2>No email yet</h2>
      <p>Invites and notifications will appear here.</p>
    </div>}
    {!error && data && data.entries.length > 0 && <ul className="team-email-list" aria-label="Emails">
      {data.entries.map((entry) => {
        const who = "displayName" in entry.to ? entry.to.displayName : `Invitee ${entry.to.hash.slice(0, 6)}`;
        const expanded = open === entry.id;
        return <li key={entry.id} className={`team-email-entry status-${entry.status}`}>
          <button type="button" className="team-email-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : entry.id)}>
            <span className="team-email-top">
              <strong>{TEMPLATE_LABELS[entry.template] ?? entry.template}</strong>
              <span className={`team-status-chip mail-${entry.status}`}>{STATUS_LABELS[entry.status] ?? entry.status}</span>
            </span>
            <span className="team-row-meta">To {who}{entry.suppression ? <span className="team-status-chip mail-suppressed team-email-suppression">{SUPPRESSION_LABELS[entry.suppression] ?? entry.suppression}</span> : null} · {relativeTime(entry.sentAt ?? entry.createdAt)} · {entry.attempts} attempt{entry.attempts === 1 ? "" : "s"}</span>
          </button>
          {expanded && <dl className="team-email-details">
            <div><dt>Id</dt><dd><code>{entry.id}</code></dd></div>
            <div><dt>Queued</dt><dd>{new Date(entry.createdAt).toLocaleString()}</dd></div>
            {entry.sentAt && <div><dt>Sent</dt><dd>{new Date(entry.sentAt).toLocaleString()}</dd></div>}
            {entry.notBefore && <div><dt>Next try</dt><dd>{new Date(entry.notBefore).toLocaleString()}</dd></div>}
            {entry.skipReason && <div><dt>Reason</dt><dd>{SKIP_LABELS[entry.skipReason] ?? entry.skipReason}</dd></div>}
            {entry.suppression && <div><dt>Recipient</dt><dd>{entry.suppression === "soft" ? "Paused after repeated soft bounces" : entry.suppression === "complaint" ? "Reported an email as spam; only security email goes" : "Address bounced; only security email goes"}</dd></div>}
            {entry.errorCode && <div><dt>Error</dt><dd><code>{entry.errorCode}</code></dd></div>}
            {entry.providerId && <div><dt>Provider id</dt><dd><code>{entry.providerId}</code></dd></div>}
            {entry.status === "dead" && "userId" in entry.to && <div className="team-email-retry"><button type="button" className="team-action" onClick={() => { void retry(entry); }}><RotateCcw />Retry</button></div>}
          </dl>}
        </li>;
      })}
    </ul>}
    {data?.nextCursor && <button type="button" className="team-action team-email-more" onClick={() => { void load(filter, data.nextCursor); }}>Show older</button>}
  </article>;
}
