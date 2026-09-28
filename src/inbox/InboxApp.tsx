import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, ChevronLeft, ExternalLink, House, Inbox, RotateCcw, Sparkles, TriangleAlert, X } from "lucide-react";
import { ApiError } from "../api";
import { AccountActions, useBinCount } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { diffStats, lineDiff } from "../diff/lineDiff";
import { relativeTime } from "../files/format";
import { popStateClosedDialog } from "../historyDialogs";
import { parseRoute, type Route } from "../router";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import {
  announceInboxChanged,
  approveProposal,
  bulkProposals,
  getProposal,
  listProposals,
  rejectProposal,
  type ProposalDetail,
  type ProposalGroup,
  type ProposalRef,
  type ProposalSummary
} from "./inboxApi";
import { actionLabel, BULK_CONFIRM_OVER, bulkConfirmText, bulkSummary, expiresText, failureText, groupTitle, inboxBackAction, rejectedText, rejectEffectText, statusLabel } from "./inboxFormat";
import "./inbox.css";

type InboxRoute = Extract<Route, { app: "inbox" }>;
type InboxNavigate = (route: Route, options?: { replace?: boolean }) => void;

type InboxAppProps = {
  displayName: string;
  navigate: InboxNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onBin?: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens an in-app path (a card, event, row, or note) as a new history entry. */
  onOpenPath: (path: string) => void;
};

type Dialog =
  | { kind: "reject"; ids: string[]; label: string; effect: string }
  | { kind: "approve-all"; items: ProposalSummary[] };

type Banner = { text: string; ref?: ProposalRef | null; tone: "ok" | "warn" };

const currentRoute = (): InboxRoute => {
  const route = parseRoute(window.location.pathname);
  return route.app === "inbox" ? route : { app: "inbox", view: "pending", proposalId: null };
};

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const codeOf = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string }).code ?? null : null;

const refLabel: Record<ProposalRef["type"], string> = { note: "Open note", card: "Open card", event: "Open event", row: "Open row" };

/**
 * The Inbox (docs/plan/research/2026-09-28-agent-inbox-routines.md §9): proposals from MCP keys,
 * grouped by key (and by routine run in Wave 22), each with a readable diff. The list is /inbox
 * (History at /inbox/history) and one proposal /inbox/p/:id, all history entries; dialogs push none
 * (D18, D69), so Back closes a dialog first, then the proposal, then the Inbox. Everything an agent
 * wrote is rendered as text under "Written by the agent" (T127). Approve is for members and admins;
 * viewers may reject (D152).
 */
export function InboxApp({ displayName, navigate, flash, onHome, onBin, onSettings, onSignOut, onOpenPath }: InboxAppProps) {
  const { canWrite } = useRole();
  const binCount = useBinCount(Boolean(onBin));
  const [route, setRoute] = useState<InboxRoute>(currentRoute);
  const [groups, setGroups] = useState<ProposalGroup[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const routeRef = useRef(route);
  routeRef.current = route;
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const status = route.view === "history" ? "resolved" : "pending";

  const go = useCallback((next: Omit<InboxRoute, "app">, replace = false) => {
    const target: InboxRoute = { app: "inbox", ...next };
    setRoute(target);
    navigateRef.current(target, { replace });
  }, []);

  const loadList = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoadError(null);
    try {
      const result = await listProposals({ status });
      if (generation !== listGeneration.current) return;
      setGroups(result.groups);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      if (generation === listGeneration.current) setLoadError(messageOf(reason, "Could not load the Inbox"));
    }
  }, [status]);

  useEffect(() => { setGroups(null); setBanner(null); void loadList(); }, [loadList]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const result = await listProposals({ status, cursor: nextCursor });
      setGroups((current) => [...(current ?? []), ...result.groups]);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      flash(messageOf(reason, "Could not load more"));
    } finally {
      setLoadingMore(false);
    }
  }

  // Back and Forward between the list, History, and a proposal (an open dialog only closes).
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname);
      if (next.app === "inbox") setRoute(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadDetail = useCallback(async (proposalId: string) => {
    const generation = ++detailGeneration.current;
    setDetailError(null);
    try {
      const { proposal } = await getProposal(proposalId);
      if (generation === detailGeneration.current) setDetail(proposal);
    } catch (reason) {
      if (generation !== detailGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        flash("Proposal not found");
        go({ view: routeRef.current.view, proposalId: null }, true);
      } else {
        setDetailError(messageOf(reason, "Could not open this proposal"));
      }
    }
  }, [flash, go]);

  useEffect(() => {
    setDialog(null);
    if (!route.proposalId) {
      setDetail(null);
      return;
    }
    setDetail((current) => current?.id === route.proposalId ? current : null);
    void loadDetail(route.proposalId);
  }, [loadDetail, route.proposalId]);

  useEffect(() => {
    document.title = detail && route.proposalId === detail.id ? `${detail.kindLabel} · Inbox · Nook` : route.view === "history" ? "History · Inbox · Nook" : "Inbox · Nook";
  }, [detail, route.proposalId, route.view]);

  const back = useCallback(() => {
    const action = inboxBackAction(routeRef.current.proposalId, readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "list") go({ view: routeRef.current.view, proposalId: null }, true);
    else onHome();
  }, [go, onHome]);

  const items = useMemo(() => (groups ?? []).flatMap((group) => group.items), [groups]);

  /** After an action: refresh, tell the badge, and on a phone detail page move on without leaving a resolved entry behind. */
  async function settled(changedId: string | null, nextId: string | null | undefined) {
    announceInboxChanged();
    await loadList();
    const open = routeRef.current.proposalId;
    if (!open) return;
    if (changedId && open === changedId) {
      // Phones replace the resolved entry with the next proposal, or step back to the list (§9.1).
      if (nextId) go({ view: "pending", proposalId: nextId }, true);
      else if (window.matchMedia?.("(max-width: 760px)").matches) back();
      else void loadDetail(changedId);
    } else {
      // Another proposal changed: refresh the open one's "2 of 4".
      void loadDetail(open);
    }
  }

  async function approve(proposal: Pick<ProposalSummary, "id" | "kind" | "title">, nextId?: string | null) {
    setBusy(proposal.id);
    try {
      const result = await approveProposal(proposal.id);
      setBanner({ text: `Approved: ${proposal.title}`, ref: result.ref, tone: "ok" });
      // On a phone the list (and its banner) is hidden behind the proposal, so say it in a toast too.
      if (routeRef.current.proposalId && window.matchMedia?.("(max-width: 760px)").matches) flash("Approved");
      await settled(proposal.id, nextId);
    } catch (reason) {
      const code = codeOf(reason);
      if (reason instanceof ApiError && reason.status === 409 && code && code !== "NOT_PENDING") setBanner({ text: failureText(code), tone: "warn" });
      else flash(messageOf(reason, "Could not approve"));
      await settled(proposal.id, null);
    } finally {
      setBusy(null);
    }
  }

  async function reject(ids: string[], reason: string) {
    try {
      if (ids.length === 1) {
        const result = await rejectProposal(ids[0]!, reason || undefined);
        setBanner({ text: rejectedText(result.draft), tone: "ok" });
      } else {
        const { results } = await bulkProposals("reject", ids, reason || undefined);
        setBanner({ text: bulkSummary(results), tone: "ok" });
      }
      setDialog(null);
      const nextId = ids.length === 1 && detail?.id === ids[0] ? detail.position?.nextId : null;
      await settled(ids.length === 1 ? ids[0]! : null, nextId);
      if (ids.length > 1 && routeRef.current.proposalId && ids.includes(routeRef.current.proposalId)) go({ view: "pending", proposalId: null }, true);
    } catch (error) {
      throw error instanceof Error ? error : new Error("Could not reject");
    }
  }

  async function approveAll(group: ProposalSummary[]) {
    setDialog(null);
    setBusy("bulk");
    try {
      const { results } = await bulkProposals("approve", group.map((item) => item.id));
      const applied = results.filter((result) => result.status === "applied");
      setBanner({ text: bulkSummary(results), ref: applied.length === 1 ? applied[0]!.ref : null, tone: results.every((result) => result.status === "applied") ? "ok" : "warn" });
      announceInboxChanged();
      await loadList();
      if (routeRef.current.proposalId && group.some((item) => item.id === routeRef.current.proposalId)) go({ view: "pending", proposalId: null }, true);
    } catch (reason) {
      flash(messageOf(reason, "Could not approve"));
    } finally {
      setBusy(null);
    }
  }

  function requestApproveAll(group: ProposalSummary[]) {
    if (group.length > BULK_CONFIRM_OVER) setDialog({ kind: "approve-all", items: group });
    else void approveAll(group);
  }

  // Desktop keys (§9.3): J/K move, A approves, R rejects, on the open proposal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k" && key !== "a" && key !== "r") return;
      const pending = items.filter((item) => item.status === "pending");
      const index = pending.findIndex((item) => item.id === routeRef.current.proposalId);
      if (key === "j" || key === "k") {
        const next = pending[index < 0 ? 0 : Math.min(pending.length - 1, Math.max(0, index + (key === "j" ? 1 : -1)))];
        if (next && next.id !== routeRef.current.proposalId) go({ view: routeRef.current.view, proposalId: next.id }, index >= 0);
        return;
      }
      if (!detail || detail.status !== "pending" || busy) return;
      if (key === "a" && canWrite && !detail.restricted) void approve(detail, detail.position?.nextId);
      if (key === "r") setDialog({ kind: "reject", ids: [detail.id], label: detail.title, effect: rejectEffectText([detail]) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pendingTotal = status === "pending" ? items.length : 0;

  return <main className={`app-page inbox-app${route.proposalId ? " inbox-detail-open" : ""}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Inbox</strong></span></span>
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />
    </header>
    <ReadOnlyBanner />

    <div className="inbox-layout">
      <section className="inbox-list-pane" aria-labelledby="inbox-title">
        <div className="inbox-intro">
          <h1 id="inbox-title">Inbox</h1>
          <p>Changes your MCP keys suggested. Nothing changes until you approve it{canWrite ? "" : ", and your team role can only reject"}.</p>
        </div>
        <div className="inbox-segments" role="group" aria-label="Show">
          <button type="button" className={route.view === "pending" ? "active" : ""} aria-pressed={route.view === "pending"} onClick={() => { if (route.view !== "pending") go({ view: "pending", proposalId: null }); }}>Pending{pendingTotal > 0 && <b>{nextCursor ? `${pendingTotal}+` : pendingTotal}</b>}</button>
          <button type="button" className={route.view === "history" ? "active" : ""} aria-pressed={route.view === "history"} onClick={() => { if (route.view !== "history") go({ view: "history", proposalId: null }); }}>History</button>
        </div>

        {banner && <div className={`inbox-banner ${banner.tone}`} role="status">
          <span>{banner.text}</span>
          {banner.ref && <button type="button" className="inbox-link-button" onClick={() => onOpenPath(banner.ref!.href)}>{refLabel[banner.ref.type]}<ExternalLink aria-hidden="true" /></button>}
          <button type="button" className="icon-button" onClick={() => setBanner(null)} aria-label="Dismiss"><X /></button>
        </div>}

        {loadError && <div className="inbox-state inbox-error" role="alert">
          <span className="inbox-state-icon"><TriangleAlert /></span>
          <h2>Could not load the Inbox</h2>
          <p>{loadError}</p>
          <button className="primary-button" onClick={() => { void loadList(); }}><RotateCcw />Try again</button>
        </div>}
        {!loadError && !groups && <p className="inbox-loading" role="status">Loading proposals…</p>}
        {!loadError && groups && groups.length === 0 && <div className="inbox-state">
          <span className="inbox-state-icon"><Inbox /></span>
          <h2>{status === "pending" ? "Nothing waiting for you" : "No history yet"}</h2>
          <p>{status === "pending"
            ? "When an agent with an MCP key that can suggest changes proposes a card, event, row, or note draft, it waits here for you."
            : "Approved, rejected, and expired proposals are kept here for 90 days."}</p>
        </div>}

        {!loadError && groups && groups.map((group, index) => {
          const pending = group.items.filter((item) => item.status === "pending");
          const headingId = `inbox-group-${index}`;
          return <section key={`${groupTitle(group)}-${index}`} className="inbox-group" aria-labelledby={headingId}>
            <header className="inbox-group-header">
              <h2 id={headingId}>{groupTitle(group)}<span className="inbox-group-count"> · {group.items.length}</span></h2>
              {status === "pending" && pending.length > 1 && <div className="inbox-group-actions">
                <button type="button" className="inbox-action" onClick={() => setDialog({ kind: "reject", ids: pending.map((item) => item.id), label: `${pending.length} proposals from ${groupTitle(group)}`, effect: rejectEffectText(pending) })} disabled={busy !== null}>Reject all</button>
                {canWrite && <button type="button" className="inbox-action primary" onClick={() => requestApproveAll(pending)} disabled={busy !== null}><CheckCheck />Approve all {pending.length}</button>}
              </div>}
            </header>
            <ul className="inbox-list">
              {group.items.map((item) => <li key={item.id}>
                <ProposalCard
                  item={item}
                  selected={item.id === route.proposalId}
                  busy={busy === item.id || busy === "bulk"}
                  canApprove={canWrite}
                  onOpen={() => { if (item.id !== route.proposalId) go({ view: route.view, proposalId: item.id }, Boolean(route.proposalId) && window.matchMedia?.("(min-width: 761px)").matches); }}
                  onApprove={() => { void approve(item); }}
                  onReject={() => setDialog({ kind: "reject", ids: [item.id], label: item.title, effect: rejectEffectText([item]) })}
                />
              </li>)}
            </ul>
          </section>;
        })}
        {nextCursor && <button type="button" className="inbox-action inbox-more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</button>}
      </section>

      <section className="inbox-detail-pane" aria-label="Proposal">
        {route.proposalId && detail?.id === route.proposalId
          ? <ProposalView proposal={detail} busy={busy !== null} canApprove={canWrite} onBack={back} onOpenPath={onOpenPath}
            onApprove={() => { void approve(detail, detail.position?.nextId); }}
            onReject={() => setDialog({ kind: "reject", ids: [detail.id], label: detail.title, effect: rejectEffectText([detail]) })} />
          : route.proposalId
            ? detailError ? <div className="inbox-state inbox-error" role="alert"><p>{detailError}</p><button className="inbox-action" onClick={() => { void loadDetail(route.proposalId!); }}><RotateCcw />Try again</button></div>
              : <p className="inbox-loading" role="status">Loading…</p>
            : <div className="inbox-placeholder"><Inbox aria-hidden="true" /><p>Choose a proposal to see exactly what it changes.</p></div>}
      </section>
    </div>

    {dialog?.kind === "reject" && <RejectDialog label={dialog.label} count={dialog.ids.length} effect={dialog.effect} onClose={() => setDialog(null)} onReject={(reason) => reject(dialog.ids, reason)} />}
    {dialog?.kind === "approve-all" && <ConfirmDialog title={bulkConfirmText(dialog.items)} body="Each change is applied on its own, in the order the agent suggested them. Any that no longer apply are left unchanged and marked failed." confirm="Approve all" onClose={() => setDialog(null)} onConfirm={() => { void approveAll(dialog.items); }} />}
  </main>;
}

function KindChip({ kind, label }: { kind: string; label: string }) {
  return <span className={`inbox-kind inbox-kind-${kind.split("_")[0]}`}>{label}</span>;
}

export function ProposalCard({ item, selected, busy, canApprove, onOpen, onApprove, onReject }: {
  item: ProposalSummary; selected: boolean; busy: boolean; canApprove: boolean;
  onOpen: () => void; onApprove: () => void; onReject: () => void;
}) {
  const pending = item.status === "pending";
  return <article className={`inbox-card${selected ? " selected" : ""}${pending ? "" : ` resolved ${item.status}`}`} aria-label={`${item.kindLabel}: ${item.title}`}>
    <button type="button" className="inbox-card-open" onClick={onOpen} aria-current={selected ? "page" : undefined}>
      <span className="inbox-card-top">
        <KindChip kind={item.kind} label={item.kindLabel} />
        {!pending && <span className={`inbox-status ${item.status}`}>{statusLabel(item.status, item.resultCode)}</span>}
      </span>
      <strong className="inbox-card-title">{item.title}</strong>
      {item.digest && <span className="inbox-card-digest">{item.digest}</span>}
      <span className="inbox-card-meta">
        {item.restricted ? "A target you can no longer open" : item.targetLabel}
        {" · "}{pending ? expiresText(item.expiresAt) : relativeTime(item.resolvedAt ?? item.createdAt)}
      </span>
      {item.status === "failed" && <span className="inbox-card-failure">{failureText(item.resultCode)}</span>}
    </button>
    {pending && <div className="inbox-card-actions">
      <button type="button" className="inbox-action" onClick={onReject} disabled={busy} aria-label={actionLabel("Reject", item)}>Reject</button>
      {canApprove && <button type="button" className="inbox-action primary" onClick={onApprove} disabled={busy || item.restricted} aria-label={actionLabel("Approve", item)}><Check />Approve</button>}
    </div>}
  </article>;
}

export function ProposalView({ proposal, busy, canApprove, onBack, onOpenPath, onApprove, onReject }: {
  proposal: ProposalDetail; busy: boolean; canApprove: boolean;
  onBack: () => void; onOpenPath: (path: string) => void; onApprove: () => void; onReject: () => void;
}) {
  const pending = proposal.status === "pending";
  const restricted = "restricted" in proposal.preview;
  return <article className="inbox-detail" aria-labelledby="inbox-detail-title">
    <div className="inbox-detail-top">
      <button type="button" className="inbox-back" onClick={onBack}><ChevronLeft />Inbox</button>
      {proposal.position && proposal.position.of > 1 && <span className="inbox-position">Proposal {proposal.position.index} of {proposal.position.of}</span>}
    </div>
    <header className="inbox-detail-header">
      <p className="inbox-detail-kind"><KindChip kind={proposal.kind} label={proposal.kindLabel} /><span>Key “{proposal.keyName}”</span></p>
      <h2 id="inbox-detail-title">{proposal.title}</h2>
      {!pending && <p className={`inbox-status ${proposal.status}`}>{statusLabel(proposal.status, proposal.resultCode)}{proposal.resolvedAt ? ` · ${relativeTime(proposal.resolvedAt)}` : ""}</p>}
    </header>

    {proposal.rationale && <section className="inbox-rationale" aria-label="Why the agent suggests this">
      <span className="inbox-agent-label">Written by the agent</span>
      <p>{proposal.rationale}</p>
    </section>}

    {proposal.status === "failed" && <p className="inbox-failure" role="note"><TriangleAlert aria-hidden="true" />{failureText(proposal.resultCode)}</p>}
    {proposal.status === "rejected" && proposal.rejectReason && <p className="inbox-muted">Your reason: {proposal.rejectReason}</p>}

    <Preview proposal={proposal} />

    <dl className="inbox-facts">
      <div><dt>Changes</dt><dd>{restricted ? "Something you can no longer open" : proposal.targetHref && proposal.kind !== "note_draft"
        ? <button type="button" className="inbox-link-button" onClick={() => onOpenPath(proposal.targetHref!)}>{proposal.targetLabel}<ExternalLink aria-hidden="true" /></button>
        : proposal.targetLabel}</dd></div>
      <div><dt>Suggested</dt><dd>{relativeTime(proposal.createdAt)}</dd></div>
      {pending && <div><dt>Expires</dt><dd>{new Date(proposal.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</dd></div>}
    </dl>

    {proposal.ref && proposal.status === "applied" && <button type="button" className="inbox-action" onClick={() => onOpenPath(proposal.ref!.href)}>{refLabel[proposal.ref.type]}<ExternalLink aria-hidden="true" /></button>}

    {pending && <footer className="inbox-detail-footer">
      {/* A note draft opens in the editor, where the draft badge and Publish are (§9.2). */}
      {proposal.kind === "note_draft" && proposal.targetHref && <button type="button" className="inbox-action" onClick={() => onOpenPath(proposal.targetHref!)}>Open note</button>}
      <button type="button" className="inbox-action" onClick={onReject} disabled={busy} aria-label={actionLabel("Reject", proposal)}>Reject…</button>
      {canApprove && <button type="button" className="inbox-action primary" onClick={onApprove} disabled={busy || restricted} aria-label={actionLabel("Approve", proposal)}><Check />{proposal.kind === "note_draft" ? "Approve and publish" : "Approve"}</button>}
    </footer>}
  </article>;
}

function Preview({ proposal }: { proposal: ProposalDetail }) {
  const [mode, setMode] = useState<"changes" | "full">("changes");
  const preview = proposal.preview;
  const markdown = "markdown" in preview ? preview.markdown : null;
  const diff = useMemo(() => markdown ? lineDiff(markdown.published, markdown.draft) : [], [markdown]);
  if ("restricted" in preview) return <p className="inbox-restricted" role="note">You can no longer open what this proposal changes, so it cannot be shown or approved.</p>;
  if (markdown) {
    const stats = diffStats(diff);
    return <section className="inbox-preview" aria-label="Changes">
      <div className="inbox-preview-heading">
        <span>{stats.label}</span>
        <div className="inbox-toggle" role="group" aria-label="Show">
          <button type="button" aria-pressed={mode === "changes"} className={mode === "changes" ? "active" : ""} onClick={() => setMode("changes")}>Changes</button>
          <button type="button" aria-pressed={mode === "full"} className={mode === "full" ? "active" : ""} onClick={() => setMode("full")}>Full draft</button>
        </div>
      </div>
      {markdown.draftChanged && <p className="inbox-muted" role="note">The draft changed after the agent wrote it, so approving will fail. Open the note to review and publish it yourself.</p>}
      {mode === "changes"
        ? <pre className="diff-view inbox-diff">{diff.map((line, index) => <span key={`${index}-${line.kind}`} className={line.kind}>{line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}{line.text || " "}</span>)}</pre>
        : <pre className="diff-view inbox-diff">{markdown.draft}</pre>}
    </section>;
  }
  return <section className="inbox-preview" aria-label="Changes">
    <table className="inbox-changes">
      <thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>
        {("fields" in preview ? preview.fields : []).map((field) => <tr key={field.name}>
          <th scope="row">{field.name}</th>
          <td className="before">{field.before === null ? <em>(none)</em> : field.before}</td>
          <td className="after">{field.after === null ? <em>(cleared)</em> : field.after}</td>
        </tr>)}
      </tbody>
    </table>
  </section>;
}

/** `effect` says exactly what the reject does (rejectEffectText, review H1). */
export function RejectDialog({ label, count, effect, onClose, onReject }: { label: string; count: number; effect: string; onClose: () => void; onReject: (reason: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onReject(String(new FormData(event.currentTarget).get("reason") ?? "").trim());
    } catch (reason) {
      setError(messageOf(reason, "Could not reject"));
      setBusy(false);
    }
  }
  return <>
    <button type="button" className="panel-scrim inbox-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close" tabIndex={-1} />
    <div className="inbox-dialog" role="dialog" aria-modal="true" aria-labelledby="inbox-reject-title">
      <header>
        <h2 id="inbox-reject-title">{count === 1 ? "Reject this proposal?" : `Reject ${count} proposals?`}</h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      <form onSubmit={submit}>
        <p className="inbox-dialog-subject">{label}</p>
        <p>{effect}</p>
        <label className="inbox-field">Reason (optional, the agent can read it)<textarea name="reason" maxLength={200} rows={2} autoFocus /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="inbox-dialog-actions">
          <button type="button" className="inbox-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="inbox-action primary danger" disabled={busy}>{busy ? "Rejecting…" : "Reject"}</button>
        </div>
      </form>
    </div>
  </>;
}

function ConfirmDialog({ title, body, confirm, onClose, onConfirm }: { title: string; body: string; confirm: string; onClose: () => void; onConfirm: () => void }) {
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <>
    <button type="button" className="panel-scrim inbox-dialog-scrim" onClick={onClose} aria-label="Close" tabIndex={-1} />
    <div className="inbox-dialog" role="dialog" aria-modal="true" aria-labelledby="inbox-confirm-title">
      <header>
        <h2 id="inbox-confirm-title">{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button>
      </header>
      <p>{body}</p>
      <div className="inbox-dialog-actions">
        <button type="button" className="inbox-action" onClick={onClose}>Cancel</button>
        <button type="button" className="inbox-action primary" onClick={onConfirm} autoFocus>{confirm}</button>
      </div>
    </div>
  </>;
}
