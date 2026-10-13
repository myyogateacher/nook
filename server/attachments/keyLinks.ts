import { db } from "../db";
import { anchorsOf, keyReach, reachCovers } from "../keyResources";
import type { McpKeyContext } from "../mcpToolKit";
import { HOSTS, isHostKind, type HostKind } from "./hosts";
import { ATTACHMENTS_FOLDER_KIND, hostReadable, type LinkPolicy } from "./service";

/**
 * What an API or MCP key may do with its owner's attachments (v0.35.0 review M2, T354). A key acts as
 * its owner, but it must never widen a file's reach beyond what its own grants cover:
 *
 * - A key links (or derives a link to) only an **Attachments-folder** file of its owner, and only
 *   when the file is not already linked to a host the key cannot reach, or its `files:read` grant
 *   covers the file. A chat image or a private card's file therefore never moves into a note, an
 *   event, a card, or a row through a key that could not open it where it is. A Files item outside
 *   the Attachments folder is never derived by a key; cards and rows still take one with
 *   `confirmed` and `files:read` over it (T341, T345).
 * - A key sees an attachment of its owner's through a host (list_attachments, read_attachment_text,
 *   read_note) only on the same terms. Other people's files on a host the key reaches are what the
 *   owner sees as a reader there (their owners shared them through the host).
 *
 * One helper for every module (notes, whiteboards, calendar, tasks, collections), so the rule is the
 * same everywhere. A signed-in person approving a proposal is not limited (`key.person`).
 */

export type HostRef = { kind: HostKind; hostId: string };

/** Whether the key reaches a host for its module's read scope, and its owner can open it now. */
export function keyReachesHost(key: McpKeyContext, kind: HostKind, hostId: string) {
  const spec = HOSTS[kind];
  const reach = keyReach(key, spec.readScope);
  const covered = spec.itemKind === null ? reach === "all" : reachCovers(reach, anchorsOf(spec.itemKind, hostId));
  return covered && hostReadable(kind, hostId, key.userId);
}

/** Every host that links the document, in every link table. */
function documentHosts(documentId: string): HostRef[] {
  const rows = db.query(`SELECT host_kind, host_id FROM attachment_links WHERE document_id = $id
    UNION ALL SELECT 'card', card_id FROM card_attachments WHERE document_id = $id
    UNION ALL SELECT 'row', row_id FROM collection_row_attachments WHERE document_id = $id`).all({ id: documentId }) as Array<{ host_kind: string; host_id: string }>;
  return rows.flatMap((row) => isHostKind(row.host_kind) ? [{ kind: row.host_kind, hostId: row.host_id }] : []);
}

/**
 * Whether the document is linked to any host that `inside` does not accept: the one helper behind
 * every "already attached somewhere else" refusal (collections: outside this collection; keys:
 * outside the key's reach).
 */
export function linkedElsewhere(documentId: string, inside: (host: HostRef) => boolean) {
  return documentHosts(documentId.toLowerCase()).some((host) => !inside(host));
}

/** Whether any link of the document sits on a host the key cannot reach (`except`, the host at hand, is ignored). */
export function linkedOutsideKeyReach(key: McpKeyContext, documentId: string, except?: HostRef) {
  if (key.person) return false;
  return linkedElsewhere(documentId, (host) => (except !== undefined && host.kind === except.kind && host.hostId === except.hostId) || keyReachesHost(key, host.kind, host.hostId));
}

/** Whether the key's `files:read` grant covers the document (its id or its folder). */
export const keyFilesReadCovers = (key: McpKeyContext, documentId: string) =>
  reachCovers(keyReach(key, "files:read"), anchorsOf("document", documentId));

/** An Attachments-folder file the key may link to `host` (see the rule above). */
export function keyMayLinkAttachment(key: McpKeyContext, documentId: string, host?: HostRef) {
  if (key.person) return true;
  return keyFilesReadCovers(key, documentId) || !linkedOutsideKeyReach(key, documentId, host);
}

/** The derived-link policy of a key (publish_note_draft, create_whiteboard): Attachments-folder files the key may link; never a confirm. */
export const keyLinkPolicy = (key: McpKeyContext, host: HostRef): LinkPolicy => (document) =>
  document.system_kind === ATTACHMENTS_FOLDER_KIND && keyMayLinkAttachment(key, document.id, host) ? "link" : "skip";

/**
 * Whether the key may see one attachment of a host it reaches: anyone else's file (shared through
 * the host by its owner); its owner's own file only when `files:read` covers it, or it is in the
 * Attachments folder and linked nowhere the key cannot reach.
 */
export function keyMaySeeAttachment(key: McpKeyContext, host: HostRef, document: { id: string; owner_id: string; system_kind: string | null }) {
  if (key.person || document.owner_id !== key.userId) return true;
  if (keyFilesReadCovers(key, document.id)) return true;
  return document.system_kind === ATTACHMENTS_FOLDER_KIND && !linkedOutsideKeyReach(key, document.id, host);
}

/** `keyMaySeeAttachment` by document id (looks the document up). */
export function keyMaySeeAttachmentId(key: McpKeyContext, host: HostRef, documentId: string) {
  const document = db.query("SELECT d.id, d.owner_id, f.system_kind FROM documents d LEFT JOIN folders f ON f.id = d.folder_id WHERE d.id = ?")
    .get(documentId.toLowerCase()) as { id: string; owner_id: string; system_kind: string | null } | null;
  return document !== null && keyMaySeeAttachment(key, host, document);
}
