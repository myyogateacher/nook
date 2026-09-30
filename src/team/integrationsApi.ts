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
  status: "active" | "blocked";
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
  blockedAt: string | null;
  blockedBy: { id: string; displayName: string } | null;
  keys: { live: number };
  lastUsedAt: string | null;
};

export type IntegrationDetail = Integration & { events: TeamEvent[]; ownsContent: boolean };

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

/** The Delete confirm's words: what happens depends on whether it created anything (D287). */
export function deleteIntegrationMessage(integration: Pick<IntegrationDetail, "displayName" | "ownsContent" | "keys">) {
  const keys = integration.keys.live ? ` Its ${integration.keys.live === 1 ? "key stops" : `${integration.keys.live} keys stop`} working at once.` : "";
  return integration.ownsContent
    ? `${integration.displayName} created or changed content, so it stays as a blocked integration and its name stays on that content.${keys} Owners' shares with it stay until they remove them.`
    : `${integration.displayName} and everything shared with it are removed.${keys} This cannot be undone.`;
}

/** "Last used 3 days ago" / "Never used", for the list row. */
export const lastUsedText = (integration: Pick<Integration, "lastUsedAt">, relative: (value: string) => string) =>
  integration.lastUsedAt ? `Used ${relative(integration.lastUsedAt)}` : "Never used";
