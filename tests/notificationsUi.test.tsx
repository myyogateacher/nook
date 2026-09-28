import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountActions } from "../src/AppShell";
import { createAppHistoryState, readAppHistorySection } from "../src/appShellNavigation";
import { reminderLabel } from "../src/calendar/EventReminders";
import { popStateClosedDialog, registerHistoryDialogGuard } from "../src/historyDialogs";
import { badgeLabel, notificationAge, NotificationsContext, safeNotificationPath } from "../src/notifications/notificationsApi";
import { NotificationsApp } from "../src/notifications/NotificationsApp";
import { formatRoute, parseRoute } from "../src/router";

const eventId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const account = { displayName: "Ada", onSettings: () => undefined, onSignOut: () => undefined };

test("/notifications is a route and an app section", () => {
  expect(parseRoute("/notifications")).toEqual({ app: "notifications" });
  expect(parseRoute("/notifications/")).toEqual({ app: "notifications" });
  expect(parseRoute("/notifications/extra")).toEqual({ app: "home" });
  expect(formatRoute({ app: "notifications" })).toBe("/notifications");
  expect(readAppHistorySection(createAppHistoryState("user-1", "notifications", null), "user-1")).toBe("notifications");
});

test("notification clicks follow only same-origin event paths built from ids (T68)", () => {
  expect(safeNotificationPath(`/calendar/event/${eventId}`)).toBe(`/calendar/event/${eventId}`);
  expect(safeNotificationPath(`/calendar/event/${eventId.toUpperCase()}`)).toBe(`/calendar/event/${eventId}`);
  for (const hostile of ["https://evil.example/calendar/event/x", "//evil.example", "javascript:alert(1)", `/calendar/event/${eventId}/../../x`, `/calendar/event/${eventId}?next=//evil`, "/calendar/event/not-an-id", "/notes/x", ""]) {
    expect(safeNotificationPath(hostile)).toBe("/notifications");
  }
});

test("dialog guards stack: the newest is asked first, and an idle one lets the next handle Back", () => {
  let appDialogOpen = true;
  let popoverOpen = false;
  const calls: string[] = [];
  const unregisterApp = registerHistoryDialogGuard(() => { calls.push("app"); if (!appDialogOpen) return false; appDialogOpen = false; return true; });
  const unregisterBell = registerHistoryDialogGuard(() => { calls.push("bell"); if (!popoverOpen) return false; popoverOpen = false; return true; });
  expect(popStateClosedDialog({})).toBe(true);
  expect(calls).toEqual(["bell", "app"]);
  popoverOpen = true;
  appDialogOpen = true;
  calls.length = 0;
  expect(popStateClosedDialog({})).toBe(true);
  expect(calls).toEqual(["bell"]);
  expect(appDialogOpen).toBe(true);
  unregisterBell();
  calls.length = 0;
  expect(popStateClosedDialog({})).toBe(true);
  expect(calls).toEqual(["app"]);
  expect(popStateClosedDialog({})).toBe(false);
  unregisterApp();
  expect(popStateClosedDialog({})).toBe(false);
});

test("the bell renders only inside the signed-in shell, next to the account group", () => {
  expect(renderToStaticMarkup(<AccountActions {...account} />)).not.toContain("app-notification-bell");
  const markup = renderToStaticMarkup(<NotificationsContext.Provider value={{ openList: () => undefined, openPath: () => undefined }}><AccountActions {...account} /></NotificationsContext.Provider>);
  expect(markup).toContain('class="app-account-button app-notification-bell"');
  expect(markup).toContain('aria-label="Notifications"');
  // The account group itself still holds exactly Settings and Sign out.
  const group = markup.match(/<div class="app-account" role="group" aria-label="Account">(.*?)<\/div>/)?.[1] ?? "";
  expect([...group.matchAll(/<button/g)].length).toBe(2);
});

test("the notifications page shows its loading state, Back, and the account actions", () => {
  const markup = renderToStaticMarkup(<NotificationsApp {...account} onHome={() => undefined} onOpenPath={() => undefined} />);
  expect(markup).toContain("<strong>Notifications</strong>");
  expect(markup).toContain(">Back</button>");
  expect(markup).toContain("Loading…");
});

test("labels for ages, badges, and reminder offsets", () => {
  const now = Date.parse("2031-01-10T12:00:00Z");
  expect(notificationAge("2031-01-10T11:59:40Z", now)).toBe("Just now");
  expect(notificationAge("2031-01-10T11:45:00Z", now)).toBe("15 min ago");
  expect(notificationAge("2031-01-10T09:00:00Z", now)).toBe("3 h ago");
  expect(notificationAge("2031-01-09T09:00:00Z", now)).toBe("Yesterday");
  expect(notificationAge("2031-01-05T09:00:00Z", now)).toBe("5 days ago");
  expect(badgeLabel(7)).toBe("7");
  expect(badgeLabel(120)).toBe("99+");
  expect(reminderLabel(0, false)).toBe("At the start");
  expect(reminderLabel(15, false)).toBe("15 minutes before");
  expect(reminderLabel(60, false)).toBe("1 hour before");
  expect(reminderLabel(1440, false)).toBe("1 day before");
  expect(reminderLabel(10_080, false)).toBe("1 week before");
  expect(reminderLabel(-30, false)).toBe("30 minutes after the start");
  expect(reminderLabel(-540, true)).toBe("9:00 on the day");
  expect(reminderLabel(900, true)).toBe("9:00 the day before");
  expect(reminderLabel(2340, true)).toBe("9:00, 2 days before");
  expect(reminderLabel(9540, true)).toBe("9:00 a week before");
});

test("the calendar Today button and notification text buttons are 44 px targets (L6)", async () => {
  const calendarCss = await Bun.file(new URL("../src/calendar/calendar.css", import.meta.url)).text();
  expect(calendarCss.slice(calendarCss.indexOf("@media (max-width: 760px)"))).toMatch(/\.calendar-today-button \{ min-height: 44px; \}/);
  const notificationsCss = await Bun.file(new URL("../src/notifications/notifications.css", import.meta.url)).text();
  expect(notificationsCss).toMatch(/\.notification-text-button \{ min-height: 44px;/);
});

test("the Push new proposals row wraps its text instead of overflowing the card (3b)", async () => {
  const css = await Bun.file(new URL("../src/notifications/notifications.css", import.meta.url)).text();
  // No icon: a text column sized to its content (the base three-column grid) ran 766 px in a 710 px box.
  expect(css).toContain(".modules-row.notification-proposals-row { grid-template-columns: minmax(0, 1fr) auto; }");
  const source = await Bun.file(new URL("../src/notifications/NotificationSettings.tsx", import.meta.url)).text();
  expect(source).toContain("className=\"modules-row notification-proposals-row\"");
});
