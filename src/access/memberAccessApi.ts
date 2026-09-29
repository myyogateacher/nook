import { api } from "../api";
import type { Role } from "../team/teamRoles";

/**
 * Central access management (Wave 33, access plan §C.6, §C.7, docs/plan/API_CONTRACTS.md): the
 * member access page for admins, Settings → My access for yourself, templates, and the access
 * activity log.
 */

export type AccessKind = "note" | "folder" | "document" | "board" | "task_view" | "collection" | "calendar";
export type AccessLevel = "view" | "comment" | "edit" | "manage";

/** `items`: distinct items (the headline); `direct` and `group`: grant rows, so an item shared both ways is in each. */
export type KindCount = { kind: AccessKind; module: "notes" | "files" | "tasks" | "collections" | "calendar"; items: number; direct: number; group: number; audience: number };
export type ResetCounts = { directShares: number; groups: number; keys: number; feeds: number; routines: number };

export type AccessSummary = {
  member: { id: string; displayName: string; role: Role; status: "active" | "blocked"; isYou: boolean };
  groups: Array<{ id: string; name: string; grantCount: number; memberCount: number; addedAt: string; addedBy: { id: string; displayName: string } | null; selfAdded: boolean }>;
  keys: Array<{ id: string; name: string; prefix: string; state: string; surfaces: string; expiresAt: string | null; lastUsedAt: string | null; modules: string[] }>;
  feeds: { live: number };
  routines: { enabled: number };
  kinds: KindCount[];
  resetCounts: ResetCounts;
  pageSize: number;
};

/** One row. `titleHidden`: the viewer cannot open the item, so the title is "Board owned by Carol" and there is no id (D269). */
export type AccessRow = {
  kind: AccessKind;
  title: string;
  titleHidden: boolean;
  owner: { id: string; displayName: string };
  id?: string;
  level: AccessLevel;
  via: "direct" | "group";
  group: { id: string; name: string } | null;
  active: boolean;
  lowerTo: AccessLevel[];
  /** Admin page only: the opaque handle the reductions take. */
  handle?: string;
};

export type AccessPage = { kind: AccessKind; items: AccessRow[]; nextCursor: string | null };

const memberPath = (userId: string) => `/team/members/${encodeURIComponent(userId)}`;
const pageQuery = (kind: AccessKind, cursor?: string | null) => `?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

export const getMemberAccess = (userId: string) => api<AccessSummary>(`${memberPath(userId)}/access`);
export const getMemberAccessPage = (userId: string, kind: AccessKind, cursor?: string | null) => api<AccessPage>(`${memberPath(userId)}/access${pageQuery(kind, cursor)}`);
export const getMyAccess = () => api<AccessSummary>("/me/access");
export const getMyAccessPage = (kind: AccessKind, cursor?: string | null) => api<AccessPage>(`/me/access${pageQuery(kind, cursor)}`);

export const removeMemberAccess = (userId: string, handle: string) =>
  api<{ removed: "share" | "group"; kind?: AccessKind; groupId?: string }>(`${memberPath(userId)}/access/${encodeURIComponent(handle)}`, { method: "DELETE", body: "{}" });
export const lowerMemberAccess = (userId: string, handle: string, level: AccessLevel) =>
  api<{ lowered: true; from: AccessLevel; to: AccessLevel }>(`${memberPath(userId)}/access/${encodeURIComponent(handle)}`, { method: "PATCH", body: JSON.stringify({ level }) });
export const removeMemberFromGroup = (userId: string, groupId: string) =>
  api<{ groupId: string }>(`${memberPath(userId)}/groups/${encodeURIComponent(groupId)}`, { method: "DELETE", body: "{}" });
export const resetMemberAccess = (userId: string) =>
  api<{ removed: ResetCounts; remaining: ResetCounts }>(`${memberPath(userId)}/access/reset`, { method: "POST", body: "{}" });
export const applyTemplateToMember = (userId: string, templateId: string) =>
  api<{ added: number; skipped: number; templateName: string }>(`${memberPath(userId)}/templates/${encodeURIComponent(templateId)}/apply`, { method: "POST", body: "{}" });

// Templates (D286)
export type TemplateRole = "member" | "viewer" | "guest";
export type AccessTemplate = { id: string; name: string; role: TemplateRole; groups: Array<{ id: string; name: string }>; liveInvites: number; revision: number; createdAt: string; updatedAt: string };

export const listTemplates = () => api<{ templates: AccessTemplate[]; limit: number }>("/team/templates");
export const createTemplate = (body: { name: string; role: TemplateRole; groupIds: string[] }) =>
  api<{ template: AccessTemplate }>("/team/templates", { method: "POST", body: JSON.stringify(body) });
export const patchTemplate = (id: string, body: { name?: string; role?: TemplateRole; groupIds?: string[]; revision: number }) =>
  api<{ template: AccessTemplate }>(`/team/templates/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteTemplate = (id: string, revision: number) =>
  api<{ ok: true; liveInvites: number }>(`/team/templates/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) });

// Access activity (D288)
export type ActivityCategory = "keys" | "groups" | "items" | "policies" | "templates";
export type ActivityEvent = {
  id: string;
  action: string;
  via: string;
  createdAt: string;
  actor: { id: string; displayName: string } | null;
  target: { id: string; displayName: string } | null;
  group: { id: string; name: string | null } | null;
  key: { id: string; name: string | null; prefix: string | null } | null;
  item: { kind: string; title: string; titleHidden: boolean; id?: string } | null;
  meta: Record<string, unknown> | null;
};
export const listAccessActivity = (filter: { user?: string; group?: string; key?: string; action?: ActivityCategory; cursor?: string | null }) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) if (value) params.set(name, value);
  const query = params.toString();
  return api<{ events: ActivityEvent[]; nextCursor: string | null }>(`/team/activity${query ? `?${query}` : ""}`);
};

// ------------------------------------------------------------------ labels

export const KIND_PLURALS: Record<AccessKind, [string, string]> = {
  note: ["note", "notes"], folder: ["folder", "folders"], document: ["file", "files"], board: ["board", "boards"],
  task_view: ["task view", "task views"], collection: ["collection", "collections"], calendar: ["calendar", "calendars"]
};
export const kindCount = (kind: AccessKind, count: number) => `${count} ${KIND_PLURALS[kind][count === 1 ? 0 : 1]}`;

export const MODULE_TITLES: Record<KindCount["module"], string> = { notes: "Notes", files: "Files", tasks: "Tasks", collections: "Collections", calendar: "Calendar" };

export const LEVEL_WORDS: Record<AccessLevel, string> = { view: "Can view", comment: "Can comment", edit: "Can edit", manage: "Manager" };

/** "Can edit (direct)" or "Can view (via Ops)". */
export const viaLabel = (row: Pick<AccessRow, "level" | "via" | "group">) => `${LEVEL_WORDS[row.level]} ${row.via === "direct" ? "(direct)" : `(via ${row.group?.name ?? "a group"})`}`;

/** The confirm copy for Reset access: what goes, what stays. */
export function resetSummary(counts: ResetCounts) {
  const parts = [
    `${counts.directShares} direct ${counts.directShares === 1 ? "share" : "shares"}`,
    `${counts.groups} ${counts.groups === 1 ? "group" : "groups"}`,
    `${counts.keys} API ${counts.keys === 1 ? "key" : "keys"}`,
    `${counts.feeds} calendar ${counts.feeds === 1 ? "feed" : "feeds"}`,
    `${counts.routines} ${counts.routines === 1 ? "routine" : "routines"} paused`
  ];
  return parts.join(" · ");
}

const ACTION_LABELS: Record<string, (event: ActivityEvent) => string> = {
  "key.created": (event) => `${who(event)} created the key ${keyName(event)}`,
  "key.narrowed": (event) => `${who(event)} narrowed the key ${keyName(event)}`,
  "key.rotated": (event) => `${who(event)} rotated the key ${keyName(event)}`,
  "key.revoked": (event) => event.meta?.by === "admin" ? `${who(event)} revoked ${target(event)}'s key ${keyName(event)}` : `${who(event)} revoked the key ${keyName(event)}`,
  "key.grace_ended": (event) => `The rotation grace of ${keyName(event)} ended`,
  "key.policy_blocked": (event) => `A policy blocked the key ${keyName(event)}`,
  "policy.changed": (event) => `${who(event)} changed team policies`,
  "group.created": (event) => `${who(event)} created the group ${groupName(event)}`,
  "group.updated": (event) => `${who(event)} changed the group ${groupName(event)}`,
  "group.deleted": (event) => `${who(event)} deleted a group`,
  "group.member_added": (event) => event.meta?.self ? `${who(event)} added themselves to ${groupName(event)}` : `${who(event)} added ${target(event)} to ${groupName(event)}`,
  "group.member_removed": (event) => `${who(event)} removed ${target(event)} from ${groupName(event)}`,
  "item.access_changed": (event) => `${who(event)} changed who can open ${itemName(event)}`,
  "access.share_removed": (event) => `${who(event)} removed ${target(event)}'s access to ${itemName(event)}`,
  "access.share_lowered": (event) => `${who(event)} lowered ${target(event)}'s access to ${itemName(event)}`,
  "access.reset": (event) => `${who(event)} reset ${target(event)}'s access`,
  "template.created": (event) => `${who(event)} created an access template`,
  "template.updated": (event) => `${who(event)} changed an access template`,
  "template.deleted": (event) => `${who(event)} deleted an access template`,
  "template.applied": (event) => `${who(event)} applied a template to ${target(event)}`
};
const who = (event: ActivityEvent) => event.actor?.displayName ?? (event.via === "sweeper" ? "Nook" : "Someone");
const target = (event: ActivityEvent) => event.target?.displayName ?? "someone";
const keyName = (event: ActivityEvent) => event.key?.name ? `“${event.key.name}”` : "(deleted)";
const groupName = (event: ActivityEvent) => event.group?.name ? `“${event.group.name}”` : "a deleted group";
const itemName = (event: ActivityEvent) => !event.item ? "an item that is gone" : event.item.titleHidden ? event.item.title.replace(/^(\w)/, (letter) => letter.toLowerCase()).replace(/^/, "a ") : `“${event.item.title}”`;

export const activityLabel = (event: ActivityEvent) => (ACTION_LABELS[event.action] ?? ((row: ActivityEvent) => row.action))(event);
