import { createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { audit, db, now } from "../db";
import type { PublicChatSnapshot, PublicLinkState } from "../../shared/agents";
import { ownedChat, parseToolCalls, pathTo, type ChatRow } from "./chats";
import { readAgentSettings } from "./settings";
import { AgentError, agentsStatus } from "./status";

/**
 * Public chat links (Wave 43, AC-D, plan §6.2, D362, AC-O1, T315, T316): a frozen snapshot of the
 * branch on screen, reachable at `/share/c/<token>` by anyone with the link, behind the admin policy
 * `public_chat_links` (off by default; member and above create them).
 *
 * - The token is 32 random bytes (base64url, 43 characters), shown once; only its SHA-256 is stored
 *   (`chat_public_shares.token_hash`). "Update link" re-snapshots under the same token; "New link"
 *   replaces the token; Revoke deletes the row.
 * - The snapshot keeps names only: the chat's title, the agent's name, the owner's display name
 *   (never an email or an id), and each turn's text. Tool calls appear by name; their arguments and
 *   results only when the owner ticked "Include tool results". Later turns never appear until Update.
 * - Policy off: every route answers 404 at once, links included; rows are kept, so turning the policy
 *   back on brings them back. A binned chat (or a blocked owner, an owner demoted below member, or the module off) is a 404 too, and
 *   purging the chat deletes its row (the cascade).
 */

export const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SNAPSHOT_CAP = 2_000_000;

export const hashPublicToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Whether public links work right now: the module on and the policy on. */
export const publicLinksOn = () => agentsStatus().enabled && readAgentSettings().publicChatLinks;
/** Who may create one (AC-O1: member and above). */
export const roleMayPublish = (role: string) => role === "admin" || role === "member";

const shareRow = db.query("SELECT chat_id, include_tool_results, created_at, updated_at FROM chat_public_shares WHERE chat_id = ?");

function requirePublishable(role: string) {
  if (!publicLinksOn()) throw new AgentError(404, "NOT_FOUND", "Not found");
  if (!roleMayPublish(role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot create public links");
}

const stateOf = (row: { include_tool_results: number; created_at: string; updated_at: string } | null): PublicLinkState | null =>
  row ? { createdAt: row.created_at, updatedAt: row.updated_at, includeToolResults: row.include_tool_results === 1 } : null;

/** The owner's view of the chat's link (null when none). 404 with the policy off; only the owner. */
export function publicLinkFor(actor: { userId: string; role: string }, chatId: string): { link: PublicLinkState | null } {
  if (!publicLinksOn()) throw new AgentError(404, "NOT_FOUND", "Not found");
  ownedChat(chatId, actor.userId);
  return { link: stateOf(shareRow.get(chatId) as { include_tool_results: number; created_at: string; updated_at: string } | null) };
}

/** The owner's link state for the chat detail, or null (no link, or the policy off). */
export function publicLinkState(chatId: string): PublicLinkState | null {
  if (!publicLinksOn()) return null;
  return stateOf(shareRow.get(chatId) as { include_tool_results: number; created_at: string; updated_at: string } | null);
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The frozen snapshot of the chat's branch on screen, as the public page shows it. */
export function snapshotOf(chat: ChatRow, includeToolResults: boolean): PublicChatSnapshot {
  const ownerName = (db.query("SELECT display_name FROM users WHERE id = ?").get(chat.owner_id) as { display_name: string } | null)?.display_name ?? "A member";
  const agentName = chat.agent_id ? (db.query("SELECT name FROM agents WHERE id = ?").get(chat.agent_id) as { name: string } | null)?.name ?? null : null;
  const messages = pathTo(chat.id, chat.active_leaf_id)
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
      createdAt: row.created_at,
      toolCalls: parseToolCalls(row.tool_calls_json).map((call) => ({
        tool: call.tool, server: call.server, ok: call.ok,
        ...(includeToolResults ? { args: clip(call.argsPreview, 1024), result: call.resultPreview === null ? null : clip(call.resultPreview, 1024) } : {})
      }))
    }))
    .filter((message) => message.content.length > 0 || message.toolCalls.length > 0);
  const snapshot: PublicChatSnapshot = { version: 1, title: chat.title, agentName, ownerName, snapshotAt: now(), includeToolResults, truncated: false, messages };
  // Within the column's 2 MiB: the oldest turns go first (the page says so).
  while (JSON.stringify(snapshot).length > SNAPSHOT_CAP && snapshot.messages.length > 1) {
    snapshot.messages.shift();
    snapshot.truncated = true;
  }
  if (JSON.stringify(snapshot).length > SNAPSHOT_CAP) snapshot.messages = [{ ...snapshot.messages[0]!, content: clip(snapshot.messages[0]!.content, 200_000) }];
  return snapshot;
}

export const publicUrl = (token: string) => `${config.appOrigin}/share/c/${token}`;

/**
 * Create or update the chat's public link (owner only). Creating answers the URL once; Update
 * (`newLink` false on an existing link) re-snapshots under the same token and answers no URL;
 * `newLink` replaces the token, so the old link stops working at once.
 */
export function upsertPublicLink(actor: { userId: string; role: string }, chatId: string, input: { includeToolResults: boolean; newLink?: boolean }): { link: PublicLinkState; url: string | null } {
  requirePublishable(actor.role);
  return db.transaction(() => {
    const chat = ownedChat(chatId, actor.userId);
    const snapshot = JSON.stringify(snapshotOf(chat, input.includeToolResults));
    const timestamp = now();
    const existing = shareRow.get(chatId) as { chat_id: string } | null;
    let url: string | null = null;
    if (!existing || input.newLink) {
      const token = randomBytes(32).toString("base64url");
      url = publicUrl(token);
      db.query(`INSERT INTO chat_public_shares (chat_id, token_hash, snapshot_json, include_tool_results, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET token_hash = excluded.token_hash, snapshot_json = excluded.snapshot_json, include_tool_results = excluded.include_tool_results,
          created_by = excluded.created_by, created_at = excluded.created_at, updated_at = excluded.updated_at`)
        .run(chatId, hashPublicToken(token), snapshot, input.includeToolResults ? 1 : 0, actor.userId, timestamp, timestamp);
    } else {
      db.query("UPDATE chat_public_shares SET snapshot_json = ?, include_tool_results = ?, updated_at = ? WHERE chat_id = ?").run(snapshot, input.includeToolResults ? 1 : 0, timestamp, chatId);
    }
    audit(actor.userId, null, existing ? (input.newLink ? "agents.chat.public_replace" : "agents.chat.public_update") : "agents.chat.public_create", { chatId, includeToolResults: input.includeToolResults });
    return { link: stateOf(shareRow.get(chatId) as { include_tool_results: number; created_at: string; updated_at: string })!, url };
  })();
}

/** Revoke: deletes the row; the link answers 404 from then on. */
export function revokePublicLink(actor: { userId: string; role: string }, chatId: string) {
  if (!publicLinksOn()) throw new AgentError(404, "NOT_FOUND", "Not found");
  ownedChat(chatId, actor.userId);
  const removed = db.query("DELETE FROM chat_public_shares WHERE chat_id = ?").run(chatId).changes;
  if (!removed) throw new AgentError(404, "NOT_FOUND", "Not found");
  audit(actor.userId, null, "agents.chat.public_revoke", { chatId });
  return { ok: true as const };
}

/**
 * The snapshot a token opens now, or null (unknown, revoked, policy off, the chat binned, the owner blocked,
 * or the owner no longer in a role that may publish: review L3, so a demotion closes the link and a re-promotion reopens it).
 */
export function readPublicShare(token: string): PublicChatSnapshot | null {
  if (!PUBLIC_TOKEN.test(token) || !publicLinksOn()) return null;
  const row = db.query(`SELECT s.snapshot_json FROM chat_public_shares s JOIN chats c ON c.id = s.chat_id JOIN users u ON u.id = c.owner_id
    WHERE s.token_hash = ? AND c.deleted_at IS NULL AND u.disabled_at IS NULL AND u.role IN ('admin','member')`).get(hashPublicToken(token)) as { snapshot_json: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.snapshot_json) as PublicChatSnapshot;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------ the per-address limit

/** 60 requests a minute per address (sliding window of two fixed minutes), for the page and its API. */
export const PUBLIC_LIMIT = { perMinute: 60 } as const;
const windows = new Map<string, { start: number; count: number; previous: number }>();
let limitClock: () => number = Date.now;
let checks = 0;

/** Counts one request; returns the seconds to wait when over the limit, else 0. */
export function publicShareLimited(bucket: string, address: string, nowMs = limitClock()): number {
  const key = `${bucket}:${address}`;
  const minute = Math.floor(nowMs / 60_000) * 60_000;
  let entry = windows.get(key);
  if (!entry || entry.start < minute - 60_000) entry = { start: minute, count: 0, previous: 0 };
  else if (entry.start < minute) entry = { start: minute, count: 0, previous: entry.count };
  const weight = 1 - (nowMs - minute) / 60_000;
  const estimate = entry.count + entry.previous * weight;
  windows.set(key, entry);
  // Forget idle addresses now and then, so the map stays small.
  if (++checks % 1000 === 0) for (const [name, value] of windows) if (value.start < minute - 60_000) windows.delete(name);
  if (estimate >= PUBLIC_LIMIT.perMinute) return Math.max(1, Math.ceil((minute + 60_000 - nowMs) / 1000));
  entry.count += 1;
  return 0;
}

/** Test hook: empties the windows and, with `nowMs`, pins the clock the routes count by (null: the real one), so a count never straddles a minute. */
export const resetPublicLimitsForTests = (nowMs: number | null = null) => { windows.clear(); limitClock = nowMs === null ? Date.now : () => nowMs; };

/** The strict header set for the public page and its API (no-index, no-store, a CSP that allows only Nook's own scripts). */
export const PUBLIC_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
export const PUBLIC_API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
