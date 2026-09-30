/**
 * The confirm for leaving an API key that is shown only once (C1): switching Settings section, or
 * leaving the Settings page (Home, Bin, sign-out, Back or Forward); and (Wave 36 review R4) leaving an
 * integration's page in Team → Integrations with its new key still on screen. Closing the browser tab
 * is not guarded. ("close" is the wording from when Settings was a dialog.)
 */
export function unsavedKeyConfirm(action: "close" | "section" | "leave" | "integration") {
  const where = action === "section" ? "Leave this section" : action === "close" ? "Close Settings" : action === "integration" ? "Leave this integration" : "Leave Settings";
  return {
    title: "Leave without saving the key?",
    message: `This API key is shown only once. ${where} without copying it? You would have to rotate or create a key again.`,
    confirmLabel: action === "section" ? "Leave section" : action === "close" ? "Close without saving" : "Leave without saving",
    danger: true
  };
}
