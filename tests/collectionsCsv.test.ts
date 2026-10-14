import { describe, expect, test } from "bun:test";
import { CsvError, neutralizeFormula, parseCsv, restoreNeutralized, writeCsv } from "../server/collections/csv";
import { cpuMs } from "./support/cpuTime";

const limits = { maxRecords: 5001, maxColumns: 50 };
const parse = (text: string) => parseCsv(text, limits);

function csvError(text: string, custom = limits) {
  try {
    parseCsv(text, custom);
  } catch (error) {
    if (error instanceof CsvError) return error;
    throw error;
  }
  throw new Error("Expected a CsvError");
}

describe("CSV parsing (RFC 4180)", () => {
  test("handles quotes, doubled quotes, commas, and line breaks inside quotes", () => {
    expect(parse('name,notes\r\n"Smith, Jo","said ""hi""\nthen left"\r\nplain,x')).toEqual([
      ["name", "notes"],
      ["Smith, Jo", 'said "hi"\nthen left'],
      ["plain", "x"]
    ]);
    // A quote inside an unquoted field is literal.
    expect(parse('a,5" screen\n')).toEqual([["a", '5" screen']]);
    expect(parse('"",x')).toEqual([["", "x"]]);
  });

  test("accepts CRLF, LF, and CR line ends, strips a BOM, and skips empty records", () => {
    expect(parse("﻿a,b\r\n1,2\n3,4\r5,6\r\n\r\n,\n")).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
    expect(parse("")).toEqual([]);
    expect(parse("only")).toEqual([["only"]]);
    expect(parse("a,,c")).toEqual([["a", "", "c"]]);
  });

  test("rejects unterminated quotes and text after a closing quote, with the line", () => {
    const unterminated = csvError('a,b\n1,"never closed\n2,3');
    expect(unterminated.message).toContain("not closed");
    expect(unterminated.line).toBe(2);
    const trailing = csvError('a\n"x"y');
    expect(trailing.message).toContain("after a closing quote");
    expect(trailing.line).toBe(2);
  });

  test("stops at the row and column caps", () => {
    expect(csvError("a,b,c", { maxRecords: 10, maxColumns: 2 }).message).toContain("at most 2 columns");
    expect(csvError("h\n1\n2\n3", { maxRecords: 3, maxColumns: 5 }).message).toContain("at most 2 rows");
    expect(csvError(Array.from({ length: 51 }, () => "x").join(",")).message).toContain("at most 50 columns");
    expect(parse(Array.from({ length: 50 }, () => "x").join(","))[0]).toHaveLength(50);
  });

  test("parses 50,000 cells quickly", () => {
    const row = Array.from({ length: 10 }, (_, index) => index % 3 === 0 ? `"cell, ${index}"` : `cell ${index}`).join(",");
    const text = ["h0,h1,h2,h3,h4,h5,h6,h7,h8,h9", ...Array.from({ length: 5000 }, () => row)].join("\r\n");
    let records: ReturnType<typeof parse> = [];
    // CPU time, not wall time (tests/support/cpuTime.ts).
    const used = cpuMs(() => { records = parse(text); });
    expect(records).toHaveLength(5001);
    expect(records[1]).toHaveLength(10);
    expect(records[5000]![0]).toBe("cell, 0");
    expect(used).toBeLessThan(1500);
  });
});

describe("CSV writing", () => {
  test("neutralizes formula starts in text only and round-trips", () => {
    for (const dangerous of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tTab", "\rCR"]) {
      expect(neutralizeFormula(dangerous)).toBe(`'${dangerous}`);
      expect(restoreNeutralized(neutralizeFormula(dangerous))).toBe(dangerous);
    }
    for (const safe of ["Tea", "", "'quoted", "1=1", " =spaced"]) expect(neutralizeFormula(safe)).toBe(safe);
    expect(restoreNeutralized("'plain")).toBe("'plain");
  });

  test("writes a BOM, CRLF, and quotes only when needed", () => {
    const csv = writeCsv([["Name", "Notes"], ["Smith, Jo", 'said "hi"'], ["multi\nline", " padded "], ["plain", ""]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿Name,Notes\r\n"Smith, Jo","said ""hi"""\r\n"multi\nline"," padded "\r\nplain,\r\n');
    expect(parse(csv)).toEqual([["Name", "Notes"], ["Smith, Jo", 'said "hi"'], ["multi\nline", " padded "], ["plain", ""]]);
  });
});
