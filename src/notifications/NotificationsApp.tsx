import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCheck, House, RotateCcw, Sparkles } from "lucide-react";
import { AccountActions, AppPageName } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { announceNotificationsChanged, NotificationList } from "./NotificationBell";
import { listNotifications, markAllRead, markRead, safeNotificationPath, type NotificationItem } from "./notificationsApi";
import "./notifications.css";

type NotificationsAppProps = {
  displayName: string;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens a notification's in-app path as a new history entry. */
  onOpenPath: (path: string) => void;
};

/** /notifications: the full list (the phone view of the bell; desktops can open it from the popover). */
export function NotificationsApp({ displayName, onHome, onSettings, onSignOut, onOpenPath }: NotificationsAppProps) {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await listNotifications({ limit: 50 });
      setItems(result.items);
      setUnread(result.unreadCount);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load notifications");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function open(item: NotificationItem) {
    if (!item.read) {
      await markRead([item.id]).catch(() => undefined);
      announceNotificationsChanged();
    }
    onOpenPath(safeNotificationPath(item.href));
  }

  async function readAll() {
    await markAllRead().catch(() => undefined);
    announceNotificationsChanged();
    void load();
  }

  // In-app Back: the previous entry of this visit, otherwise Home (never out of Nook).
  const back = () => { if (readHistoryDepth(window.history.state) > 0) window.history.back(); else onHome(); };

  return <main className="app-page notifications-app">
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Notifications</strong></span></span><AppPageName name="Notifications" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <section className="notifications-content" aria-labelledby="notifications-title">
      <button className="calendar-back notifications-back" onClick={back}><ArrowLeft />Back</button>
      <div className="notifications-intro">
        <h1 id="notifications-title">Notifications</h1>
        {unread > 0 && <button className="secondary-button notifications-read-all" onClick={() => { void readAll(); }}><CheckCheck />Mark all read</button>}
      </div>
      {error ? <div className="notification-empty" role="alert"><p>{error}</p><button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button></div>
        : <NotificationList items={items} error={null} onOpen={(item) => { void open(item); }} />}
    </section>
  </main>;
}
