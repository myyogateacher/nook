/// <reference lib="webworker" />
import { getDocumentProxy } from "unpdf";

/**
 * The PDF text worker (lane FILES, D496): one PDF at a time, off the main thread, so a slow or
 * hostile file never blocks requests; server/pdfText.ts terminates it when its time runs out.
 *
 * pdf.js (the serverless build bundled by unpdf; it has no eval path) runs with font faces off, no system
 * fonts, and no network (no font, CMap, or worker URLs are given). Only text content is read:
 * nothing is rendered. Pages stop at `maxPages` and text at `maxChars`.
 */

type Job = { id: number; bytes: Uint8Array; maxPages: number; maxChars: number };
export type PdfWorkerReply =
  | { id: number; ok: true; text: string; pages: number; pagesRead: number; truncated: boolean }
  | { id: number; ok: false; reason: "invalid" | "encrypted" | "failed" };

declare const self: Worker;

self.onmessage = async (event: MessageEvent<Job>) => {
  const { id, bytes, maxPages, maxChars } = event.data;
  let reply: PdfWorkerReply;
  try {
    const pdf = await getDocumentProxy(bytes, { disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
    try {
      const parts: string[] = [];
      let chars = 0;
      let pagesRead = 0;
      const last = Math.min(pdf.numPages, maxPages);
      for (let number = 1; number <= last && chars < maxChars; number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
        page.cleanup();
        pagesRead += 1;
        const trimmed = text.replace(/[ \t]+\n/g, "\n").trim();
        if (trimmed) { parts.push(trimmed); chars += trimmed.length + 2; }
      }
      let text = parts.join("\n\n");
      const cut = text.length > maxChars;
      if (cut) text = text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
      reply = { id, ok: true, text, pages: pdf.numPages, pagesRead, truncated: cut || pagesRead < pdf.numPages };
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (error) {
    const name = (error as { name?: string }).name;
    reply = { id, ok: false, reason: name === "PasswordException" ? "encrypted" : name === "InvalidPDFException" ? "invalid" : "failed" };
  }
  self.postMessage(reply);
};
