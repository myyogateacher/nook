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
