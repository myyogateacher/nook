import { withoutRouteNames } from "../routeNames";
import { createContext, useContext } from "react";
import { api } from "../api";
import { formatRoute, parseRoute } from "../router";

export type NotificationItem = { id: string; kind?: "reminder" | "proposals" | "access"; title: string; href: string; late: boolean; read: boolean; createdAt: string; occurrenceStart: string | null };
export type NotificationList = { items: NotificationItem[]; unreadCount: number };

/** The topic of an @mention notification (docs/plan/MENTIONS.md D1333): the page's Mentions view asks for it. */
export const MENTION_TOPIC = "core.mention";

export const listNotifications = (options: { unread?: boolean; limit?: number; topic?: string } = {}) => {
  const params = new URLSearchParams();
  if (options.topic) params.set("topic", options.topic);
  if (options.unread) params.set("unread", "1");
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return api<NotificationList>(`/notifications${query ? `?${query}` : ""}`);
};
export const markRead = (ids: string[]) => api<{ ok: true; updated: number }>("/notifications/read", { method: "POST", body: JSON.stringify({ ids }) });
export const markAllRead = () => api<{ ok: true; updated: number }>("/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });

/** At most this long: the server's longest path is well under it. */
const MAX_PATH = 200;

/**
 * The in-app path a notification opens (bell deep links, v0.32). The server builds every href from
 * ids only (T68); the client follows it only when it is a same-origin path the router itself would
 * write: parsing it and formatting it back must give the same text (so every id matches the id
 * pattern, ids are written lowercase, and nothing else rides along), and it must name a page, not fall through to Home.
 * Anything else opens the notifications list. The page then loads the item as usual, so an item
 * the reader can no longer open shows that module's own "not found" state, never its content.
 */
export function safeNotificationPath(href: unknown) {
  if (typeof href !== "string" || href.length > MAX_PATH || !href.startsWith("/") || href.startsWith("//") || /[\\\s#]/.test(href)) return "/notifications";
  // Ids are compared without case: the router writes them lowercase, and so does the server. The check
  // runs without this tab's names (D774), so a UUID href and a friendly one (/tasks/MYT-12) both pass
  // as written; opening it then canonicalizes the URL.
  const { route, path } = withoutRouteNames(() => {
    const parsed = parseRoute(href);
    return { route: parsed, path: formatRoute(parsed) };
  });
  if (route.app === "home" || path.toLowerCase() !== href.toLowerCase()) return "/notifications";
  return path;
}

/**
 * D1260: the in-app path an embed's "Open" (a goal, form, townhall, whiteboard card) or a sheet's
 * "Open in …" asks for through the nook:open-path event, checked as a notification's href is; null
 * for anything the router would not open as written (the event is then ignored).
 */
export function inAppOpenPath(href: unknown): string | null {
  const path = safeNotificationPath(href);
  return path === "/notifications" && (typeof href !== "string" || href.toLowerCase() !== "/notifications") ? null : path;
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
