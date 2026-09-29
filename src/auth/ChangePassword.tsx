import { useId, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { api, ApiError } from "../api";
import { collectProblems, confirmPasswordProblem, fieldName, newPasswordProblem, secondFactorProblem, useFieldErrors } from "./fieldChecks";
import { PasswordInput, SecondFactorField, secondFactorBody, secondFactorName } from "./passwordPages";
import "./auth.css";

/**
 * Settings → Security → Password (Wave 30). The form opens in place (no dialog, so there is no
 * history entry to guard). It needs the current password and, with two-factor on, a code; the
 * server keeps this session and signs out every other one. Works with email off.
 */

/** The line shown after a change. */
export function passwordChangedText(signedOut: number) {
  if (signedOut === 0) return "Password changed. No other devices were signed in.";
  return `Password changed. ${signedOut} other ${signedOut === 1 ? "session was" : "sessions were"} signed out.`;
}

export function ChangePasswordCard({ totpEnabled }: { totpEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [recovery, setRecovery] = useState(false);
  const formId = useId();
  const fields = useFieldErrors();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const currentPassword = String(form.get("currentPassword") ?? "");
    // A server error from the last try never outlives a new one.
    setError("");
    const problems = collectProblems({
      currentPassword: currentPassword ? null : "Enter your current password.",
      newPassword: newPasswordProblem(newPassword),
      confirmPassword: newPasswordProblem(newPassword) ? null : confirmPasswordProblem(newPassword, String(form.get("confirmPassword") ?? "")),
      [secondFactorName(recovery)]: totpEnabled ? secondFactorProblem(String(form.get(secondFactorName(recovery)) ?? ""), recovery) : null
    });
    if (fields.show(event.currentTarget, problems)) return;
    const body = { currentPassword, newPassword, ...secondFactorBody(form, totpEnabled, recovery) };
    setBusy(true);
    try {
      const result = await api<{ ok: true; signedOut: number }>("/auth/password/change", { method: "POST", body: JSON.stringify(body) });
      setDone(passwordChangedText(result.signedOut));
      setOpen(false);
      setRecovery(false);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 429 ? "Too many attempts. Try again in a few minutes." : reason instanceof Error ? reason.message : "Could not change your password");
    } finally {
      setBusy(false);
    }
  }

  return <div className="security-card password-change-card">
    <div className="password-change-summary">
      <span className="settings-icon" aria-hidden="true"><KeyRound /></span>
      <div>
        <strong>Password</strong>
        <small>Changing it signs out every other device. API keys keep working; review them under API keys.</small>
      </div>
      {!open && <button type="button" className="secondary-button" aria-expanded={false} aria-controls={formId} onClick={() => { setOpen(true); setDone(""); setError(""); }}>Change password</button>}
    </div>
    {done && <p className="password-change-done" role="status"><Check aria-hidden="true" />{done}</p>}
    {open && <form id={formId} className="auth-form password-change-form" onSubmit={submit} noValidate onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
      <PasswordInput name="currentPassword" label="Current password" autoComplete="current-password" disabled={busy} error={fields.errors.currentPassword} />
      <PasswordInput name="newPassword" label="New password" autoComplete="new-password" disabled={busy} error={fields.errors.newPassword} />
      <PasswordInput name="confirmPassword" label="Confirm new password" autoComplete="new-password" disabled={busy} error={fields.errors.confirmPassword} />
      {totpEnabled && <SecondFactorField recovery={recovery} disabled={busy} error={fields.errors[secondFactorName(recovery)]} onToggle={() => { setRecovery((value) => !value); setError(""); fields.clear(); }} />}
      <small className="password-change-hint">Use at least 12 characters. Forgot the current one? Sign out and use “Forgot password?”.</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="password-change-actions">
        <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setOpen(false); setError(""); fields.clear(); setRecovery(false); }}>Cancel</button>
      </div>
    </form>}
  </div>;
}
