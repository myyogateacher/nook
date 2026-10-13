import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { isGoogleReauthRequired, useAccountAuthLoader } from "../auth/accountAuth";
import { reauthBody, ReauthFields, reauthProblems, reauthReady } from "../auth/GoogleAccountCard";
import { useFieldErrors } from "../auth/fieldChecks";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { reauth, reauthStatus, type ReauthStatus } from "./vaultApi";
import { errorCode, messageOf } from "./VaultDialogs";
import { FormError } from "../ui/FormError";

/**
 * Protected environments (D226, V-O2; Wave 26): the server refuses reading (reveal, copy, a version,
 * export) their values with 403 `REAUTH_REQUIRED` until this session re-authenticates (password
 * plus TOTP, valid 15 minutes). Writes never ask (2026-10-06 operator), so only reads, lifting
 * protection, and deleting a protected environment go through `run`. `run(action)` does the
 * action; on that refusal it opens the re-authentication dialog (the app's shared ReauthFields, a
 * history layer that Back closes) and, once confirmed, does the action once more. Cancelling rejects with `ReauthCancelled`.
 */

export class ReauthCancelled extends Error {
  constructor() {
    super("Nothing was shown: that environment is protected and you did not confirm it's you.");
    this.name = "ReauthCancelled";
  }
}

export type ReauthRun = <T>(action: () => Promise<T>) => Promise<T>;
const passthrough: ReauthRun = (action) => action();
export const VaultReauthContext = createContext<ReauthRun>(passthrough);
export const useVaultReauth = () => useContext(VaultReauthContext);

/** The provider's state: `run` for the pages, and the dialog to render while one is asked. */
export function useReauthProvider(): { run: ReauthRun; element: ReactNode } {
  const [pending, setPending] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const ask = useCallback(() => new Promise<boolean>((resolve) => {
    pendingRef.current?.resolve(false);
    setPending({ resolve });
  }), []);
  const settle = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    setPending(null);
    // After the dialog's history layer is gone, so a caller that opens another layer does not race it.
    setTimeout(() => current?.resolve(ok), 0);
  }, []);
  const run = useCallback<ReauthRun>(async (action) => {
    try {
      return await action();
    } catch (reason) {
      if (errorCode(reason) !== "REAUTH_REQUIRED") throw reason;
      if (!await ask()) throw new ReauthCancelled();
      return action();
    }
  }, [ask]);
  return { run, element: pending ? <ReauthDialog onDone={() => settle(true)} onCancel={() => settle(false)} /> : null };
}

export function ReauthDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { account } = useAccountAuthLoader();
  const [status, setStatus] = useState<ReauthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const fields = useFieldErrors();
  useHistoryDialogGuard(true, onCancel, { blocked: busy });
  useEffect(() => { reauthStatus().then(setStatus, (reason) => setError(messageOf(reason, "Could not check how to confirm it's you"))); }, []);
  const twoFactor = status?.twoFactor ?? account?.twoFactor ?? false;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    const form = new FormData(event.currentTarget);
    if (fields.show(event.currentTarget, reauthProblems(form, account, twoFactor))) return;
    if (!reauthReady(event.currentTarget, account)) {
      setExpired(true);
      setError("Confirm with Google first, then press Confirm.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reauth(reauthBody(form, account, twoFactor));
      onDone();
    } catch (reason) {
      setBusy(false);
      const code = errorCode(reason);
      if (isGoogleReauthRequired(reason)) setExpired(true);
      setError(code === "REAUTH_FAILED" ? "That password or code is not right. Try again." : code === "RATE_LIMITED" ? "Too many tries. Wait a few minutes, then try again." : messageOf(reason, "Could not confirm it's you"));
    }
  }

  return <ModalDialog title="Confirm it's you" eyebrow="Protected environment" onClose={onCancel} busy={busy} className="vault-dialog vault-reauth">
    <form className="file-dialog-form vault-form" onSubmit={submit} noValidate>
      <p className="file-dialog-hint"><ShieldCheck className="vault-hint-icon" aria-hidden="true" />This environment is protected. Confirm it's you to open its values here for the next 15 minutes.</p>
      {account ? <ReauthFields account={account} totpEnabled={twoFactor} errors={fields.errors} idPrefix="vault-reauth" returnTo={typeof window === "undefined" ? "/vault" : window.location.pathname} disabled={busy} expired={expired} />
        : <p className="file-dialog-hint" role="status">Loading…</p>}
      <FormError message={error} />
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !account || account.reauth === "none"}>{busy ? "Checking…" : "Confirm"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
