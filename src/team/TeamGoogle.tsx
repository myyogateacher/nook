import { useCallback, useEffect, useState } from "react";
import { Check, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../api";
import { GoogleMark } from "../auth/googleSignIn";
import { KeysDialog } from "../keys/KeysDialog";
import "../keys/keys.css";

/**
 * Team → member → Google sign-in (Wave 35 review, HIGH-1, L6; admins only). A Google sign-in never
 * links itself to an account whose address Nook has not verified; here an admin allows the next one
 * (once, within 24 hours), optionally resetting the account first when nobody knows who created it,
 * or removes a linked Google identity. Each opens the app's own dialog, which Back closes.
 */

export type ResetCounts = { sessions: number; keys: number; feeds: number; items: number; shares: number; groupGrants: number; invites: number; routines: number; password: number; twoFactor: number };
export type GoogleAdminState = { linked: { email: string } | null; allowedUntil: string | null; emailVerified: boolean; hasPassword: boolean; resetPreview: ResetCounts; self: boolean };

/** The reset counts in plain words; zeros left out. */
export function resetLines(counts: ResetCounts) {
  const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  const lines = [
    counts.sessions && plural(counts.sessions, "signed-in session ends", "signed-in sessions end"),
    counts.keys && plural(counts.keys, "API key is revoked", "API keys are revoked"),
    counts.feeds && plural(counts.feeds, "calendar feed link stops", "calendar feed links stop"),
    counts.items && plural(counts.items, "shared item becomes private", "shared items become private"),
    counts.shares && plural(counts.shares, "person loses access to those items", "people lose access to those items"),
    counts.groupGrants && plural(counts.groupGrants, "group loses access", "groups lose access"),
    counts.invites && plural(counts.invites, "live invite is revoked", "live invites are revoked"),
    counts.routines && plural(counts.routines, "routine is paused", "routines are paused"),
    counts.password ? "The password is removed" : null,
    counts.twoFactor ? "Two-factor authentication is removed" : null
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines : ["Nothing to remove: no sessions, keys, sharing, or password."];
}

type Step = "choose" | "reset" | "done" | "unlink";

export function TeamGoogleCard({ userId, name }: { userId: string; name: string }) {
  const [state, setState] = useState<GoogleAdminState | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ allowedUntil: string; reset: ResetCounts | null } | null>(null);
  const load = useCallback(() => {
    api<GoogleAdminState>(`/team/${userId}/google`).then(setState, () => setState(null));
  }, [userId]);
  useEffect(() => { load(); }, [load]);
  if (!state) return null;

  const close = () => { if (!busy) { setStep(null); setError(""); setResult(null); } };
  async function allow(reset: boolean) {
    setBusy(true);
    setError("");
    try {
      const outcome = await api<{ allowedUntil: string; reset: ResetCounts | null }>(`/team/${userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset }) });
      setResult(outcome);
      setStep("done");
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Could not allow Google sign-in");
    }
    setBusy(false);
  }
  async function unlink() {
    setBusy(true);
    setError("");
    try {
      await api(`/team/${userId}/google`, { method: "DELETE", body: "{}" });
      setStep(null);
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Could not unlink Google");
    }
    setBusy(false);
  }
  const until = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return <section className="team-card team-google" aria-labelledby={`team-google-${userId}`}>
    <h3 id={`team-google-${userId}`} className="team-google-heading"><GoogleMark />Google sign-in</h3>
    <p className="team-muted">
      {state.linked ? `Signs in with Google (${state.linked.email}).`
        : state.allowedUntil ? `Allowed: the next Google sign-in with this account's address links it, until ${until(state.allowedUntil)}.`
          : state.emailVerified ? "Not linked. A Google sign-in with this address links it on its own when Google manages the address."
            : "Not linked. This address was never confirmed, so a Google sign-in cannot link it on its own."}
    </p>
    {state.self
      ? <p className="team-muted">You cannot change this for your own account here. Another admin, or the host command line, can.</p>
      : <div className="team-google-actions">
        {!state.linked && <button type="button" className="team-action" onClick={() => setStep("choose")}>Allow Google sign-in…</button>}
        {state.linked && <button type="button" className="team-action danger" onClick={() => setStep("unlink")}>Unlink Google…</button>}
      </div>}
    {step && step !== "unlink" && <KeysDialog title={step === "done" ? "Google sign-in allowed" : step === "reset" ? `Reset ${name}'s account?` : "Allow Google sign-in?"} onClose={close} busy={busy}
      description={step === "choose" ? `The next Google sign-in with ${name}'s address links this account and confirms the address. It works once, within 24 hours.` : undefined}
      footer={step === "choose" ? <>
        <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>
        <button type="button" className="secondary-button" onClick={() => { load(); setStep("reset"); }} disabled={busy}>Reset this account first…</button>
        <button type="button" className="primary-button" onClick={() => void allow(false)} disabled={busy}>{busy ? "Please wait…" : "Allow Google sign-in"}</button>
      </> : step === "reset" ? <>
        <button type="button" className="secondary-button" onClick={() => setStep("choose")} disabled={busy}>Back</button>
        <button type="button" className="danger-button" onClick={() => void allow(true)} disabled={busy}>{busy ? "Resetting…" : "Reset and allow"}</button>
      </> : <button type="button" className="primary-button" onClick={close}>Done</button>}>
      {step === "choose" && <p className="team-google-copy">Use this when you know the account belongs to the person who will sign in. If you do not know who created it, reset it first.</p>}
      {step === "reset" && <>
        <p className="team-google-copy"><ShieldAlert aria-hidden="true" />Do this when you do not know who created the account. It happens now, and cannot be undone. Notes, files, and other content are kept.</p>
        <ul className="team-google-counts">{resetLines(state.resetPreview).map((line) => <li key={line}>{line}</li>)}</ul>
      </>}
      {step === "done" && result && <>
        <p className="team-google-copy"><Check aria-hidden="true" />Allowed until {until(result.allowedUntil)}.{result.reset ? " The account was reset first:" : ""}</p>
        {result.reset && <ul className="team-google-counts">{resetLines(result.reset).map((line) => <li key={line}>{line}</li>)}</ul>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </KeysDialog>}
    {step === "unlink" && <KeysDialog title="Unlink Google?" description={`${name} will no longer sign in with ${state.linked?.email ?? "Google"}.`} onClose={close} busy={busy}
      footer={<>
        <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>
        <button type="button" className="danger-button" onClick={() => void unlink()} disabled={busy}>{busy ? "Unlinking…" : "Unlink Google"}</button>
      </>}>
      <p className="team-google-copy">Use this when they recreated their Google account. They need a password, or allow Google sign-in again afterwards, to get back in.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </KeysDialog>}
  </section>;
}
