import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, EyeOff, UserMinus, X } from "lucide-react";
import { Select, type Option } from "../ui/Select";
import { KIND_LABELS } from "../team/groupsApi";
import { kindCount, LEVEL_WORDS, MODULE_TITLES, viaLabel, type AccessKind, type AccessLevel, type AccessPage, type AccessRow, type AccessSummary, type KindCount } from "./memberAccessApi";
import "./memberAccess.css";

/**
 * What one person can reach, per module (Wave 33, access plan §C.6, §E): the member access page
 * for admins and Settings → My access for yourself share it. Each item kind opens on demand and
 * loads 200 rows at a time (T218). A row whose title the viewer may not see shows "Board owned by
 * Carol" and an eye-off mark (D269). With `actions` (the admin page), rows offer the reductions
 * only: Lower (a custom Select of levels below the current one), Remove, or Remove from a group.
 */

export type AccessRowActions = {
  onRemove: (row: AccessRow) => void;
  onLower: (row: AccessRow, level: AccessLevel) => void;
};

const MODULE_ORDER: Array<KindCount["module"]> = ["notes", "files", "tasks", "collections", "calendar"];

export function AccessOverview({ summary, loadPage, actions, reloadKey = 0, busy = false }: {
  summary: AccessSummary;
  loadPage: (kind: AccessKind, cursor?: string | null) => Promise<AccessPage>;
  actions?: AccessRowActions;
  /** Bumped after a change: open kinds reload from their first page. */
  reloadKey?: number;
  busy?: boolean;
}) {
  return <div className="ma-overview">
    {MODULE_ORDER.map((module) => {
      const kinds = summary.kinds.filter((row) => row.module === module);
      const total = kinds.reduce((sum, row) => sum + row.direct + row.group, 0);
      const audience = kinds.reduce((sum, row) => sum + row.audience, 0);
      return <section key={module} className="team-card ma-module" aria-labelledby={`ma-module-${module}`}>
        <h3 id={`ma-module-${module}`}>{MODULE_TITLES[module]}</h3>
        {total === 0 && audience === 0 && <p className="team-muted">Nothing shared.</p>}
        {kinds.filter((row) => row.direct + row.group + row.audience > 0).map((row) => <KindSection key={row.kind} counts={row} loadPage={loadPage} actions={actions} reloadKey={reloadKey} busy={busy} />)}
      </section>;
    })}
  </div>;
}

function KindSection({ counts, loadPage, actions, reloadKey, busy }: { counts: KindCount; loadPage: (kind: AccessKind, cursor?: string | null) => Promise<AccessPage>; actions?: AccessRowActions; reloadKey: number; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const shared = counts.direct + counts.group;

  const load = useCallback(async (from: string | null) => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await loadPage(counts.kind, from);
      if (current !== generation.current) return;
      setRows((previous) => from && previous ? [...previous, ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [counts.kind, loadPage]);

  useEffect(() => {
    if (open && shared > 0) void load(null);
    // reloadKey: a change elsewhere on the page reloads open kinds from the start.
  }, [load, open, reloadKey, shared]);

  const id = `ma-kind-${counts.kind}`;
  const parts = [counts.direct ? `${counts.direct} direct` : "", counts.group ? `${counts.group} through groups` : ""].filter(Boolean).join(", ");
  return <div className="ma-kind">
    {shared > 0
      ? <button type="button" className="ma-kind-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        <span><strong>{kindCount(counts.kind, counts.items)}</strong>{parts && <small>{parts}</small>}</span>
      </button>
      : null}
    {counts.audience > 0 && <p className="ma-audience">{kindCount(counts.kind, counts.audience)} shared with everyone signed in</p>}
    {open && <div id={id} className="ma-kind-rows">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!rows && loading && <p className="team-loading" role="status">Loading…</p>}
      {rows && <ul className="group-item-list" aria-label={`${KIND_LABELS[counts.kind]} access`}>
        {rows.map((row, index) => <AccessRowItem key={row.handle ?? `${row.via}-${row.id ?? index}-${row.group?.id ?? ""}`} row={row} actions={actions} busy={busy} />)}
      </ul>}
      {cursor && <button type="button" className="team-action ma-more" disabled={loading} onClick={() => { void load(cursor); }}>{loading ? "Loading…" : "Show more"}</button>}
    </div>}
  </div>;
}

function AccessRowItem({ row, actions, busy }: { row: AccessRow; actions?: AccessRowActions; busy: boolean }) {
  const lowerOptions: Option<AccessLevel>[] = row.lowerTo.map((level) => ({ value: level, label: LEVEL_WORDS[level] }));
  return <li className="group-item-row ma-row">
    <span className="team-row-copy">
      <span className="team-row-title">{row.titleHidden && <EyeOff aria-hidden="true" className="group-item-hidden" />}<strong>{row.title}</strong></span>
      <span className="team-row-meta">
        {!row.titleHidden && <span>Owned by {row.owner.displayName}</span>}
        {row.titleHidden && <span>Title hidden: you cannot open it</span>}
        <span>{viaLabel(row)}</span>
        {!row.active && <span className="team-status-chip">Not in effect now</span>}
      </span>
    </span>
    {actions && row.handle && <span className="ma-row-actions">
      {lowerOptions.length > 0 && <Select<AccessLevel> variant="chip" label={`Lower ${row.title}`} placeholder="Lower…" value={null} options={lowerOptions} disabled={busy} onChange={(level) => actions.onLower(row, level)} />}
      {row.via === "direct"
        ? <button type="button" className="icon-button group-member-remove" disabled={busy} aria-label={`Remove access to ${row.title}`} title="Remove access" onClick={() => actions.onRemove(row)}><X /></button>
        : <button type="button" className="icon-button group-member-remove" disabled={busy} aria-label={`Remove from ${row.group?.name ?? "the group"}`} title={`Remove from ${row.group?.name ?? "the group"}`} onClick={() => actions.onRemove(row)}><UserMinus /></button>}
    </span>}
  </li>;
}
