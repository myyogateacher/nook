import { api } from "../api";
import type { ItemActivityEntry, ItemComment } from "../../shared/itemActivity";
import type { ReactionAggregate, ReactionKey } from "../../shared/reactions";
import type { PeopleAllow, PersonSummary } from "../../shared/people";
import type { LinkRelation, WorkKind, WorkLinkView, WorkRef, WorkSummary } from "../../shared/workRefs";

/**
 * The foundation endpoints the shared components call (docs/plan/WORKSPACE_MODULES.md §D.0 HTTP,
 * W1-CORE): people search, links and refs, item activity and comments. One place, so every module's
 * chips and panels ask the same way.
 */

export const searchPeople = (q: string, allow: readonly PeopleAllow[], options: { book?: string; signal?: AbortSignal } = {}) => {
  const query = new URLSearchParams({ q: q.slice(0, 120), allow: allow.join(",") });
  if (options.book) query.set("book", options.book);
  return api<{ people: PersonSummary[] }>(`/people/search?${query}`, { signal: options.signal });
};

/** Chips for member and contact ids a module holds (D1206); unreadable contacts come back hidden. */
export const resolvePeople = (ids: { users?: readonly string[]; contacts?: readonly string[] }) => {
  const query = new URLSearchParams();
  if (ids.users?.length) query.set("users", [...new Set(ids.users)].slice(0, 200).join(","));
  if (ids.contacts?.length) query.set("contacts", [...new Set(ids.contacts)].slice(0, 200).join(","));
  return api<{ people: PersonSummary[] }>(`/people/resolve?${query}`);
};

export const listLinks =(ref: WorkRef) => api<{ links: WorkLinkView[] }>(`/links?${new URLSearchParams({ kind: ref.kind, id: ref.id })}`);
export const createLink = (a: WorkRef, b: WorkRef | { ref: string }, relation: LinkRelation) =>
  api<{ link: WorkLinkView }>("/links", { method: "POST", body: JSON.stringify({ a, b, relation }) });
export const deleteLink = (linkId: string) => api<void>(`/links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
export const resolveRef = (ref: string, signal?: AbortSignal) => api<{ summary: WorkSummary }>(`/refs/resolve?${new URLSearchParams({ ref: ref.slice(0, 2048) })}`, { signal });

/** Searching work for the link picker: the All search scope, one query (§B.12). */
export const searchWork = (q: string, signal?: AbortSignal) => api<{ sections: Array<{ scope: string; label: string; results: unknown[] }> }>(`/search?${new URLSearchParams({ scope: "all", q: q.slice(0, 200) })}`, { signal });

const itemPath = (kind: WorkKind, id: string) => `/items/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
export const itemActivity = (kind: WorkKind, id: string, options: { order?: "asc" | "desc"; cursor?: string | null } = {}) => {
  const query = new URLSearchParams({ order: options.order ?? "desc" });
  if (options.cursor) query.set("cursor", options.cursor);
  return api<{ entries: ItemActivityEntry[]; nextCursor: string | null }>(`${itemPath(kind, id)}/activity?${query}`);
};
export const itemComments = (kind: WorkKind, id: string, cursor?: string | null) =>
  api<{ comments: ItemComment[]; nextCursor: string | null }>(`${itemPath(kind, id)}/comments${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`);
/** `attachmentIds`: the caller's own files, uploaded with uploadForHost(file, "item_comment") (D1363); with files the text may be empty. */
export const addItemComment = (kind: WorkKind, id: string, body: string, parentId?: string | null, attachmentIds: readonly string[] = []) =>
  api<{ comment: ItemComment }>(`${itemPath(kind, id)}/comments`, { method: "POST", body: JSON.stringify({ ...(body ? { body } : {}), ...(parentId ? { parentId } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) }) });
export const editItemComment = (kind: WorkKind, id: string, commentId: string, body: string) =>
  api<{ comment: ItemComment }>(`${itemPath(kind, id)}/comments/${encodeURIComponent(commentId)}`, { method: "PATCH", body: JSON.stringify({ body }) });
/** Deletes at once; the ticket undoes it through POST /api/undo/:ticket (D813, D1364). */
export const deleteItemComment = (kind: WorkKind, id: string, commentId: string) =>
  api<{ undoTicket: string }>(`${itemPath(kind, id)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });

/** Puts back what a fine-grained delete removed (server/undo.ts, D813): the shared Undo toast's action. */
export const undoTicket = (ticket: string) => api<{ restored: number }>(`/undo/${encodeURIComponent(ticket)}`, { method: "POST" });

/** A reaction on an item comment (D1362): PUT adds the caller's emoji, DELETE removes it. */
export const setItemCommentReaction = (commentId: string, emoji: ReactionKey, on: boolean) =>
  api<{ reactions: ReactionAggregate[] }>(`/reactions/item_comment/${encodeURIComponent(commentId)}/${encodeURIComponent(emoji)}`, { method: on ? "PUT" : "DELETE", headers: { "Content-Type": "application/json" } });
