import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { CircleCheck, Database, Plus, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type ConnectionTest, type DatasourceSummary } from "../../shared/reports";
import { codeOf, createDatasource, deleteDatasource, listDatasources, messageOf, parseAllowlistText, previewAllowlist, syncDatasource, testDatasource, updateDatasource } from "../reports/reportsApi";
import "../reports/reports.css";

/**
 * Settings → Report data sources (Wave 45, admins): the ClickHouse connections reports may query.
 * Add, edit, test (with a warning when the user can write), re-sync the schema, and remove. The
 * password is write-only. The allowlist takes databases or `db.table` globs and shows how many
 * tables they match, live, once the data source is saved.
 */
export function ReportDataSources() {
  const [list, setList] = useState<DatasourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DatasourceSummary | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ConnectionTest>>({});
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      setList((await listDatasources()).datasources);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load data sources"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function test(source: DatasourceSummary) {
    setBusy(`test:${source.id}`);
    try {
      const { test: result } = await testDatasource(source.id);
      setTests((current) => ({ ...current, [source.id]: result }));
    } catch (reason) {
      notify.error(messageOf(reason, "Could not test the connection"));
    } finally {
      setBusy(null);
    }
  }
  async function sync(source: DatasourceSummary) {
    setBusy(`sync:${source.id}`);
    try {
      const { sync: result, datasource } = await syncDatasource(source.id);
      setList((current) => current?.map((item) => item.id === datasource.id ? datasource : item) ?? current);
      notify.success(`Schema synced: ${result.tables} ${result.tables === 1 ? "table" : "tables"}${result.mode === "show" ? " (through SHOW and DESCRIBE)" : ""}${result.truncated ? ", more were left out" : ""}`);
    } catch (reason) {
      notify.error(messageOf(reason, "Could not sync the schema"));
      void load();
    } finally {
      setBusy(null);
    }
  }
  async function remove(source: DatasourceSummary) {
    if (!await confirm.ask({ title: `Remove ${source.name}?`, message: "Reports that use it keep their queries but cannot run them until they get another data source. Its saved password and cached schema are deleted.", confirmLabel: "Remove", danger: true })) return;
    try {
      await deleteDatasource(source.id);
      notify.success(`Removed ${source.name}`);
      void load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not remove the data source"));
    }
  }

  return <section className="settings-content report-sources" aria-labelledby="report-sources-heading">
    <div className="settings-section-heading"><span className="settings-icon"><Database /></span><div><h3 id="report-sources-heading">Report data sources</h3><p>ClickHouse connections reports may query. Use a read-only user that can only SELECT the allowed tables: Nook's own checks are a second layer, not the boundary.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {list && list.length === 0 && <p className="file-dialog-hint">No data sources yet.</p>}
    {list && list.length > 0 && <ul className="report-source-list">
      {list.map((source) => {
        const result = tests[source.id];
        return <li key={source.id} className="report-source">
          <div className="report-source-head">
            <strong>{source.name}{!source.enabled && <span className="reports-status">Off</span>}</strong>
            <small><code>{source.url}</code> · {source.username} · {source.database}</small>
          </div>
          <dl className="report-source-facts">
            <div><dt>Allowlist</dt><dd>{source.allowlist.length ? source.allowlist.join(", ") : "Nothing yet"}</dd></div>
            <div><dt>Schema</dt><dd>{source.schema.error ? <span className="form-error">{source.schema.error}</span> : source.schema.syncedAt ? `${source.schema.tables} tables, synced ${relativeTime(source.schema.syncedAt)}${source.schema.truncated ? " (more left out)" : ""}` : "Not synced yet"}</dd></div>
            <div><dt>Limits</dt><dd>{source.maxRows.toLocaleString()} rows, {source.timeoutS} s</dd></div>
          </dl>
          {result && <div className={`report-test ${result.ok ? "ok" : "failed"}`} role="status">
            {result.ok ? <p><CircleCheck aria-hidden="true" />Connected as {result.user} to ClickHouse {result.version} in {result.ms} ms.</p> : <p><TriangleAlert aria-hidden="true" />{result.error}</p>}
            {result.warnings.map((warning) => <p key={warning} className="report-test-warning"><ShieldAlert aria-hidden="true" />{warning}</p>)}
            {result.writeGrants.length > 0 && <ul>{result.writeGrants.map((grant) => <li key={grant}><code>{grant}</code></li>)}</ul>}
          </div>}
          <div className="report-source-actions">
            <button type="button" className="secondary-button" onClick={() => { void test(source); }} disabled={busy !== null}>{busy === `test:${source.id}` ? "Testing…" : "Test connection"}</button>
            <button type="button" className="secondary-button" onClick={() => { void sync(source); }} disabled={busy !== null || !source.enabled}><RefreshCw />{busy === `sync:${source.id}` ? "Syncing…" : "Re-sync schema"}</button>
            <button type="button" className="secondary-button" onClick={() => setEditing(source)}>Edit</button>
            <button type="button" className="secondary-button" onClick={() => { void remove(source); }}>Remove</button>
          </div>
        </li>;
      })}
    </ul>}
    <button type="button" className="action-button secondary" onClick={() => setEditing("new")} disabled={!list}><Plus />Add data source</button>
    {editing && <DatasourceSheet source={editing === "new" ? null : editing} onCancel={() => setEditing(null)} onSaved={(saved) => {
      setEditing(null);
      notify.success(`Saved ${saved.name}${saved.allowlist.length && saved.enabled ? "; the schema is syncing" : ""}`);
      void load();
    }} />}
    {confirm.confirmElement}
  </section>;
}

const whole = (text: string, min: number, max: number) => /^\s*\d+\s*$/.test(text) && Number(text) >= min && Number(text) <= max ? Number(text) : null;

function DatasourceSheet({ source, onCancel, onSaved }: { source: DatasourceSummary | null; onCancel: () => void; onSaved: (source: DatasourceSummary) => void }) {
  const [name, setName] = useState(source?.name ?? "");
  const [url, setUrl] = useState(source?.url ?? "");
  const [username, setUsername] = useState(source?.username ?? "");
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [database, setDatabase] = useState(source?.database ?? "default");
  const [allowlist, setAllowlist] = useState((source?.allowlist ?? []).join("\n"));
  const [maxRows, setMaxRows] = useState(String(source?.maxRows ?? REPORT_LIMITS.maxRowsDefault));
  const [timeoutS, setTimeoutS] = useState(String(source?.timeoutS ?? REPORT_LIMITS.timeoutDefaultS));
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [preview, setPreview] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), url: useId(), user: useId(), password: useId(), database: useId(), allowlist: useId(), rows: useId(), timeout: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  // The live match count: once saved, the patterns are counted against ClickHouse's table list (cached a minute).
  useEffect(() => {
    if (!source) return undefined;
    const patterns = parseAllowlistText(allowlist);
    if (!patterns.length) { setPreview({ text: "No tables: add a database or a db.table pattern.", error: false }); return undefined; }
    let live = true;
    const timer = window.setTimeout(() => {
      previewAllowlist(source.id, patterns).then(({ preview: result }) => {
        if (live) setPreview({ text: `Matches ${result.matched.toLocaleString()} of ${result.total.toLocaleString()} tables in ${result.databases} ${result.databases === 1 ? "database" : "databases"}${result.sample.length ? `: ${result.sample.slice(0, 5).join(", ")}${result.matched > 5 ? ", …" : ""}` : ""}`, error: false });
      }, (reason) => { if (live) setPreview({ text: messageOf(reason, "Could not count the matching tables"), error: true }); });
    }, 400);
    return () => { live = false; window.clearTimeout(timer); };
  }, [allowlist, source]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    if (!url.trim()) return setError("Enter the ClickHouse HTTP URL.");
    if (!username.trim()) return setError("Enter the ClickHouse user.");
    const rows = whole(maxRows, 1, REPORT_LIMITS.maxRowsCeiling);
    if (rows === null) return setError(`Enter at most ${REPORT_LIMITS.maxRowsCeiling.toLocaleString()} rows (a whole number).`);
    const timeout = whole(timeoutS, 1, REPORT_LIMITS.timeoutCeilingS);
    if (timeout === null) return setError(`Enter a timeout of 1 to ${REPORT_LIMITS.timeoutCeilingS} whole seconds.`);
    setBusy(true);
    setError(null);
    const common = { name: name.trim(), url: url.trim(), username: username.trim(), database: database.trim() || "default", allowlist: parseAllowlistText(allowlist), maxRows: rows, timeoutS: timeout, enabled };
    try {
      const { datasource } = source
        ? await updateDatasource(source.id, { ...common, ...(password ? { password } : {}), removePassword, expectedRevision: source.revision })
        : await createDatasource({ ...common, password: password || null });
      setPassword("");
      onSaved(datasource);
    } catch (reason) {
      setError(codeOf(reason).code === "REVISION_CONFLICT" ? "This data source changed elsewhere; close and reopen it." : messageOf(reason, "Could not save the data source"));
      setBusy(false);
    }
  }

  return <ModalDialog title={source ? `Edit ${source.name}` : "Add data source"} eyebrow="Reports" onClose={onCancel} busy={busy} variant="sheet" className="reports-dialog">
    <form className="file-dialog-form report-source-form" onSubmit={submit} noValidate>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={60} autoFocus autoComplete="off" placeholder="Warehouse" onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.url}>ClickHouse HTTP URL</label>
      <input id={ids.url} value={url} maxLength={512} autoComplete="off" spellCheck={false} inputMode="url" placeholder="https://clickhouse.example.com:8443" onChange={(event) => setUrl(event.target.value)} />
      <p className="file-dialog-hint">https only. A private host, or plain http, must be listed in AGENT_ALLOWED_PRIVATE_HOSTS on the server.</p>
      <label htmlFor={ids.user}>User</label>
      <input id={ids.user} value={username} maxLength={128} autoComplete="off" spellCheck={false} placeholder="nook_readonly" onChange={(event) => setUsername(event.target.value)} />
      <label htmlFor={ids.password}>Password</label>
      <input id={ids.password} type="password" value={password} maxLength={1024} autoComplete="new-password" placeholder={source?.hasPassword ? "Saved; type to replace it" : ""} onChange={(event) => setPassword(event.target.value)} />
      {source?.hasPassword && <label className="reports-check"><input type="checkbox" checked={removePassword} onChange={(event) => setRemovePassword(event.target.checked)} />Remove the saved password</label>}
      <p className="file-dialog-hint">Stored encrypted under AGENT_SECRETS_KEY and never shown again.</p>
      <label htmlFor={ids.database}>Default database</label>
      <input id={ids.database} value={database} maxLength={128} autoComplete="off" spellCheck={false} onChange={(event) => setDatabase(event.target.value)} />
      <label htmlFor={ids.allowlist}>Allowed tables</label>
      <textarea id={ids.allowlist} value={allowlist} rows={4} spellCheck={false} placeholder={"analytics\nstaging.orders_*"} onChange={(event) => setAllowlist(event.target.value)} />
      <p className="file-dialog-hint">One per line: a database (every table in it) or a db.table pattern with * and ?. The system database is never allowed.</p>
      {source ? preview && <p className={preview.error ? "form-error" : "report-preview"} role="status">{preview.text}</p> : <p className="file-dialog-hint">Save to see how many tables match.</p>}
      <div className="report-source-limits">
        <span><label htmlFor={ids.rows}>Max rows per query</label><input id={ids.rows} value={maxRows} inputMode="numeric" onChange={(event) => setMaxRows(event.target.value)} /></span>
        <span><label htmlFor={ids.timeout}>Timeout (seconds)</label><input id={ids.timeout} value={timeoutS} inputMode="numeric" onChange={(event) => setTimeoutS(event.target.value)} /></span>
      </div>
      <label className="reports-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />On: reports may use it</label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : source ? "Save" : "Add data source"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
