import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Eye, EyeOff, KeyRound, Link2Off, Lock, MailX, Sparkles } from "lucide-react";
import { api, ApiError } from "../api";
import "./auth.css";

/**
 * Forgot / reset password (Wave 30, outbound email §A.5, §E.6). Both pages work signed out.
 *
 * - `/forgot-password` asks for an address and always ends at the same neutral confirmation: the
 *   server answers the same way whether or not an account exists (T224). With email off it says so
 *   and sends nothing.
 * - `/reset-password#token=…` carries its token in the fragment, which browsers never send; the SPA
 *   reads it once and strips it from the address bar at once (T220). The server tells the page only
 *   whether a second-factor code is needed. Success never signs anyone in.
 */

export const FORGOT_PATH = "/forgot-password";
export const RESET_PATH = "/reset-password";
export type PasswordLink = { kind: "forgot" } | { kind: "reset"; token: string | null } | null;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Reads a password page from a location and strips a reset fragment. Pure apart from `history`. */
export function takePasswordLinkFromLocation(location: Pick<Location, "pathname" | "hash"> = window.location, history: Pick<History, "state" | "replaceState"> = window.history): PasswordLink {
  const path = location.pathname.replace(/\/$/, "");
  if (path === FORGOT_PATH) return { kind: "forgot" };
  if (path !== RESET_PATH) return null;
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const raw = params.get("token");
  if (location.hash) history.replaceState(history.state, "", RESET_PATH);
  return { kind: "reset", token: raw && TOKEN.test(raw) ? raw : null };
}

let initial: PasswordLink | undefined;
/** The password page on the page's first URL, read (and stripped) once per page load. */
export function initialPasswordLink() {
  if (initial === undefined) initial = takePasswordLinkFromLocation();
  return initial;
}

/** The only thing the forgot page ever says after a request (T224). */
export const FORGOT_SENT_TEXT = "If that address has a verified account, we sent a link. It works for 30 minutes.";
/** With email off there is no link to send (members ask an admin). */
export const FORGOT_OFF_TEXT = "Email is off on this Nook, so it cannot send a reset link. Ask an admin of this Nook to help you back in.";

function Card({ children }: { children: React.ReactNode }) {
  return <main className="auth-page">
    <section className="auth-card password-card">
      <div className="brand-mark"><Sparkles aria-hidden="true" /></div>
      {children}
    </section>
  </main>;
}

export function PasswordInput({ name, label, autoComplete, disabled, minLength = 12, describedBy }: { name: string; label: string; autoComplete: string; disabled?: boolean; minLength?: number; describedBy?: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return <div className="auth-password-group">
    <label htmlFor={id}>{label}</label>
    <span className="password-field">
      <input id={id} name={name} type={visible ? "text" : "password"} autoComplete={autoComplete} required minLength={minLength} maxLength={256} disabled={disabled} aria-describedby={describedBy} />
      <button type="button" className="password-visibility-toggle" aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={visible} onClick={() => setVisible((value) => !value)}>
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </span>
  </div>;
}

/** The six-digit or recovery code field, with the switch between them (as on the sign-in page). */
export function SecondFactorField({ recovery, onToggle, disabled }: { recovery: boolean; onToggle: () => void; disabled?: boolean }) {
  return <>
    {recovery
      ? <label>Recovery code<input name="recoveryCode" autoComplete="one-time-code" placeholder="ABCDE-FGHIJ-KLMNO" minLength={10} maxLength={32} required disabled={disabled} /><small>Enter one complete recovery code. Each code works once.</small></label>
      : <label>Six-digit authentication code<input name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required disabled={disabled} /><small>Your account uses two-factor authentication, so the code from your app is needed too.</small></label>}
    <button type="button" className="inline-auth-switch" onClick={onToggle}>{recovery ? "Use an authentication code instead" : "Use a recovery code"}</button>
  </>;
}

/** The second-factor part of a password form's body, from its fields. */
export function secondFactorBody(form: FormData, needsCode: boolean, recovery: boolean) {
  if (!needsCode) return {};
  return recovery ? { recoveryCode: String(form.get("recoveryCode") ?? "").trim() } : { totpCode: String(form.get("totpCode") ?? "").trim() };
}

export function ForgotPasswordPage({ onBack }: { onBack: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<"form" | "working" | "sent">("form");
  const [error, setError] = useState("");
  useEffect(() => { document.title = "Forgot password · Nook"; }, []);
  useEffect(() => {
    let live = true;
    api<{ passwordReset?: boolean }>("/about").then((info) => { if (live) setAvailable(info.passwordReset === true); }, () => { if (live) setAvailable(true); });
    return () => { live = false; };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setState("working");
    setError("");
    try {
      await api("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: address }) });
      setState("sent");
    } catch (reason) {
      setState("form");
      setError(reason instanceof ApiError && reason.status === 429 ? "Too many requests from this device. Try again later." : reason instanceof Error ? reason.message : "Could not send the request");
    }
  }

  return <Card>
    {available === false ? <div className="auth-heading" role="status">
      <span className="eyebrow">Password</span>
      <h1><MailX aria-hidden="true" className="invite-register-icon" />Email is off</h1>
      <p>{FORGOT_OFF_TEXT}</p>
    </div> : state === "sent" ? <div className="auth-heading" role="status">
      <span className="eyebrow">Password</span>
      <h1><CheckCircle2 aria-hidden="true" className="invite-register-icon" />Check your email</h1>
      <p>{FORGOT_SENT_TEXT}</p>
      <p>Nothing arrived? Check spam, or ask an admin of this Nook.</p>
    </div> : <>
      <div className="auth-heading">
        <span className="eyebrow">Password</span>
        <h1>Forgot your password?</h1>
        <p>Enter the email address of your Nook account. If it has a verified address, Nook emails you a link to choose a new password.</p>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} disabled={state === "working" || available === null} autoFocus /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={state === "working" || available === null}>{state === "working" ? "Sending…" : "Send reset link"}</button>
      </form>
    </>}
    <button type="button" className="text-button" onClick={onBack}>Back to sign in</button>
    <p className="security-note"><Lock /> Nook never asks for your password by email.</p>
  </Card>;
}

type ResetState = { kind: "checking" } | { kind: "ready"; needsCode: boolean } | { kind: "done" } | { kind: "dead"; reason: "expired" | "invalid" | "error"; message?: string };

const DEAD_COPY = {
  expired: { title: "This link expired", body: "Reset links work for 30 minutes. Ask for a new one." },
  invalid: { title: "This link is not valid", body: "It may have been used already, replaced by a newer link, or copied incompletely. Ask for a new one." },
  error: { title: "Could not open this link", body: "" }
} as const;

function deadFrom(reason: unknown): ResetState {
  const code = reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code : undefined;
  if (code === "TOKEN_EXPIRED") return { kind: "dead", reason: "expired" };
  if (code === "TOKEN_INVALID") return { kind: "dead", reason: "invalid" };
  return { kind: "dead", reason: "error", message: reason instanceof Error ? reason.message : "Something went wrong" };
}

export function ResetPasswordPage({ token, onSignIn, onForgot }: { token: string | null; onSignIn: () => void; onForgot: () => void }) {
  const [state, setState] = useState<ResetState>(token ? { kind: "checking" } : { kind: "dead", reason: "invalid" });
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const checked = useRef(false);
  const hintId = useId();
  useEffect(() => { document.title = "Reset password · Nook"; }, []);
  useEffect(() => {
    if (!token || checked.current) return;
    checked.current = true;
    api<{ ok: true; needsCode: boolean }>("/auth/password-reset/check", { method: "POST", body: JSON.stringify({ token }) })
      .then((result) => setState({ kind: "ready", needsCode: result.needsCode }), (reason) => setState(deadFrom(reason)));
  }, [token]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || state.kind !== "ready") return;
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirmPassword") ?? "")) {
      setError("The two passwords do not match.");
      return;
    }
    const factor = secondFactorBody(form, state.needsCode, recovery);
    setBusy(true);
    setError("");
    try {
      await api("/auth/password-reset/complete", { method: "POST", body: JSON.stringify({ token, newPassword, ...factor }) });
      setState({ kind: "done" });
    } catch (reason) {
      const payload = reason instanceof ApiError ? reason.payload as { code?: string; requiresTotp?: boolean } | undefined : undefined;
      if (payload?.code === "TOKEN_INVALID" || payload?.code === "TOKEN_EXPIRED") setState(deadFrom(reason));
      else {
        if (payload?.requiresTotp) setState({ kind: "ready", needsCode: true });
        setError(reason instanceof Error ? reason.message : "Could not change your password");
      }
    } finally {
      setBusy(false);
    }
  }

  return <Card>
    {state.kind === "checking" && <p className="invite-register-status" role="status">Checking your link…</p>}
    {state.kind === "dead" && <>
      <div className="auth-heading" role="alert">
        <span className="eyebrow">Password</span>
        <h1><Link2Off aria-hidden="true" className="invite-register-icon" />{DEAD_COPY[state.reason].title}</h1>
        <p>{state.reason === "error" ? state.message : DEAD_COPY[state.reason].body}</p>
      </div>
      <div className="auth-form"><button type="button" className="primary-button" onClick={onForgot}>Ask for a new link</button></div>
    </>}
    {state.kind === "done" && <>
      <div className="auth-heading" role="status">
        <span className="eyebrow">Password</span>
        <h1><CheckCircle2 aria-hidden="true" className="invite-register-icon" />Password changed</h1>
        <p>All devices were signed out. Sign in with your new password.</p>
      </div>
      <div className="auth-form"><button type="button" className="primary-button" onClick={onSignIn}>Sign in</button></div>
    </>}
    {state.kind === "ready" && <>
      <div className="auth-heading">
        <span className="eyebrow">Password</span>
        <h1><KeyRound aria-hidden="true" className="invite-register-icon" />Choose a new password</h1>
        <p id={hintId}>Use at least 12 characters. Every device signed in to this account will be signed out.</p>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <PasswordInput name="newPassword" label="New password" autoComplete="new-password" disabled={busy} describedBy={hintId} />
        <PasswordInput name="confirmPassword" label="Confirm new password" autoComplete="new-password" disabled={busy} />
        {state.needsCode && <SecondFactorField recovery={recovery} disabled={busy} onToggle={() => { setRecovery((value) => !value); setError(""); }} />}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
      </form>
    </>}
    {state.kind !== "done" && <button type="button" className="text-button" onClick={onSignIn}>Back to sign in</button>}
  </Card>;
}
