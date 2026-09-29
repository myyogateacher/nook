/**
 * What /api/about says about signing up (QA note 13): yes/no flags, never a user count.
 * `passwordReset` (Wave 30): whether "Forgot password?" can mail a link (email on).
 * `authMethods` (Wave 35, D295): which sign-in methods are on; older servers leave it out.
 */
export type RegistrationInfo = { hasUsers?: boolean; openRegistration?: boolean; passwordReset?: boolean; authMethods?: { password: boolean; google: boolean } };

/**
 * Whether to offer "Forgot password?" or "Ask for a new link" (v0.13.0 QA, A6): not while /about is
 * still loading, never when it says email is off, and (as the forgot page does) yes when it failed.
 */
export function passwordResetOffered(info: RegistrationInfo | null | "failed") {
  if (info === "failed") return true;
  return info !== null && info.passwordReset !== false;
}

/**
 * The login screen's switch to the registration form: "Create the first account" only on a fresh
 * instance, "Create an account" when registration is open, and nothing otherwise (people join by
 * invite link). Unknown (the request failed or an older server) shows nothing.
 */
export function registrationPrompt(info: RegistrationInfo | null): string | null {
  if (!info || typeof info.hasUsers !== "boolean") return null;
  if (!info.hasUsers) return "Setting up Nook? Create the first account";
  return info.openRegistration ? "New here? Create an account" : null;
}
