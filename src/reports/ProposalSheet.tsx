import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, TriangleAlert, X } from "lucide-react";
import { Markdown, type RenderContext } from "../chat/markdown/render";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportBlock, ReportDetail } from "../../shared/reports";
import type { BlockChange, ProposalView, ReportInstruction } from "../../shared/reportsEdit";
import type { QueryResultView } from "../../shared/reportsView";
import { applyProposal, getProposal, rejectProposal } from "./reportEditApi";
import { codeOf, messageOf } from "./reportsApi";
import { DataBlockCard, useChartPalette } from "./ReportView";
import { reportCssVariables } from "../../shared/reportTheme";
import type { ResultLookup } from "./KpiTile";
import type { ChartPalette } from "./chartOption";

const countText = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** What the instruction's author (not the owner) sees of a pending proposal (review M1): its status and size only. */
export const proposalWaitingText = (redacted: { blocks: number; queries: number }) =>
  `Ready, waiting for the owner. It changes ${countText(redacted.blocks, "block")} and ${countText(redacted.queries, "query", "queries")}; you see the new version once the owner applies it.`;
const CHANGE_TEXT: Record<BlockChange["change"], string> = { added: "Added", updated: "Changed", removed: "Removed", moved: "Moved" };
const noop = () => undefined;
const markdownContext: RenderContext = { onExternalLink: noop, onNookLink: noop, images: { mode: "public" } };

/** One side of a block's diff, drawn by the viewer's own block card (read-only: its buttons are hidden). */
export function BlockPreview({ block, results, palette, lookup }: { block: ReportBlock; results: ReadonlyMap<string, QueryResultView>; palette: ChartPalette; lookup: ResultLookup }) {
  if (block.type === "markdown") {
    return <article className="report-block report-block-markdown">
      {block.title && <h3 className="report-block-title">{block.title}</h3>}
      <div className="report-markdown"><Markdown text={block.markdown} context={markdownContext} /></div>
    </article>;
  }
  return <DataBlockCard block={block} view={results.get(block.queryKey)} hasQuery={results.has(block.queryKey)} palette={palette} running={null} loaded lookup={lookup} onInspect={noop} onMenu={noop} />;
}

type Props = {
  report: ReportDetail;
  instructionId: string;
  instruction: ReportInstruction | null;
  canApply: boolean;
  onClose: () => void;
  reopen: () => void;
  onDecided: (applied: boolean) => void;
};

/**
 * A proposal under review (plan wave 48): what the instruction asked, the agent's summary, every
 * changed block before and after (new charts drawn from the proposal's own results, beside the current
 * ones), and the changed SQL. Apply (the owner) makes it a new version; Reject keeps the report as is.
 */
export function ProposalSheet({ report, instructionId, instruction, canApply, onClose, reopen, onDecided }: Props) {
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
  const palette = useChartPalette();
  const cssVars = useMemo(() => reportCssVariables(palette.mode) as React.CSSProperties, [palette.mode]);
  useHistoryDialogGuard(true, onClose, { blocked: busy !== null, reopen });
  useEffect(() => {
    let alive = true;
    getProposal(report.id, instructionId).then(({ proposal: next }) => { if (alive) setProposal(next); }).catch((reason) => { if (alive) setError(messageOf(reason, "Could not load the proposal")); });
    return () => { alive = false; };
  }, [report.id, instructionId]);

  const after = useMemo(() => new Map((proposal?.results ?? []).map((item) => [item.queryKey, item])), [proposal]);
  const before = useMemo(() => new Map((proposal?.currentResults ?? []).map((item) => [item.queryKey, item])), [proposal]);
  // KPI comparisons and sparklines read other queries' results: the proposal's own first, then the current ones.
  const lookupAfter = useCallback<ResultLookup>((key) => after.get(key)?.result ?? before.get(key)?.result ?? null, [after, before]);
  const lookupBefore = useCallback<ResultLookup>((key) => before.get(key)?.result ?? null, [before]);

  async function decide(kind: "apply" | "reject") {
    setBusy(kind);
    try {
      if (kind === "apply") await applyProposal(report.id, instructionId);
      else await rejectProposal(report.id, instructionId);
      notify.success(kind === "apply" ? "Applied: a new version of the report" : "Rejected; the report is unchanged");
      onDecided(kind === "apply");
    } catch (reason) {
      const { code } = codeOf(reason);
      notify.error(code === "REVISION_CONFLICT" ? "The report changed since this was proposed; reject it and ask again." : code === "RUN_IN_PROGRESS" ? "The report is running; apply when it finishes." : messageOf(reason, "Could not save the decision"));
      setBusy(null);
    }
  }

  const mayReject = canApply || Boolean(instruction?.isMine);
  return <ModalDialog title="Review the change" eyebrow={report.title} onClose={onClose} busy={busy !== null} variant="sheet" className="reports-dialog report-edit-sheet report-proposal">
    <div className={`report-edit-sheet-body report-view report-theme-${palette.mode} report-diff`} style={cssVars}>
      {instruction && <blockquote className="report-proposal-ask">{instruction.text}</blockquote>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!proposal && !error && <p className="reports-loading" role="status">Loading the proposal…</p>}
      {proposal && <>
        {proposal.redacted && <p className="report-proposal-waiting" role="status">{proposalWaitingText(proposal.redacted)}</p>}
        {proposal.summary && <p className="report-proposal-summary">{proposal.summary}</p>}
        {proposal.outOfDate && <p className="report-proposal-stale" role="note"><TriangleAlert aria-hidden="true" />{proposal.staleReason ?? "The report changed since this was proposed"}. It is rejected when the queue moves on; ask again.</p>}
        {proposal.blocks.map((change) => <section key={change.blockId} className={`report-diff-block report-diff-${change.change}`} aria-label={`${CHANGE_TEXT[change.change]}: ${change.after?.title ?? change.before?.title ?? change.blockId}`}>
          <h3><span className="reports-status">{CHANGE_TEXT[change.change]}</span>{change.after?.title ?? change.before?.title ?? change.blockId}</h3>
          <div className={`report-diff-sides${change.before && change.after && change.change !== "moved" ? " report-diff-two" : ""}`}>
            {change.before && change.change !== "moved" && <div className="report-diff-side"><span className="report-diff-label">Before</span><BlockPreview block={change.before} results={before} palette={palette} lookup={lookupBefore} /></div>}
            {change.after && <div className="report-diff-side"><span className="report-diff-label">{change.change === "added" ? "New" : change.change === "moved" ? "Here now" : "After"}</span>
              {change.textHidden ? <p className="report-diff-hidden">The new text is shown to the report's owner, who reviews it; you see it once it is applied.</p> : <BlockPreview block={change.after} results={after} palette={palette} lookup={lookupAfter} />}</div>}
          </div>
        </section>)}
        {proposal.queries.length > 0 && <section className="report-diff-block" aria-label="Queries">
          <h3>Queries</h3>
          {proposal.queries.map((query) => <div key={query.key} className="report-diff-query">
            <p><span className="reports-status">{query.change === "added" ? "Added" : query.change === "removed" ? "Removed" : "Changed"}</span><code>{query.key}</code></p>
            {query.before && query.change !== "added" && <pre className="report-code report-diff-sql-before"><code>{query.before}</code></pre>}
            {query.after && <pre className="report-code"><code>{query.after}</code></pre>}
          </div>)}
        </section>}
      </>}
    </div>
    <footer className="file-dialog-actions report-edit-sheet-actions">
      {mayReject && <button type="button" className="secondary-button" onClick={() => { void decide("reject"); }} disabled={busy !== null || !proposal}><X />{busy === "reject" ? "Rejecting…" : "Reject"}</button>}
      {canApply && <button type="button" className="primary-button" onClick={() => { void decide("apply"); }} disabled={busy !== null || !proposal || proposal.outOfDate}><Check />{busy === "apply" ? "Applying…" : "Apply"}</button>}
      {!canApply && !mayReject && <button type="button" className="secondary-button" onClick={onClose}>Close</button>}
    </footer>
  </ModalDialog>;
}
