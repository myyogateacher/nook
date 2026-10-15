import { afterEach, describe, expect, test } from "bun:test";
import { makePdf } from "./support/pdf";
import { extractPdfText, PDF_TEXT_LIMITS, PdfTextError, stopPdfTextWorkerForTests } from "../server/pdfText";

/** Lane FILES (D496): PDF text in the worker, with its page, character, size, and time caps. */

const saved = { ...PDF_TEXT_LIMITS };
afterEach(() => Object.assign(PDF_TEXT_LIMITS, saved));

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof PdfTextError ? error.reason : String(error);
  }
};

describe("PDF text", () => {
  test("reads every page in order", async () => {
    const result = await extractPdfText(makePdf(["First page quokka", "Second page numbat"]), { maxChars: 10_000 });
    expect(result).toEqual({ text: "First page quokka\n\nSecond page numbat", pages: 2, pagesRead: 2, truncated: false });
  });

  test("stops at the page and character caps, and says so", async () => {
    const pages = await extractPdfText(makePdf(["one", "two", "three"]), { maxChars: 10_000, maxPages: 2 });
    expect(pages).toMatchObject({ text: "one\n\ntwo", pages: 3, pagesRead: 2, truncated: true });
    const chars = await extractPdfText(makePdf(["abcdefghij", "never read"]), { maxChars: 5 });
    expect(chars).toMatchObject({ text: "abcde", pagesRead: 1, truncated: true });
  });

  test("a file that is not a PDF, and one over the size cap, are refused", async () => {
    expect(await reason(extractPdfText(new TextEncoder().encode("plain text, not a PDF"), { maxChars: 100 }))).toBe("invalid");
    PDF_TEXT_LIMITS.maxBytes = 10;
    expect(await reason(extractPdfText(makePdf(["x"]), { maxChars: 100 }))).toBe("failed");
  });

  test("a PDF over the time cap ends its worker; the next one gets a fresh worker", async () => {
    PDF_TEXT_LIMITS.timeoutMs = 1;
    expect(await reason(extractPdfText(makePdf(["slow"]), { maxChars: 100 }))).toBe("timeout");
    PDF_TEXT_LIMITS.timeoutMs = saved.timeoutMs;
    expect((await extractPdfText(makePdf(["after the timeout"]), { maxChars: 100 })).text).toBe("after the timeout");
    stopPdfTextWorkerForTests();
  });

  test("callers queue: concurrent PDFs each get their own text", async () => {
    const texts = await Promise.all(["alpha", "beta", "gamma"].map((word) => extractPdfText(makePdf([word]), { maxChars: 100 })));
    expect(texts.map((item) => item.text)).toEqual(["alpha", "beta", "gamma"]);
  });
});
