import { describe, expect, test } from "bun:test";
import { DIFF_LIMITS, diffSpecVersions, lineDiff } from "../shared/reportVersions";
import type { ReportSpec } from "../shared/reports";
import { historySpecs } from "./support/reportVersionsSeed";

/**
 * Lane J: the structured diff between two report versions (blocks, queries as SQL line diffs,
 * markdown text, sections, the one-line summary, and the caps).
 */

const specs = historySpecs();
const at = (n: number) => specs[n - 1]!;

describe("line diff", () => {
  test("unchanged, removed, and added lines in order", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd").lines).toEqual([
      { op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "B" }, { op: "same", text: "c" }, { op: "add", text: "d" }
    ]);
    expect(lineDiff(null, "x\ny").lines.map((line) => line.op)).toEqual(["add", "add"]);
    expect(lineDiff("x", null).lines).toEqual([{ op: "del", text: "x" }]);
    expect(lineDiff("same\r\ntext", "same\ntext").lines.every((line) => line.op === "same")).toBe(true);
  });

  test("longer texts are cut at the cap and say so", () => {
    const long = Array.from({ length: DIFF_LIMITS.lines + 50 }, (_, index) => `line ${index}`).join("\n");
    const diff = lineDiff(long, `${long}\nmore`);
    expect(diff.truncated).toBe(true);
    expect(diff.lines.length).toBe(DIFF_LIMITS.lines);
  });
});

describe("the diff between two specs", () => {
  test("blocks added with their fields, a changed title, and a query added", () => {
    const diff = diffSpecVersions(at(1), at(2), { from: 1, to: 2 });
    expect(diff.blocks.map((block) => [block.blockId, block.change, block.type])).toEqual([["country-bar", "changed", "chart"], ["recent-table", "added", "table"]]);
    expect(diff.blocks[0]!.fields).toEqual([{ field: "title", before: "Top countries", after: "Top countries by revenue" }]);
    expect(diff.blocks[1]!.fields.map((field) => field.field)).toEqual(["type", "title", "queryKey", "formats"]);
    expect(diff.blocks[1]!.fields.every((field) => field.before === null)).toBe(true);
    expect(diff.queries).toHaveLength(1);
    expect(diff.queries[0]).toMatchObject({ key: "recent", change: "added" });
    expect(diff.queries[0]!.lines.every((line) => line.op === "add")).toBe(true);
    expect(diff.summary).toBe("+1 table, title changed, 1 query added");
  });

  test("markdown as a text diff; width and section as changed fields; a section added", () => {
    const diff = diffSpecVersions(at(2), at(3), { from: 2, to: 3 });
    const intro = diff.blocks.find((block) => block.blockId === "intro")!;
    expect(intro.fields).toEqual([]);
    expect(intro.text!.filter((line) => line.op !== "same")).toEqual([
      { op: "del", text: "Revenue is **net of refunds**, per the metrics doc. Data: `analytics.orders`." },
      { op: "add", text: "Revenue is **net of refunds**." },
      { op: "add", text: "Source: `analytics.orders`." }
    ]);
    expect(diff.blocks.find((block) => block.blockId === "kpi-orders")!.fields).toEqual([{ field: "width", before: null, after: "half" }, { field: "section", before: null, after: "overview" }]);
    expect(diff.sections).toEqual([{ id: "overview", change: "added", title: "Overview", fields: [{ field: "title", before: null, after: "Overview" }, { field: "summary", before: null, after: "Revenue at a glance" }] }]);
    expect(diff.summary).toBe("1 block changed, text changed, 1 section changed");
  });

  test("a query changed is a line diff of its SQL; nothing else changes", () => {
    const diff = diffSpecVersions(at(3), at(4), { from: 3, to: 4 });
    expect(diff.blocks).toEqual([]);
    expect(diff.queries).toHaveLength(1);
    const changed = diff.queries[0]!.lines.filter((line) => line.op !== "same");
    expect(changed.map((line) => line.op)).toEqual(["del", "add"]);
    expect(changed[1]!.text).toContain("LIMIT 10");
    expect(diff.summary).toBe("1 query changed");
  });

  test("moved blocks, a removed block and query, a renamed and a removed section", () => {
    const before: ReportSpec = { ...at(3), sections: [{ id: "overview", title: "Overview" }, { id: "detail", title: "Detail" }] };
    const blocks = before.blocks.filter((block) => block.id !== "recent-table");
    const after: ReportSpec = {
      ...before,
      blocks: [blocks[3]!, ...blocks.slice(0, 3), ...blocks.slice(4)],
      queries: before.queries.filter((query) => query.key !== "recent"),
      sections: [{ id: "overview", title: "At a glance" }]
    };
    const diff = diffSpecVersions(before, after, { from: 3, to: 7 });
    expect(diff.blocks.map((block) => [block.blockId, block.change, block.position ?? null])).toEqual([
      ["daily-line", "moved", { before: 4, after: 1 }],
      ["recent-table", "removed", null]
    ]);
    expect(diff.queries.map((query) => [query.key, query.change])).toEqual([["recent", "removed"]]);
    expect(diff.sections.map((section) => [section.id, section.change])).toEqual([["overview", "changed"], ["detail", "removed"]]);
    expect(diff.summary).toBe("−1 table, 1 block moved, 1 query removed, 2 sections changed");
  });

  test("provenance and Nook's own fields never read as a change; the same spec is 'No changes'", () => {
    const stamped: ReportSpec = { ...at(1), blocks: at(1).blocks.map((block) => ({ ...block, provenance: { runId: "x", version: 9 }, autoFixes: [{ rule: "sort", detail: "sorted" }] })) };
    const diff = diffSpecVersions(at(1), stamped, { from: 1, to: 2 });
    expect([diff.blocks, diff.queries, diff.sections, diff.summary]).toEqual([[], [], [], "No changes"]);
  });

  test("without text (list summaries) the line diffs are left out but the summary is the same", () => {
    const light = diffSpecVersions(at(2), at(3), { from: 2, to: 3, withText: false });
    expect(light.summary).toBe(diffSpecVersions(at(2), at(3), { from: 2, to: 3 }).summary);
    expect(light.blocks.find((block) => block.blockId === "intro")!.text).toBeUndefined();
  });

  test("long values are cut; a huge diff is capped and says so", () => {
    const wide: ReportSpec = { ...at(1), blocks: at(1).blocks.map((block) => block.id === "country-bar" ? { ...block, title: "x".repeat(1000) } : block) };
    const field = diffSpecVersions(at(1), wide, { from: 1, to: 2 }).blocks[0]!.fields[0]!;
    expect(field.after!.length).toBe(DIFF_LIMITS.value);
    expect(field.after!.endsWith("…")).toBe(true);
    const many: ReportSpec = { ...at(1), blocks: Array.from({ length: DIFF_LIMITS.entries + 10 }, (_, index) => ({ id: `md-${index}`, type: "markdown" as const, markdown: `Note ${index}` })) };
    const capped = diffSpecVersions({ ...at(1), blocks: [] }, many, { from: 1, to: 2 });
    expect(capped.blocks.length).toBe(DIFF_LIMITS.entries);
    expect(capped.truncated).toBe(true);
    expect(capped.summary).toBe(`+${DIFF_LIMITS.entries + 10} text blocks`);
  });
});
