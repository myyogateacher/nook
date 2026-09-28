import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { dueText, durationText, groupTitle, KIND_OPTIONS, runLine, runMetrics, runStatusLabel } from "../src/inbox/inboxFormat";
import { boardPinLabels, RoutinesPane } from "../src/inbox/RoutinesPane";
import type { Routine } from "../src/inbox/inboxApi";

/** The Routines segment of the Inbox (agent inbox Wave 22, §9.1, §9.2 C). */

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "0b8f3c1e-1111-4222-8333-444455556666", name: "Weekly review", instructions: "x", outputKinds: ["card_create"], targets: null, scopeHints: null,
  cadence: "daily", atTime: "08:00", weekday: null, tz: "UTC", scheduleNote: null, scheduleText: "Daily at 08:00", keyId: null, keyName: null, keyRevoked: false,
  maxProposals: 25, expireDays: 14, enabled: true, nextDueAt: "2026-09-28T08:00:00.000Z", due: true, lastRunAt: null, lastRunStatus: null, running: null,
  revision: 1, createdAt: "2026-09-28T07:00:00.000Z", updatedAt: "2026-09-28T07:00:00.000Z", ...overrides
});

describe("routines UI", () => {
  test("/inbox/routines parses and formats; anything after it opens the list", () => {
    expect(parseRoute("/inbox/routines")).toEqual({ app: "inbox", view: "routines", proposalId: null });
    expect(parseRoute("/inbox/routines/whatever")).toEqual({ app: "inbox", view: "routines", proposalId: null });
    expect(formatRoute({ app: "inbox", view: "routines", proposalId: null })).toBe("/inbox/routines");
    expect(formatRoute({ app: "inbox", view: "routines", proposalId: "0b8f3c1e-1111-4222-8333-444455556666" })).toBe("/inbox/routines");
  });

  test("due text, run labels, and metrics", () => {
    const now = Date.parse("2026-09-28T09:00:00.000Z");
    expect(dueText(routine(), now)).toBe("Due now");
    expect(dueText(routine({ enabled: false }), now)).toBe("Paused");
    expect(dueText(routine({ cadence: "manual", nextDueAt: null }), now)).toBe("Manual only");
    expect(dueText(routine({ running: { id: "r", startedAt: "", leaseExpiresAt: "" } }), now)).toBe("Running now");
    expect(dueText(routine({ nextDueAt: "2026-09-29T08:00:00.000Z" }), now)).toStartWith("Next ");
    expect(runStatusLabel("abandoned")).toBe("Abandoned");
    expect(durationText(45_000)).toBe("45 s");
    expect(durationText(3_900_000)).toBe("1 h 5 min");
    expect(runMetrics({ proposals: 1, toolCalls: 31, durationMs: 120_000, capped: true })).toBe("1 proposal · 31 tool calls · 2 min · hit the per-run limit");
    expect(KIND_OPTIONS.map((option) => option.value)).toHaveLength(8);
  });

  test("a run group is titled by its routine, with the run line", () => {
    const group = { routine: { id: "a", name: "Weekly review" }, run: { id: "r", startedAt: "2026-09-28T08:02:00.000Z", summary: "Done", status: "abandoned", capped: true }, key: { name: "cron-box" }, items: [] };
    expect(groupTitle(group)).toBe("Weekly review");
    expect(runLine(group.run)).toContain("Abandoned · limit reached");
  });

  test("the pane renders its heading, the new-routine action for writers only, and the client recipe", () => {
    const writer = renderToStaticMarkup(<RoutinesPane canWrite flash={() => undefined} />);
    expect(writer).toContain("New routine");
    expect(writer).toContain("list_due_routines");
    expect(writer).toContain("finish_run");
    expect(writer).not.toContain("<select");
    const viewer = renderToStaticMarkup(<RoutinesPane canWrite={false} flash={() => undefined} />);
    expect(viewer).not.toContain("New routine");
  });

  test("\"Only in\" tells same-name boards apart by owner, else by created date (Friction 8)", () => {
    const labels = boardPinLabels([
      { id: "a", name: "Roadmap", owner_name: "Asha", created_at: "2026-01-05T10:00:00.000Z" },
      { id: "b", name: "Roadmap", owner_name: "Ben", created_at: "2026-02-05T10:00:00.000Z" },
      { id: "c", name: "Ops", owner_name: "Asha", created_at: "2026-03-05T10:00:00.000Z" },
      { id: "d", name: "Ops", owner_name: "Asha", created_at: "2026-04-05T10:00:00.000Z" },
      { id: "e", name: "Solo", owner_name: "Asha", created_at: "2026-04-05T10:00:00.000Z" }
    ]);
    expect(labels.get("a")).toBe("Roadmap (Asha)");
    expect(labels.get("b")).toBe("Roadmap (Ben)");
    expect(labels.get("c")).toStartWith("Ops (Asha, created ");
    expect(labels.get("c")).not.toBe(labels.get("d"));
    expect(labels.get("e")).toBe("Solo");
  });

  test("new controls keep 44 px touch targets", async () => {
    const css = await Bun.file(new URL("../src/inbox/inbox.css", import.meta.url)).text();
    for (const selector of [".inbox-recipe summary {", ".routine-check {", ".routine-zone .inbox-link-button {"]) {
      const rule = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
      expect({ selector, has: /min-height: 44px/.test(rule) }).toEqual({ selector, has: true });
    }
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
  });
});
