import { csvCell } from "./questions/service";
import { contentDisposition } from "./contentHeaders";

/**
 * CSV downloads (D1387), as Forms, Time, Contacts, Collections, and Townhall write them: UTF-8 with a
 * BOM (so spreadsheets read accents), CRLF line ends, every cell through `csvCell` (quoted, and a cell
 * starting with = + - @ or a tab/CR gets a leading ' so a spreadsheet never runs it as a formula, T514),
 * `no-store`, and an attachment name from the item's title.
 */

/** The most rows one export writes; the file says so on its last line when it stopped there. */
export const CSV_EXPORT_ROWS = 10_000;

export function csvText(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>, truncated = false) {
  const lines = [header.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  if (truncated) lines.push(csvCell(`Stopped at ${CSV_EXPORT_ROWS.toLocaleString("en-US")} rows`));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A safe file name: letters, digits, spaces, dashes, and underscores from `title`, else `fallback`. */
export const csvFileName = (title: string, fallback: string) => `${title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60) || fallback}.csv`;

export function csvResponse(text: string, fileName: string) {
  return new Response(text, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition("attachment", fileName), "Cache-Control": "no-store" } });
}
