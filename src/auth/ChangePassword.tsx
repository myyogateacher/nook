import { useId, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { api, ApiError } from "../api";
import { asksForCode, GoogleReauthNotice, isGoogleReauthRequired, ReauthRouteToggle, useReauthRoute, type AccountAuth } from "./accountAuth";
import { collectProblems, confirmPasswordProblem, fieldName, newPasswordProblem, secondFactorProblem, useFieldErrors } from "./fieldChecks";
import { PasswordInput, SecondFactorField, secondFactorBody, secondFactorName } from "./passwordPages";
import "./auth.css";

/**
 * Settings → Security → Password (Wave 30). The form opens in place (no dialog, so there is no
 * history entry to guard). It needs the current password and, with two-factor on, a code; or, for an
 * account with Google linked, this session's Google confirmation alone (2026-10-12), which is also how
 * a Google account with no password sets its first one. The server keeps this session and signs out
 * every other one. Works with email off.
 */

/** The line shown after a change. */
export function passwordChangedText(signedOut: number, set = false) {
  const first = set ? "Password set. You can now sign in with your email and password too." : "Password changed.";
  if (signedOut === 0) return `${first} No other devices were signed in.`;
  return `${first} ${signedOut} other ${signedOut === 1 ? "session was" : "sessions were"} signed out.`;
}

/**
 * The hint under the form (QA v0.13.0): "Forgot password?" only where it exists, that is when
 * `/api/about` says `passwordReset` (email on); otherwise the way out is an admin.
 */
export function forgotCurrentHint(passwordReset: boolean) {
  return passwordReset
    ? "Use at least 12 characters. Forgot the current one? Sign out and use “Forgot password?”."
    : "Use at least 12 characters. Forgot the current one? Email is off on this Nook, so ask an admin.";
}

export function ChangePasswordCard({ totpEnabled, passwordReset = false, account = null, onChanged }: { totpEnabled: boolean; passwordReset?: boolean; account?: AccountAuth | null; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [expired, setExpired] = useState(false);
  const formId = useId();
  const fields = useFieldErrors();
  const { viaPassword, toggle } = useReauthRoute(account);
  // A Google account with no password sets its first one here (Google confirms it).
  const setting = Boolean(account && !account.hasPassword);
  const withCode = asksForCode(totpEnabled, viaPassword);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const currentPassword = String(form.get("currentPassword") ?? "");
    // A server error from the last try never outlives a new one.
    setError("");
    const problems = collectProblems({
      currentPassword: viaPassword && !currentPassword ? "Enter your current password." : null,
      newPassword: newPasswordProblem(newPassword),
      confirmPassword: newPasswordProblem(newPassword) ? null : confirmPasswordProblem(newPassword, String(form.get("confirmPassword") ?? "")),
      [secondFactorName(recovery)]: withCode ? secondFactorProblem(String(form.get(secondFactorName(recovery)) ?? ""), recovery) : null
    });
    if (fields.show(event.currentTarget, problems)) return;
    const body = { ...(viaPassword ? { currentPassword } : {}), newPassword, ...secondFactorBody(form, withCode, recovery) };
    setBusy(true);
    try {
      const result = await api<{ ok: true; signedOut: number }>("/auth/password/change", { method: "POST", body: JSON.stringify(body) });
      setDone(passwordChangedText(result.signedOut, setting));
      setOpen(false);
      setRecovery(false);
      setExpired(false);
      onChanged?.();
    } catch (reason) {
      if (isGoogleReauthRequired(reason)) setExpired(true);
      setError(reason instanceof ApiError && reason.status === 429 ? "Too many attempts. Try again in a few minutes." : reason instanceof Error ? reason.message : "Could not change your password");
    } finally {
      setBusy(false);
    }
  }

  const action = setting ? "Set password" : "Change password";
  return <div className="security-card password-change-card">
    <div className="password-change-summary">
      <span className="settings-icon" aria-hidden="true"><KeyRound /></span>
      <div>
        <strong>Password</strong>
        <small>{setting ? "This account signs in with Google and has no password. Set one to sign in with your email too; Google confirms it's you." : "Changing it signs out every other device. API keys keep working; review them under API keys."}</small>
      </div>
      {!open && <button type="button" className="secondary-button" aria-expanded={false} aria-controls={formId} onClick={() => { setOpen(true); setDone(""); setError(""); }}>{action}</button>}
    </div>
    {done && <p className="password-change-done" role="status"><Check aria-hidden="true" />{done}</p>}
    {open && <form id={formId} className="auth-form password-change-form" onSubmit={submit} noValidate onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
      {viaPassword
        ? <PasswordInput name="currentPassword" label="Current password" autoComplete="current-password" disabled={busy} error={fields.errors.currentPassword} />
        : account && <GoogleReauthNotice account={account} returnTo="/settings/security" startable={false} expired={expired} />}
      <ReauthRouteToggle viaPassword={viaPassword} onToggle={toggle} disabled={busy} />
      <PasswordInput name="newPassword" label="New password" autoComplete="new-password" disabled={busy} error={fields.errors.newPassword} />
      <PasswordInput name="confirmPassword" label="Confirm new password" autoComplete="new-password" disabled={busy} error={fields.errors.confirmPassword} />
      {withCode && <SecondFactorField recovery={recovery} disabled={busy} error={fields.errors[secondFactorName(recovery)]} onToggle={() => { setRecovery((value) => !value); setError(""); fields.clear(); }} />}
      <small className="password-change-hint">{viaPassword ? forgotCurrentHint(passwordReset) : "Use at least 12 characters."}</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="password-change-actions">
        <button className="primary-button" disabled={busy}>{busy ? "Saving…" : action}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setOpen(false); setError(""); fields.clear(); setRecovery(false); }}>Cancel</button>
      </div>
    </form>}
  </div>;
}
