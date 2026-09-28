import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Link2Off, MailX, Sparkles } from "lucide-react";
import { api, ApiError } from "../api";
import { settingsPath } from "../router";

/**
 * The two pages mail links open (Wave 28, outbound email §E.4, §E.6). Both carry their token in the
 * URL fragment, which browsers never send to the server; the SPA reads it once and strips it from
 * the address bar at once (T220), then POSTs it. Neither page needs a session, and neither signs
 * anyone in.
 *
 * - `/verify-email#token=…` verifies the address (single use, 24 h).
 * - `/mail/unsubscribe#t=…` turns one email category off, only after the person confirms: a GET
 *   (a link scanner or a preview) never changes anything (T221).
 */

export type MailLink = { kind: "verify" | "unsubscribe"; token: string | null } | null;

const VERIFY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UNSUBSCRIBE_TOKEN = /^[A-Za-z0-9_-]{16,200}\.[A-Za-z0-9_-]{8,64}$/;

/** Reads a mail link from a location and strips its fragment. Pure apart from `history`. */
export function takeMailLinkFromLocation(location: Pick<Location, "pathname" | "hash"> = window.location, history: Pick<History, "state" | "replaceState"> = window.history): MailLink {
  const path = location.pathname.replace(/\/$/, "");
  const kind = path === "/verify-email" ? "verify" : path === "/mail/unsubscribe" ? "unsubscribe" : null;
  if (!kind) return null;
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const raw = params.get(kind === "verify" ? "token" : "t");
  const token = raw && (kind === "verify" ? VERIFY_TOKEN : UNSUBSCRIBE_TOKEN).test(raw) ? raw : null;
  if (location.hash) history.replaceState(history.state, "", path);
  return { kind, token };
}

let initial: MailLink | undefined;
/** The mail link on the page's first URL, read (and stripped) once per page load. */
export function initialMailLink() {
  if (initial === undefined) initial = takeMailLinkFromLocation();
  return initial;
}

export const CATEGORY_LABELS: Record<string, string> = {
  assignments: "Assigned to you",
  comments: "Comments on your cards",
  sharing: "Shared with you",
  proposals: "Proposals awaiting you",
  sprints: "Sprints",
  bin: "Bin clean-up",
  reminders: "Reminders by email"
};

/** The category an unsubscribe token names, for the confirmation text only (the server verifies it). */
export function unsubscribeCategory(token: string) {
  try {
    const payload = atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"));
    const category = payload.split("|")[2] ?? "";
    return Object.hasOwn(CATEGORY_LABELS, category) ? category : null;
  } catch {
    return null;
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return <main className="auth-page">
    <section className="auth-card mail-link-card">
      <div className="brand-mark"><Sparkles aria-hidden="true" /></div>
      {children}
    </section>
  </main>;
}

type VerifyState = "working" | "verified" | "expired" | "invalid" | "error";

export function VerifyEmailPage({ token, onContinue, signedIn }: { token: string | null; onContinue: () => void; signedIn: boolean }) {
  const [state, setState] = useState<VerifyState>(token ? "working" : "invalid");
  const [message, setMessage] = useState("");
  const sent = useRef(false);
  useEffect(() => { document.title = "Verify email · Nook"; }, []);
  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api<{ ok: true }>("/mail/verify", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setState("verified"), (reason) => {
        const code = reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code : undefined;
        if (code === "TOKEN_EXPIRED") setState("expired");
        else if (code === "TOKEN_INVALID") setState("invalid");
        else {
          setState("error");
          setMessage(reason instanceof Error ? reason.message : "Could not verify your email");
        }
      });
  }, [token]);
  return <Card>
    {state === "working" && <p className="invite-register-status" role="status">Verifying your email…</p>}
    {state === "verified" && <div className="auth-heading" role="status">
      <span className="eyebrow">Email</span>
      <h1><CheckCircle2 aria-hidden="true" className="invite-register-icon" />Email verified</h1>
      <p>Nook can now send you email about assignments, shares, and other updates. Choose which ones in Settings → Notifications.</p>
    </div>}
    {(state === "expired" || state === "invalid" || state === "error") && <div className="auth-heading" role="alert">
      <span className="eyebrow">Email</span>
      <h1><Link2Off aria-hidden="true" className="invite-register-icon" />{state === "expired" ? "This link expired" : state === "invalid" ? "This link is not valid" : "Could not verify your email"}</h1>
      <p>{state === "error" ? message : state === "expired" ? "Send a new one from Settings → Notifications." : "It may have been used already or copied incompletely. Send a new one from Settings → Notifications."}</p>
    </div>}
    {state !== "working" && <div className="auth-form"><button type="button" className="primary-button" onClick={onContinue}>{signedIn ? "Open Nook" : "Sign in"}</button></div>}
  </Card>;
}

/**
 * After "Turn off". The server answers 200 for any token (no oracle for a guessed or stale link),
 * so the page cannot know the switch changed and says so neutrally, with the way to check (L5).
 */
export function UnsubscribeDone({ label, onManage }: { label: string; onManage: () => void }) {
  return <div className="auth-heading" role="status">
    <span className="eyebrow">Email</span>
    <h1><CheckCircle2 aria-hidden="true" className="invite-register-icon" />Request received</h1>
    <p>If this link is current, “{label}” emails are now off. Check <a href={settingsPath("notifications")} onClick={(event) => { event.preventDefault(); onManage(); }}>Settings → Notifications → Email</a> to be sure.</p>
    <p>You'll still see these in Nook. Security emails keep coming.</p>
  </div>;
}

export function UnsubscribePage({ token, onContinue, onManage }: { token: string | null; onContinue: () => void; onManage: () => void }) {
  const category = token ? unsubscribeCategory(token) : null;
  const label = category ? CATEGORY_LABELS[category] : null;
  const [state, setState] = useState<"confirm" | "working" | "done" | "error">("confirm");
  useEffect(() => { document.title = "Email settings · Nook"; }, []);
  async function turnOff() {
    if (!token) return;
    setState("working");
    try {
      const response = await fetch(`/api/mail/unsubscribe?t=${encodeURIComponent(token)}`, { method: "POST", credentials: "omit" });
      setState(response.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }
  if (!token || !label) return <Card>
    <div className="auth-heading" role="alert">
      <span className="eyebrow">Email</span>
      <h1><Link2Off aria-hidden="true" className="invite-register-icon" />This link is not valid</h1>
      <p>Open the full link from the email, or change what Nook sends you in Settings → Notifications.</p>
    </div>
    <div className="auth-form">
      <button type="button" className="primary-button" onClick={onManage}>Manage email settings</button>
      <button type="button" className="text-button" onClick={onContinue}>Open Nook</button>
    </div>
  </Card>;
  return <Card>
    {state === "done" ? <UnsubscribeDone label={label} onManage={onManage} /> : <div className="auth-heading">
      <span className="eyebrow">Email</span>
      <h1><MailX aria-hidden="true" className="invite-register-icon" />Turn off “{label}” emails?</h1>
      <p>You'll still see these in Nook. Security emails keep coming.</p>
      {state === "error" && <p className="form-error" role="alert">Could not save that. Try again, or use Settings → Notifications.</p>}
    </div>}
    <div className="auth-form">
      {state !== "done" && <button type="button" className="primary-button" disabled={state === "working"} onClick={() => { void turnOff(); }}>{state === "working" ? "Turning off…" : "Turn off"}</button>}
      <button type="button" className={state === "done" ? "primary-button" : "secondary-button"} onClick={onManage}>Manage all email settings</button>
    </div>
  </Card>;
}
