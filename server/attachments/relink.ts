import { relinkRowDocument } from "../collections/service";
import { relinkToCard } from "../tasks/attachments";
import { HOSTS, type HostKind } from "./hosts";
import { AttachmentError, relinkDeclared, type RelinkOutcome } from "./service";
import { forgetRemovedLink, removedLink } from "./undoTickets";

/**
 * Undo for removing an attachment (POST /api/attachments/relink): one server path for events and chat
 * messages (declared hosts), cards, and rows. It puts the file back on the same host, in the same part
 * and place, and takes it out of the Bin when the removal put it there.
 *
 * Every rule is the one linking already has, checked fresh: the caller must be able to edit the host
 * now (the host's own rule: 404 for a stranger, 403 for a reader), and may put back only their own
 * file, or a link to someone else's file that they themselves removed moments ago (the server's own
 * record, undoTickets.ts; never the client's word). D396 holds: a Files item outside the Attachments
 * folder comes back only with that record (the confirm was given when it was first linked). Only the
 * file's owner restores it from the Bin. Putting back what is already there changes nothing.
 *
 * Notes and whiteboards derive their links from their content: a note's Undo puts the file back in the
 * draft (the editor), and its links follow on publish. Keys never reach this route (session only).
 */

export type RelinkInput = { hostKind: HostKind; hostId: string; documentId: string; partId?: string | null };

export async function relinkAttachment(userId: string, input: RelinkInput): Promise<RelinkOutcome> {
  const spec = HOSTS[input.hostKind];
  const hostId = input.hostId.toLowerCase();
  const documentId = input.documentId.toLowerCase();
  if (spec.linking === "derived") {
    throw new AttachmentError(409, "LINKS_DERIVED", `A ${spec.noun}'s attachments follow its content; add the file to the ${spec.noun} instead`);
  }
  const removed = removedLink(userId, spec.kind, hostId, documentId);
  const partId = input.partId ?? null;
  const outcome = spec.kind === "card"
    ? await relinkToCard(userId, hostId, documentId, removed, partId)
    : spec.kind === "row"
      ? await relinkRowDocument(userId, hostId, documentId, removed, partId)
      : relinkDeclared(userId, spec.kind, hostId, documentId, removed);
  forgetRemovedLink(userId, spec.kind, hostId, documentId);
  return outcome;
}
