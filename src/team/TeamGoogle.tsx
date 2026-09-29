import { useCallback, useEffect, useId, useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { api, ApiError } from "../api";
import { GoogleMark, initialGoogleTeamResult } from "../auth/googleSignIn";
import { useAccountAuthLoader } from "../auth/accountAuth";
import { googleSettingsNotice, reauthBody, ReauthFields, reauthProblems } from "../auth/GoogleAccountCard";
import { fieldName, useFieldErrors } from "../auth/fieldChecks";
import { KeysDialog } from "../keys/KeysDialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
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
export type RelinkCounts = { sessions: number; keys: number; feeds: number; password: number; twoFactor: number };
export type GoogleAdminState = {
  linked: { email: string } | null; allowedUntil: string | null; emailVerified: boolean; hasPassword: boolean; hasTwoFactor?: boolean; resetPreview: ResetCounts; self: boolean;
  resetAllowed?: boolean; resetRefusal?: { code: string; message: string } | null;
  /** Q1: the last Google sign-in that could not link the account (time and reason code only). */
  lastRefusal?: { at: string; reason: string | null } | null;
  domain?: string;
  /** S1: what a completed re-link removes, with the password and two-factor. */
  relinkPreview?: RelinkCounts | null;
};

const REFUSAL_REASONS: Record<string, string> = {
  link_not_authoritative: "Google could not confirm that Google account manages the address",
  link_required: "the address was never confirmed and no admin allowed the link",
  already_linked: "another Google account holds this account and no re-linking was allowed"
};

/** Q1: which Google accounts can link an address, said before the admin allows anything. */
export function googleConditionText(domain: string) {
  return domain === "gmail.com" || domain === "googlemail.com"
    ? `Only the Gmail account with this exact address can link it.`
    : `Only a Google account that Google confirms is managed by ${domain} can link it: a Google Workspace account of ${domain}. A personal Google account that merely uses this address cannot.`;
}

/** G4: the re-link with "Also remove the password and two-factor" off. */
export function keptCredentialsText(twoFactor: boolean) {
  return twoFactor
    ? "The password and two-factor stay. The new Google account will be asked for the existing two-factor code at sign-in."
    : "The password stays, so whoever knows it can still sign in with it.";
}

/** What a completed re-link removes (S1), in plain words. */
export function relinkLines(counts: RelinkCounts) {
  const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  return [
    counts.sessions ? plural(counts.sessions, "signed-in session ends", "signed-in sessions end") : "Signed-in sessions end (none now)",
    counts.keys && plural(counts.keys, "API key is revoked", "API keys are revoked"),
    counts.feeds && plural(counts.feeds, "calendar feed link stops", "calendar feed links stop"),
    "Unused password-reset links stop working",
    counts.password ? "The password is removed" : null,
    counts.twoFactor ? "Two-factor authentication is removed" : null
  ].filter((line): line is string => Boolean(line));
}

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
type Outcome = { allowedUntil: string; reset: ResetCounts | null; relink?: boolean; removeCredentials?: boolean; relinkPreview?: RelinkCounts | null };

export function TeamGoogleCard({ userId, name }: { userId: string; name: string }) {
  const [state, setState] = useState<GoogleAdminState | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Outcome | null>(null);
  const { account } = useAccountAuthLoader();
  const fields = useFieldErrors();
  const formId = useId();
  const [removeCredentials, setRemoveCredentials] = useState(true);
  // Q2: an admin's Google confirmation comes back to this member's page; its result shows here.
  const [returned, setReturned] = useState(() => {
    const result = initialGoogleTeamResult();
    return result && typeof window !== "undefined" && window.location.pathname.startsWith(`/team/${userId}`) ? googleSettingsNotice(result) : null;
  });
  // Q6: the reset step is its own history layer over the Allow dialog: Back returns to the first step,
  // as the dialog's own Back button does.
  useHistoryDialogGuard(step === "reset", () => { setError(""); fields.clear(); setStep("choose"); }, { blocked: busy });
  const load = useCallback(() => {
    api<GoogleAdminState>(`/team/${userId}/google`).then(setState, () => setState(null));
  }, [userId]);
  useEffect(() => { load(); }, [load]);
  if (!state || !account) return null;
  const twoFactor = account.twoFactor === true;
  const domain = state.domain ?? "";
  // S1: the option appears only when there is a password or two-factor to remove.
  const offersCredentials = Boolean(state.relinkPreview && (state.relinkPreview.password || state.relinkPreview.twoFactor));
  const relinkCounts = state.relinkPreview ? { ...state.relinkPreview, ...(offersCredentials && removeCredentials ? {} : { password: 0, twoFactor: 0 }) } : null;
  const lastRefusal = state.lastRefusal
    ? `Last Google sign-in that could not link: ${new Date(state.lastRefusal.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}, because ${REFUSAL_REASONS[state.lastRefusal.reason ?? ""] ?? "it was refused"}.`
    : null;

  const close = () => { if (!busy) { setStep(null); setError(""); setResult(null); fields.clear(); } };
  const open = (next: Step) => {
    setError("");
    fields.clear();
    if (next === "reset" || next === "relink") load();
    if (next === "relink") setRemoveCredentials(true);
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
        const outcome = await api<Outcome>(`/team/${userId}/google/allow`, { method: "POST", body: JSON.stringify({ reset: step === "reset", ...(step === "relink" ? { removeCredentials: offersCredentials && removeCredentials } : {}), ...reauthBody(form, account, twoFactor) }) });
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
  // Distinct keys: React must not turn the clicked "Reset this account first…" button into the submit
  // button during the same click (a type change before the default action would submit the form).
  const submitButton = (label: string, danger = false) => <button key={`submit-${step}`} type="submit" form={formId} className={danger ? "danger-button" : "primary-button"} disabled={busy}>{busy ? "Please wait…" : label}</button>;
  const cancel = <button key="cancel" type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>;
  const titles: Record<Step, string> = { choose: "Allow Google sign-in?", relink: "Allow re-linking?", reset: `Reset ${name}'s account for Google sign-in?`, done: result?.relink ? "Re-linking allowed" : "Google sign-in allowed", unlink: "Unlink Google?" };
  const descriptions: Partial<Record<Step, string>> = {
    choose: `The next Google sign-in with ${name}'s address links this account and confirms the address. It works once, within 24 hours.`,
    relink: `For a new Google account: the next Google sign-in with ${state.linked?.email ?? "this address"} replaces the linked one, once, within 24 hours. The old Google account keeps working until then.`,
    unlink: `${name} will no longer sign in with ${state.linked?.email ?? "Google"}.`
  };
  const footer = step === "done" ? <button key="done" type="button" className="primary-button" onClick={close}>Done</button>
    : step === "choose" ? <>{cancel}{state.resetAllowed && <button key="reset-first" type="button" className="secondary-button" onClick={() => open("reset")} disabled={busy}>Reset account for Google sign-in…</button>}{submitButton("Allow Google sign-in")}</>
      : step === "reset" ? <><button key="back" type="button" className="secondary-button" onClick={() => open("choose")} disabled={busy}>Back</button>{submitButton("Reset and allow", true)}</>
        : step === "relink" ? <>{cancel}{submitButton("Allow re-linking")}</>
          : <>{cancel}{submitButton("Unlink Google", true)}</>;

  return <section className="team-card team-google" aria-labelledby={`team-google-${userId}`}>
    <h3 id={`team-google-${userId}`} className="team-google-heading"><GoogleMark />Google sign-in</h3>
    {returned && <p className={`settings-google-notice ${returned.tone}`} role={returned.tone === "error" ? "alert" : "status"}>{returned.text}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setReturned(null)}><X /></button></p>}
    <p className="team-muted">
      {state.linked ? `Signs in with Google (${state.linked.email}).${state.allowedUntil ? ` Re-linking allowed until ${until(state.allowedUntil)}.` : ""}`
        : state.allowedUntil ? `Allowed: the next Google sign-in with this account's address links it, until ${until(state.allowedUntil)}.`
          : state.emailVerified ? "Not linked. A Google sign-in with this address links it on its own when Google manages the address."
            : "Not linked. This address was never confirmed, so a Google sign-in cannot link it on its own."}
    </p>
    {domain && <p className="team-muted">{googleConditionText(domain)}</p>}
    {lastRefusal && <p className="team-muted team-google-refusal">{lastRefusal}</p>}
    {state.self
      ? <p className="team-muted">You cannot change this for your own account here. Another admin, or the host command line, can.</p>
      : <div className="team-google-actions">
        {!state.linked && <button type="button" className="team-action" onClick={() => open("choose")}>Allow Google sign-in…</button>}
        {state.linked && <button type="button" className="team-action" onClick={() => open("relink")}>Allow re-linking…</button>}
        {state.linked && <button type="button" className="team-action danger" onClick={() => open("unlink")}>Unlink Google…</button>}
      </div>}
    {step && <KeysDialog title={titles[step]} description={descriptions[step]} onClose={close} busy={busy} footer={footer}>
      {step === "choose" && <>
        <p className="team-google-copy">Use this when you know the account belongs to the person who will sign in.{state.resetAllowed ? " If you do not know who created it, reset it for Google sign-in first." : ""}</p>
        {domain && <p className="team-google-copy team-google-note">{googleConditionText(domain)}</p>}
        {lastRefusal && <p className="team-google-copy team-google-note">{lastRefusal}</p>}
        {!state.resetAllowed && state.resetRefusal && <p className="team-google-copy team-google-note">{state.resetRefusal.message}</p>}
      </>}
      {step === "relink" && <>
        <p className="team-google-copy team-google-warning"><ShieldAlert aria-hidden="true" />Whoever next signs in with Google as {state.linked?.email ?? "this address"} gets this account and everything in it.</p>
        {domain && <p className="team-google-copy team-google-note">{googleConditionText(domain)}</p>}
        {lastRefusal && <p className="team-google-copy team-google-note">{lastRefusal}</p>}
        {offersCredentials && <label className="team-google-option">
          <input type="checkbox" checked={removeCredentials} onChange={(event) => setRemoveCredentials(event.target.checked)} disabled={busy} />
          <span><strong>Also remove the password and two-factor</strong><br />Whoever used this account before may know them. Leave this on unless you are sure the same person will re-link.</span>
        </label>}
        <p className="team-google-copy">When the new Google account signs in:</p>
        {relinkCounts && <ul className="team-google-counts">{relinkLines(relinkCounts).map((line) => <li key={line}>{line}</li>)}</ul>}
        {offersCredentials && !removeCredentials && <p className="team-google-copy team-google-note">{keptCredentialsText(Boolean(state.relinkPreview?.twoFactor))}</p>}
        <p className="team-google-copy">Notes, files, other content, and sharing are kept.</p>
      </>}
      {step === "reset" && <>
        <p className="team-google-copy"><ShieldAlert aria-hidden="true" />Do this when you do not know who created the account. It happens now, and cannot be undone. Notes, files, and other content are kept.</p>
        <p className="team-google-copy team-google-note">This is not Reset access (Team → this person → Access), which removes what others share with them. This removes the account's own ways in and what it shares with others, so the person who signs in with Google starts clean.</p>
        <ul className="team-google-counts">{resetLines(state.resetPreview).map((line) => <li key={line}>{line}</li>)}</ul>
      </>}
      {step === "unlink" && <p className="team-google-copy">Every device where {name} is signed in is signed out now, and they sign in again with their password. For a recreated Google account, use Allow re-linking instead.</p>}
      {step !== "done" && <>
        <p className="team-google-copy team-google-note">Confirm it's you to continue.</p>
        <form id={formId} className="auth-form google-reauth-form" noValidate onSubmit={submit} onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
          <ReauthFields account={account} totpEnabled={twoFactor} errors={fields.errors} idPrefix={`team-google-${step}`} returnTo={`/team/${userId}`} disabled={busy} />
        </form>
      </>}
      {step === "done" && result && <>
        <p className="team-google-copy"><Check aria-hidden="true" />Allowed until {until(result.allowedUntil)}.{result.reset ? " The account was reset first:" : ""}</p>
        {result.reset && <ul className="team-google-counts">{resetLines(result.reset).map((line) => <li key={line}>{line}</li>)}</ul>}
        {result.relink && result.relinkPreview && <>
          <p className="team-google-copy">When the new Google account signs in:</p>
          <ul className="team-google-counts">{relinkLines(result.relinkPreview).map((line) => <li key={line}>{line}</li>)}</ul>
          {result.removeCredentials === false && offersCredentials && <p className="team-google-copy team-google-note">{keptCredentialsText(Boolean(state.relinkPreview?.twoFactor))}</p>}
        </>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </KeysDialog>}
  </section>;
}
