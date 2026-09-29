import { useEffect, useState } from "react";
import { Eye, EyeOff, Link2Off, Lock, LogOut, Sparkles } from "lucide-react";
import { api, ApiError } from "../api";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "../team/teamRoles";
import type { InviteRole } from "../team/teamApi";
import { AuthDivider, GoogleButton } from "./googleSignIn";
import type { RegistrationInfo } from "./registrationPrompt";

export type InvitePreview = { role: InviteRole; emailHint: string | null; expiresAt: string; inviterName: string };
export type InviteRegisterBody = { email: string; displayName: string; password: string; inviteToken: string };

type State =
  | { kind: "loading" }
  | { kind: "ready"; preview: InvitePreview }
  | { kind: "dead"; reason: "invalid" | "expired" | "missing" | "error"; message?: string };

const codeOf = (reason: unknown) => reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code : undefined;

function deadState(reason: unknown): State {
  const code = codeOf(reason);
  if (code === "INVITE_EXPIRED") return { kind: "dead", reason: "expired" };
  if (code === "INVITE_INVALID") return { kind: "dead", reason: "invalid" };
  return { kind: "dead", reason: "error", message: reason instanceof Error ? reason.message : "Could not open this invite" };
}

const DEAD_COPY = {
  invalid: { title: "This invite link is not valid", body: "It may have been used already, revoked, or copied incompletely. Ask your admin for a new link." },
  expired: { title: "This invite link has expired", body: "Invite links last up to 7 days. Ask your admin for a new link." },
  missing: { title: "This page needs an invite link", body: "Open the full link your admin sent you. Ask your admin for a new link if you no longer have it." },
  error: { title: "Could not open this invite", body: "" }
} as const;

/**
 * The invite-aware register screen at /register (§1.6). The token arrives in memory from the URL
 * fragment (src/auth/inviteLink.ts) and is posted in JSON bodies only: the preview first, then the
 * registration. The server fixes the role and enforces the email binding and the allowlist.
 */
export function InviteRegister({ token, onRegister, onSignIn }: {
  token: string | null;
  onRegister: (body: InviteRegisterBody) => Promise<void>;
  onSignIn: () => void;
}) {
  const [state, setState] = useState<State>(() => token ? { kind: "loading" } : { kind: "dead", reason: "missing" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  // Wave 35 (D298): which ways to join this Nook offers; unknown means the password form only, as before.
  const [methods, setMethods] = useState<{ password: boolean; google: boolean }>({ password: true, google: false });

  useEffect(() => {
    let live = true;
    api<RegistrationInfo>("/about").then((info) => { if (live && info.authMethods) setMethods(info.authMethods); }, () => undefined);
    return () => { live = false; };
  }, []);

  /** The token goes to the server in a JSON body and waits there; the start URL carries no token (T136). */
  async function continueWithGoogle() {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const { start } = await api<{ start: string }>("/auth/google/invite", { method: "POST", body: JSON.stringify({ token }) });
      window.location.assign(start);
    } catch (reason) {
      const code = codeOf(reason);
      if (code === "INVITE_INVALID" || code === "INVITE_EXPIRED") setState(deadState(reason));
      else setError(reason instanceof Error ? reason.message : "Could not continue with Google");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    let active = true;
    api<InvitePreview>("/auth/invite", { method: "POST", body: JSON.stringify({ token }) })
      .then((preview) => { if (active) setState({ kind: "ready", preview }); }, (reason) => { if (active) setState(deadState(reason)); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => { document.title = "Join Nook"; }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onRegister({ email: String(form.get("email") ?? ""), displayName: String(form.get("displayName") ?? ""), password: String(form.get("password") ?? ""), inviteToken: token });
    } catch (reason) {
      const code = codeOf(reason);
      if (code === "INVITE_INVALID" || code === "INVITE_EXPIRED") setState(deadState(reason));
      else setError(reason instanceof Error ? reason.message : "Could not create your account");
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <section className="auth-card invite-register">
      <div className="brand-mark"><Sparkles aria-hidden="true" /></div>
      {state.kind === "loading" && <p className="invite-register-status" role="status">Checking your invite…</p>}
      {state.kind === "dead" && <div className="auth-heading" role="alert">
        <span className="eyebrow">Nook</span>
        <h1><Link2Off aria-hidden="true" className="invite-register-icon" />{DEAD_COPY[state.reason].title}</h1>
        <p>{state.reason === "error" ? state.message : DEAD_COPY[state.reason].body}</p>
      </div>}
      {state.kind === "ready" && <>
        <div className="auth-heading">
          <span className="eyebrow">You were invited as {ROLE_LABELS[state.preview.role]}</span>
          <h1>Join Nook</h1>
          <p>{state.preview.inviterName} invited you to Nook as a <strong>{ROLE_LABELS[state.preview.role]}</strong>.</p>
          <p className="invite-register-role">{ROLE_DESCRIPTIONS[state.preview.role]}.</p>
          <p className="invite-register-expiry">The link works once, until {new Date(state.preview.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.</p>
        </div>
        {methods.google && <GoogleButton onClick={() => void continueWithGoogle()} disabled={busy} />}
        {methods.google && state.preview.emailHint && <p className="invite-google-hint">Choose the Google account for {state.preview.emailHint}.</p>}
        {methods.google && methods.password && <AuthDivider />}
        {!methods.password && error && <p className="form-error" role="alert">{error}</p>}
        {methods.password && <form onSubmit={submit} className="auth-form">
          <label>Name<input name="displayName" autoComplete="name" required maxLength={80} disabled={busy} /></label>
          <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} aria-describedby={state.preview.emailHint ? "invite-email-hint" : undefined} />
            {state.preview.emailHint && <small id="invite-email-hint">This invite is for {state.preview.emailHint}. Use that address.</small>}
          </label>
          <div className="auth-password-group">
            <label htmlFor="invite-password">Password</label>
            <span className="password-field">
              <input id="invite-password" name="password" type={passwordVisible ? "text" : "password"} autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy} />
              <button type="button" className="password-visibility-toggle" aria-label={passwordVisible ? "Hide password" : "Show password"} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>
                {passwordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : "Create account"}</button>
        </form>}
      </>}
      <button type="button" className="text-button" onClick={onSignIn}>Already have an account? Sign in</button>
      <p className="security-note"><Lock /> Your notes stay on this machine.</p>
    </section>
  </main>;
}

/** A signed-in visitor opened an invite link (§1.6): they must sign out to use it. */
export function InviteWhileSignedIn({ displayName, onSignOut, onContinue }: { displayName: string; onSignOut: () => void; onContinue: () => void }) {
  useEffect(() => { document.title = "Join Nook"; }, []);
  return <main className="auth-page">
    <section className="auth-card invite-register">
      <div className="brand-mark"><Sparkles aria-hidden="true" /></div>
      <div className="auth-heading">
        <span className="eyebrow">Invite link</span>
        <h1>You're already signed in</h1>
        <p>You're signed in as {displayName}. Sign out to use this invite and create a new account.</p>
      </div>
      <div className="auth-form">
        <button type="button" className="primary-button invite-register-signout" onClick={onSignOut}><LogOut aria-hidden="true" />Sign out and use the invite</button>
      </div>
      <button type="button" className="text-button" onClick={onContinue}>Continue to Nook as {displayName}</button>
    </section>
  </main>;
}
