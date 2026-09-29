import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureCookie } from "../auth";
import { db } from "../db";
import { randomToken, sha256Hex } from "./oidc";

/**
 * The server half of a Google round trip (Wave 35, D291, T250, T251). The browser holds only a random
 * binding token in an HttpOnly, SameSite=Lax cookie scoped to /api/auth/google; the row is keyed by
 * its SHA-256 and holds the state hash, nonce, PKCE verifier, intent, return path, and for invites
 * the invite token's hash. Rows are single use and short-lived.
 */

export const FLOW_COOKIE = "nook_google_flow";
const FLOW_PATH = "/api/auth/google";
export const FLOW_TTL_MS = 10 * 60_000;
export const SECOND_FACTOR_TTL_MS = 5 * 60_000;
export const SECOND_FACTOR_ATTEMPTS = 5;

export type FlowIntent = "signin" | "invite" | "link" | "reauth";
export type FlowRow = {
  id: string;
  state_hash: string;
  nonce: string;
  code_verifier: string;
  intent: FlowIntent;
  stage: "prepared" | "authorize" | "second_factor";
  return_to: string;
  invite_hash: string | null;
  user_id: string | null;
  session_id: string | null;
  failures: number;
  client_hash: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

function setFlowCookie(c: Context, token: string, ttlMs: number) {
  setCookie(c, FLOW_COOKIE, token, { httpOnly: true, secure: secureCookie(c), sameSite: "Lax", path: FLOW_PATH, maxAge: Math.floor(ttlMs / 1000) });
}

export function clearFlowCookie(c: Context) {
  deleteCookie(c, FLOW_COOKIE, { path: FLOW_PATH, secure: secureCookie(c), sameSite: "Lax" });
}

type NewFlow = { intent: FlowIntent; stage: FlowRow["stage"]; returnTo: string; inviteHash?: string | null; userId?: string | null; sessionId?: string | null; ttlMs?: number; clientHash?: string | null };

/** Live (unused, unexpired) flows one client holds at most (L4): a cap per client, not a global one. */
export const LIVE_FLOWS_PER_CLIENT = 10;
export function liveFlowsForClient(clientHash: string, nowMs = Date.now()) {
  return (db.query("SELECT COUNT(*) AS count FROM google_auth_flows WHERE client_hash = ? AND used_at IS NULL AND expires_at > ?").get(clientHash, new Date(nowMs).toISOString()) as { count: number }).count;
}

/**
 * Inserts a flow and sets its cookie (replacing any earlier flow cookie of this browser). For the
 * `authorize` stage it returns the state, nonce, and verifier to send to Google; only the state's
 * hash is stored.
 */
export function createFlow(c: Context, input: NewFlow) {
  const token = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const ttlMs = input.ttlMs ?? FLOW_TTL_MS;
  const nowMs = Date.now();
  db.query(`INSERT INTO google_auth_flows (id, state_hash, nonce, code_verifier, intent, stage, return_to, invite_hash, user_id, session_id, client_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sha256Hex(token), sha256Hex(state), nonce, verifier, input.intent, input.stage, input.returnTo,
    input.inviteHash ?? null, input.userId ?? null, input.sessionId ?? null, input.clientHash ?? null, new Date(nowMs).toISOString(), new Date(nowMs + ttlMs).toISOString()
  );
  setFlowCookie(c, token, ttlMs);
  return { state, nonce, verifier };
}

/** The live (unused, unexpired) flow behind this browser's cookie, or null. */
export function readFlow(c: Context, nowMs = Date.now()) {
  const token = getCookie(c, FLOW_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.query("SELECT * FROM google_auth_flows WHERE id = ?").get(sha256Hex(token)) as FlowRow | null;
  if (!row || row.used_at !== null || Date.parse(row.expires_at) <= nowMs) return null;
  return row;
}

/** Claims a flow: one guarded UPDATE, so a replay or a race finds it used (T251). */
export function claimFlow(id: string) {
  const at = new Date().toISOString();
  return db.query("UPDATE google_auth_flows SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(at, id, at).changes === 1;
}

/** Counts a wrong second-factor code; the flow ends at the fifth. Returns whether it is still live. */
export function countFlowFailure(id: string) {
  db.query("UPDATE google_auth_flows SET failures = failures + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT failures FROM google_auth_flows WHERE id = ?").get(id) as { failures: number } | null;
  if (!row || row.failures >= SECOND_FACTOR_ATTEMPTS) {
    claimFlow(id);
    return false;
  }
  return true;
}

/** Hourly: removes used flows and flows past their expiry. */
export function sweepGoogleFlows(nowMs = Date.now()) {
  return db.query("DELETE FROM google_auth_flows WHERE used_at IS NOT NULL OR expires_at <= ?").run(new Date(nowMs).toISOString()).changes;
}

/**
 * A same-origin return path (T253): one leading "/", no backslash, control character, or "//"; not
 * into /api/ or /login; at most 512 characters; re-parsed against a fixed base so it cannot name
 * another origin. Anything else is "/". The fragment is dropped.
 */
export function safeReturnPath(raw: string | null | undefined) {
  if (!raw || raw.length > 512 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, "http://nook.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "http://nook.invalid") return "/";
  const path = `${url.pathname}${url.search}`;
  if (path.startsWith("//") || path === "/api" || path.startsWith("/api/") || path === "/login" || path.startsWith("/login/") || path.startsWith("/login?")) return "/";
  return path;
}
