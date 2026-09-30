import { api } from "../api";
import type { Role } from "./teamRoles";

/** Team → Groups (Wave 32, access plan D267, docs/plan/API_CONTRACTS.md). Admins only. */
export type GroupSummary = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  guestCount: number;
  grantCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type GroupMember = {
  id: string;
  displayName: string;
  role: Role;
  status: "active" | "blocked";
  addedAt: string;
  addedBy: { id: string; displayName: string } | null;
  /** An admin added themselves (O-A1): allowed, but flagged here and in the history. */
  selfAdded: boolean;
};

export type AccessLevel = "view" | "comment" | "edit" | "manage";
export type AccessKind = "note" | "folder" | "document" | "board" | "task_view" | "collection" | "calendar";

/** An item shared with the group. `titleHidden`: the admin cannot open it, so only the kind and owner show (D269). */
export type GroupItem = { kind: AccessKind; title: string; titleHidden: boolean; owner: { id: string; displayName: string }; id?: string; level: AccessLevel };

export type GroupHistoryRow = { id: string; action: string; createdAt: string; actor: { id: string; displayName: string } | null; target: { id: string; displayName: string } | null; self: boolean };

/** `guestAddRefused`: sharing with guests is off and the group has items shared with it, so guests cannot be added (T213). */
export type GroupDetail = GroupSummary & { members: GroupMember[]; items: GroupItem[]; truncated: boolean; history: GroupHistoryRow[]; guestAddRefused: boolean };

const groupPath = (groupId: string) => `/team/groups/${encodeURIComponent(groupId)}`;

export const listGroups = () => api<{ groups: GroupSummary[]; limit: number }>("/team/groups");
export const getGroup = (groupId: string) => api<{ group: GroupDetail }>(groupPath(groupId));
export const createGroup = (body: { name: string; description?: string | null }) =>
  api<{ group: GroupDetail }>("/team/groups", { method: "POST", body: JSON.stringify(body) });
export const patchGroup = (groupId: string, body: { name?: string; description?: string | null; revision: number }) =>
  api<{ group: GroupDetail }>(groupPath(groupId), { method: "PATCH", body: JSON.stringify(body) });
export const deleteGroup = (groupId: string, revision: number) =>
  api<{ ok: true; removedGrants: number; removedMembers: number }>(groupPath(groupId), { method: "DELETE", body: JSON.stringify({ revision }) });
export const putGroupMembers = (groupId: string, body: { userIds: string[]; revision: number }) =>
  api<{ added: number; removed: number; selfAdded: boolean; group: GroupDetail }>(`${groupPath(groupId)}/members`, { method: "PUT", body: JSON.stringify(body) });

export const KIND_LABELS: Record<AccessKind, string> = {
  note: "Note", folder: "Folder", document: "File", board: "Board", task_view: "Task view", collection: "Collection", calendar: "Calendar"
};

export const LEVEL_LABELS: Record<AccessLevel, string> = { view: "Can view", comment: "Can comment", edit: "Can edit", manage: "Manager" };

export function groupEventLabel(row: GroupHistoryRow) {
  const actor = row.actor?.displayName ?? "Someone";
  const target = row.target?.displayName ?? "someone";
  switch (row.action) {
    case "group.created": return `${actor} created the group`;
    case "group.updated": return `${actor} changed the name or description`;
    case "group.member_added": return row.self ? `${actor} added themselves` : `${actor} added ${target}`;
    case "group.member_removed": return row.self ? `${actor} left the group` : `${actor} removed ${target}`;
    // F10: an action this build does not know still reads as a sentence, never as its code.
    default: return `${actor} changed the group`;
  }
}

export const memberCountLabel = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;
/** The Delete group confirm (QA v0.13.0 B10): says what is lost, with a sentence of its own when nobody or nothing is. */
export function deleteGroupMessage(memberCount: number, grantCount: number) {
  const items = `${grantCount} ${grantCount === 1 ? "item" : "items"}`;
  const tail = "This cannot be undone.";
  if (!memberCount && !grantCount) return `Nobody is in this group and nothing is shared with it. ${tail}`;
  if (!memberCount) return `Nobody is in this group. The ${items} shared with it will no longer be shared with the group. ${tail}`;
  if (!grantCount) return `Nothing is shared with this group, so its ${memberCountLabel(memberCount)} ${memberCount === 1 ? "loses" : "lose"} no access. ${tail}`;
  return `${memberCountLabel(memberCount)} ${memberCount === 1 ? "loses" : "lose"} what owners shared with the group: ${items}. Their own and directly shared items are not affected. ${tail}`;
}
export const guestCountLabel = (count: number) => count ? ` · includes ${count} ${count === 1 ? "guest" : "guests"}` : "";
