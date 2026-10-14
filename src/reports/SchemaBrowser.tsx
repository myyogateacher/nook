import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { ChevronDown, ChevronRight, KeyRound, LoaderCircle, Search } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { newLayerReopenMemory, useHistoryDialogGuard, useLayerReopen, type LayerReopenMemory } from "../ui/useHistoryDialogGuard";
import type { CatalogTable } from "../../shared/reports";
import { countLabel, describeSchemaTables, listSchemaTables, messageOf, searchSchema, type TableListItem } from "./reportsApi";

type Row = { table: string; comment: string; totalRows: number | null; matchingColumns?: string[] };

/**
 * The Schema browser (Wave 45, D417): the cached catalog of the report's data source as a sheet.
 * Search runs over table and column names and comments (no ClickHouse round trip); without a query it
 * lists tables 50 at a time, optionally one database. Opening a table shows its keys and columns
 * (read once from ClickHouse when it was not cached yet). Back or Escape closes the sheet (D18).
 */
export function SchemaBrowser({ reportId, onClose, onInsert, reopen, tableMemory }: { reportId: string; onClose: () => void; onInsert?: (table: string) => void;
  /** Forward after Back closed the sheet shows it again (D479). */
  reopen?: () => void;
  /** Kept by the page so Forward shows the open table again once the sheet is back (D478). */
  tableMemory?: MutableRefObject<LayerReopenMemory<string>>;
}) {
  const [query, setQuery] = useState("");
  const [db, setDb] = useState<string>("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CatalogTable | "missing" | "loading">>({});
  const generation = useRef(0);
  useHistoryDialogGuard(true, onClose, { reopen });
  // Review L6: an open table is a layer of its own, so Back returns to the list before closing the sheet;
  // Forward opens it again (D479).
  const ownTableMemory = useRef(newLayerReopenMemory<string>());
  const tables = tableMemory ?? ownTableMemory;
  if (open !== null) tables.current.last = open;
  const { reopen: reopenTable } = useLayerReopen<string>(setOpen, tables);
  useHistoryDialogGuard(open !== null, () => setOpen(null), { reopen: reopenTable });

  useEffect(() => {
    const current = ++generation.current;
    const timer = window.setTimeout(() => {
      setError(null);
      const load = query.trim()
        ? searchSchema(reportId, query.trim()).then(({ results }) => ({ rows: results as Row[], more: false, databases: null as string[] | null }))
        : listSchemaTables(reportId, { db: db || undefined, page: 0 }).then((result) => ({ rows: result.tables as Row[], more: result.hasMore, databases: result.databases }));
      load.then((result) => {
        if (current !== generation.current) return;
        setRows(result.rows);
        setHasMore(result.more);
        setPage(0);
        if (result.databases) setDatabases(result.databases);
      }, (reason) => { if (current === generation.current) setError(messageOf(reason, "Could not load the schema")); });
    }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [db, query, reportId]);

  async function more() {
    const next = page + 1;
    try {
      const result = await listSchemaTables(reportId, { db: db || undefined, page: next });
      setRows((current) => [...(current ?? []), ...(result.tables as TableListItem[])]);
      setHasMore(result.hasMore);
      setPage(next);
    } catch (reason) {
      setError(messageOf(reason, "Could not load more tables"));
    }
  }

  async function toggle(table: string) {
    if (open === table) return setOpen(null);
    setOpen(table);
    if (details[table] && details[table] !== "missing") return;
    setDetails((current) => ({ ...current, [table]: "loading" }));
    try {
      const result = await describeSchemaTables(reportId, [table]);
      setDetails((current) => ({ ...current, [table]: result.tables[0] ?? "missing" }));
    } catch (reason) {
      setDetails((current) => ({ ...current, [table]: "missing" }));
      setError(messageOf(reason, "Could not describe the table"));
    }
  }

  return <ModalDialog title="Schema" eyebrow="Data source" onClose={onClose} variant="sheet" className="reports-dialog schema-browser">
    <div className="schema-controls">
      <label className="reports-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search tables and columns</span>
        <input type="search" value={query} maxLength={200} autoFocus placeholder="Search tables and columns" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {!query.trim() && databases.length > 1 && <Select label="Database" value={db} onChange={setDb} options={[{ value: "", label: "All databases" }, ...databases.map((name) => ({ value: name, label: name }))]} className="schema-db" />}
    </div>
    <div className="schema-list-wrap">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!rows && !error && <p className="reports-loading" role="status">Loading the schema…</p>}
      {rows && rows.length === 0 && <p className="reports-loading">{query.trim() ? "No table or column matches." : "No tables yet. An admin re-syncs the schema in Settings → Report data sources."}</p>}
      {rows && rows.length > 0 && <ul className="schema-list" aria-label="Tables">
        {rows.map((row) => {
          const detail = details[row.table];
          const expanded = open === row.table;
          return <li key={row.table}>
            <button type="button" className="schema-table" aria-expanded={expanded} onClick={() => { void toggle(row.table); }}>
              {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              <span className="schema-table-copy">
                <code>{row.table}</code>
                <small>{[countLabel(row.totalRows), row.comment].filter(Boolean).join(" · ")}</small>
                {row.matchingColumns && row.matchingColumns.length > 0 && <small className="schema-match">Columns: {row.matchingColumns.join(", ")}</small>}
              </span>
            </button>
            {expanded && <div className="schema-detail">
              {detail === "loading" && <p role="status"><LoaderCircle className="spin" /> Reading the table…</p>}
              {detail === "missing" && <p>This table is not available.</p>}
              {detail && typeof detail === "object" && <>
                <dl className="schema-keys">
                  {detail.engine && <div><dt>Engine</dt><dd>{detail.engine}</dd></div>}
                  {detail.partitionKey && <div><dt>Partition key</dt><dd><code>{detail.partitionKey}</code></dd></div>}
                  {detail.sortingKey && <div><dt>Sorting key</dt><dd><code>{detail.sortingKey}</code></dd></div>}
                </dl>
                <ul className="schema-columns" aria-label={`Columns of ${row.table}`}>
                  {detail.columns.map((column) => <li key={column.name}>
                    <code>{column.name}</code><span className="schema-type">{column.type}</span>
                    {detail.sortingKey.split(/[\s,()]+/).includes(column.name) && <KeyRound className="schema-key" aria-label="In the sorting key" />}
                    {column.comment && <small>{column.comment}</small>}
                  </li>)}
                </ul>
                {onInsert && <button type="button" className="secondary-button" onClick={() => onInsert(row.table)}>Use in console</button>}
              </>}
            </div>}
          </li>;
        })}
      </ul>}
      {!query.trim() && hasMore && <button type="button" className="secondary-button schema-more" onClick={() => { void more(); }}>Show more tables</button>}
    </div>
  </ModalDialog>;
}
