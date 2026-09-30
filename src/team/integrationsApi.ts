import { api } from "../api";
import type { KeyList } from "../keys/keysApi";
import type { TeamEvent } from "./teamApi";

/**
 * Team → Integrations (Wave 36, D287): `/api/team/integrations`, admins only. An integration is an
 * account for an AI client or script: it never signs in, and its keys reach only what owners share
 * with it by name.
 */

export type IntegrationRole = "member" | "viewer";

export type Integration = {
  id: string;
  displayName: string;
  description: string | null;
  role: IntegrationRole;
  /** "retired": deleted, kept for attribution; final (review R3). */
  status: "active" | "blocked" | "retired";
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
  blockedAt: string | null;
  blockedBy: { id: string; displayName: string } | null;
  retiredAt: string | null;
  keys: { live: number };
  lastUsedAt: string | null;
};

/** `ownsContent`: it made or touched content; `hadKeys`: it ever had a key. Either keeps it on delete. */
export type IntegrationDetail = Integration & { events: TeamEvent[]; ownsContent: boolean; hadKeys: boolean };

export const listIntegrations = () => api<{ integrations: Integration[]; limit: number }>("/team/integrations");
export const getIntegration = (id: string) => api<{ integration: IntegrationDetail; keys: KeyList }>(`/team/integrations/${encodeURIComponent(id)}`);
export const createIntegration = (body: { name: string; role: IntegrationRole; description?: string | null }) =>
  api<{ integration: IntegrationDetail }>("/team/integrations", { method: "POST", body: JSON.stringify(body) });
export const updateIntegration = (id: string, body: { name?: string; description?: string | null; role?: IntegrationRole; expectedRole?: IntegrationRole }) =>
  api<{ changed: string[]; integration: IntegrationDetail }>(`/team/integrations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const blockIntegration = (id: string) => api<{ integration: IntegrationDetail }>(`/team/integrations/${encodeURIComponent(id)}/block`, { method: "POST", body: "{}" });
export const unblockIntegration = (id: string) => api<{ integration: IntegrationDetail }>(`/team/integrations/${encodeURIComponent(id)}/unblock`, { method: "POST", body: "{}" });
export type DeleteResult = { deleted: true; retained: false; keysRevoked: number } | { deleted: false; retained: true; keysRevoked: number; integration: IntegrationDetail };
export const deleteIntegration = (id: string) => api<DeleteResult>(`/team/integrations/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });

export const INTEGRATION_ROLE_OPTIONS: Array<{ value: IntegrationRole; label: string; description: string }> = [
  { value: "member", label: "Member", description: "Its keys can read and, where an owner gave it Can edit, write" },
  { value: "viewer", label: "Viewer", description: "Its keys can only read" }
];

/** How a deleted integration kept for attribution shows in the list and on its page (review R3). */
export const RETIRED_LABEL = "Deleted (kept for attribution)";
export const RETIRED_HELP = "It can never sign in, be unblocked, or get a key again, and it does not count toward the integration limit. "
  + "Its name stays on what it made and on its keys' history in Access activity.";

/** Whether Delete keeps it (as retired) rather than removing it. */
const keptOnDelete = (integration: Pick<IntegrationDetail, "ownsContent" | "hadKeys">) => integration.ownsContent || integration.hadKeys;

/** The Delete confirm's words: what happens depends on whether it created anything or ever had a key (D287, review R1). */
export function deleteIntegrationMessage(integration: Pick<IntegrationDetail, "displayName" | "ownsContent" | "hadKeys" | "keys">) {
  const keys = integration.keys.live ? ` Its ${integration.keys.live === 1 ? "key stops" : `${integration.keys.live} keys stop`} working at once.` : "";
  if (!keptOnDelete(integration)) return `${integration.displayName} and everything shared with it are removed.${keys} This cannot be undone.`;
  const why = integration.ownsContent ? "created or changed content" : "had API keys";
  return `${integration.displayName} ${why}, so it is kept, blocked for good, and its name stays on what it did and on its keys' history.${keys} `
    + "It can never be unblocked or get a key again. Owners' shares with it stay until they remove them.";
}

/** The toast after a Delete that kept it. */
export const retainedMessage = (integration: Pick<IntegrationDetail, "displayName" | "ownsContent">) =>
  `${integration.displayName} was deleted. It ${integration.ownsContent ? "created content" : "had keys"}, so it is kept for attribution; its keys were revoked.`;

/** "Last used 3 days ago" / "Never used", for the list row. */
export const lastUsedText = (integration: Pick<Integration, "lastUsedAt">, relative: (value: string) => string) =>
  integration.lastUsedAt ? `Used ${relative(integration.lastUsedAt)}` : "Never used";
