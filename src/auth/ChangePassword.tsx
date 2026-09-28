import { useId, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { api, ApiError } from "../api";
import { PasswordInput, SecondFactorField, secondFactorBody } from "./passwordPages";
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

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirmPassword") ?? "")) {
      setError("The two new passwords do not match.");
      return;
    }
    const body = { currentPassword: String(form.get("currentPassword") ?? ""), newPassword, ...secondFactorBody(form, totpEnabled, recovery) };
    setBusy(true);
    setError("");
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
    {open && <form id={formId} className="auth-form password-change-form" onSubmit={submit}>
      <PasswordInput name="currentPassword" label="Current password" autoComplete="current-password" minLength={1} disabled={busy} />
      <PasswordInput name="newPassword" label="New password" autoComplete="new-password" disabled={busy} />
      <PasswordInput name="confirmPassword" label="Confirm new password" autoComplete="new-password" disabled={busy} />
      {totpEnabled && <SecondFactorField recovery={recovery} disabled={busy} onToggle={() => { setRecovery((value) => !value); setError(""); }} />}
      <small className="password-change-hint">Use at least 12 characters. Forgot the current one? Sign out and use “Forgot password?”.</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="password-change-actions">
        <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setOpen(false); setError(""); setRecovery(false); }}>Cancel</button>
      </div>
    </form>}
  </div>;
}
