import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { api } from "../api";
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
  /** The proof a re-authentication asks for: the password, a Google confirmation, or none possible. */
  reauth: "password" | "google" | "none";
  /** Until when this session's Google confirmation counts, or null. */
  reauthUntil: string | null;
  /** Email is on, so Forgot password can add or reset a password. */
  passwordReset: boolean;
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
 * In place of a password field: "Confirm with Google" (a round trip that comes back to `returnTo`),
 * or the confirmation's expiry once it is done, or a note when nothing can confirm this account.
 */
export function GoogleReauthNotice({ account, returnTo, startable = true }: { account: AccountAuth; returnTo: string; /** False inside a form with typed content (QA U11): confirm before opening it instead. */ startable?: boolean }) {
  if (account.reauth === "none") {
    return <p className="reauth-note" role="note">This account has no password on this Nook and no linked Google account, so it cannot confirm changes here. Link Google under Security, or ask your admin.</p>;
  }
  if (googleConfirmed(account)) {
    const until = new Date(account.reauthUntil!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return <p className="reauth-note reauth-done" role="status"><Check aria-hidden="true" />Confirmed with Google until {until}.</p>;
  }
  if (!startable) return <p className="reauth-note" role="note"><ShieldCheck aria-hidden="true" />Your Google confirmation ran out. Close this, confirm with Google again, then start over.</p>;
  return <div className="reauth-google">
    <p className="reauth-note"><ShieldCheck aria-hidden="true" />Confirm it's you with Google{account.google ? ` (${account.google.email})` : ""} first. It counts for 5 minutes on this device.</p>
    <GoogleButton label="Confirm with Google" href={googleStartUrl("reauth", returnTo)} />
  </div>;
}
