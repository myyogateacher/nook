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

describe("C7: the Files list/grid toggle is a phone-sized target", () => {
  test("each view button is 44 px at phone widths (32 px on desktop)", async () => {
    const css = await read("files/files.css");
    const phone = css.slice(css.indexOf("@media (max-width: 760px)", css.indexOf(".file-view-toggle {")));
    expect(phone).toContain(".file-view-toggle .icon-button { width: 44px; height: 44px; }");
    expect(css).toContain(".file-view-toggle .icon-button { width: 32px; height: 32px; border-radius: 8px; }");
  });
});
