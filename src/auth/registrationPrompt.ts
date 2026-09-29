/** What /api/about says about signing up (QA note 13): yes/no flags, never a user count. */
export type RegistrationInfo = { hasUsers?: boolean; openRegistration?: boolean; /** Wave 35 (D295): which sign-in methods are on; older servers leave it out. */ authMethods?: { password: boolean; google: boolean } };

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
