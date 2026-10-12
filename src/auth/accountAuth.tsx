import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { api, ApiError } from "../api";
import { useConfirm } from "../ui/useConfirm";
import { GoogleButton, googleStartUrl } from "./googleSignIn";

/**
 * What Settings needs to know about how this account signs in and re-authenticates (Wave 35,
 * GET /api/auth/account, D297). Settings loads it once and shares it through a context, so the
 * Security section, the two-factor forms, and the API key dialogs ask for the right proof.
 */
export type AccountAuth = {
  methods: { password: boolean; google: boolean };
  hasPassword: boolean;
  google: { email: string } | null;
  /**
   * The proof a re-authentication shows first: a Google confirmation for any account with Google
   * linked (the password, if it has one, is the alternative), else the password, else none possible.
   */
  reauth: "password" | "google" | "none";
  /** Until when this session's Google confirmation counts, or null. */
  reauthUntil: string | null;
  /** Email is on, so Forgot password can add or reset a password. */
  passwordReset: boolean;
  /** The account has two-factor on, so re-authentication also asks for a code (older servers omit it). */
  twoFactor?: boolean;
};

export const AccountAuthContext = createContext<AccountAuth | null>(null);

/** Loads /api/auth/account; `null` while loading or on an older server (then everything behaves as before). */
export function useAccountAuthLoader() {
  const [account, setAccount] = useState<AccountAuth | null>(null);
  const reload = useCallback(() => {
    api<AccountAuth>("/auth/account").then(setAccount, () => setAccount(null));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { account, reload };
}

export const useAccountAuth = () => useContext(AccountAuthContext);

/** Whether a re-authentication form should show a password field (the default when unknown). */
export const asksForPassword = (account: AccountAuth | null) => !account || account.reauth === "password";

/** Whether this session's Google confirmation still counts. */
export const googleConfirmed = (account: AccountAuth | null, now = Date.now()) => Boolean(account?.reauthUntil && Date.parse(account.reauthUntil) > now);

/** The request's first factor: the typed password, or nothing when a Google confirmation stands in (D297). */
export function reauthPassword(value: FormDataEntryValue | string | null | undefined) {
  const password = typeof value === "string" ? value : "";
  return password ? { password } : {};
}

/**
 * The account confirms with Google first but also has a password it may use instead (operator
 * decision 2026-10-12: Google is shown first for every account with Google linked).
 */
export const passwordAlternative = (account: AccountAuth | null) => Boolean(account && account.reauth === "google" && account.methods.password && account.hasPassword);

/** Which proof a form uses: the password (the only way, or chosen with "Use password instead") or Google. */
export function useReauthRoute(account: AccountAuth | null) {
  const [chosePassword, setChosePassword] = useState(false);
  const alternative = passwordAlternative(account);
  return {
    viaPassword: asksForPassword(account) || (alternative && chosePassword),
    toggle: alternative ? () => setChosePassword((value) => !value) : null
  };
}

/** "Use password instead" / "Confirm with Google instead", for accounts that have both. */
export function ReauthRouteToggle({ viaPassword, onToggle, disabled }: { viaPassword: boolean; onToggle: (() => void) | null; disabled?: boolean }) {
  if (!onToggle) return null;
  return <button type="button" className="inline-auth-switch reauth-toggle" onClick={onToggle} disabled={disabled}>{viaPassword ? "Confirm with Google instead" : "Use password instead"}</button>;
}

/**
 * Whether the form asks for the two-factor code (2026-10-12): with two-factor on, on the password
 * route always; on the Google route only for actions that change the factors (`secondFactor`).
 */
export const asksForCode = (twoFactor: boolean, viaPassword: boolean, secondFactor = false) => twoFactor && (viaPassword || secondFactor);

/** The server's answer when this session's Google confirmation ran out (or was never done here). */
export const GOOGLE_REAUTH_REQUIRED = "GOOGLE_REAUTH_REQUIRED";
export const isGoogleReauthRequired = (reason: unknown) => reason instanceof ApiError && Boolean(reason.payload) && typeof reason.payload === "object" && (reason.payload as { code?: unknown }).code === GOOGLE_REAUTH_REQUIRED;

/** Re-renders when this session's Google confirmation runs out, so the form offers it again on time. */
function useConfirmationClock(until: string | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!until) return undefined;
    const left = Date.parse(until) - Date.now();
    if (left <= 0) return undefined;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.min(left + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [until]);
}

/**
 * In place of a password field: "Confirm with Google" (a round trip that comes back to `returnTo`),
 * or the confirmation's expiry once it is done, or a note when nothing can confirm this account.
 * `expired` (the server answered GOOGLE_REAUTH_REQUIRED) offers it again whatever the clock says.
 */
export function GoogleReauthNotice({ account, returnTo, startable = true, expired = false }: { account: AccountAuth; returnTo: string; /** False inside a form with typed content (QA U11): ask before leaving it. */ startable?: boolean; expired?: boolean }) {
  useConfirmationClock(account.reauthUntil);
  const { ask, confirmElement } = useConfirm();
  if (account.reauth === "none") {
    return <p className="reauth-note" role="note">This account has no password on this Nook and no linked Google account, so it cannot confirm changes here. Link Google under Security, or ask your admin.</p>;
  }
  if (!expired && googleConfirmed(account)) {
    const until = new Date(account.reauthUntil!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return <p className="reauth-note reauth-done" role="status"><Check aria-hidden="true" />Confirmed with Google until {until}. No password or code needed.</p>;
  }
  const href = googleStartUrl("reauth", returnTo);
  const again = expired || Boolean(account.reauthUntil);
  if (!startable) {
    // Inside a form with typed content: say what happens, then go (Back returns to this page).
    const leave = async () => {
      if (await ask({ title: "Confirm with Google?", message: "Google opens in this tab, and what you typed in this form is not kept. You come back here afterwards, confirmed for 5 minutes.", confirmLabel: "Continue to Google" })) window.location.assign(href);
    };
    return <div className="reauth-google">
      <p className="reauth-note" role="note"><ShieldCheck aria-hidden="true" />{again ? "Your Google confirmation ran out. Confirm with Google again, then fill this in once more." : "Confirm it's you with Google first. It counts for 5 minutes on this device."}</p>
      <GoogleButton label={again ? "Confirm with Google again" : "Confirm with Google"} onClick={() => { void leave(); }} />
      {confirmElement}
    </div>;
  }
  return <div className="reauth-google">
    <p className="reauth-note"><ShieldCheck aria-hidden="true" />{again ? "Your Google confirmation ran out. " : ""}Confirm it's you with Google{account.google ? ` (${account.google.email})` : ""}. If you are already signed in to Google, just pick the account. It counts for 5 minutes on this device.</p>
    <GoogleButton label={again ? "Confirm with Google again" : "Confirm with Google"} href={href} />
  </div>;
}
