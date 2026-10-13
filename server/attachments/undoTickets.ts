import type { HostKind } from "./hosts";

/**
 * Undo tickets for removed attachments (POST /api/attachments/relink). When someone removes a link,
 * the link as it was (its part, position, linker, and time) is kept here for a short while, for that
 * person only. Undo uses it to put the link back exactly where it was, and it is the only way a link
 * to a file the person does not own can come back: the file's owner made that link, and Undo only
 * restores it (it never makes a new one). Tickets are in memory: a restart forgets them, and Undo
 * then falls back to the ordinary link rules (the owner's own file, appended at the end).
 */

export type RemovedLink = {
  partId: string | null;
  position: number;
  linkedBy: string | null;
  createdAt: string;
  /** Whether the removal moved the file to its owner's Bin. */
  binned: boolean;
};

type Ticket = RemovedLink & { expiresAt: number };

/** Long enough for the toast's Undo (10 s) with slack for a slow phone; short enough to stay a mistake's undo. */
export const UNDO_TICKET_TTL_MS = 10 * 60_000;
/** A bound on memory: the oldest tickets go first. */
export const UNDO_TICKET_MAX = 10_000;

const tickets = new Map<string, Ticket>();
const keyOf = (userId: string, kind: HostKind, hostId: string, documentId: string) => `${userId}\u0000${kind}\u0000${hostId.toLowerCase()}\u0000${documentId.toLowerCase()}`;

function sweep(nowMs: number) {
  for (const [key, ticket] of tickets) if (ticket.expiresAt <= nowMs) tickets.delete(key);
  while (tickets.size > UNDO_TICKET_MAX) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
}

/** Records the link `userId` just removed. Call after the removal committed. */
export function recordRemovedLink(userId: string, kind: HostKind, hostId: string, documentId: string, link: RemovedLink, nowMs = Date.now()) {
  const key = keyOf(userId, kind, hostId, documentId);
  tickets.delete(key);
  tickets.set(key, { ...link, expiresAt: nowMs + UNDO_TICKET_TTL_MS });
  if (tickets.size > UNDO_TICKET_MAX || tickets.size % 256 === 0) sweep(nowMs);
}

/** The live ticket for this removal, or null (not consumed). */
export function removedLink(userId: string, kind: HostKind, hostId: string, documentId: string, nowMs = Date.now()): RemovedLink | null {
  const key = keyOf(userId, kind, hostId, documentId);
  const ticket = tickets.get(key);
  if (!ticket) return null;
  if (ticket.expiresAt <= nowMs) {
    tickets.delete(key);
    return null;
  }
  const { expiresAt: _expiresAt, ...link } = ticket;
  return link;
}

/** Drops the ticket once the link is back (or can never come back). */
export function forgetRemovedLink(userId: string, kind: HostKind, hostId: string, documentId: string) {
  tickets.delete(keyOf(userId, kind, hostId, documentId));
}

/** Tests only. */
export function resetUndoTickets() {
  tickets.clear();
}
