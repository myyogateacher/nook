// Nook service worker (WAVES_10-12.md D65, §4.4, T68, T69). Handwritten, scoped to "/".
//
// Pushes are payload-less: a push only wakes this worker, which fetches the unread
// notifications from Nook with the session cookie and shows them. There is deliberately no
// fetch handler: this worker never sees or caches page or API traffic. Clicking a notification
// opens only same-origin paths rebuilt from ids.

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_TITLE = "You have a reminder in Nook";
const ICON = "/icons/nook-192.png";
const MAX_SHOWN = 5;

/** The only paths a notification may open: an event page built from its id, or the list. */
function safePath(href) {
  // The agent inbox (Wave 21): proposal notifications open the Inbox.
  if (href === "/inbox") return "/inbox";
  const match = typeof href === "string" ? /^\/calendar\/event\/([^/?#]+)$/.exec(href) : null;
  return match && idPattern.test(match[1]) ? `/calendar/event/${match[1].toLowerCase()}` : "/notifications";
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function showUnread() {
  let items = [];
  try {
    const response = await fetch("/api/notifications?unread=1&limit=5", { credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (response.ok) {
      const body = await response.json();
      if (body && Array.isArray(body.items)) items = body.items;
    }
  } catch {
    // Signed out, offline, or the server is unreachable: fall back to the generic notice.
  }
  const valid = items.filter((item) => item && typeof item.id === "string" && idPattern.test(item.id) && typeof item.title === "string").slice(0, MAX_SHOWN);
  if (!valid.length) {
    await self.registration.showNotification(GENERIC_TITLE, { tag: "nook-reminder", icon: ICON, data: { path: "/notifications" } });
    return;
  }
  await Promise.all(valid.map((item) => self.registration.showNotification(item.title.slice(0, 200), {
    // tag = notification id, so a repeated push never shows the same reminder twice.
    tag: item.id,
    body: item.late ? "Calendar reminder (delivered late)" : "Calendar reminder",
    icon: ICON,
    data: { path: safePath(item.href) }
  })));
}

self.addEventListener("push", (event) => {
  event.waitUntil(showUnread());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.path);
  event.waitUntil((async () => {
    const target = new URL(path, self.location.origin);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        await client.focus();
        if ("navigate" in client) await client.navigate(target.href);
        return;
      } catch {
        // The window could not be focused or navigated: open the same safe path instead.
        break;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
