import type { HostKind } from "./hosts";

/**
 * Undo tickets for removed attachments (POST /api/attachments/relink). When someone removes a link,
 * the link as it was (its part, position, linker, and time) is kept here for a short while, for that
 * person only. Undo uses it to put the link back exactly where it was, and it is the only way a link
 * to a file the person does not own can come back: the file's owner made that link, and Undo only
 * restores it (it never makes a new one). Tickets are in memory: a restart forgets them, and Undo
 * then falls back to the ordinary link rules (the owner's own file, appended at the end).
 *
 * A ticket undoes ONE removal, the latest one (v0.36.0 review M1). Whenever any link for (kind, host,
 * document) is created or removed, by anyone and by any path, every ticket for that link is dropped
 * (linkChanged / linksChanged / hostLinksGone; the secondary index `byLink` finds them) and the
 * link's generation ends. A removal then records a fresh ticket bound to a new generation, and a
 * ticket whose generation is not the link's current one is refused, so an older removal can never
 * override a later decision (for example the file's owner linking it again and withdrawing it).
 */

export type RemovedLink = {
  partId: string | null;
  position: number;
  linkedBy: string | null;
  createdAt: string;
  /** Whether the removal moved the file to its owner's Bin. */
  binned: boolean;
};

/** A live ticket as removedLink returns it: the removed link and the link generation it belongs to. */
export type RemovalTicket = RemovedLink & { generation: number };

type Ticket = RemovalTicket & { expiresAt: number };

/** The toast's Undo lasts 10 s; this leaves slack for a slow phone and stays a mistake's undo. */
export const UNDO_TICKET_TTL_MS = 60_000;
/** A bound on memory: the oldest tickets go first. */
export const UNDO_TICKET_MAX = 10_000;

/** Tickets by (remover, link). */
const tickets = new Map<string, Ticket>();
/** Secondary index by link (kind, host, document): its current generation and who holds a ticket for it. */
const byLink = new Map<string, { generation: number; users: Set<string> }>();
/** Generations only grow, so a link whose index entry goes and comes back never repeats a number. */
let epoch = 0;

const SEP = "\u0000";
const linkKeyOf = (kind: HostKind, hostId: string, documentId: string) => `${kind}${SEP}${hostId.toLowerCase()}${SEP}${documentId.toLowerCase()}`;
const ticketKeyOf = (userId: string, linkKey: string) => `${userId}${SEP}${linkKey}`;

function dropTicket(userId: string, linkKey: string) {
  tickets.delete(ticketKeyOf(userId, linkKey));
  const entry = byLink.get(linkKey);
  if (!entry) return;
  entry.users.delete(userId);
  if (entry.users.size === 0) byLink.delete(linkKey);
}

function sweep(nowMs: number) {
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt > nowMs && tickets.size <= UNDO_TICKET_MAX) continue;
    const userId = key.slice(0, key.indexOf(SEP));
    dropTicket(userId, key.slice(userId.length + 1));
  }
}

/**
 * A link for (kind, host, document) was created or removed, by anyone, by any path: every ticket for
 * it is dropped and its generation ends. Safe inside a transaction (a rollback only loses an Undo,
 * never grants one).
 */
export function linkChanged(kind: HostKind, hostId: string, documentId: string) {
  const linkKey = linkKeyOf(kind, hostId, documentId);
  const entry = byLink.get(linkKey);
  if (!entry) return;
  for (const userId of entry.users) tickets.delete(ticketKeyOf(userId, linkKey));
  byLink.delete(linkKey);
}

/** linkChanged for several documents on one host. */
export function linksChanged(kind: HostKind, hostId: string, documentIds: Iterable<string>) {
  for (const documentId of documentIds) linkChanged(kind, hostId, documentId);
}

/** Hosts were purged with all their links (a cascade): every ticket on them goes. Rare, so one scan. */
export function hostLinksGone(kind: HostKind, hostIds: Iterable<string>) {
  const hosts = new Set([...hostIds].map((hostId) => hostId.toLowerCase()));
  if (!hosts.size || !byLink.size) return;
  for (const linkKey of [...byLink.keys()]) {
    const [linkKind, hostId, documentId] = linkKey.split(SEP);
    if (linkKind === kind && hosts.has(hostId!)) linkChanged(kind, hostId!, documentId!);
  }
}

/** Records the link `userId` just removed (dropping every older ticket for that link). Call after the removal committed. */
export function recordRemovedLink(userId: string, kind: HostKind, hostId: string, documentId: string, link: RemovedLink, nowMs = Date.now()) {
  linkChanged(kind, hostId, documentId);
  const linkKey = linkKeyOf(kind, hostId, documentId);
  const generation = ++epoch;
  byLink.set(linkKey, { generation, users: new Set([userId]) });
  tickets.set(ticketKeyOf(userId, linkKey), { ...link, generation, expiresAt: nowMs + UNDO_TICKET_TTL_MS });
  if (tickets.size > UNDO_TICKET_MAX || tickets.size % 256 === 0) sweep(nowMs);
}

/** The live ticket for this removal, or null (not consumed). Expired, or the link changed since: null. */
export function removedLink(userId: string, kind: HostKind, hostId: string, documentId: string, nowMs = Date.now()): RemovalTicket | null {
  const linkKey = linkKeyOf(kind, hostId, documentId);
  const ticket = tickets.get(ticketKeyOf(userId, linkKey));
  if (!ticket) return null;
  if (ticket.expiresAt <= nowMs || byLink.get(linkKey)?.generation !== ticket.generation) {
    dropTicket(userId, linkKey);
    return null;
  }
  const { expiresAt: _expiresAt, ...link } = ticket;
  return link;
}

/** Drops the caller's ticket once the link is back (or can never come back). */
export function forgetRemovedLink(userId: string, kind: HostKind, hostId: string, documentId: string) {
  dropTicket(userId, linkKeyOf(kind, hostId, documentId));
}

/** Tests only. */
export function resetUndoTickets() {
  tickets.clear();
  byLink.clear();
}

/** Tests only: how many tickets and indexed links are held. */
export function undoTicketCounts() {
  return { tickets: tickets.size, links: byLink.size };
}
