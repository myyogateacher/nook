import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { trapTabKey } from "../files/Dialog";
import { PHONE_QUERY, useDialogBackGuard, useMediaQuery } from "../calendar/hooks";
import { badgeLabel, listNotifications, markAllRead, markRead, notificationAge, NOTIFICATIONS_POLLED, safeNotificationPath, useNotificationsContext, type NotificationItem } from "./notificationsApi";
import "./notifications.css";

const POLL_MS = 60_000;
export const NOTIFICATIONS_CHANGED = "mynotes:notifications-changed";

/** Tells every bell on screen to refresh its count (after marking read elsewhere). */
export const announceNotificationsChanged = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

/**
 * The bell in app headers: an unread badge, a popover of recent notifications on desktop (a dialog
 * that pushes no entry and closes on Back through the guard, D69), and the /notifications route on
 * phones. Renders nothing outside the signed-in shell.
 */
export function NotificationBell() {
  const context = useNotificationsContext();
  const phone = useMediaQuery(PHONE_QUERY);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      setUnread((await listNotifications({ unread: true, limit: 1 })).unreadCount);
      // Badges beside the bell (the Inbox count) refresh on the same signal.
      window.dispatchEvent(new Event(NOTIFICATIONS_POLLED));
    } catch {
      // The badge is best-effort; the list shows errors.
    }
  }, []);

  useEffect(() => {
    if (!context) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    const onChange = () => { void refresh(); };
    window.addEventListener("focus", onChange);
    window.addEventListener(NOTIFICATIONS_CHANGED, onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onChange);
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChange);
    };
  }, [context, refresh]);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useDialogBackGuard(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(null);
    listNotifications({ limit: 10 }).then((result) => {
      if (!active) return;
      setItems(result.items);
      setUnread(result.unreadCount);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load notifications"); });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => { active = false; window.removeEventListener("keydown", onKey); };
  }, [open, close]);

  if (!context) return null;

  async function openItem(item: NotificationItem) {
    setOpen(false);
    if (!item.read) {
      await markRead([item.id]).catch(() => undefined);
      announceNotificationsChanged();
    }
    context!.openPath(safeNotificationPath(item.href));
  }

  async function readAll() {
    await markAllRead().catch(() => undefined);
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? current);
    setUnread(0);
    announceNotificationsChanged();
  }

  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return <>
    <button ref={buttonRef} className="app-account-button app-notification-bell" onClick={() => phone ? context.openList() : setOpen((value) => !value)}
      aria-label={label} title="Notifications" aria-haspopup={phone ? undefined : "dialog"} aria-expanded={phone ? undefined : open}>
      <Bell />
      {unread > 0 && <span className="app-notification-badge" aria-hidden="true">{badgeLabel(unread)}</span>}
    </button>
    {open && <>
      <button className="notification-popover-scrim" onClick={close} aria-label="Close notifications" tabIndex={-1} />
      <section className="notification-popover" role="dialog" aria-modal="true" aria-labelledby="notification-popover-title" onKeyDown={trapTabKey}>
        <header>
          <h2 id="notification-popover-title">Notifications</h2>
          {items?.some((item) => !item.read) && <button className="notification-text-button" onClick={() => { void readAll(); }}><CheckCheck />Mark all read</button>}
          <button className="icon-button" onClick={close} aria-label="Close notifications" autoFocus><X /></button>
        </header>
        <NotificationList items={items} error={error} onOpen={(item) => { void openItem(item); }} />
        <footer><button className="notification-text-button" onClick={() => { setOpen(false); context.openList(); }}>See all</button></footer>
      </section>
    </>}
  </>;
}

export function NotificationList({ items, error, onOpen }: { items: NotificationItem[] | null; error: string | null; onOpen: (item: NotificationItem) => void }) {
  if (error) return <p className="notification-empty" role="alert">{error}</p>;
  if (!items) return <p className="notification-empty" role="status">Loading…</p>;
  if (!items.length) return <p className="notification-empty">No notifications yet. Reminders you set on events show up here.</p>;
  return <ul className="notification-list">
    {items.map((item) => <li key={item.id}>
      <button className={`notification-item${item.read ? "" : " unread"}`} onClick={() => onOpen(item)}>
        <span className="notification-dot" aria-hidden="true" />
        <span className="notification-copy">
          <strong>{item.title}</strong>
          <small>{item.read ? "" : "Unread · "}{notificationAge(item.createdAt)}{item.late ? " · delivered late" : ""}</small>
        </span>
      </button>
    </li>)}
  </ul>;
}
