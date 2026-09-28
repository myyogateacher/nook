import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderInboxButton, INBOX_COUNT_SIGNALS, InboxNavContext, type InboxNav } from "../src/AppShell";
import { INBOX_CHANGED } from "../src/inbox/inboxApi";
import { NOTIFICATIONS_POLLED } from "../src/notifications/notificationsApi";

const root = join(import.meta.dir, "..", "src");

test("the Inbox badge refreshes on the bell's signal, not only on load and focus (QA note 1)", async () => {
  expect(INBOX_COUNT_SIGNALS).toContain(NOTIFICATIONS_POLLED);
  expect(INBOX_COUNT_SIGNALS).toContain(INBOX_CHANGED);
  const bell = await Bun.file(join(root, "notifications", "NotificationBell.tsx")).text();
  expect(bell).toContain("window.dispatchEvent(new Event(NOTIFICATIONS_POLLED))");
});

test("Home keeps Sign out and Inbox together and the Inbox badge matches the bell (QA note 2)", async () => {
  const css = await Bun.file(join(root, "appShell.css")).text();
  expect(css).toMatch(/\.app-home-header \{ justify-content: flex-start; gap: 4px; \}/);
  expect(css).toMatch(/\.app-account-inbox \.app-account-badge \{ background: var\(--yellow\);/);
});

test("the Files header gets the Inbox button with the account row's rules (QA note 3)", async () => {
  const render = (nav: InboxNav | null) => renderToStaticMarkup(<InboxNavContext.Provider value={nav}><HeaderInboxButton /></InboxNavContext.Provider>);
  const member = render({ role: "member", openInbox: () => undefined, onInbox: false });
  expect(member).toContain('class="app-account-button app-account-inbox"');
  expect(member).toContain('aria-label="Inbox"');
  expect(render({ role: "guest", openInbox: () => undefined, onInbox: false })).toBe("");
  expect(render({ role: "member", openInbox: () => undefined, onInbox: true })).toBe("");
  expect(render(null)).toBe("");
  const files = await Bun.file(join(root, "files", "FilesApp.tsx")).text();
  expect(files).toMatch(/<HeaderInboxButton \/>\s*<NotificationBell \/>/);
  // The extra button leaves no room for the Upload label on phones; it stays the button's name.
  expect(files).toContain('<Upload /><span className="files-upload-label">Upload</span>');
  const css = await Bun.file(join(root, "files", "files.css")).text();
  expect(css).toMatch(/@media \(max-width: 760px\) \{ \.files-upload-button \{ width: 44px;[^}]*\} \.files-upload-label \{ position: absolute;/);
});
