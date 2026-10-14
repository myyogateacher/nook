import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { ArrowDown, ArrowUp, Check, CircleStop, History, LayoutList, LoaderCircle, Send, X } from "lucide-react";
import { followRun, type SequencedRunEvent } from "../chat/chatApi";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard, useLayerReopen, type LayerReopenMemory } from "../ui/useHistoryDialogGuard";
import type { ReportDetail } from "../../shared/reports";
import { INSTRUCTION_LIMITS, INSTRUCTION_STATUS_TEXT, type InstructionsView, type ReportInstruction } from "../../shared/reportsEdit";
import { ArrangeSheet } from "./ArrangeSheet";
import { applyEvent, resultLine, stepDetail, toolLabel, type ProgressStep } from "./GenerateProgress";
import { ProposalSheet } from "./ProposalSheet";
import { addInstruction, cancelInstruction, listInstructions, reorderInstructions, setAutoApply, threadMoving } from "./reportEditApi";
import { timeAgo } from "./reportViewApi";
import { messageOf } from "./reportsApi";
import { VersionsSheet } from "./VersionsSheet";
import "./reportEdit.css";

const POLL_MS = 1500;
/** The composer's "whole report" choice (block ids never start with an underscore). */
const PAGE = "_page";

/** The caller's rights on a report (level, comment, apply), read once by the page. */
export function useReportRights(reportId: string) {
  const [rights, setRights] = useState<Pick<InstructionsView, "level" | "canComment" | "canApply"> | null>(null);
  useEffect(() => {
    let alive = true;
    listInstructions(reportId).then((view) => { if (alive) setRights({ level: view.level, canComment: view.canComment, canApply: view.canApply }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [reportId]);
  return rights;
}

const blockLabel = (report: ReportDetail, blockId: string | null) => {
  if (!blockId) return "Whole report";
  const block = report.spec.blocks.find((item) => item.id === blockId);
  if (!block) return `Block ${blockId} (removed)`;
  return block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.type === "markdown" ? "Text" : block.queryKey);
};

export type ChangesSheet = Sheet;
type Sheet = { kind: "proposal"; instructionId: string } | { kind: "versions" } | { kind: "arrange" };

type Props = {
  report: ReportDetail;
  /** The block a comment starts on (null: the whole report). */
  initialBlockId: string | null;
  onClose: () => void;
  /** The spec changed (an apply, a restore, a manual edit): the page reloads the report. */
  onReportChanged: () => void;
  /** Forward after Back closed the panel shows it again. */
  reopen?: () => void;
  /** Kept by the page so Forward can show the sheet that was over the panel once it is back (D478). */
  sheetMemory?: MutableRefObject<LayerReopenMemory<Sheet>>;
};

/**
 * The Changes panel (plan wave 48): the instruction thread of a report with each instruction's status,
 * live progress of the caller's running one over SSE, and its outcome; the composer (the whole report
 * or one block); the queue's order and Cancel; Review (the proposal sheet), Versions, and Arrange
 * (manual edits). A side panel from 761 px, a bottom sheet on phones; Back closes it, and each sheet
 * over it is its own Back step (Forward opens it again).
 */
export function ChangesPanel({ report, initialBlockId, onClose, onReportChanged, reopen: reopenPanel, sheetMemory, focusComposer = false }: Props & { /** "Ask for a chart" on an empty report: the composer takes focus. */ focusComposer?: boolean }) {
  const [view, setView] = useState<InstructionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>(initialBlockId ?? "");
  const [sending, setSending] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const textId = useId();
  const targetId = useId();
  const applied = useRef<Set<string> | null>(null);
  useHistoryDialogGuard(true, onClose, { reopen: reopenPanel });

  const load = useCallback(async () => {
    try {
      const next = await listInstructions(report.id);
      setView(next);
      setError(null);
      // An instruction applied since the last look (auto-apply, or Apply in another tab) changed the spec.
      const nowApplied = new Set(next.instructions.filter((item) => item.status === "applied").map((item) => item.id));
      if (applied.current && [...nowApplied].some((id) => !applied.current!.has(id))) onReportChanged();
      applied.current = nowApplied;
      return next;
    } catch (reason) {
      setError(messageOf(reason, "Could not load the changes"));
      return null;
    }
  }, [onReportChanged, report.id]);
  useEffect(() => { void load(); }, [load]);
  const moving = view ? threadMoving(view.instructions) : false;
  useEffect(() => {
    if (!moving) return undefined;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, moving]);

  const { open: openSheet, reopen } = useLayerReopen<Sheet>(setSheet, sheetMemory);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await addInstruction(report.id, text.trim(), target || null);
      setText("");
      await load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not send the instruction"));
    } finally {
      setSending(false);
    }
  }

  async function act(work: () => Promise<unknown>, failure: string) {
    try {
      await work();
      await load();
    } catch (reason) {
      notify.error(messageOf(reason, failure));
    }
  }

  const queued = view?.instructions.filter((item) => item.status === "queued") ?? [];
  const move = (id: string, by: -1 | 1) => {
    const ids = queued.map((item) => item.id);
    const at = ids.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to]!, ids[at]!];
    void act(() => reorderInstructions(report.id, ids), "Could not reorder");
  };

  const dataBlocks = report.spec.blocks;
  return <ModalDialog title="Changes" eyebrow={report.title} onClose={onClose} className="reports-dialog report-changes">
    <div className="report-changes-body">
      {view?.canComment && <form className="report-changes-compose" noValidate onSubmit={send}>
        <label htmlFor={targetId}>About</label>
        <Select id={targetId} value={target || PAGE} onChange={(next) => setTarget(next === PAGE ? "" : next)}
          options={[{ value: PAGE, label: "The whole report" }, ...dataBlocks.map((block) => ({ value: block.id, label: blockLabel(report, block.id) }))]} />
        <label htmlFor={textId} className="sr-only">What should change</label>
        <textarea id={textId} autoFocus={focusComposer} value={text} maxLength={INSTRUCTION_LIMITS.text} rows={3} placeholder={target ? "Split this by country…" : "Add weekly retention below the revenue chart…"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send(event as unknown as FormEvent); }} />
        <div className="report-changes-compose-actions">
          <p className="file-dialog-hint">The AI changes the report one instruction at a time{view.canApply ? "" : "; the owner reviews each change"}.</p>
          <button type="submit" className="primary-button" disabled={sending || !text.trim()}>{sending ? <LoaderCircle className="spin" /> : <Send />}Send</button>
        </div>
      </form>}
      {view && !view.canComment && <p className="file-dialog-hint report-changes-readonly">You can view this report and its changes; its owner can let you ask for changes.</p>}

      <div className="report-changes-tools">
        {view?.canApply && <label className="report-changes-toggle">
          <input type="checkbox" checked={view.autoApply} onChange={(event) => { const on = event.target.checked; void act(() => setAutoApply(report.id, on), "Could not change auto-apply"); }} />
          <span>Apply my changes without review</span>
        </label>}
        <span className="report-changes-tool-buttons">
          <button type="button" className="secondary-button" onClick={() => openSheet({ kind: "versions" })}><History aria-hidden="true" />Versions</button>
          {view?.canApply && <button type="button" className="secondary-button" onClick={() => openSheet({ kind: "arrange" })}><LayoutList aria-hidden="true" />Arrange</button>}
        </span>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!view && !error && <p className="reports-loading" role="status">Loading changes…</p>}
      {view && !view.instructions.length && <p className="report-changes-empty">No changes asked for yet.</p>}
      <ol className="report-changes-thread" aria-label="Instructions">
        {view?.instructions.map((item) => <InstructionItem key={item.id} report={report} item={item} canApply={view.canApply}
          queuedIndex={item.status === "queued" ? queued.findIndex((entry) => entry.id === item.id) : -1} queuedCount={queued.length}
          onMove={(by) => move(item.id, by)}
          onCancel={() => { void act(() => cancelInstruction(report.id, item.id), "Could not cancel"); }}
          onReview={() => openSheet({ kind: "proposal", instructionId: item.id })}
          onFinished={() => { void load(); }} />)}
      </ol>
    </div>
    {sheet?.kind === "proposal" && <ProposalSheet report={report} instruction={view?.instructions.find((item) => item.id === sheet.instructionId) ?? null} instructionId={sheet.instructionId}
      canApply={Boolean(view?.canApply)} onClose={() => setSheet(null)} reopen={reopen}
      onDecided={(applied) => { setSheet(null); void load(); if (applied) onReportChanged(); }} />}
    {sheet?.kind === "versions" && <VersionsSheet report={report} canRestore={Boolean(view?.canApply)} onClose={() => setSheet(null)} reopen={reopen} onRestored={() => { setSheet(null); onReportChanged(); }} />}
    {sheet?.kind === "arrange" && <ArrangeSheet report={report} onClose={() => setSheet(null)} reopen={reopen} onChanged={onReportChanged} />}
  </ModalDialog>;
}

type ItemProps = {
  report: ReportDetail;
  item: ReportInstruction;
  canApply: boolean;
  queuedIndex: number;
  queuedCount: number;
  onMove: (by: -1 | 1) => void;
  onCancel: () => void;
  onReview: () => void;
  onFinished: () => void;
};

/** The status line: a proposal waits for the owner, as its author (not the owner) or another reader sees it. */
export function instructionStatusText(item: Pick<ReportInstruction, "status">, canApply: boolean): string {
  if (item.status === "proposed" && !canApply) return "Ready, waiting for the owner";
  return INSTRUCTION_STATUS_TEXT[item.status];
}

function InstructionItem({ report, item, canApply, queuedIndex, queuedCount, onMove, onCancel, onReview, onFinished }: ItemProps) {
  const mayCancel = canApply || item.isMine;
  return <li className={`report-instruction report-instruction-${item.status}`}>
    <div className="report-instruction-head">
      <span className={`reports-status report-instruction-status-${item.status}`}>{item.status === "running" && <LoaderCircle className="spin" aria-hidden="true" />}{instructionStatusText(item, canApply)}</span>
      <span className="report-instruction-target">{blockLabel(report, item.blockId)}</span>
      <span className="report-instruction-meta">{item.isMine ? "You" : item.authorName ?? "Someone"}{item.via === "mcp" ? " via MCP" : ""} · {timeAgo(item.createdAt)}</span>
    </div>
    <p className="report-instruction-text">{item.text}</p>
    {item.summary && item.status !== "queued" && <p className="report-instruction-summary">{item.summary}</p>}
    {item.error && (item.status === "failed" || item.status === "cancelled") && <p className="report-instruction-error">{item.error}</p>}
    {item.status === "applied" && item.appliedVersion !== null && <p className="report-instruction-summary"><Check aria-hidden="true" />Version {item.appliedVersion}{item.autoApplied ? " (applied automatically)" : ""}</p>}
    {item.status === "running" && item.agentRunId && <InstructionProgress agentRunId={item.agentRunId} onDone={onFinished} />}
    <div className="report-instruction-actions">
      {item.status === "queued" && canApply && queuedCount > 1 && <>
        <button type="button" className="icon-button" onClick={() => onMove(-1)} disabled={queuedIndex <= 0} aria-label="Run earlier"><ArrowUp /></button>
        <button type="button" className="icon-button" onClick={() => onMove(1)} disabled={queuedIndex >= queuedCount - 1} aria-label="Run later"><ArrowDown /></button>
      </>}
      {(item.status === "queued" || item.status === "running") && mayCancel && <button type="button" className="secondary-button" onClick={onCancel}>{item.status === "running" ? <CircleStop /> : <X />}Cancel</button>}
      {/* Review M1: a pending proposal is the owner's and its author's only (the author sees its status). */}
      {item.status === "proposed" && (canApply || item.isMine) && <button type="button" className={canApply ? "primary-button" : "secondary-button"} onClick={onReview}>{canApply ? "Review" : "Details"}</button>}
    </div>
  </li>;
}

const EDIT_LABELS: Record<string, string> = { submit_patch: "Propose the change" };

/** The live step list of the caller's running instruction (its run's events over SSE). */
function InstructionProgress({ agentRunId, onDone }: { agentRunId: string; onDone: () => void }) {
  const [steps, setSteps] = useState<ProgressStep[]>([]);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const controller = new AbortController();
    let seq = 0;
    const onEvent = (event: SequencedRunEvent) => {
      seq = Math.max(seq, event.seq);
      setSteps((current) => applyEvent(current, event));
    };
    void (async () => {
      for (let attempt = 0; attempt < 4 && !controller.signal.aborted; attempt += 1) {
        try {
          if (await followRun(agentRunId, seq, onEvent, controller.signal) === "ended") doneRef.current();
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    })();
    return () => controller.abort();
  }, [agentRunId]);
  if (!steps.length) return null;
  return <ol className="generate-steps report-instruction-steps" aria-live="polite">
    {steps.map((step) => {
      const detail = stepDetail(step.tool, step.args);
      const line = resultLine(step);
      return <li key={step.callId} className={`generate-step ${step.ok === null ? "is-running" : step.ok ? "is-ok" : "is-failed"}`}>
        <span className="generate-step-icon" aria-hidden="true">{step.ok === null ? <LoaderCircle className="spin" /> : step.ok ? <Check /> : <X />}</span>
        <span className="generate-step-body">
          <strong>{EDIT_LABELS[step.tool] ?? toolLabel(step.tool)}</strong>
          {detail.text && <span className="generate-step-text">{detail.text}</span>}
          {line && step.ok === false && <span className="generate-step-error">{line}</span>}
        </span>
      </li>;
    })}
  </ol>;
}
