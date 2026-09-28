import { createHash } from "node:crypto";
import { db } from "../db";
import { listReadableFolders, readableNote } from "../access";
import { readableDocument } from "../documentAccess";
import { readableCard, readableBoard } from "../tasks/access";
import { requireReadableView } from "../tasks/views";
import { calendarLevel, readableCalendar } from "../calendar/access";
import { collectionLevel, readableCollection } from "../collections/access";
import { atLeast } from "../access/levels";
import { parseStoredScopes } from "../mcpScopes";
import { stripMarkdown } from "./html";
import { isMuted } from "./mutes";
import { resolveEventChanged, resolveReminder } from "./calendarMail";
import { resolveBinExpiring, resolveSprint } from "./laterMail";
import { resolveDigest } from "./digest";
import type { TemplateName } from "./registry";
import type { AssignedCard, CommentExcerpt, SharedItem, SharedKind } from "./templates/activity";
import type { AccountEvent, TwoFactorEvent } from "./templates/security";

/**
 * Send-time resolution (docs/plan/research/2026-09-28-outbound-email.md §D.6, T226, T233). The
 * outbox payload holds ids and counts; here each id is re-read with the module's normal read check
 * as the recipient, binned or unreadable items are dropped, and titles are fetched now. Nothing left
 * means the row is skipped. Tokens (verify) are minted here, at send time, and exist only in memory
 * until the mail is sent (T220).
 */

export type Recipient = { id: string; email: string; displayName: string; role: string; tz: string };
export type Resolution = { data: unknown } | { skip: "access_lost" | "empty" | "muted" };

type Payload = Record<string, unknown>;
const ids = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const nameOf = (userId: unknown) => typeof userId === "string" ? (db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | null)?.display_name ?? null : null;
const names = (value: unknown) => ids(value).map(nameOf).filter((name): name is string => name !== null);

export const VERIFY_TTL_MS = 24 * 3_600_000;

function resolveAssigned(payload: Payload, recipient: Recipient): Resolution {
  const cards: AssignedCard[] = [];
  let muted = 0;
  for (const cardId of ids(payload.cardIds)) {
    const found = readableCard(cardId, recipient.id);
    if (!found) continue;
    // A board muted since the enqueue (D249) drops its cards too.
    if (isMuted(recipient.id, "board", found.board.id)) {
      muted += 1;
      continue;
    }
    if (!db.query("SELECT 1 FROM card_assignees WHERE card_id = ? AND user_id = ?").get(cardId, recipient.id)) continue;
    const column = found.card.column_id ? (db.query("SELECT name FROM board_columns WHERE id = ?").get(found.card.column_id) as { name: string } | null)?.name ?? null : null;
    cards.push({ boardId: found.board.id, cardId, title: found.card.title, boardName: found.board.name, dueOn: found.card.due_on, column });
  }
  if (!cards.length) return { skip: muted ? "muted" : "access_lost" };
  return { data: { actors: names(payload.actorIds), cards } };
}

function resolveComment(payload: Payload, recipient: Recipient): Resolution {
  const cardId = typeof payload.cardId === "string" ? payload.cardId : "";
  const found = readableCard(cardId, recipient.id);
  if (!found) return { skip: "access_lost" };
  if (isMuted(recipient.id, "board", found.board.id)) return { skip: "muted" };
  const rows = db.query(`SELECT m.id, m.body, u.display_name AS author FROM card_comments m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.card_id = ? AND m.id IN (SELECT value FROM json_each(?)) AND (m.author_id IS NULL OR m.author_id <> ?) ORDER BY m.created_at DESC, m.rowid DESC`)
    .all(cardId, JSON.stringify(ids(payload.commentIds)), recipient.id) as Array<{ id: string; body: string; author: string | null }>;
  if (!rows.length) return { skip: "empty" };
  const comments: CommentExcerpt[] = rows.slice(0, 3).map((row) => ({ author: row.author ?? "Former member", excerpt: stripMarkdown(row.body, 280) }));
  return { data: { boardId: found.board.id, cardId, cardTitle: found.card.title, boardName: found.board.name, comments, total: rows.length } };
}

/** One shared item as the recipient can read it now, or null (also the digest's "Shared with you"). */
export function sharedItem(kind: SharedKind, id: string, userId: string): SharedItem | null {
  switch (kind) {
    case "note": {
      const note = readableNote(id, userId);
      return note && note.current_version > 0 ? { kind, id, title: note.title, access: "read" } : null;
    }
    case "folder": {
      const folder = listReadableFolders(userId).find((item) => item.id === id);
      return folder ? { kind, id, title: folder.name, access: "read" } : null;
    }
    case "file": {
      const document = readableDocument(id, userId);
      return document && document.deleted_at === null && document.purpose === "file" ? { kind, id, title: document.name, access: "read" } : null;
    }
    case "board": {
      const board = readableBoard(id, userId);
      return board ? { kind, id, title: board.name, access: null } : null;
    }
    case "calendar": {
      const calendar = readableCalendar(id, userId);
      return calendar ? { kind, id, title: calendar.name, access: atLeast(calendarLevel(calendar, userId), "edit") ? "edit" : "read" } : null;
    }
    case "collection": {
      const collection = readableCollection(id, userId);
      return collection ? { kind, id, title: collection.name, access: atLeast(collectionLevel(collection, userId), "edit") ? "edit" : "read" } : null;
    }
    case "view": {
      try {
        const view = requireReadableView(id, userId) as { name: string };
        return { kind, id, title: view.name, access: null };
      } catch {
        return null;
      }
    }
  }
}

function resolveShared(payload: Payload, recipient: Recipient): Resolution {
  const raw = Array.isArray(payload.items) ? payload.items as Array<{ kind?: unknown; id?: unknown }> : [];
  const items = raw.flatMap((item) => typeof item.kind === "string" && typeof item.id === "string" ? [sharedItem(item.kind as SharedKind, item.id, recipient.id)] : [])
    .filter((item): item is SharedItem => item !== null);
  if (!items.length) return { skip: "access_lost" };
  return { data: { actors: names(payload.actorIds), items } };
}

function resolveProposals(_payload: Payload, recipient: Recipient): Resolution {
  const rows = db.query(`SELECT key_name, COUNT(*) AS count, MIN(expires_at) AS oldest FROM proposals WHERE owner_id = ? AND status = 'pending'
      GROUP BY COALESCE(key_id, key_name) ORDER BY count DESC, key_name LIMIT 20`).all(recipient.id) as Array<{ key_name: string; count: number; oldest: string }>;
  if (!rows.length) return { skip: "empty" };
  return {
    data: {
      keys: rows.map((row) => ({ name: row.key_name, count: row.count })),
      total: rows.reduce((sum, row) => sum + row.count, 0),
      oldestExpiresAt: rows.map((row) => row.oldest).sort()[0] ?? null
    }
  };
}

const MODULE_LABELS: Record<string, string> = { notes: "Notes", files: "Files", tasks: "Tasks", today: "Today", calendar: "Calendar", collections: "Collections", team: "Team", inbox: "Inbox" };
const ACCESS_LABELS: Record<string, string> = { read: "read", write: "write", "write-draft": "write drafts" };

/** "Notes: read, write drafts · Tasks: read". */
export function scopesSummary(json: string) {
  const byModule = new Map<string, string[]>();
  for (const scope of parseStoredScopes(json)) {
    const [module, access] = scope.split(":") as [string, string];
    byModule.set(module, [...(byModule.get(module) ?? []), ACCESS_LABELS[access] ?? access]);
  }
  return [...byModule].map(([module, access]) => `${MODULE_LABELS[module] ?? module}: ${access.join(", ")}`).join(" · ");
}

function resolveKeyCreated(payload: Payload, recipient: Recipient): Resolution {
  const key = db.query("SELECT name, scopes, created_at FROM mcp_api_keys WHERE id = ? AND user_id = ?").get(String(payload.keyId ?? ""), recipient.id) as { name: string; scopes: string; created_at: string } | null;
  if (!key) return { skip: "empty" };
  return { data: { keyName: key.name, scopes: scopesSummary(key.scopes), at: key.created_at } };
}

function resolveRoleChanged(payload: Payload, recipient: Recipient): Resolution {
  const fromRole = String(payload.fromRole ?? "");
  // A role toggled back within the window sends nothing (A.2 #2).
  if (recipient.role === fromRole) return { skip: "empty" };
  return { data: { userId: recipient.id, fromRole, toRole: recipient.role, actorName: nameOf(payload.actorId) } };
}

function resolveTwoFactor(payload: Payload): Resolution {
  return { data: { event: String(payload.event) as TwoFactorEvent, at: String(payload.at), remaining: typeof payload.remaining === "number" ? payload.remaining : null } };
}

function resolveAccount(payload: Payload): Resolution {
  return { data: { event: String(payload.event) as AccountEvent, actorName: nameOf(payload.actorId), at: String(payload.at) } };
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Mints a verify token (32 random bytes, SHA-256 at rest, 24 h, single use); older unused ones stop working. */
function resolveVerify(_payload: Payload, recipient: Recipient, nowMs: number): Resolution {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(nowMs + VERIFY_TTL_MS).toISOString();
  db.transaction(() => {
    db.query("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email' AND used_at IS NULL").run(recipient.id);
    db.query("INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email_at_issue, expires_at, created_at) VALUES (?, ?, 'verify_email', ?, ?, ?, ?)")
      .run(crypto.randomUUID(), recipient.id, tokenHash(token), recipient.email, expiresAt, new Date(nowMs).toISOString());
  })();
  return { data: { token, expiresAt, address: recipient.email } };
}

export const hashAuthToken = tokenHash;

/** Resolves an outbox row's payload for its recipient at send time. */
export function resolvePayload(template: TemplateName, payload: Payload, recipient: Recipient, nowMs: number): Resolution {
  switch (template) {
    case "tasks.assigned": return resolveAssigned(payload, recipient);
    case "tasks.comment": return resolveComment(payload, recipient);
    case "sharing.shared": return resolveShared(payload, recipient);
    case "inbox.proposals": return resolveProposals(payload, recipient);
    case "security.api_key_created": return resolveKeyCreated(payload, recipient);
    case "security.role_changed": return resolveRoleChanged(payload, recipient);
    case "security.two_factor": return resolveTwoFactor(payload);
    case "security.account": return resolveAccount(payload);
    case "account.verify": return resolveVerify(payload, recipient, nowMs);
    case "account.test": return { data: { sentAt: new Date(nowMs).toISOString() } };
    case "calendar.reminder": return resolveReminder(payload, recipient, nowMs);
    case "calendar.event_changed": return resolveEventChanged(payload, recipient, nowMs);
    case "tasks.sprint": return resolveSprint(payload, recipient);
    case "bin.expiring": return resolveBinExpiring(recipient, nowMs);
    case "digest.summary": return resolveDigest(payload, recipient, nowMs);
    // Invites are sent synchronously and never queued (D254).
    case "team.invite": return { skip: "empty" };
  }
}
