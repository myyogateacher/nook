import { expect, test } from "bun:test";
import { join } from "node:path";
import { INBOX_COUNT_SIGNALS } from "../src/AppShell";
import { INBOX_CHANGED } from "../src/inbox/inboxApi";
import { NOTIFICATIONS_POLLED } from "../src/notifications/notificationsApi";

const root = join(import.meta.dir, "..", "src");

test("the Inbox badge refreshes on the bell's signal, not only on load and focus (QA note 1)", async () => {
  expect(INBOX_COUNT_SIGNALS).toContain(NOTIFICATIONS_POLLED);
  expect(INBOX_COUNT_SIGNALS).toContain(INBOX_CHANGED);
  const bell = await Bun.file(join(root, "notifications", "NotificationBell.tsx")).text();
  // D1272: the poll's count rides on the event, for the sidebar's Notifications badge.
  expect(bell).toContain("window.dispatchEvent(new CustomEvent(NOTIFICATIONS_POLLED, { detail: { unread: unreadCount } }))");
});

test("the Inbox badge is the bell's bright badge (QA note 2), now on the sidebar's Inbox row (D1270)", async () => {
  const css = await Bun.file(join(root, "shell", "sidebar.css")).text();
  expect(css).toMatch(/\.app-sidebar-badge \{[^}]*background: var\(--yellow\);/);
});

test("Files has no Inbox button of its own: the sidebar's Inbox row serves every app (QA note 3, D1276)", async () => {
  const files = await Bun.file(join(root, "files", "FilesApp.tsx")).text();
  expect(files).not.toContain("HeaderInboxButton");
  expect(files).toContain("<NotificationBell />");
  // The extra button leaves no room for the Upload label on phones; it stays the button's name.
  // U6: the Upload button moved into the Upload menu component.
  const uploadMenu = await Bun.file(join(root, "files", "UploadMenu.tsx")).text();
  expect(files).toContain("<UploadMenu ");
  expect(uploadMenu).toContain('<Upload /><span className="files-upload-label">Upload</span>');
  const css = await Bun.file(join(root, "files", "files.css")).text();
  expect(css).toMatch(/@media \(max-width: 760px\) \{ \.files-upload-button \{ width: 44px;[^}]*\} \.files-upload-label \{ position: absolute;/);
});
