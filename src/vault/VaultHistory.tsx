import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ConfirmRequest } from "../ui/useConfirm";
import type { SecretType } from "../../shared/vault";
import { canWriteEnv, errorCode, messageOf, RevealedText } from "./VaultDialogs";
import { ReauthCancelled, useVaultReauth } from "./VaultReauth";
import { listVersions, readVersion, restoreVersion, type VaultEnvironment, type VersionInfo } from "./vaultApi";

/**
 * A value's history (D224; Wave 26 UI for the Wave 25 API): the last 20 versions of one secret in one
 * environment, newest first, with who wrote each and when. Show opens one version (a read, audited
 * `version.read`, and hidden again after 30 seconds); Restore writes it as a new version through the
 * same compare-and-swap. A protected environment asks to confirm it's you first. A history layer:
 * Back closes it before anything else.
 */
export function VersionHistoryDialog({ vaultId, secret, env, ask, flash, onClose, onRestored }: {
  vaultId: string;
  secret: { id: string; name: string; type: SecretType };
  env: VaultEnvironment;
  ask: (request: ConfirmRequest) => Promise<boolean>;
  flash: (message: string) => void;
  onClose: () => void;
  onRestored: () => void;
}) {
  const run = useVaultReauth();
  const [data, setData] = useState<{ current: { version: number; set: boolean }; versions: VersionInfo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ version: number; value: string; comment: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await listVersions(vaultId, secret.id, env.id));
    } catch (reason) {
      setError(messageOf(reason, "Could not load the history"));
    }
  }, [env.id, secret.id, vaultId]);
  useEffect(() => { void load(); }, [load]);
  // A shown version hides again after 30 seconds, and when the tab is hidden (T187).
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(null), 30_000);
    const onHidden = () => { if (document.visibilityState === "hidden") setShown(null); };
    document.addEventListener("visibilitychange", onHidden);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onHidden); };
  }, [shown]);

  async function show(version: number) {
    try {
      const result = await run(() => readVersion(vaultId, secret.id, env.id, version));
      if (result.version.value !== null) setShown({ version, value: result.version.value, comment: result.version.comment });
    } catch (reason) {
      if (!(reason instanceof ReauthCancelled)) flash(messageOf(reason, "Could not show that version"));
    }
  }

  async function restore(version: number) {
    if (!data) return;
    if (!await ask({ title: `Restore version ${version}?`, message: `${secret.name} in ${env.name} gets version ${version}'s value as a new version. The current value stays in history.`, confirmLabel: "Restore" })) return;
    setBusy(true);
    try {
      await run(() => restoreVersion(vaultId, secret.id, env.id, version, data.current.version));
      flash(`Restored version ${version} in ${env.name}`);
      setShown(null);
      onRestored();
      await load();
    } catch (reason) {
      if (!(reason instanceof ReauthCancelled)) flash(errorCode(reason) === "VALUE_CHANGED" ? "The value changed meanwhile. The history now shows the latest; restore again if you still want to." : messageOf(reason, "Could not restore that version"));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const writable = canWriteEnv(env);
  return <ModalDialog title={`History · ${secret.name}`} eyebrow={`${env.name}${env.protected ? " · protected" : ""}`} onClose={onClose} busy={busy} variant="sheet" className="vault-dialog vault-history">
    <div className="file-dialog-form vault-form">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <p className="file-dialog-hint" role="status">Loading…</p>}
      {data && data.versions.length === 0 && <p className="file-dialog-hint">No versions yet in {env.name}.</p>}
      {data && data.versions.length > 0 && <ol className="vault-history-list" aria-label={`Versions of ${secret.name} in ${env.name}`}>
        {data.versions.map((item) => {
          const current = data.current.set && item.version === data.current.version;
          const open = shown?.version === item.version;
          return <li key={item.version} className={current ? "current" : undefined}>
            <div className="vault-history-head">
              <strong>Version {item.version}</strong>
              <span>{item.cleared ? "Cleared" : current ? "Current" : ""}</span>
              <small><time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>{item.createdBy ? ` · ${item.createdBy}` : ""}</small>
            </div>
            {open && shown && <div className="vault-history-value"><RevealedText type={secret.type} revealed={{ value: shown.value, comment: shown.comment, version: shown.version }} />{shown.comment && <p className="vault-value-comment">{shown.comment}</p>}</div>}
            {!item.cleared && <div className="vault-card-actions">
              {open ? <button type="button" className="secondary-button" onClick={() => setShown(null)}><EyeOff />Hide</button>
                : <button type="button" className="secondary-button" onClick={() => { void show(item.version); }} aria-label={`Show version ${item.version}`}><Eye />Show</button>}
              {writable && !current && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void restore(item.version); }} aria-label={`Restore version ${item.version}`}><RotateCcw />Restore</button>}
            </div>}
          </li>;
        })}
      </ol>}
      <p className="file-dialog-hint">The last 20 versions are kept. Showing a version is recorded in the vault's Activity.</p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Done</button>
      </footer>
    </div>
  </ModalDialog>;
}
