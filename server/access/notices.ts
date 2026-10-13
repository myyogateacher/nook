import { db, now } from "../db";
import { presentItem } from "./effective";
import { ACCESS_KINDS, type AccessKind, type Level } from "./levels";
import { vaultTitleFor } from "../vault/access";
import { sharedTitleFor } from "../agents/sharing";
import { deviceLabelFromCode } from "../deviceLabels";
import { paths } from "../mail/links";
import { mayChatNow } from "../agents/status";
import { userRole } from "../team/userRole";

const LEVEL_WORDS: Record<Level, string> = { view: "Can view", comment: "Can comment", edit: "Can edit", manage: "Manager" };

/**
 * Bell notices about access (Wave 33, access plan §C.11, migration 032): the owner hears when an
 * admin removes or lowers someone's access to their item or resets someone's access (D268, T214),
 * a member hears when they are added to or removed from a group, and a key owner hears when an
 * admin revokes their key. Stored as ids and counts; the line is written when the recipient reads
 * the bell, through `presentItem`, so a title shows only to someone who can open the item (D269).
 * Nobody is notified about their own action. Email: none of these has a mail kind in the plan yet
 * (O-A13 leaves it to the digest), so the bell is the only channel.
 */

export type AccessNoticeKind = "share_removed" | "share_lowered" | "access_reset" | "access_reset_self" | "group_added" | "group_removed" | "key_revoked"
  // Wave 35 (Google sign-in): an admin allowed linking or re-linking, reset the account for Google,
  // or unlinked Google; or a re-link completed. `count` carries GOOGLE_RESET_PARTS bits.
  | "google_allowed" | "google_relink_allowed" | "google_reset" | "google_unlinked" | "google_relinked"
  // Wave 26 (Vault B): a vault was shared with you, or your access to one ended. The line names the
  // vault only while you can read it, and never a secret (D223). `vault_key_rotated` goes to a
  // vault's owners when people lost read outside its Access sheet (Team → Groups, Reset access, a
  // block, a role change): the data key rotates, and the real credentials should be rotated upstream.
  | "vault_shared" | "vault_removed" | "vault_key_rotated"
  // Wave 27 (Vault C): one of your vault keys hit its per-key rate limit (at most one notice a day per key).
  | "key_vault_limited"
  // Wave 27 fixes (V-O6): one of your vault keys read more than 500 values today (`count`: how many), once a day per key.
  | "key_vault_volume"
  // Wave 43 (AC-D): an agent or a chat was shared with you, by name or through a group. The line names
  // it only while you can open it (the agent's name or the chat's title), never a prompt or a message.
  | "agent_shared" | "chat_shared"
  // Wave 44 (AC-E): a knowledge base was shared with you; named only while you can open it.
  | "knowledge_base_shared"
  // Wave 43 fixes (review L4): a manager changed the agent's system prompt, tools, or direct Nook writes,
  // or the change turned on the trifecta. To the agent's owner; `count` carries AGENT_CHANGE_PARTS bits.
  | "agent_changed"
  // Migration 044 (outbound email plan #9): a sign-in from a device or browser the account had not
  // used. The resource is `device` with the `browser:os` family codes (server/deviceLabels.ts), never text.
  | "new_sign_in"
  // Bell deep links (v0.32): an admin revoked one of your calendar feed links (the resource is the
  // calendar, named only while you can open it) or paused one of your routines (the resource is the
  // routine; its name is yours). From Settings → Team → a member's access page (D268).
  | "feed_revoked" | "routine_paused"
  // T353: an admin removed your profile picture (Team → a member). Opens Settings → Security, where the picture card is.
  | "avatar_removed";

export type AccessNotice = {
  userId: string;
  kind: AccessNoticeKind;
  actorId: string | null;
  targetUserId?: string | null;
  resource?: { kind: AccessKind | "vault" | "agent" | "chat" | "knowledge_base" | "device" | "routine"; id: string } | null;
  groupId?: string | null;
  keyId?: string | null;
  count?: number | null;
  /** The new level of a lowered share. */
  level?: Level | null;
};

const recipientIsPerson = db.query("SELECT 1 FROM users WHERE id = ? AND kind = 'person'");
const insert = db.query(`INSERT INTO access_notices (id, user_id, kind, actor_id, target_user_id, resource_kind, resource_id, group_id, key_id, count, level, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Queues one bell notice; a notice to the actor about their own action is dropped. Call inside the action's transaction. */
export function notifyAccess(notice: AccessNotice, timestamp = now()) {
  if (notice.actorId !== null && notice.actorId === notice.userId) return false;
  // Integrations (D287) have no bell: nobody signs in as one.
  if (!recipientIsPerson.get(notice.userId)) return false;
  insert.run(crypto.randomUUID(), notice.userId, notice.kind, notice.actorId, notice.targetUserId ?? null, notice.resource?.kind ?? null, notice.resource?.id ?? null,
    notice.groupId ?? null, notice.keyId ?? null, notice.count ?? null, notice.level ?? null, timestamp);
  return true;
}

type NoticeRow = {
  id: string; kind: string; actor_name: string | null; target_name: string | null; resource_kind: string | null; resource_id: string | null;
  group_name: string | null; key_name: string | null; count: number | null; level: string | null; created_at: string; read_at: string | null;
};

/**
 * Where an access notice opens (bell deep links, v0.32). Paths come from the mail link builders
 * (`server/mail/links.ts`), so they are built from ids only and checked against the router's id
 * pattern (T68); no title or free text ever reaches a link. An item opens only while the recipient
 * can open it; otherwise the notice opens the module's list (or the notifications list), so a link
 * never names an item the reader cannot reach. The client re-checks every path (`safeNotificationPath`).
 */
export const ACCESS_NOTICE_HREF = "/notifications";

/** A path from a builder, or the fallback when an id is malformed (the builders throw). */
function built(build: () => string, fallback = ACCESS_NOTICE_HREF) {
  try {
    return build();
  } catch {
    return fallback;
  }
}

const ITEM_LISTS: Record<AccessKind, () => string> = {
  note: paths.notesList, folder: paths.notesList, document: paths.filesList, board: paths.boards, task_view: paths.boards, collection: paths.collections, calendar: paths.calendar
};

/** One item of an access kind, as the recipient may open it: the item, or its module's list. */
function itemPath(kind: AccessKind, id: string, recipientId: string) {
  const item = presentItem(kind, id, recipientId);
  const list = ITEM_LISTS[kind]();
  if (!item || item.titleHidden) return list;
  switch (kind) {
    case "note": return built(() => paths.note(id), list);
    case "folder": return built(() => paths.noteFolder(id), list);
    case "document": return built(() => paths.file(id), list);
    case "board": return built(() => paths.board(id), list);
    case "task_view": return built(() => paths.taskView(id), list);
    case "collection": return built(() => paths.collection(id), list);
    // Calendars have no page of their own: the calendar opens with every calendar the reader has.
    case "calendar": return list;
  }
}

/**
 * A shared agent, chat, or knowledge base: its page while the recipient can open it, else its list.
 * A link into Chat (a shared chat, or a shared agent's new chat) needs the recipient to be able to
 * chat now (TODO "Chat role message"): with Chat off or their role left out of "Who can chat", the
 * notice opens the bell list (`/notifications`) like any other item they cannot open.
 */
function sharedPath(kind: "agent" | "chat" | "knowledge_base", id: string, recipientId: string, agentOpens: "chat" | "editor") {
  const opensChat = kind === "chat" || (kind === "agent" && agentOpens === "chat");
  if (opensChat && !mayChatNow(userRole(recipientId) ?? "guest")) return paths.notifications();
  const list = opensChat ? paths.chats() : paths.settings(kind === "agent" ? "agents" : "knowledge");
  if (sharedTitleFor(kind, id, recipientId) === null) return list;
  if (kind === "chat") return built(() => paths.chat(id), list);
  if (kind === "knowledge_base") return built(() => paths.knowledgeBase(id), list);
  return built(() => agentOpens === "chat" ? paths.chatWithAgent(id) : paths.agent(id), list);
}

export function accessNoticeHref(row: { kind: string; resource_kind: string | null; resource_id: string | null }, recipientId: string): string {
  const id = row.resource_id;
  switch (row.kind) {
    // Your access ended or changed: Settings → My access lists what you still reach, your groups, and feeds.
    case "access_reset_self":
    case "group_added":
    case "group_removed":
    case "feed_revoked":
      return paths.settings("access");
    case "key_revoked":
    case "key_vault_limited":
    case "key_vault_volume":
      return paths.settings("keys");
    case "routine_paused":
      return paths.routines();
    // Settings → Security: recognised devices, Google sign-in, and two-factor.
    case "new_sign_in":
    case "avatar_removed":
    case "google_allowed":
    case "google_relink_allowed":
    case "google_reset":
    case "google_unlinked":
    case "google_relinked":
      return paths.settings("security");
    case "vault_shared":
    case "vault_removed":
    case "vault_key_rotated":
      return id && vaultTitleFor(recipientId, id) !== null ? built(() => paths.vault(id), paths.vaults()) : paths.vaults();
    // Wave 43: an agent opens a new chat with it; a chat opens read-only.
    case "agent_shared": return id ? sharedPath("agent", id, recipientId, "chat") : paths.chats();
    case "chat_shared": return id ? sharedPath("chat", id, recipientId, "chat") : paths.chats();
    // Wave 43 fixes (review L4): the owner opens the agent's editor.
    case "agent_changed": return id ? sharedPath("agent", id, recipientId, "editor") : paths.settings("agents");
    // Wave 44 (AC-E): a knowledge base opens its page in Settings → Knowledge.
    case "knowledge_base_shared": return id ? sharedPath("knowledge_base", id, recipientId, "editor") : paths.settings("knowledge");
    // To an item's owner: an admin removed or lowered someone's access to it. The owner opens the item.
    case "share_removed":
    case "share_lowered":
      if (!id) return ACCESS_NOTICE_HREF;
      if (isAccessKind(row.resource_kind)) return itemPath(row.resource_kind, id, recipientId);
      if (row.resource_kind === "agent" || row.resource_kind === "chat" || row.resource_kind === "knowledge_base") return sharedPath(row.resource_kind, id, recipientId, "editor");
      if (row.resource_kind === "vault") return vaultTitleFor(recipientId, id) !== null ? built(() => paths.vault(id), paths.vaults()) : paths.vaults();
      return ACCESS_NOTICE_HREF;
    // About someone else and several of your items at once: there is no one item to open.
    case "access_reset":
    default:
      return ACCESS_NOTICE_HREF;
  }
}

const isAccessKind = (value: string | null): value is AccessKind => value !== null && (ACCESS_KINDS as readonly string[]).includes(value);

function line(row: NoticeRow, recipientId: string) {
  if (row.kind === "new_sign_in") return `New sign-in from ${deviceLabelFromCode(row.resource_id)}`;
  const actor = row.actor_name ?? "An admin";
  if (row.resource_kind === "vault" && row.resource_id) {
    const title = vaultTitleFor(recipientId, row.resource_id);
    if (row.kind === "vault_shared") return title ? `${row.actor_name ?? "Someone"} shared the vault “${title}” with you` : "A vault shared with you is no longer available to you";
    if (row.kind === "vault_removed") return title ? `${actor} changed your access to the vault “${title}”` : `${actor} removed your access to a vault`;
    if (row.kind === "vault_key_rotated") {
      const people = row.count === 1 ? "someone" : `${row.count ?? 0} people`;
      return `${actor}'s change in Team took ${people} off ${title ? `the vault “${title}”` : "a vault"}. Its data key is being rotated; rotate the real credentials they could read where they are issued.`;
    }
  }
  if (row.resource_kind === "knowledge_base" && row.resource_id && row.kind === "knowledge_base_shared") {
    const title = sharedTitleFor("knowledge_base", row.resource_id, recipientId);
    return title ? `${row.actor_name ?? "Someone"} shared the knowledge base “${title}” with you` : "A knowledge base shared with you is no longer available to you";
  }
  if ((row.resource_kind === "agent" || row.resource_kind === "chat") && row.resource_id) {
    const title = sharedTitleFor(row.resource_kind, row.resource_id, recipientId);
    const noun = row.resource_kind === "agent" ? "agent" : "chat";
    if (row.kind === "agent_shared" || row.kind === "chat_shared") return title ? `${row.actor_name ?? "Someone"} shared the ${noun} “${title}” with you` : `A${noun === "agent" ? "n" : ""} ${noun} shared with you is no longer available to you`;
    if (row.kind === "agent_changed") {
      const mask = row.count ?? 0;
      const parts = agentChangeParts(mask);
      const what = `${row.actor_name ?? "A manager"} changed ${parts.length ? listWords(parts) : "the settings"} on your agent${title ? ` “${title}”` : ""}`;
      return mask & AGENT_CHANGE_TRIFECTA ? `${what}; it can now read your Nook and reach the open web (the trifecta)` : what;
    }
  }
  const target = row.target_name ?? "someone";
  const item = isAccessKind(row.resource_kind) && row.resource_id ? presentItem(row.resource_kind, row.resource_id, recipientId) : null;
  const sharedKind = row.resource_kind === "agent" || row.resource_kind === "chat" ? row.resource_kind : null;
  const sharedTitle = sharedKind && row.resource_id ? sharedTitleFor(sharedKind, row.resource_id, recipientId) : null;
  const itemText = sharedKind ? (sharedTitle ? `the ${sharedKind} “${sharedTitle}”` : sharedKind === "agent" ? "an agent" : "a chat")
    : item ? (item.titleHidden ? `a ${item.title.split(" owned by ")[0]!.toLowerCase()}` : `“${item.title}”`) : "an item that is gone";
  // A group that is gone gets its own sentence, not "the group a group…" (C15a).
  const group = row.group_name ? `the group “${row.group_name}”` : "a group that has since been deleted";
  switch (row.kind) {
    case "share_removed": return `${actor} removed ${target}'s access to ${itemText}`;
    case "share_lowered": return `${actor} lowered ${target}'s access to ${itemText}${row.level && row.level in LEVEL_WORDS ? ` to ${LEVEL_WORDS[row.level as Level]}` : ""}`;
    case "access_reset": return `${actor} reset ${target}'s access, including ${row.count ?? 0} of your items`;
    case "access_reset_self": {
      const parts = resetParts(row.count ?? 0);
      return parts.length ? `${actor} reset your access: ${listWords(parts)}` : `${actor} reset your access`;
    }
    case "group_added": return `${actor} added you to ${group}`;
    case "group_removed": return `${actor} removed you from ${group}`;
    case "key_revoked": return `${actor} revoked your API key${row.key_name ? ` “${row.key_name}”` : ""}`;
    case "feed_revoked": return `${actor} revoked your calendar feed link for ${item ? (item.titleHidden ? "a calendar" : `“${item.title}”`) : "a calendar that is gone"}`;
    case "routine_paused": {
      const name = row.resource_id ? routineName(recipientId, row.resource_id) : null;
      return `${actor} paused your routine${name ? ` “${name}”` : ""}`;
    }
    case "key_vault_volume": return `Your vault API key${row.key_name ? ` “${row.key_name}”` : ""} read more than 500 values today. If you did not expect this much use, revoke it in Settings → API keys.`;
    case "key_vault_limited": return `Your vault API key${row.key_name ? ` “${row.key_name}”` : ""} hit its rate limit. If you did not expect this much use, revoke it in Settings → API keys.`;
    case "google_allowed": return `${actor} allowed your account to be linked to Google at your next Google sign-in`;
    case "google_relink_allowed": return `${actor} allowed your account to be re-linked: the next Google sign-in with your address takes it over`;
    case "google_reset": {
      const parts = googleResetParts(row.count ?? 0);
      return `${actor} reset your account for Google sign-in${parts.length ? `: ${listWords(parts)}` : ""}`;
    }
    case "google_unlinked": return `${actor} unlinked Google from your account`;
    case "avatar_removed": return `${actor} removed your profile picture. You can add a new one in Settings → Security.`;
    case "google_relinked": {
      const parts = googleResetParts(row.count ?? 0);
      return `A new Google account was linked to your account${parts.length ? `; removed ${listWords(parts)}` : ""}`;
    }
    default: return "Your access changed";
  }
}

const routineNameQuery = db.query("SELECT name FROM routines WHERE id = ? AND owner_id = ?");
/** The recipient's own routine's name (routines are private: nobody else's is ever read). */
const routineName = (ownerId: string, routineId: string) => (routineNameQuery.get(routineId, ownerId) as { name: string } | null)?.name ?? null;

/** What a Reset removed, as bits in the notice's `count` (the notice keeps ids and numbers only). */
const RESET_PARTS = [
  { bit: 1, key: "directShares", words: "direct shares" },
  { bit: 2, key: "groups", words: "groups" },
  { bit: 4, key: "keys", words: "API keys" },
  { bit: 8, key: "feeds", words: "calendar feeds" },
  { bit: 16, key: "routines", words: "routines (paused)" }
] as const;

export function resetMask(removed: Record<(typeof RESET_PARTS)[number]["key"], number>) {
  return RESET_PARTS.reduce((mask, part) => removed[part.key] > 0 ? mask | part.bit : mask, 0);
}

export const resetParts = (mask: number) => RESET_PARTS.filter((part) => (mask & part.bit) !== 0).map((part) => part.words);

/** What a manager changed on an agent (Wave 43 fixes, review L4), as bits in the notice's `count`. */
const AGENT_CHANGE_PARTS = [
  { bit: 1, key: "systemPrompt", words: "the system prompt" },
  { bit: 2, key: "tools", words: "the tools" },
  { bit: 4, key: "nookDirectWrites", words: "direct Nook writes" }
] as const;
/** The change turned the trifecta warning on: a consequence, said after the fields. */
export const AGENT_CHANGE_TRIFECTA = 8;
export function agentChangeMask(changed: Partial<Record<(typeof AGENT_CHANGE_PARTS)[number]["key"] | "trifecta", boolean>>) {
  return AGENT_CHANGE_PARTS.reduce((mask, part) => changed[part.key] ? mask | part.bit : mask, changed.trifecta ? AGENT_CHANGE_TRIFECTA : 0);
}
export const agentChangeParts = (mask: number) => AGENT_CHANGE_PARTS.filter((part) => (mask & part.bit) !== 0).map((part) => part.words);

/** What a Google reset or re-link removed (Wave 35), as bits in the notice's `count`. */
const GOOGLE_RESET_PARTS = [
  { bit: 1, key: "sessions", words: "signed-in sessions" },
  { bit: 2, key: "keys", words: "API keys" },
  { bit: 4, key: "feeds", words: "calendar feeds" },
  { bit: 8, key: "password", words: "the password" },
  { bit: 16, key: "twoFactor", words: "two-factor" },
  { bit: 32, key: "sharing", words: "sharing" },
  { bit: 64, key: "invites", words: "live invites" },
  { bit: 128, key: "routines", words: "routines (paused)" }
] as const;

/** Counts of a Google reset or re-link; `items`, `shares`, and `groupGrants` together are "sharing". */
export function googleResetMask(counts: Partial<Record<string, number>>) {
  const values: Partial<Record<string, number>> = { ...counts, sharing: (counts.items ?? 0) + (counts.shares ?? 0) + (counts.groupGrants ?? 0) };
  return GOOGLE_RESET_PARTS.reduce((mask, part) => (values[part.key] ?? 0) > 0 ? mask | part.bit : mask, 0);
}

export const googleResetParts = (mask: number) => GOOGLE_RESET_PARTS.filter((part) => (mask & part.bit) !== 0).map((part) => part.words);

/** "a, b, and c" */
export function listWords(words: readonly string[]) {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

export type AccessNoticeItem = { id: string; kind: "access"; title: string; href: string; late: false; read: boolean; createdAt: string; occurrenceStart: null };

/** The newest `limit` notices for the bell, shaped like calendar notifications. */
export function listAccessNotices(userId: string, options: { unread: boolean; limit: number }): AccessNoticeItem[] {
  const rows = db.query(`SELECT n.id, n.kind, a.display_name AS actor_name, t.display_name AS target_name, n.resource_kind, n.resource_id,
      g.name AS group_name, k.name AS key_name, n.count, n.level, n.created_at, n.read_at
    FROM access_notices n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN users t ON t.id = n.target_user_id
      LEFT JOIN user_groups g ON g.id = n.group_id LEFT JOIN mcp_api_keys k ON k.id = n.key_id AND k.user_id = n.user_id
    WHERE n.user_id = $userId AND ($unread = 0 OR n.read_at IS NULL) ORDER BY n.created_at DESC, n.rowid DESC LIMIT $limit`)
    .all({ userId, unread: options.unread ? 1 : 0, limit: options.limit }) as NoticeRow[];
  return rows.map((row) => ({
    id: row.id, kind: "access" as const, title: line(row, userId), href: accessNoticeHref(row, userId),
    late: false, read: row.read_at !== null, createdAt: row.created_at, occurrenceStart: null
  }));
}

export const unreadAccessNotices = (userId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM access_notices WHERE user_id = ? AND read_at IS NULL").get(userId) as { count: number }).count;

export function markAccessNoticesRead(userId: string, target: { ids: string[] } | { all: true }, timestamp: string) {
  return ("all" in target
    ? db.query("UPDATE access_notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(timestamp, userId)
    : db.query("UPDATE access_notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))").run(timestamp, userId, JSON.stringify(target.ids))).changes;
}

export const sweepAccessNotices = (cutoff: string) => db.query("DELETE FROM access_notices WHERE created_at < ?").run(cutoff).changes;
