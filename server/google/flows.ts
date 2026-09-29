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
  /** Why an unfinished flow ended early: "evicted" (a cap made room) or "replaced" (a newer flow for the same invite). */
  ended_reason?: string | null;
};

function setFlowCookie(c: Context, token: string, ttlMs: number) {
  setCookie(c, FLOW_COOKIE, token, { httpOnly: true, secure: secureCookie(c), sameSite: "Lax", path: FLOW_PATH, maxAge: Math.floor(ttlMs / 1000) });
}

export function clearFlowCookie(c: Context) {
  deleteCookie(c, FLOW_COOKIE, { path: FLOW_PATH, secure: secureCookie(c), sameSite: "Lax" });
}

type NewFlow = { intent: FlowIntent; stage: FlowRow["stage"]; returnTo: string; inviteHash?: string | null; userId?: string | null; sessionId?: string | null; ttlMs?: number; clientHash?: string | null };

/**
 * Caps on unfinished flows (L4, N1, QA G1). At a cap the oldest flow of the right class is evicted;
 * a new flow is never refused, since behind a proxy with TRUSTED_PROXY_HOPS=0 every visitor shares
 * one address and refusing would let anyone stop everyone's sign-in. Eviction runs inside
 * `createFlow`, after the request has claimed the prepared flow it uses, so the flow a request is
 * about to use is never evicted.
 *
 * - `authorize` flows: at most 50 per client address. Anonymous sign-ins (intent `signin`, cheap to
 *   create) go first, oldest first; other `authorize` flows (invite, link, re-auth) only when no
 *   anonymous one is left.
 * - `prepared` flows (need a valid invite token or a signed-in, re-authenticated session): their own
 *   cap of 20 per client address, evicted only among themselves; one live prepared flow per invite
 *   (a new one replaces the old); at most 3 per session for Settings links.
 * - Re-auth and link `authorize` flows: at most 3 per session.
 * - `second_factor` flows (Google already said yes) are never evicted and count toward no cap.
 */
export const LIVE_FLOWS_PER_CLIENT = 50;
export const PREPARED_FLOWS_PER_CLIENT = 20;
export const FLOWS_PER_SESSION = 3;

function endFlows(ids: string[], reason: "evicted" | "replaced", at: string) {
  const end = db.query("UPDATE google_auth_flows SET used_at = ?, ended_reason = ? WHERE id = ? AND used_at IS NULL");
  let changes = 0;
  for (const id of ids) changes += end.run(at, reason, id).changes;
  return changes;
}

/** Ends the oldest live flows matching `where` until at most `keep` remain; `order` ranks classes (kept first). */
function trimFlows(where: string, params: Array<string>, keep: number, order: string | null, at: string) {
  const ids = (db.query(`SELECT id FROM google_auth_flows WHERE ${where} AND used_at IS NULL AND expires_at > ? ORDER BY ${order ? `${order}, ` : ""}created_at DESC, rowid DESC`)
    .all(...params, at) as Array<{ id: string }>).map((row) => row.id);
  // The list runs from the most worth keeping to the least; everything past `keep` goes.
  return endFlows(ids.slice(Math.max(0, keep)), "evicted", at);
}

/** Makes room for one more flow of this kind (see above); returns how many flows were evicted. */
export function makeRoomForFlow(input: { stage: FlowRow["stage"]; clientHash?: string | null; sessionId?: string | null; inviteHash?: string | null }, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  let evicted = 0;
  if (input.stage === "second_factor") return 0;
  if (input.stage === "prepared") {
    if (input.inviteHash) {
      const same = (db.query("SELECT id FROM google_auth_flows WHERE stage = 'prepared' AND invite_hash = ? AND used_at IS NULL AND expires_at > ?").all(input.inviteHash, at) as Array<{ id: string }>).map((row) => row.id);
      endFlows(same, "replaced", at);
    }
    if (input.sessionId) evicted += trimFlows("stage = 'prepared' AND session_id = ?", [input.sessionId], FLOWS_PER_SESSION - 1, null, at);
    if (input.clientHash) evicted += trimFlows("stage = 'prepared' AND client_hash = ?", [input.clientHash], PREPARED_FLOWS_PER_CLIENT - 1, null, at);
    return evicted;
  }
  if (input.sessionId) evicted += trimFlows("stage = 'authorize' AND session_id = ?", [input.sessionId], FLOWS_PER_SESSION - 1, null, at);
  // Keep order: non-anonymous first (kept longest), then anonymous sign-ins; newest first within each.
  if (input.clientHash) evicted += trimFlows("stage = 'authorize' AND client_hash = ?", [input.clientHash], LIVE_FLOWS_PER_CLIENT - 1, "CASE intent WHEN 'signin' THEN 1 ELSE 0 END", at);
  return evicted;
}

/** Test and diagnostics: live flows of one stage for a client address. */
export function liveFlowsForClient(clientHash: string, stage: FlowRow["stage"] = "authorize", nowMs = Date.now()) {
  return (db.query("SELECT COUNT(*) AS count FROM google_auth_flows WHERE client_hash = ? AND stage = ? AND used_at IS NULL AND expires_at > ?").get(clientHash, stage, new Date(nowMs).toISOString()) as { count: number }).count;
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
  makeRoomForFlow(input, nowMs);
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

/**
 * Why this browser's flow cookie no longer finds a live flow (QA G1d): "gone" (no cookie, no row, or a
 * normal single use: T251 answers `expired` as before), or "ended" (the flow expired, was evicted at a
 * cap, or was replaced), which the pages explain as "That took too long" and, for an invite, recover.
 */
export function endedFlow(c: Context, nowMs = Date.now()): FlowRow | null {
  const token = getCookie(c, FLOW_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.query("SELECT * FROM google_auth_flows WHERE id = ?").get(sha256Hex(token)) as FlowRow | null;
  if (!row) return null;
  const ended = row.used_at !== null ? row.ended_reason === "evicted" || row.ended_reason === "replaced" : Date.parse(row.expires_at) <= nowMs;
  return ended ? row : null;
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
