import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesApp } from "../src/files/FilesApp";

test("the Files workspace renders its rail, list, and phone panels before data loads", () => {
  const markup = renderToStaticMarkup(<FilesApp userId="u1" displayName="Ada Lovelace" navigate={() => undefined} flash={() => undefined} onHome={() => undefined} onSettings={() => undefined} onSignOut={() => undefined} />);
  expect(markup).toContain("<span class=\"brand-text\"><strong>Files</strong></span>");
  expect(markup).not.toContain("<small>Nook</small>");
  for (const label of ["All files", "Shared with me", "Loading files…", "Select a file"]) expect(markup).toContain(label);
  for (const label of ['aria-label="New folder"', 'aria-label="Filter files by name"', 'aria-label="Sort files: Newest modified"']) expect(markup).toContain(label);
  expect(markup).toContain('data-mobile-panel="folders"');
  expect(markup).toContain('aria-live="polite"');
  expect(markup).toContain('aria-describedby="file-list-keys"');
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('role="status">Loading files…');
  expect(markup).toContain('type="file" multiple=""');
  // Nothing to upload into until the folders are known.
  expect(markup).not.toContain(">Upload</button>");
});

test("the Files pane keeps its folders only: Home, Settings, and Sign out are the sidebar's (D1276)", async () => {
  const props = { userId: "u1", displayName: "Ada Lovelace", navigate: () => undefined, flash: () => undefined, onHome: () => undefined, onSettings: () => undefined, onSignOut: () => undefined };
  const markup = renderToStaticMarkup(<FilesApp {...props} />);
  expect(markup).not.toContain('<footer class="sidebar-footer">');
  expect(markup).not.toContain("nav-home");
  expect(markup).not.toContain("footer-bin");
  expect(markup).not.toContain(">Sign out<");
  // Uploads still ask before the sidebar leaves Files (C1).
  const source = await Bun.file(new URL("../src/files/FilesApp.tsx", import.meta.url)).text();
  expect(source).toContain("useShellLeaveGuard((leave) => { void leaveFiles(leave); });");
});
