import { createContext, useContext } from "react";
import { api } from "../api";

export type NotificationItem = { id: string; title: string; href: string; late: boolean; read: boolean; createdAt: string; occurrenceStart: string | null };
export type NotificationList = { items: NotificationItem[]; unreadCount: number };

export const listNotifications = (options: { unread?: boolean; limit?: number } = {}) => {
  const params = new URLSearchParams();
  if (options.unread) params.set("unread", "1");
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return api<NotificationList>(`/notifications${query ? `?${query}` : ""}`);
};
export const markRead = (ids: string[]) => api<{ ok: true; updated: number }>("/notifications/read", { method: "POST", body: JSON.stringify({ ids }) });
export const markAllRead = () => api<{ ok: true; updated: number }>("/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The in-app path a notification opens. Only the shapes the server builds are followed, and only
 * same-origin paths (T68): anything else opens the notifications list.
 */
export function safeNotificationPath(href: string) {
  // Proposal notifications (agent inbox D159) open the Inbox.
  if (href === "/inbox") return "/inbox";
  // "Shared the vault … with you" (Wave 26) opens that vault.
  const vault = /^\/vault\/([^/?#]+)$/.exec(href);
  if (vault && idPattern.test(vault[1]!)) return `/vault/${vault[1]!.toLowerCase()}`;
  const match = /^\/calendar\/event\/([^/?#]+)$/.exec(href);
  return match && idPattern.test(match[1]!) ? `/calendar/event/${match[1]!.toLowerCase()}` : "/notifications";
}

/** "Just now", "5 min ago", "3 h ago", "2 days ago". */
export function notificationAge(createdAt: string, nowMs = Date.now()) {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/** Fired after each bell refresh (its poll, focus, or a change), so other account-row badges follow it. */
export const NOTIFICATIONS_POLLED = "mynotes:notifications-polled";

export const badgeLabel = (count: number) => count > 99 ? "99+" : String(count);

/** What the app shell gives the bell: how to open the full list and a notification's target. */
export type NotificationsContextValue = { openList: () => void; openPath: (path: string) => void };
export const NotificationsContext = createContext<NotificationsContextValue | null>(null);
export const useNotificationsContext = () => useContext(NotificationsContext);
