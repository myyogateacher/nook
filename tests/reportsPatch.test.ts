import { describe, expect, test } from "bun:test";
import type { ReportSpec } from "../shared/reports";
import { applyPatch, diffSpecs, parsePatch, withoutUnusedQueries } from "../server/reports/patch";

/**
 * Wave 48 patches (server/reports/patch.ts, D451): ops on whole blocks, so fields this code does not
 * know (a later spec version's) pass through every op; provenance is never set or cleared by a patch;
 * errors name the op; the diff the review shows.
 */

const spec = (): ReportSpec => ({
  version: 1,
  queries: [
    { key: "daily", sql: "SELECT day, sum(x) AS v FROM analytics.t GROUP BY day", purpose: "per day", createdBy: "agent" },
    { key: "by_country", sql: "SELECT country, sum(x) AS v FROM analytics.t GROUP BY country", purpose: "per country", createdBy: "agent" }
  ],
  blocks: [
    { id: "intro", type: "markdown", markdown: "Hello", provenance: { runId: "r1", version: 1 } },
    // `width` and `intent` stand for fields a later spec version adds.
    { id: "chart", type: "chart", queryKey: "daily", kind: "line", x: "day", y: ["v"], provenance: { runId: "r1", version: 1 }, ...{ width: "half", intent: "trend" } } as ReportSpec["blocks"][number],
    { id: "table", type: "table", queryKey: "by_country" }
  ]
});

const ok = (result: ReturnType<typeof applyPatch>) => {
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.spec;
};

describe("applyPatch", () => {
  test("add, update, move, and remove keep unknown block fields and never touch provenance", () => {
    const before = spec();
    const after = ok(applyPatch(before, { ops: [
      { op: "add_block", after: "intro", block: { id: "new", type: "chart", queryKey: "by_country", kind: "bar", x: "country", y: ["v"], section: "Countries", provenance: { runId: "forged", version: 99 } } },
      { op: "update_block", id: "chart", set: { kind: "area", provenance: { runId: "forged", version: 99 }, id: "renamed" } },
      { op: "move_block", id: "table", after: null }
    ] }, "agent"));
    expect(after.blocks.map((block) => block.id)).toEqual(["table", "intro", "new", "chart"]);
    const added = after.blocks.find((block) => block.id === "new") as Record<string, unknown>;
    expect(added.section).toBe("Countries");
    expect(added.provenance).toBeUndefined();
    const chart = after.blocks.find((block) => block.id === "chart") as Record<string, unknown>;
    expect(chart).toEqual({ id: "chart", type: "chart", queryKey: "daily", kind: "area", x: "day", y: ["v"], provenance: { runId: "r1", version: 1 }, width: "half", intent: "trend" });
    // The input is untouched (a copy is patched).
    expect(before.blocks.map((block) => block.id)).toEqual(["intro", "chart", "table"]);
  });

  test("a new type replaces the block's fields; unset removes fields but never id, type, or provenance", () => {
    const after = ok(applyPatch(spec(), { ops: [
      { op: "update_block", id: "chart", set: { type: "table", queryKey: "daily" } },
      { op: "update_block", id: "intro", unset: ["markdown", "id", "type", "provenance"] }
    ] }, "agent"));
    expect(after.blocks[1]).toEqual({ id: "chart", type: "table", queryKey: "daily", provenance: { runId: "r1", version: 1 } } as never);
    expect(after.blocks[0]).toEqual({ id: "intro", type: "markdown", provenance: { runId: "r1", version: 1 } } as never);
  });

  test("query ops stamp their author; errors name the op and stop the patch", () => {
    const after = ok(applyPatch(spec(), { ops: [
      { op: "add_query", query: { key: "totals", sql: "SELECT 1 AS n" } },
      { op: "update_query", key: "daily", sql: "SELECT day, sum(y) AS v FROM analytics.t GROUP BY day" },
      { op: "update_query", key: "by_country", purpose: "countries" },
      { op: "remove_query", key: "totals" }
    ] }, "user"));
    expect(after.queries).toEqual([
      { key: "daily", sql: "SELECT day, sum(y) AS v FROM analytics.t GROUP BY day", purpose: "per day", createdBy: "user" },
      { key: "by_country", sql: "SELECT country, sum(x) AS v FROM analytics.t GROUP BY country", purpose: "countries", createdBy: "agent" }
    ]);
    const failed = applyPatch(spec(), { ops: [{ op: "remove_block", id: "intro" }, { op: "update_block", id: "missing", set: { title: "x" } }] }, "agent");
    expect(failed).toEqual({ ok: false, errors: ["op 2 (update_block): no block with id missing"] });
    expect(applyPatch(spec(), { ops: [{ op: "add_block", block: { id: "intro", type: "markdown", markdown: "x" } }] }, "agent")).toMatchObject({ ok: false });
    expect(applyPatch(spec(), { ops: [{ op: "move_block", id: "intro", after: "nowhere" }] }, "agent")).toEqual({ ok: false, errors: ["op 1 (move_block): no block with id nowhere to insert after"] });
    expect(applyPatch(spec(), { ops: [{ op: "add_query", query: { key: "daily", sql: "SELECT 1" } }] }, "agent")).toMatchObject({ ok: false });
  });

  test("parsePatch refuses unknown ops, blocks without id or type, and empty patches", () => {
    expect(parsePatch({ ops: [{ op: "drop_table", id: "x" }] }).ok).toBe(false);
    expect(parsePatch({ ops: [{ op: "add_block", block: { type: "markdown" } }] }).ok).toBe(false);
    expect(parsePatch({ ops: [] }).ok).toBe(false);
    const parsed = parsePatch({ summary: "s", ops: [{ op: "add_block", block: { id: "a", type: "kpi", anything: { nested: true } } }] });
    expect(parsed.ok && parsed.patch.ops[0]).toEqual({ op: "add_block", block: { id: "a", type: "kpi", anything: { nested: true } } });
  });
});

describe("diffSpecs and withoutUnusedQueries", () => {
  test("added, updated (its own fields or its query's SQL), removed, moved; provenance alone is no change", () => {
    const before = spec();
    const after = ok(applyPatch(before, { ops: [
      { op: "add_block", after: null, block: { id: "kpi", type: "kpi", queryKey: "daily", column: "v" } },
      { op: "update_query", key: "by_country", sql: "SELECT country, sum(z) AS v FROM analytics.t GROUP BY country" },
      { op: "remove_block", id: "intro" }
    ] }, "agent"));
    after.blocks[1] = { ...after.blocks[1]!, provenance: { runId: "other", version: 7 } };
    const diff = diffSpecs(before, after);
    expect(diff.blocks.map((change) => [change.blockId, change.change])).toEqual([["kpi", "added"], ["table", "updated"], ["intro", "removed"]]);
    expect(diff.queries.map((change) => [change.key, change.change])).toEqual([["by_country", "updated"]]);
    const moved = ok(applyPatch(before, { ops: [{ op: "move_block", id: "table", after: null }] }, "user"));
    expect(diffSpecs(before, moved).blocks.map((change) => [change.blockId, change.change])).toEqual([["table", "moved"]]);
    const swapped = ok(applyPatch(before, { ops: [{ op: "move_block", id: "chart", after: "table" }] }, "user"));
    // A swap of neighbours is one move (either of the two).
    expect(diffSpecs(before, swapped).blocks.filter((change) => change.change === "moved").length).toBe(1);
  });

  test("dropping a block's last use drops its query", () => {
    const after = withoutUnusedQueries(ok(applyPatch(spec(), { ops: [{ op: "remove_block", id: "table" }] }, "user")));
    expect(after.queries.map((query) => query.key)).toEqual(["daily"]);
  });
});
