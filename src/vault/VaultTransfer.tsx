import { useId, useMemo, useState, type ChangeEvent } from "react";
import { Download, FileUp, TriangleAlert, Upload } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { VAULT_BOUNDS } from "../../shared/vault";
import { formatFromFileName, parseImport, type ParseProblem, type TransferFormat } from "../../shared/vaultTransfer";
import { canWriteEnv, errorCode, messageOf } from "./VaultDialogs";
import { useVaultReauth } from "./VaultReauth";
import { exportEnvironment, importEntries, type ImportResult, type ImportStatus, type VaultSummary } from "./vaultApi";

/**
 * Import and Export (vault plan §6.4; Wave 26). Both are sheets and history layers: Back closes them
 * first. Import reads the file in this browser (it is never uploaded), shows what would be created,
 * updated, left the same, skipped, or refused (the server's dry run, which compares with the current
 * values), then writes on Import. Export decrypts on the server and downloads a plaintext file; the
 * sheet says so. A protected environment asks to confirm it's you first (D226).
 */

export const FORMAT_OPTIONS: Array<{ value: TransferFormat; label: string; description: string }> = [
  { value: "dotenv", label: ".env", description: "KEY=value lines" },
  { value: "json", label: "JSON", description: "Names and values, with comments" },
  { value: "csv", label: "CSV", description: "name, value, comment columns" }
];
const MODE_OPTIONS: Array<{ value: "skip" | "overwrite"; label: string; description: string }> = [
  { value: "skip", label: "Keep existing values", description: "Only add what is not set yet" },
  { value: "overwrite", label: "Overwrite changed values", description: "Replace values that differ (history keeps the old ones)" }
];
export const STATUS_LABELS: Record<ImportStatus, string> = { create: "New secret", set: "New value", update: "Replaces the value", same: "Unchanged", skip: "Skipped", invalid: "Refused" };
const COUNT_WORDS: Record<ImportStatus, [string, string]> = { create: ["new secret", "new secrets"], set: ["new value", "new values"], update: ["replaced value", "replaced values"], same: ["unchanged", "unchanged"], skip: ["skipped", "skipped"], invalid: ["refused", "refused"] };
/** "2 new secrets", "1 skipped". */
export const countLabel = (status: ImportStatus, count: number) => `${count} ${COUNT_WORDS[status][count === 1 ? 0 : 1]}`;

type Parsed = { fileName: string; format: TransferFormat; entries: Array<{ name: string; value: string; comment?: string | null }>; problems: ParseProblem[] };

export function ImportDialog({ vault, initialEnvId, onClose, onImported }: { vault: VaultSummary; initialEnvId: string | null; onClose: () => void; onImported: (message: string) => void }) {
  const run = useVaultReauth();
  const writable = vault.environments.filter(canWriteEnv);
  const [envId, setEnvId] = useState<string | null>(writable.find((env) => env.id === initialEnvId)?.id ?? writable[0]?.id ?? null);
  const [format, setFormat] = useState<TransferFormat>("dotenv");
  const [mode, setMode] = useState<"skip" | "overwrite">("skip");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { env: useId(), format: useId(), mode: useId(), file: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const env = vault.environments.find((item) => item.id === envId) ?? null;

  function reparse(next: { fileName: string; text: string; format: TransferFormat }) {
    const result = parseImport(next.format, next.text);
    setParsed({ fileName: next.fileName, format: next.format, entries: result.entries, problems: result.problems });
    setPreview(null);
    setError(result.entries.length > VAULT_BOUNDS.importEntries ? `This file has ${result.entries.length} entries; an import takes at most ${VAULT_BOUNDS.importEntries}.` : null);
  }
  const [fileText, setFileText] = useState<string | null>(null);

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > VAULT_BOUNDS.importFileBytes) {
      setError("The file is larger than 1 MiB.");
      return;
    }
    const guessed = formatFromFileName(file.name) ?? format;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setFormat(guessed);
      setFileText(text);
      reparse({ fileName: file.name, text, format: guessed });
    };
    reader.onerror = () => setError("Could not read that file");
    reader.readAsText(file);
  }

  async function send(dryRun: boolean) {
    if (!parsed || !envId || parsed.entries.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await run(() => importEntries(vault.id, envId, { entries: parsed.entries, mode, dryRun }));
      if (dryRun) setPreview(result);
      else {
        const written = result.counts.create + result.counts.set + result.counts.update;
        onImported(`Imported ${written} ${written === 1 ? "value" : "values"} into ${env?.name ?? "the environment"}${result.counts.invalid ? `; ${result.counts.invalid} refused` : ""}`);
        return;
      }
    } catch (reason) {
      setError(errorCode(reason) === "QUOTA_EXCEEDED" ? "This import would pass the vault's storage quota. Nothing was imported." : messageOf(reason, dryRun ? "Could not preview the import" : "Could not import"));
    }
    setBusy(false);
  }

  const counts = preview?.counts;
  const writes = counts ? counts.create + counts.set + counts.update : 0;
  return <ModalDialog title="Import" eyebrow={vault.name} onClose={onClose} busy={busy} variant="sheet" className="vault-dialog vault-import">
    <div className="file-dialog-form vault-form">
      {writable.length === 0 ? <p className="file-dialog-hint">You cannot write in any environment of this vault.</p> : <>
        <span id={ids.env} className="vault-field-label">Into</span>
        <Select labelledBy={ids.env} value={envId} onChange={(next) => { setEnvId(next); setPreview(null); }} disabled={busy}
          options={writable.map((item) => ({ value: item.id, label: item.name, description: `${item.slug}${item.protected ? " · protected" : ""}` }))} />
        <span id={ids.file} className="vault-field-label">File</span>
        <label className="secondary-button vault-inline-button vault-file-pick">
          <FileUp aria-hidden="true" />{parsed ? `Choose another file (${parsed.fileName})` : "Choose a .env, JSON, or CSV file"}
          <input type="file" accept=".env,.json,.csv,.txt,text/plain,application/json,text/csv" onChange={onFile} disabled={busy} aria-labelledby={ids.file} />
        </label>
        <p className="file-dialog-hint">The file is read in this browser and never uploaded; only the names and values are sent when you import.</p>
        {parsed && <>
          <span id={ids.format} className="vault-field-label">Format</span>
          <Select labelledBy={ids.format} value={format} onChange={(next) => { setFormat(next); if (fileText !== null) reparse({ fileName: parsed.fileName, text: fileText, format: next }); }} options={FORMAT_OPTIONS} disabled={busy} />
          <span id={ids.mode} className="vault-field-label">When a name already has a value</span>
          <Select labelledBy={ids.mode} value={mode} onChange={(next) => { setMode(next); setPreview(null); }} options={MODE_OPTIONS} disabled={busy} />
          <p className="file-dialog-hint" role="status">{parsed.entries.length} {parsed.entries.length === 1 ? "entry" : "entries"} read{parsed.problems.length ? `; ${parsed.problems.length} ${parsed.problems.length === 1 ? "line" : "lines"} could not be read` : ""}.</p>
          {parsed.problems.length > 0 && <ul className="vault-import-problems" aria-label="Lines that could not be read">
            {parsed.problems.slice(0, 20).map((problem, index) => <li key={index}>{problem.line ? `Line ${problem.line}` : problem.name ?? "Entry"}: {problem.reason}</li>)}
          </ul>}
        </>}
        {preview && counts && <section className="vault-import-preview" aria-label="Preview">
          <p className="vault-import-counts">{(["create", "set", "update", "same", "skip", "invalid"] as const).filter((key) => counts[key] > 0).map((key) => countLabel(key, counts[key])).join(" · ") || "Nothing to import"}</p>
          <ul className="vault-import-rows">
            {preview.entries.map((entry, index) => <li key={`${entry.name}-${index}`} className={`status-${entry.status}`}>
              <code>{entry.name}</code><span>{STATUS_LABELS[entry.status]}</span>{entry.reason && <small>{entry.reason}</small>}
            </li>)}
          </ul>
        </section>}
      </>}
      {env?.protected && <p className="file-dialog-hint"><TriangleAlert className="vault-hint-icon" aria-hidden="true" />{env.name} is protected: you will be asked to confirm it's you.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        {!preview
          ? <button type="button" className="primary-button" disabled={busy || !parsed || parsed.entries.length === 0 || !envId || parsed.entries.length > VAULT_BOUNDS.importEntries} onClick={() => { void send(true); }}>{busy ? "Checking…" : "Preview"}</button>
          : <button type="button" className="primary-button" disabled={busy || writes === 0} onClick={() => { void send(false); }}><Upload />{busy ? "Importing…" : writes === 0 ? "Nothing to import" : `Import ${writes}`}</button>}
      </footer>
    </div>
  </ModalDialog>;
}

export function ExportDialog({ vault, initialEnvId, onClose, flash }: { vault: VaultSummary; initialEnvId: string | null; onClose: () => void; flash: (message: string) => void }) {
  const run = useVaultReauth();
  const readable = vault.environments.filter((env) => env.level !== "none");
  const [envId, setEnvId] = useState<string | null>(readable.find((env) => env.id === initialEnvId)?.id ?? readable[0]?.id ?? null);
  const [format, setFormat] = useState<TransferFormat>("dotenv");
  const [comments, setComments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { env: useId(), format: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const env = useMemo(() => vault.environments.find((item) => item.id === envId) ?? null, [envId, vault.environments]);

  async function download() {
    if (!envId) return;
    setBusy(true);
    setError(null);
    try {
      const file = await run(() => exportEnvironment(vault.id, envId, format, comments));
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash(`Exported ${file.count} ${file.count === 1 ? "value" : "values"}${file.skipped ? `; ${file.skipped} left out (not valid .env names)` : ""}. Delete the file when you are done with it.`);
      onClose();
    } catch (reason) {
      setBusy(false);
      setError(errorCode(reason) === "RATE_LIMITED" ? "You can export 10 times an hour. Try again later." : messageOf(reason, "Could not export"));
    }
  }

  return <ModalDialog title="Export" eyebrow={vault.name} onClose={onClose} busy={busy} variant="sheet" className="vault-dialog vault-export">
    <div className="file-dialog-form vault-form">
      <span id={ids.env} className="vault-field-label">Environment</span>
      <Select labelledBy={ids.env} value={envId} onChange={setEnvId} disabled={busy} options={readable.map((item) => ({ value: item.id, label: item.name, description: `${item.slug}${item.protected ? " · protected" : ""}` }))} />
      <span id={ids.format} className="vault-field-label">Format</span>
      <Select labelledBy={ids.format} value={format} onChange={setFormat} options={FORMAT_OPTIONS} disabled={busy} />
      <label className="vault-check"><input type="checkbox" checked={comments} onChange={(event) => setComments(event.target.checked)} disabled={busy} />Include value comments</label>
      <div className="vault-conflict vault-export-warning" role="note">
        <p><TriangleAlert className="vault-hint-icon" aria-hidden="true" />The file holds every value of {env?.name ?? "this environment"} in plain text. Keep it off shared drives and chat, and delete it when you are done. Open CSV files in a text editor rather than a spreadsheet. In a CSV, a name, value, or comment that starts with =, +, -, or @ gets a leading apostrophe so a spreadsheet does not run it; importing the file takes it off again.</p>
        <p>Exports are recorded in the vault's Activity, and you can export 10 times an hour.</p>
      </div>
      {env?.protected && <p className="file-dialog-hint">{env.name} is protected: you will be asked to confirm it's you.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => { void download(); }} disabled={busy || !envId}><Download />{busy ? "Exporting…" : "Download"}</button>
      </footer>
    </div>
  </ModalDialog>;
}
