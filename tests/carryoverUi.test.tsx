import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MutedTag } from "../src/calendar/CalendarsDialog";

// Small UI carry-overs after v0.13.0 (C6–C8, C11). The browser checks at 1280 × 800 and 390 × 844
// are in TEST_PLAN "Carry-overs after v0.13.0".

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

describe("C6: a muted calendar says Muted in words", () => {
  test("the tag is text with a tooltip, its icon hidden from screen readers", () => {
    const markup = renderToStaticMarkup(<MutedTag />);
    expect(markup).toContain(">Muted</span>");
    expect(markup).toContain('title="No activity emails from this calendar"');
    expect(markup).toContain('aria-hidden="true"');
  });

  test("it leads the calendar's line, so a long role line cannot cut it off at 390 px", async () => {
    const source = await read("calendar/CalendarsDialog.tsx");
    expect(source).toContain('<small>{mutes.loaded && mutes.isMuted("calendar", calendar.id) && <><MutedTag /> · </>}{roleLabel(calendar)}</small>');
  });
});

describe("C8: Calendar's header has the Bin button, as the other modules do", () => {
  test("CalendarApp passes onBin and its count to AccountActions, and the app hands it the Bin", async () => {
    const calendar = await read("calendar/CalendarApp.tsx");
    expect(calendar).toContain("const binCount = useBinCount(Boolean(onBin));");
    expect(calendar).toContain("<AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />");
    const app = await read("App.tsx");
    expect(app).toMatch(/<CalendarApp [^\n]*onBin=\{openBin\}/);
  });
});

describe("C11a: the change-password hint offers Forgot password? only when it exists", () => {
  test("with /api/about passwordReset it points at Forgot password?; without it, at an admin", async () => {
    const { forgotCurrentHint } = await import("../src/auth/ChangePassword");
    expect(forgotCurrentHint(true)).toContain("Sign out and use “Forgot password?”.");
    expect(forgotCurrentHint(false)).not.toContain("Forgot password?");
    expect(forgotCurrentHint(false)).toContain("ask an admin");
    const app = await read("App.tsx");
    expect(app).toContain("<ChangePasswordCard totpEnabled={state.enabled} passwordReset={appInfo.passwordReset === true} />");
    const card = await read("auth/ChangePassword.tsx");
    expect(card).toContain('<small className="password-change-hint">{forgotCurrentHint(passwordReset)}</small>');
  });
});

describe("C11c: Move to folder… for the open note, on phones and desktop", () => {
  test("the Files Move sheet, as a history layer, from the toolbar and the phone ⋯ menu", async () => {
    const app = await read("App.tsx");
    expect(app).toContain("useHistoryDialogGuard(movingNote, closeMoveNote);");
    expect(app).toContain('aria-label="Move to folder…" title="Move to folder"><FolderInput /></button>');
    expect(app).toContain("<FolderInput />Move to folder…</button>");
    expect(app).toMatch(/movingNote && note && <MoveSheet[\s\S]*?itemLabel="note"[\s\S]*?onMove=\{async \(folder\) => \{ await moveNote\(note\.id, folder\); closeMoveNote\(\); \}\}/);
  });

  test("the sheet names the note and lists owned folders with the current one disabled", async () => {
    const { MoveSheet } = await import("../src/files/MoveSheet");
    const folder = (id: string, name: string, extra = {}) => ({ id, name, owner_id: "u", is_owner: 1, is_default: 0, parent_id: null, visibility: "private", created_at: "", updated_at: "", ...extra }) as never;
    const markup = renderToStaticMarkup(<MoveSheet document={{ name: "Plans", folder_id: "f1" }} itemLabel="note" folders={[folder("f1", "Default", { is_default: 1 }), folder("f2", "Archive"), folder("f3", "Theirs", { is_owner: 0 })]} onMove={async () => undefined} onCancel={() => undefined} />);
    expect(markup).toContain("Move “Plans”");
    expect(markup).toContain("Archive");
    expect(markup).toContain("Current folder");
    expect(markup).not.toContain("Theirs");
  });
});

describe("C7: the Files list/grid toggle is a phone-sized target", () => {
  test("each view button is 44 px at phone widths (32 px on desktop)", async () => {
    const css = await read("files/files.css");
    const phone = css.slice(css.indexOf("@media (max-width: 760px)", css.indexOf(".file-view-toggle {")));
    expect(phone).toContain(".file-view-toggle .icon-button { width: 44px; height: 44px; }");
    expect(css).toContain(".file-view-toggle .icon-button { width: 32px; height: 32px; border-radius: 8px; }");
  });
});

describe("Q3 and Q4 (end-user QA, final carry-overs)", () => {
  test("bell notices wrap to three lines instead of being cut off", async () => {
    const css = await read("notifications/notifications.css");
    expect(css).toContain(".notification-copy strong { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3;");
    expect(css).not.toMatch(/\.notification-copy strong \{[^}]*white-space: nowrap/);
  });

  test("target sizes: the dialog close is 40 px on desktop and 44 px on phones; the note toolbar's ⋯ and Back are 44 px on phones", async () => {
    const files = await read("files/files.css");
    expect(files).toContain(".file-dialog-header .icon-button { width: 40px; height: 40px; }");
    expect(files).toContain("  .file-dialog-header .icon-button { width: 44px; height: 44px; }");
    const styles = await read("styles.css");
    expect(styles).toContain(".toolbar-actions .mobile-more, .mobile-editor-nav .icon-button { width: 44px; height: 44px; }");
  });

  test("focus: Discard from the phone ⋯ menu returns to ⋯; a new API key takes focus", async () => {
    const app = await read("App.tsx");
    expect(app).toContain('void discard(document.querySelector<HTMLElement>(".toolbar-actions .mobile-more"));');
    const keys = await read("keys/KeysSettings.tsx");
    expect(keys).toContain("window.requestAnimationFrame(() => window.requestAnimationFrame(() => tokenFieldRef.current?.focus()));");
    expect(keys).toContain('<textarea ref={tokenFieldRef} readOnly value={newToken.token} aria-label="New API key"');
  });

  test("the Access sheet stops offering guests once guest sharing is known to be off", async () => {
    const { pickerOptions, draftFrom } = await import("../src/access/accessModel");
    const access = { etag: "x", kind: "note", title: "N", owner: { id: "o", displayName: "O" }, audience: "selected", audienceLevel: "view", audienceLevels: ["view"], people: [], groups: [], levels: ["view", "edit"], yourLevel: "owner", shareWithGuests: true, inheritable: true } as never;
    const people = [{ id: "g", displayName: "Gia", role: "guest" }, { id: "m", displayName: "Mo", role: "member" }] as never;
    const labels = (shareWithGuests: boolean) => pickerOptions(draftFrom({ ...(access as object), shareWithGuests } as never), { ...(access as object), shareWithGuests } as never, people, []).map((option) => option.label);
    expect(labels(true)).toEqual(["Gia", "Mo"]);
    expect(labels(false)).toEqual(["Mo"]);
  });

  test("Q4: a key blocked for having no expiry says why and what to do", async () => {
    const { blockedLine, EXPIRY_BLOCKED_TEXT } = await import("../src/keys/KeysSettings");
    expect(EXPIRY_BLOCKED_TEXT).toBe("Blocked by team policy: keys need an expiry. Rotate it to give it one.");
    expect(blockedLine({ blockedBy: "expiry_required", blockedMessage: "Team policy requires…" })).toBe(EXPIRY_BLOCKED_TEXT);
    expect(blockedLine({ blockedBy: "lifetime", blockedMessage: "Too long" })).toBe("Too long");
    // The Docker verify stage has no docs/: check the guide only where it exists.
    const guide = Bun.file(new URL("../docs/USING.md", import.meta.url));
    if (await guide.exists()) expect(await guide.text()).toContain(EXPIRY_BLOCKED_TEXT);
  });
});
