/**
 * Wave 47 additions to the reports vocabulary (the viewer, refresh, schedules). shared/reports.ts is
 * frozen after Wave 45, so the shapes the new routes answer with live here; they only compose the
 * frozen types. Pure: no server or client imports.
 */
import type { ReportResult, ReportRun, ReportSchedule } from "./reports";
import type { DocPageInfo } from "./reportsGenerate";

/**
 * What a block shows for one query: the last good result (`result`), and the newest attempt when it
 * failed after that (`failed`). A block with both is stale: it keeps showing the last good rows.
 */
export type QueryResultView = { queryKey: string; result: ReportResult | null; failed: ReportResult | null; stale: boolean };

/** GET /api/reports/:id/results. `running` is the report's run in progress, if any (the one-run lock). */
export type ReportResultsView = { results: QueryResultView[]; running: ReportRun | null };

/** A doc snapshot as the inspect panel's Provenance tab shows it (never its markdown). */
export type DocSnapshotInfo = { id: string; title: string | null; sha256: string; fetchedAt: string };

/** GET /api/reports/:id/provenance. */
export type ProvenanceView = { run: ReportRun | null; snapshot: DocSnapshotInfo | null; /** The plan todo that produced the block (2c), the owner's only. */ todo?: { id: string; title: string; status: string; note: string | null } | null; /** B3: the linked pages the run read, the owner's only. */ pages?: DocPageInfo[] };

/** A report's schedule as the Schedule sheet edits it; `autoDisabled` once five scheduled refreshes failed in a row. */
export type ScheduleView = ReportSchedule & { autoDisabled: boolean; lastRunId: string | null };

export type ScheduleInput = { cadence: string; atTime: string | null; weekday: number | null; tz: string; enabled: boolean };

/** GET /api/reports/:id/runs: the kept runs, newest first, and the schedule. */
export type RunHistoryView = { runs: ReportRun[]; schedule: ScheduleView };
