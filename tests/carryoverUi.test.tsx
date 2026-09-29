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
