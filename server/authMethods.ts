import type { Context } from "hono";
import { googleAuthEnabled, passwordAuthEnabled } from "./config";

/**
 * Server-side enforcement of AUTH_METHODS (Wave 35, D295). The UI hides what is off; these answers
 * make sure a hand-made request cannot use it anyway. Stable codes, instance facts only.
 */

export const PASSWORD_SIGNIN_DISABLED = { error: "This Nook signs people in with Google only.", code: "PASSWORD_SIGNIN_DISABLED" } as const;
export const GOOGLE_SIGNIN_DISABLED = { error: "Not found", code: "GOOGLE_SIGNIN_DISABLED" } as const;

/** 403 PASSWORD_SIGNIN_DISABLED while AUTH_METHODS=google, else null. */
export function passwordMethodRefusal(c: Context) {
  return passwordAuthEnabled() ? null : c.json(PASSWORD_SIGNIN_DISABLED, 403);
}

/** 404 GOOGLE_SIGNIN_DISABLED while Google sign-in is off, else null. */
export function googleMethodRefusal(c: Context) {
  return googleAuthEnabled() ? null : c.json(GOOGLE_SIGNIN_DISABLED, 404);
}
