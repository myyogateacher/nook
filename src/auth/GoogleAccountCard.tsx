import { useEffect, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { api, ApiError } from "../api";
import { KeysDialog } from "../keys/KeysDialog";
import "../keys/keys.css";
import { asksForPassword, GoogleReauthNotice, type AccountAuth } from "./accountAuth";
import { collectProblems, FieldError, fieldName, secondFactorProblem, useFieldErrors } from "./fieldChecks";
import { GoogleButton, GoogleMark, googleErrorMessage, type GoogleSettingsResult } from "./googleSignIn";
import "./auth.css";

/** The line Settings shows after a Google round trip came back to it (D300). */
export function googleSettingsNotice(result: GoogleSettingsResult): { tone: "ok" | "error"; text: string } | null {
  if (!result) return null;
  if (result.kind === "linked") return { tone: "ok", text: "Google sign-in is linked. You can now sign in with Google." };
  if (result.kind === "reauthed") return { tone: "ok", text: "Confirmed with Google. Finish the change within 5 minutes." };
  return result.kind === "error" ? { tone: "error", text: googleErrorMessage(result.code) } : null;
}

/** The re-authentication part of a request body: the password (when asked for) and the code. */
export function reauthBody(form: FormData, account: AccountAuth | null, totpEnabled: boolean) {
  const password = String(form.get("password") ?? "");
  const code = String(form.get("totpCode") ?? "").trim();
  return { ...(asksForPassword(account) && password ? { password } : {}), ...(totpEnabled && code ? { totpCode: code } : {}) };
}

/** Password (or the Google confirmation) and, with two-factor on, the code: inline errors, no native validation. */
function ReauthFields({ account, totpEnabled, errors, idPrefix, returnTo, disabled }: { account: AccountAuth; totpEnabled: boolean; errors: Record<string, string>; idPrefix: string; returnTo: string; disabled: boolean }) {
  return <>
    {asksForPassword(account)
      ? <label>Your password<input name="password" type="password" autoComplete="current-password" maxLength={256} disabled={disabled} aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? `${idPrefix}-password-error` : undefined} /><FieldError id={`${idPrefix}-password-error`} message={errors.password} /></label>
      : <GoogleReauthNotice account={account} returnTo={returnTo} />}
    {totpEnabled && <label>Six-digit authentication code<input name="totpCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" disabled={disabled} aria-invalid={errors.totpCode ? true : undefined} aria-describedby={errors.totpCode ? `${idPrefix}-code-error` : undefined} /><FieldError id={`${idPrefix}-code-error`} message={errors.totpCode} /></label>}
  </>;
}

const problemsOf = (form: FormData, account: AccountAuth, totpEnabled: boolean) => collectProblems({
  password: asksForPassword(account) && !String(form.get("password") ?? "") ? "Enter your password." : null,
  totpCode: totpEnabled ? secondFactorProblem(String(form.get("totpCode") ?? ""), false) : null
});

/**
 * Settings → Security → Google sign-in (Wave 35, D300; review L3): the linked address and Unlink, or
 * Link Google. Both ask for the password (and the code with two-factor on) in the app's own dialog,
 * which Back closes; linking then goes to Google and comes back here (`#google=linked`).
 */
export function GoogleAccountCard({ account, totpEnabled, onChanged, onDialogChange }: {
  account: AccountAuth;
  totpEnabled: boolean;
  onChanged: () => void;
  onDialogChange?: (open: boolean) => void;
}) {
  const [dialog, setDialog] = useState<"link" | "unlink" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const fields = useFieldErrors();
  useEffect(() => { onDialogChange?.(dialog !== null); }, [dialog, onDialogChange]);

  if (!account.methods.google) return null;
  const canUnlink = account.google !== null && account.methods.password && account.hasPassword;
  const canLink = account.google === null && account.reauth !== "none";
  const close = () => { if (!busy) { setDialog(null); setError(""); fields.clear(); } };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (fields.show(event.currentTarget, problemsOf(form, account, totpEnabled))) return;
    setBusy(true);
    setError("");
    try {
      if (dialog === "link") {
        const { start } = await api<{ start: string }>("/auth/google/link", { method: "POST", body: JSON.stringify(reauthBody(form, account, totpEnabled)) });
        window.location.assign(start);
        return;
      }
      await api("/auth/google", { method: "DELETE", body: JSON.stringify(reauthBody(form, account, totpEnabled)) });
      setDialog(null);
      setDone("Google sign-in was unlinked. Sign in with your email and password from now on.");
      onChanged();
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 429 ? "Too many attempts. Try again in a few minutes." : reason instanceof Error ? reason.message : "Something went wrong");
    }
    setBusy(false);
  }

  return <div className="security-card google-account-card">
    <div className="password-change-summary">
      <span className="settings-icon google-account-icon" aria-hidden="true"><GoogleMark /></span>
      <div>
        <strong>Google sign-in</strong>
        {account.google
          ? <small>Signed in with Google ({account.google.email}).{canUnlink ? "" : account.methods.password ? " Add a password before you unlink it, so you can still sign in." : ""}</small>
          : <small>{canLink ? "Link the Google account with this address to sign in with Google." : "Ask your admin to allow Google sign-in for this account."}</small>}
      </div>
      {account.google
        ? canUnlink && <button type="button" className="secondary-button" onClick={() => { setDone(""); setDialog("unlink"); }}>Unlink</button>
        : canLink && <GoogleButton label="Link Google" onClick={() => { setDone(""); setDialog("link"); }} />}
    </div>
    {done && <p className="password-change-done" role="status"><Check aria-hidden="true" />{done}</p>}
    {dialog && <KeysDialog title={dialog === "link" ? "Link Google" : "Unlink Google?"} description={dialog === "link" ? "Confirm it's you, then choose the Google account with this address." : "You will sign in with your email and password only. Your Google profile picture is removed too."} onClose={close} busy={busy}>
      <form className="auth-form google-reauth-form" noValidate onSubmit={submit} onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
        <ReauthFields account={account} totpEnabled={totpEnabled} errors={fields.errors} idPrefix={`google-${dialog}`} returnTo="/settings/security" disabled={busy} />
        {error && <p className="form-error" role="alert"><TriangleAlert aria-hidden="true" className="inline-icon" />{error}</p>}
        <div className="keys-dialog-actions inline">
          <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className={dialog === "link" ? "primary-button" : "danger-button"} disabled={busy || (!asksForPassword(account) && !account.reauthUntil)}>{busy ? "Please wait…" : dialog === "link" ? "Continue to Google" : "Unlink Google"}</button>
        </div>
      </form>
    </KeysDialog>}
  </div>;
}

/** Settings → Security → Password when the account cannot use the change form (D294, D295). */
export function PasswordStateCard({ account }: { account: AccountAuth }) {
  const text = !account.methods.password
    ? "This Nook signs people in with Google only, so passwords are not used."
    : account.passwordReset
      ? "This account signs in with Google and has no password. To add one, sign out and use “Forgot password?” on the sign-in page; the link goes to your address."
      : "This account signs in with Google and has no password. Email is not set up on this Nook, so ask your admin if you need one.";
  return <div className="security-card password-change-card">
    <div className="password-change-summary">
      <div><strong>Password</strong><small>{text}</small></div>
    </div>
  </div>;
}
