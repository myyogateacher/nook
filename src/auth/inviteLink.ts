/**
 * The invite link (docs/plan/WAVES_18-20_SMALL.md §1.6, Director ruling): `/register#invite=<token>`.
 * The token sits in the URL fragment, which browsers never send to the server, and the SPA strips
 * it from the address bar right after reading it, so it stays out of history too (T136).
 */
export const REGISTER_PATH = "/register";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isRegisterPath = (pathname: string) => pathname === REGISTER_PATH || pathname === `${REGISTER_PATH}/`;

/** The token in `#invite=…`, or null when there is none or it is malformed. Pure. */
export function inviteTokenFromHash(hash: string) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("invite");
  return token && TOKEN.test(token) ? token : null;
}

/**
 * Reads the invite from the current location once and strips the fragment with `replaceState`
 * (the history entry keeps its state, only the URL changes). Returns null off /register.
 */
export function takeInviteFromLocation(location: Pick<Location, "pathname" | "hash"> = window.location, history: Pick<History, "state" | "replaceState"> = window.history) {
  if (!isRegisterPath(location.pathname)) return { onRegister: false, token: null };
  const token = inviteTokenFromHash(location.hash);
  if (location.hash) history.replaceState(history.state, "", REGISTER_PATH);
  return { onRegister: true, token };
}

let initial: ReturnType<typeof takeInviteFromLocation> | null = null;

/**
 * The invite on the page's first URL, read (and stripped) once per page load. Cached, so React's
 * development double render cannot read the already-stripped URL and lose the token.
 */
export function initialInvite() {
  initial ??= takeInviteFromLocation();
  return initial;
}
