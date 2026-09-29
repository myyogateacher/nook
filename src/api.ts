let csrfToken = "";

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public payload?: unknown) {
    super(message);
  }
}

/**
 * Wave 23 QA F1: whether the last request failed at the network (or with a 5xx), and who wants to
 * know when a request succeeds again. Some browsers never fire `online` (phone emulation, some real
 * phones); the first successful response after a failure is the next best sign the network is back.
 */
let lastRequestFailed = false;
const recoveredListeners = new Set<() => void>();
export function onApiRecovered(listener: () => void) {
  recoveredListeners.add(listener);
  return () => { recoveredListeners.delete(listener); };
}
/** Records one request's outcome; after a failure, the first success tells the listeners. Exported for tests. */
export function noteRequestOutcome(ok: boolean) {
  if (!ok) { lastRequestFailed = true; return; }
  if (!lastRequestFailed) return;
  lastRequestFailed = false;
  for (const listener of [...recoveredListeners]) {
    try { listener(); } catch { /* a listener's failure is its own */ }
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (csrfToken && options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, headers, credentials: "same-origin" });
  } catch (error) {
    noteRequestOutcome(false);
    throw error;
  }
  noteRequestOutcome(response.status < 500);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}
