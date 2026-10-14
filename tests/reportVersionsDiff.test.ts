import { describe, expect, test } from "bun:test";
import { breakSql, DIFF_LIMITS, diffSpecVersions, lineDiff, wordDiff } from "../shared/reportVersions";
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
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd").lines.map(({ op, text }) => ({ op, text }))).toEqual([
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

describe("word diff", () => {
  const marked = (parts: Array<{ text: string; changed: boolean }>) => parts.map((part) => part.changed ? `[${part.text}]` : part.text).join("");

  test("the changed words of a pair of lines are marked, the rest is not; both sides read back as the lines", () => {
    const words = wordDiff("SELECT sum(revenue) AS total FROM t", "SELECT sum(net_revenue) AS net total FROM t")!;
    expect(marked(words.before)).toBe("SELECT sum([revenue]) AS total FROM t");
    expect(marked(words.after)).toBe("SELECT sum([net_revenue]) AS [net] total FROM t");
    expect(words.before.map((part) => part.text).join("")).toBe("SELECT sum(revenue) AS total FROM t");
    // Two changed words in a row are one mark, with the space between them.
    expect(marked(wordDiff("ORDER BY a ASC", "ORDER BY b DESC")!.after)).toBe("ORDER BY [b DESC]");
    expect(marked(wordDiff("x = 1", "x = 1")!.after)).toBe("x = 1");
  });

  test("a removed run and the added run after it are paired line by line; unpaired lines carry no parts", () => {
    const { lines } = lineDiff("a\nLIMIT 8\nc", "a\nLIMIT 10\nextra line\nc");
    const del = lines.find((line) => line.op === "del")!;
    const added = lines.filter((line) => line.op === "add");
    expect(marked(del.parts!)).toBe("LIMIT [8]");
    expect(marked(added[0]!.parts!)).toBe("LIMIT [10]");
    expect(added[1]!.parts).toBeUndefined();
    expect(lines.find((line) => line.op === "same")!.parts).toBeUndefined();
  });

  test("very long lines get no word diff (the line colours still show)", () => {
    const long = Array.from({ length: DIFF_LIMITS.words }, (_, index) => `w${index}`).join(" ");
    expect(wordDiff(long, `${long} more`)).toBeNull();
  });
});

describe("SQL broken at its clauses for the diff", () => {
  test("one-line SQL breaks before FROM, WHERE, GROUP BY, ORDER BY, LIMIT, and JOINs; the same input always gives the same lines", () => {
    const sql = "SELECT country, sum(revenue) AS revenue FROM analytics.orders o LEFT JOIN analytics.users u ON u.id = o.user_id WHERE o.day >= today() - 7 GROUP BY country HAVING revenue > 0 ORDER BY revenue DESC LIMIT 8";
    expect(breakSql(sql)).toBe([
      "SELECT country, sum(revenue) AS revenue", "FROM analytics.orders o", "LEFT JOIN analytics.users u ON u.id = o.user_id", "WHERE o.day >= today() - 7",
      "GROUP BY country", "HAVING revenue > 0", "ORDER BY revenue DESC", "LIMIT 8"
    ].join("\n"));
    expect(breakSql(sql)).toBe(breakSql(sql));
    expect(breakSql(breakSql(sql))).toBe(breakSql(sql));
  });

  test("strings, quoted names, comments, and words that only contain a keyword are left alone; existing lines are kept", () => {
    expect(breakSql("SELECT 'from where' AS `group by`, fromage FROM t -- order by x\nORDER BY 1")).toBe("SELECT 'from where' AS `group by`, fromage\nFROM t -- order by x\nORDER BY 1");
    expect(breakSql("select a\nfrom t\nwhere b")).toBe("select a\nfrom t\nwhere b");
    expect(breakSql("SELECT x FROM (SELECT y FROM t)")).toBe("SELECT x\nFROM (SELECT y\nFROM t)");
  });

  test("a change in GROUP BY shows on its own line, word-marked; the stored SQL is untouched", () => {
    const before: ReportSpec = { ...at(1), queries: at(1).queries.map((query) => query.key === "by_country" ? { ...query, sql: "SELECT country, sum(revenue) AS revenue FROM analytics.orders GROUP BY country ORDER BY revenue DESC LIMIT 8" } : query) };
    const after: ReportSpec = { ...before, queries: before.queries.map((query) => query.key === "by_country" ? { ...query, sql: query.sql.replace("GROUP BY country", "GROUP BY country, region") } : query) };
    const diff = diffSpecVersions(before, after, { from: 1, to: 2 });
    const changed = diff.queries[0]!.lines.filter((line) => line.op !== "same");
    expect(changed.map((line) => [line.op, line.text])).toEqual([["del", "GROUP BY country"], ["add", "GROUP BY country, region"]]);
    expect(changed[1]!.parts!.filter((part) => part.changed).map((part) => part.text)).toEqual([", region"]);
    expect(after.queries.find((query) => query.key === "by_country")!.sql).not.toContain("\n");
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
    expect(intro.text!.filter((line) => line.op !== "same").map(({ op, text }) => ({ op, text }))).toEqual([
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
