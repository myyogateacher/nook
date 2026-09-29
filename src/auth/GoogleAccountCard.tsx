import { useEffect, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { KeysDialog } from "../keys/KeysDialog";
import type { AccountAuth } from "./accountAuth";
import { GoogleButton, GoogleMark, googleErrorMessage, googleStartUrl, type GoogleSettingsResult } from "./googleSignIn";
import "./auth.css";

/** The line Settings shows after a Google round trip came back to it (D300). */
export function googleSettingsNotice(result: GoogleSettingsResult): { tone: "ok" | "error"; text: string } | null {
  if (!result) return null;
  if (result.kind === "linked") return { tone: "ok", text: "Google sign-in is linked. You can now sign in with Google." };
  if (result.kind === "reauthed") return { tone: "ok", text: "Confirmed with Google. Finish the change within 5 minutes." };
  return result.kind === "error" ? { tone: "error", text: googleErrorMessage(result.code) } : null;
}

/**
 * Settings → Security → Google sign-in (Wave 35, D300): the linked address and Unlink, or Link
 * Google. Linking is a round trip that comes back here (`#google=linked`); the Google address must be
 * this account's address. Unlink is offered only while a password can still sign in.
 */
export function GoogleAccountCard({ account, onChanged, onDialogChange }: {
  account: AccountAuth;
  onChanged: () => void;
  onDialogChange?: (open: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  useEffect(() => { onDialogChange?.(confirming); }, [confirming, onDialogChange]);

  if (!account.methods.google) return null;
  const canUnlink = account.google !== null && account.methods.password && account.hasPassword;

  async function unlink() {
    setBusy(true);
    setError("");
    try {
      await api("/auth/google", { method: "DELETE", body: "{}" });
      setConfirming(false);
      setDone("Google sign-in was unlinked. Sign in with your email and password from now on.");
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not unlink Google");
    } finally {
      setBusy(false);
    }
  }

  return <div className="security-card google-account-card">
    <div className="password-change-summary">
      <span className="settings-icon google-account-icon" aria-hidden="true"><GoogleMark /></span>
      <div>
        <strong>Google sign-in</strong>
        {account.google
          ? <small>Signed in with Google ({account.google.email}).{canUnlink ? "" : account.methods.password ? " Add a password before you unlink it, so you can still sign in." : ""}</small>
          : <small>Link the Google account with this address to sign in with Google.</small>}
      </div>
      {account.google
        ? canUnlink && <button type="button" className="secondary-button" onClick={() => { setError(""); setDone(""); setConfirming(true); }}>Unlink</button>
        : <GoogleButton label="Link Google" href={googleStartUrl("link", "/settings/security")} />}
    </div>
    {done && <p className="password-change-done" role="status"><Check aria-hidden="true" />{done}</p>}
    {error && <p className="form-error" role="alert"><TriangleAlert aria-hidden="true" className="inline-icon" />{error}</p>}
    {confirming && <KeysDialog title="Unlink Google?" description="You will sign in with your email and password only." onClose={() => setConfirming(false)} busy={busy}
      footer={<>
        <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        <button type="button" className="danger-button" onClick={() => void unlink()} disabled={busy}>{busy ? "Unlinking…" : "Unlink Google"}</button>
      </>}>
      <p className="google-unlink-copy">Your Google profile picture is removed too. You can link Google again at any time.</p>
    </KeysDialog>}
  </div>;
}

/** Settings → Security → Password when the account cannot use the change form (D294, D295). */
export function PasswordStateCard({ account }: { account: AccountAuth }) {
  const text = !account.methods.password
    ? "This Nook signs people in with Google only, so passwords are not used."
    : account.passwordReset
      ? "This account signs in with Google and has no password. To add one, sign out and use “Forgot password?” on the sign-in page; the link goes to your address."
      : "This account signs in with Google and has no password. Email is not set up on this Nook, so ask your admin if you need one.";
  return <div className="security-card password-change-card">
    <div className="password-change-summary">
      <div><strong>Password</strong><small>{text}</small></div>
    </div>
  </div>;
}
