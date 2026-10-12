import { useEffect, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { api, ApiError } from "../api";
import { KeysDialog } from "../keys/KeysDialog";
import "../keys/keys.css";
import { asksForCode, googleConfirmed, GoogleReauthNotice, isGoogleReauthRequired, ReauthRouteToggle, useReauthRoute, type AccountAuth } from "./accountAuth";
import { collectProblems, FieldError, fieldName, secondFactorProblem, useFieldErrors } from "./fieldChecks";
import { SecondFactorField, secondFactorName } from "./passwordPages";
import { GoogleButton, GoogleMark, googleErrorMessage, type GoogleSettingsResult } from "./googleSignIn";
import "./auth.css";

/** The line Settings shows after a Google round trip came back to it (D300). */
export function googleSettingsNotice(result: GoogleSettingsResult): { tone: "ok" | "error"; text: string } | null {
  if (!result) return null;
  if (result.kind === "linked") return { tone: "ok", text: "Google sign-in is linked. You can now sign in with Google." };
  if (result.kind === "reauthed") return { tone: "ok", text: "Confirmed with Google. Finish the change within 5 minutes." };
  return result.kind === "error" ? { tone: "error", text: googleErrorMessage(result.code, result.domain) } : null;
}

/**
 * The line an integration's page shows after an admin's Google round trip came back to it (review L6).
 * An integration never signs in, so "Google sign-in is linked" is not shown there (linking returns to
 * Security, so only a hand-made URL brings it); the admin's confirmation and errors are.
 */
export function googleIntegrationNotice(result: GoogleSettingsResult) {
  return result?.kind === "linked" ? null : googleSettingsNotice(result);
}

/**
 * The re-authentication part of a request body, read from the fields on screen (`ReauthFields` shows
 * only those this route needs): the password on the password route, and the code or recovery code.
 */
export function reauthBody(form: FormData, _account?: AccountAuth | null, _totpEnabled?: boolean) {
  const password = String(form.get("password") ?? "");
  const code = String(form.get("totpCode") ?? "").trim();
  const recoveryCode = String(form.get("recoveryCode") ?? "").trim();
  return { ...(password ? { password } : {}), ...(code ? { totpCode: code } : {}), ...(recoveryCode ? { recoveryCode } : {}) };
}

/**
 * Google first for accounts with Google linked ("Use password instead" when they have one), else the
 * password; and the code where it is asked for (2026-10-12: on the password route with two-factor on,
 * and on the Google route only for `secondFactor` actions), with "Use a recovery code" as the way
 * round a lost authenticator. Inline errors, no native validation.
 */
export function ReauthFields({ account, totpEnabled, errors, idPrefix, returnTo, disabled, secondFactor = false, expired = false, startable = true }: { account: AccountAuth; totpEnabled: boolean; errors: Record<string, string>; idPrefix: string; returnTo: string; disabled: boolean; /** The action changes the factors: the code is asked for after Google too. */ secondFactor?: boolean; /** The server answered GOOGLE_REAUTH_REQUIRED. */ expired?: boolean; startable?: boolean }) {
  const { viaPassword, toggle } = useReauthRoute(account);
  const [recovery, setRecovery] = useState(false);
  const code = asksForCode(totpEnabled, viaPassword, secondFactor);
  const codeError = errors[secondFactorName(recovery)];
  return <>
    {viaPassword
      ? <label>Your password<input name="password" type="password" autoComplete="current-password" maxLength={256} disabled={disabled} aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? `${idPrefix}-password-error` : undefined} /><FieldError id={`${idPrefix}-password-error`} message={errors.password} /></label>
      : <GoogleReauthNotice account={account} returnTo={returnTo} expired={expired} startable={startable} />}
    <ReauthRouteToggle viaPassword={viaPassword} onToggle={toggle} disabled={disabled} />
    {code && <SecondFactorField recovery={recovery} disabled={disabled} error={codeError} onToggle={() => setRecovery((value) => !value)} />}
  </>;
}

/** What is missing from the fields on screen. */
export const reauthProblems = (form: FormData, _account?: AccountAuth, _totpEnabled?: boolean) => collectProblems({
  password: form.has("password") && !String(form.get("password") ?? "") ? "Enter your password." : null,
  totpCode: form.has("totpCode") ? secondFactorProblem(String(form.get("totpCode") ?? ""), false) : null,
  recoveryCode: form.has("recoveryCode") ? secondFactorProblem(String(form.get("recoveryCode") ?? ""), true) : null
});

/** Whether the form can be sent: on the Google route only while this session's confirmation counts. */
export const reauthReady = (form: HTMLFormElement | null, account: AccountAuth) => Boolean(form?.querySelector("input[name=password]")) || googleConfirmed(account);

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
  const [expired, setExpired] = useState(false);
  const fields = useFieldErrors();
  useEffect(() => { onDialogChange?.(dialog !== null); }, [dialog, onDialogChange]);

  if (!account.methods.google) return null;
  const canUnlink = account.google !== null && account.methods.password && account.hasPassword;
  const canLink = account.google === null && account.reauth !== "none";
  const close = () => { if (!busy) { setDialog(null); setError(""); setExpired(false); fields.clear(); } };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (fields.show(event.currentTarget, reauthProblems(form, account, totpEnabled))) return;
    if (!reauthReady(event.currentTarget, account)) {
      setExpired(true);
      setError("Confirm with Google first, then try again.");
      return;
    }
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
      if (isGoogleReauthRequired(reason)) setExpired(true);
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
    {dialog && <KeysDialog title={dialog === "link" ? "Link Google" : "Unlink Google?"} description={dialog === "link" ? "Confirm it's you, then choose the Google account with this address." : "You will sign in with your email and password only. This device stays signed in; every other device where you are signed in is signed out. Your Google profile picture is removed too."} onClose={close} busy={busy}>
      <form className="auth-form google-reauth-form" noValidate onSubmit={submit} onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
        <ReauthFields account={account} totpEnabled={totpEnabled} errors={fields.errors} idPrefix={`google-${dialog}`} returnTo="/settings/security" disabled={busy} secondFactor={dialog === "unlink"} expired={expired} />
        {error && <p className="form-error" role="alert"><TriangleAlert aria-hidden="true" className="inline-icon" />{error}</p>}
        <div className="keys-dialog-actions inline">
          <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className={dialog === "link" ? "primary-button" : "danger-button"} disabled={busy}>{busy ? "Please wait…" : dialog === "link" ? "Continue to Google" : "Unlink Google"}</button>
        </div>
      </form>
    </KeysDialog>}
  </div>;
}

export type GoogleResetNotice = { at: string; counts: Partial<Record<string, number>> };

/** "An admin reset this account on <date>: …" in plain words (review N2c). */
export function googleResetNoticeText(notice: GoogleResetNotice) {
  const date = new Date(notice.at).toLocaleDateString(undefined, { dateStyle: "medium" });
  const removed = [
    notice.counts.password ? "password" : null,
    notice.counts.twoFactor ? "two-factor" : null,
    notice.counts.keys ? "API keys" : null,
    notice.counts.feeds ? "calendar feeds" : null,
    notice.counts.items || notice.counts.shares || notice.counts.groupGrants ? "sharing" : null
  ].filter(Boolean) as string[];
  const list = removed.length > 1 ? `${removed.slice(0, -1).join(", ")} and ${removed.at(-1)}` : removed[0] ?? "sign-in details";
  return `An admin reset this account on ${date}: ${list} ${removed.length === 1 ? "was" : "were"} removed. Your notes, files, and other content are kept, and everything you owned is private now.`;
}

/** The one-time notice after an admin reset (N2c); dismissed once read. */
export function GoogleResetNoticeBanner({ notice, onDismiss }: { notice: GoogleResetNotice; onDismiss: () => void }) {
  return <div className="google-reset-notice" role="alert">
    <p>{googleResetNoticeText(notice)}</p>
    <button type="button" className="secondary-button" onClick={onDismiss}>Got it</button>
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
