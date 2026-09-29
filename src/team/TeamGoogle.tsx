import { useCallback, useEffect, useId, useState } from "react";
import { Check, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../api";
import { GoogleMark } from "../auth/googleSignIn";
import { useAccountAuthLoader } from "../auth/accountAuth";
import { reauthBody, ReauthFields, reauthProblems } from "../auth/GoogleAccountCard";
import { fieldName, useFieldErrors } from "../auth/fieldChecks";
import { KeysDialog } from "../keys/KeysDialog";
import "../keys/keys.css";

/**
 * Team → member → Google sign-in (Wave 35 review, HIGH-1, L6, N2, N5; admins only). A Google sign-in
 * never links itself to an account whose address Nook has not verified; here an admin allows the
 * next one (once, within 24 hours), optionally resetting an unverified, non-admin account first when
 * nobody knows who created it; allows re-linking a linked account to a new Google account; or
 * removes a linked Google identity. Every action re-authenticates the acting admin inline (their
 * password, or a Google confirmation where that is their method, plus their code with two-factor
 * on). Each opens the app's own dialog, which Back closes.
 */

export type ResetCounts = { sessions: number; keys: number; feeds: number; items: number; shares: number; groupGrants: number; invites: number; routines: number; password: number; twoFactor: number };
export type GoogleAdminState = { linked: { email: string } | null; allowedUntil: string | null; emailVerified: boolean; hasPassword: boolean; resetPreview: ResetCounts; self: boolean; resetAllowed?: boolean; resetRefusal?: { code: string; message: string } | null };

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

type Step = "choose" | "relink" | "reset" | "done" | "unlink";
type Outcome = { allowedUntil: string; reset: ResetCounts | null; relink?: boolean };

export function TeamGoogleCard({ userId, name }: { userId: string; name: string }) {
  const [state, setState] = useState<GoogleAdminState | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Outcome | null>(null);
  const { account } = useAccountAuthLoader();
  const fields = useFieldErrors();
  const formId = useId();
  const load = useCallback(() => {
    api<GoogleAdminState>(`/team/${userId}/google`).then(setState, () => setState(null));
  }, [userId]);
  useEffect(() => { load(); }, [load]);
  if (!state || !account) return null;
  const twoFactor = account.twoFactor === true;

  const close = () => { if (!busy) { setStep(null); setError(""); setResult(null); fields.clear(); } };
  const open = (next: Step) => {
    setError("");
    fields.clear();
    if (next === "reset") load();
    setStep(next);
  };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (fields.show(event.currentTarget, reauthProblems(form, account!, twoFactor))) return;
    setBusy(true);
    setError("");
    try {
      if (step === "unlink") {
        await api(`/team/${userId}/google`, { method: "DELETE", body: JSON.stringify(reauthBody(form, account, twoFactor)) });
        setStep(null);
      } else {
        const outcome = await api<Outcome>(`/team/${userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: step === "reset", ...reauthBody(form, account, twoFactor) }) });
        setResult(outcome);
        setStep("done");
      }
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Something went wrong");
    }
    setBusy(false);
  }
  const until = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const submitButton = (label: string, danger = false) => <button type="submit" form={formId} className={danger ? "danger-button" : "primary-button"} disabled={busy}>{busy ? "Please wait…" : label}</button>;
  const cancel = <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>;
  const titles: Record<Step, string> = { choose: "Allow Google sign-in?", relink: "Allow re-linking?", reset: `Reset ${name}'s account?`, done: result?.relink ? "Re-linking allowed" : "Google sign-in allowed", unlink: "Unlink Google?" };
  const descriptions: Partial<Record<Step, string>> = {
    choose: `The next Google sign-in with ${name}'s address links this account and confirms the address. It works once, within 24 hours.`,
    relink: `For a new Google account: the next Google sign-in with ${state.linked?.email ?? "this address"} replaces the linked one, once, within 24 hours. The old Google account keeps working until then.`,
    unlink: `${name} will no longer sign in with ${state.linked?.email ?? "Google"}.`
  };
  const footer = step === "done" ? <button type="button" className="primary-button" onClick={close}>Done</button>
    : step === "choose" ? <>{cancel}{state.resetAllowed && <button type="button" className="secondary-button" onClick={() => open("reset")} disabled={busy}>Reset this account first…</button>}{submitButton("Allow Google sign-in")}</>
      : step === "reset" ? <><button type="button" className="secondary-button" onClick={() => open("choose")} disabled={busy}>Back</button>{submitButton("Reset and allow", true)}</>
        : step === "relink" ? <>{cancel}{submitButton("Allow re-linking")}</>
          : <>{cancel}{submitButton("Unlink Google", true)}</>;

  return <section className="team-card team-google" aria-labelledby={`team-google-${userId}`}>
    <h3 id={`team-google-${userId}`} className="team-google-heading"><GoogleMark />Google sign-in</h3>
    <p className="team-muted">
      {state.linked ? `Signs in with Google (${state.linked.email}).${state.allowedUntil ? ` Re-linking allowed until ${until(state.allowedUntil)}.` : ""}`
        : state.allowedUntil ? `Allowed: the next Google sign-in with this account's address links it, until ${until(state.allowedUntil)}.`
          : state.emailVerified ? "Not linked. A Google sign-in with this address links it on its own when Google manages the address."
            : "Not linked. This address was never confirmed, so a Google sign-in cannot link it on its own."}
    </p>
    {state.self
      ? <p className="team-muted">You cannot change this for your own account here. Another admin, or the host command line, can.</p>
      : <div className="team-google-actions">
        {!state.linked && <button type="button" className="team-action" onClick={() => open("choose")}>Allow Google sign-in…</button>}
        {state.linked && <button type="button" className="team-action" onClick={() => open("relink")}>Allow re-linking…</button>}
        {state.linked && <button type="button" className="team-action danger" onClick={() => open("unlink")}>Unlink Google…</button>}
      </div>}
    {step && <KeysDialog title={titles[step]} description={descriptions[step]} onClose={close} busy={busy} footer={footer}>
      {step === "choose" && <>
        <p className="team-google-copy">Use this when you know the account belongs to the person who will sign in.{state.resetAllowed ? " If you do not know who created it, reset it first." : ""}</p>
        {!state.resetAllowed && state.resetRefusal && <p className="team-google-copy team-google-note">{state.resetRefusal.message}</p>}
      </>}
      {step === "reset" && <>
        <p className="team-google-copy"><ShieldAlert aria-hidden="true" />Do this when you do not know who created the account. It happens now, and cannot be undone. Notes, files, and other content are kept.</p>
        <ul className="team-google-counts">{resetLines(state.resetPreview).map((line) => <li key={line}>{line}</li>)}</ul>
      </>}
      {step === "unlink" && <p className="team-google-copy">They need a password to get back in. For a recreated Google account, use Allow re-linking instead.</p>}
      {step !== "done" && <>
        <p className="team-google-copy team-google-note">Confirm it's you to continue.</p>
        <form id={formId} className="auth-form google-reauth-form" noValidate onSubmit={submit} onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
          <ReauthFields account={account} totpEnabled={twoFactor} errors={fields.errors} idPrefix={`team-google-${step}`} returnTo={`/team/${userId}`} disabled={busy} />
        </form>
      </>}
      {step === "done" && result && <>
        <p className="team-google-copy"><Check aria-hidden="true" />Allowed until {until(result.allowedUntil)}.{result.reset ? " The account was reset first:" : ""}</p>
        {result.reset && <ul className="team-google-counts">{resetLines(result.reset).map((line) => <li key={line}>{line}</li>)}</ul>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </KeysDialog>}
  </section>;
}
