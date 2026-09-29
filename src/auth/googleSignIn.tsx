/**
 * "Continue with Google" on the client (Wave 35, D300). The browser only navigates: to our own
 * /api/auth/google/start, which redirects to Google, and back through our callback. No Google script
 * and no off-origin request, so the CSP stays as it is. Results come back in the URL fragment as
 * codes only (`/login#error=…`, `/login#google=code`, `/settings/…#google=…`), are read once, and
 * are stripped from the address bar at once.
 */

import "./auth.css";

export type GoogleIntent = "signin" | "link" | "reauth";

/** The start URL. `returnTo` is a same-origin path; the server validates it again (T253). */
export function googleStartUrl(intent: GoogleIntent, returnTo: string) {
  const params = new URLSearchParams();
  if (intent !== "signin") params.set("intent", intent);
  if (returnTo && returnTo !== "/") params.set("return", returnTo);
  const query = params.toString();
  return `/api/auth/google/start${query ? `?${query}` : ""}`;
}

/** Where to come back after signing in: the page the visitor was on, never the sign-in pages. */
export function currentReturnPath(location: Pick<Location, "pathname" | "search"> = window.location) {
  const path = `${location.pathname}${location.search}`;
  if (!path.startsWith("/") || path.startsWith("//") || /^\/(login|register|forgot-password|reset-password)(\/|\?|$)/.test(path)) return "/";
  return path;
}

export type GoogleSignInResult = { kind: "error"; code: string; domain?: string } | { kind: "code" } | null;

/** Q1: `link_not_authoritative` carries the address's domain (a host name, checked here). */
function domainParam(params: URLSearchParams) {
  const domain = params.get("domain")?.toLowerCase() ?? "";
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : undefined;
}

/** Reads `/login#error=<code>` or `/login#google=code` once and replaces the URL with `/`. */
export function takeGoogleSignInResult(location: Pick<Location, "pathname" | "hash"> = window.location, history: Pick<History, "replaceState"> = window.history): GoogleSignInResult {
  if (location.pathname !== "/login" && location.pathname !== "/login/") return null;
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  history.replaceState(null, "", "/");
  const error = params.get("error");
  if (error && /^[a-z_]{1,32}$/.test(error)) return { kind: "error", code: error, domain: domainParam(params) };
  if (params.get("google") === "code") return { kind: "code" };
  return null;
}

let initialSignIn: GoogleSignInResult | undefined;
/** The result on the page's first URL, read once per page load (safe under React's double render). */
export function initialGoogleSignInResult() {
  if (initialSignIn === undefined) initialSignIn = takeGoogleSignInResult();
  return initialSignIn;
}

export type GoogleSettingsResult = { kind: "linked" | "reauthed" } | { kind: "error"; code: string; domain?: string } | null;

/**
 * Reads `#google=linked|reauthed` or `#google-error=<code>` once and strips it: on a Settings URL
 * (any section, Q2), or on Team → member when `prefix` is "/team/" (an admin's re-authentication).
 */
export function takeGoogleSettingsResult(location: Pick<Location, "pathname" | "search" | "hash"> = window.location, history: Pick<History, "state" | "replaceState"> = window.history, prefix = "/settings"): GoogleSettingsResult {
  if (!location.pathname.startsWith(prefix) || !location.hash) return null;
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const ok = params.get("google");
  const error = params.get("google-error");
  if (!ok && !error) return null;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  if (ok === "linked" || ok === "reauthed") return { kind: ok };
  if (error && /^[a-z_]{1,32}$/.test(error)) return { kind: "error", code: error, domain: domainParam(params) };
  return null;
}

let initialSettings: GoogleSettingsResult | undefined;
export function initialGoogleSettingsResult() {
  if (initialSettings === undefined) initialSettings = takeGoogleSettingsResult();
  return initialSettings;
}

let initialTeam: GoogleSettingsResult | undefined;
/** The result of an admin's Google confirmation that came back to Team → member, read once per page load. */
export function initialGoogleTeamResult() {
  if (initialTeam === undefined) initialTeam = typeof window === "undefined" ? null : takeGoogleSettingsResult(window.location, window.history, "/team/");
  return initialTeam;
}

const MESSAGES: Record<string, string> = {
  denied: "Google sign-in was cancelled.",
  expired: "That sign-in took too long or was already used. Try again.",
  // QA G1d: the round trip expired or was pushed out by other sign-ins; an invite stays usable.
  flow_expired: "That took too long. Continue with Google again.",
  failed: "Google sign-in did not complete. Try again.",
  unverified: "Google has not verified this account's email address, so it cannot be used here.",
  not_allowed: "This Google account cannot sign in to this Nook. Ask your admin.",
  signup_closed: "No Nook account uses this Google address, and new accounts need an invite. Ask your admin for one.",
  blocked: "This account has been blocked. Contact your Nook administrator.",
  invite_invalid: "This invite link is not valid. It may have been used already. Ask your admin for a new link.",
  invite_expired: "This invite link has expired. Ask your admin for a new link.",
  invite_mismatch: "This invite is for a different email address. Continue with the Google account for that address.",
  already_linked: "This Nook account is linked to a different Google account.",
  link_mismatch: "Choose the Google account for this Nook account's email address, managed by Google: a Gmail address, or a Google Workspace account on the address's own domain. A personal Google account that only uses the address does not count.",
  reauth_mismatch: "Confirm with the Google account that is linked to this Nook account.",
  reauth_stale: "Google did not ask for your password again, so this does not count as a confirmation. Try again and sign in to Google when asked.",
  link_required: linkRequiredText(true),
  rate_limited: "Too many attempts. Try again soon."
};

export const googleErrorMessage = (code: string, domain?: string) =>
  code === "link_not_authoritative" ? linkNotAuthoritativeText(domain) : MESSAGES[code] ?? MESSAGES.failed!;

/**
 * Q1: the address is right, but Google does not say this Google account manages it (a personal Google
 * account using a company address, or a Workspace account of another domain). An admin's allowance
 * cannot change that; the allowance waits for the right account.
 */
export function linkNotAuthoritativeText(domain?: string) {
  const name = domain ?? "the address's domain";
  return `Google cannot confirm this Google account is managed by ${name}. Use a Google Workspace account of ${name}, or the Gmail account itself for a Gmail address.`;
}

/** Added on the sign-in page when passwords are on (Q1). */
export const LINK_NOT_AUTHORITATIVE_PASSWORD = " Or sign in with your password.";

/**
 * `link_required` (review HIGH-1): a Nook account uses this Google address, but Nook never confirmed
 * the address (or Google does not manage it), so Google may not link it on its own. It says nothing
 * the person holding the address does not already know.
 */
export function linkRequiredText(passwordOn: boolean) {
  return passwordOn
    ? "Google cannot link to it on its own. If you know its password, sign in with it below, then choose Settings → Security → Link Google. Otherwise ask your Nook admin to allow Google sign-in for your account."
    : "Google cannot link to it on its own. Ask your Nook admin to allow Google sign-in for your account, then continue with Google again.";
}

/** Google's four-colour "G", inline so nothing is fetched from Google (D300). */
export function GoogleMark() {
  return <svg className="google-mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>;
}

/** The branded button. It navigates (full page) to our own start URL, never to Google directly. */
export function GoogleButton({ label = "Continue with Google", href, onClick, disabled }: { label?: string; href?: string; onClick?: () => void; disabled?: boolean }) {
  if (href && !onClick) return <a className="google-button" href={href}><GoogleMark /><span>{label}</span></a>;
  return <button type="button" className="google-button" onClick={onClick} disabled={disabled}><GoogleMark /><span>{label}</span></button>;
}

/** QA U5: under the button when this Nook signs people in with Google only. */
export const GOOGLE_ONLY_HINT = "This Nook signs people in with Google. Use the Google account with your Nook email address. If that does not work, ask your admin.";

/** QA U1: the password pages and forms when passwords are off. */
export const GOOGLE_ONLY_PASSWORD_TEXT = "This Nook signs people in with Google only, so there are no passwords to set or reset here.";

/** The "or" rule between Google and the password form. */
export function AuthDivider() {
  return <div className="auth-divider" role="separator"><span>or</span></div>;
}
