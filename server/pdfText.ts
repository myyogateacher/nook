import type { PdfWorkerReply } from "./pdfTextWorker";

/**
 * PDF text extraction (lane FILES, D496) with unpdf (pdf.js, pure JS, no native deps), for the Files
 * full-text index and every text reader (`readDocumentTextLayer`, D510: `read_document_text`,
 * `read_attachment_text`, the reports Nook doc source).
 *
 * - **Off the main thread.** One worker (server/pdfTextWorker.ts) runs one PDF at a time; callers
 *   queue. A PDF that takes longer than `timeoutMs` has its worker terminated (pdf.js cannot be
 *   interrupted any other way), and the next job starts a fresh one. An idle worker is closed.
 * - **Caps.** Callers check `maxBytes` before reading; the worker stops at `maxPages` and `maxChars`.
 * - **Memory (D513).** Bun 1.4 ignores `resourceLimits` on a Worker (its docs say so, and a worker given
 *   `maxOldGenerationSizeMb: 32` grew past 380 MB in a check), so there is no heap cap. The worker is
 *   bounded by its input instead: one PDF at a time, at most 16 MiB and 300 pages, 15 s, and it runs
 *   with `smol` (a smaller heap that collects more often). Revisit if Bun gains a worker heap limit.
 * - **Errors** are `PdfTextError` with a reason: `invalid` (not a PDF), `encrypted` (a password),
 *   `timeout`, or `failed`. Nothing is logged here: callers log counts, never names or text.
 */
export const PDF_TEXT_LIMITS = { maxBytes: 16 * 1024 * 1024, maxPages: 300, timeoutMs: 15_000, idleMs: 30_000, queue: 32 };

export type PdfTextReason = "invalid" | "encrypted" | "timeout" | "failed" | "busy";
export class PdfTextError extends Error {
  constructor(readonly reason: PdfTextReason) {
    super(`PDF text extraction failed: ${reason}`);
    this.name = "PdfTextError";
  }
}

export type PdfText = { text: string; pages: number; pagesRead: number; truncated: boolean };

type Pending = { bytes: Uint8Array; maxChars: number; maxPages: number; resolve: (value: PdfText) => void; reject: (error: Error) => void };

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let nextId = 0;
const queue: Pending[] = [];

function stopWorker() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  worker?.terminate();
  worker = null;
}

function startWorker() {
  if (!worker) {
    // `smol`: a smaller heap, collected more often (D513); Bun has no worker heap limit to set.
    worker = new Worker(new URL("./pdfTextWorker.ts", import.meta.url).href, { smol: true });
  }
  return worker;
}

function runNext() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    if (worker && !idleTimer) {
      idleTimer = setTimeout(stopWorker, PDF_TEXT_LIMITS.idleMs);
      idleTimer.unref?.();
    }
    return;
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  running = true;
  const id = ++nextId;
  const current = startWorker();
  const finish = (settle: () => void) => {
    clearTimeout(timer);
    current.removeEventListener("message", onMessage);
    current.removeEventListener("error", onError);
    running = false;
    settle();
    runNext();
  };
  const timer = setTimeout(() => {
    // pdf.js cannot be interrupted: the worker goes, and the next job gets a new one.
    if (worker === current) stopWorker();
    else current.terminate();
    finish(() => job.reject(new PdfTextError("timeout")));
  }, PDF_TEXT_LIMITS.timeoutMs);
  const onMessage = (event: MessageEvent<PdfWorkerReply>) => {
    const reply = event.data;
    if (reply.id !== id) return;
    finish(() => {
      if (reply.ok) job.resolve({ text: reply.text, pages: reply.pages, pagesRead: reply.pagesRead, truncated: reply.truncated });
      else job.reject(new PdfTextError(reply.reason));
    });
  };
  const onError = () => {
    if (worker === current) stopWorker();
    finish(() => job.reject(new PdfTextError("failed")));
  };
  current.addEventListener("message", onMessage);
  current.addEventListener("error", onError);
  // A copy: pdf.js detaches the buffer it is given, and the caller may still hold these bytes.
  current.postMessage({ id, bytes: job.bytes.slice(), maxPages: job.maxPages, maxChars: job.maxChars });
}

/** The text of a PDF's pages, in order, up to `maxChars` characters. */
export function extractPdfText(bytes: Uint8Array, options: { maxChars: number; maxPages?: number }): Promise<PdfText> {
  if (bytes.byteLength > PDF_TEXT_LIMITS.maxBytes) return Promise.reject(new PdfTextError("failed"));
  if (queue.length >= PDF_TEXT_LIMITS.queue) return Promise.reject(new PdfTextError("busy"));
  return new Promise((resolve, reject) => {
    queue.push({ bytes, maxChars: options.maxChars, maxPages: options.maxPages ?? PDF_TEXT_LIMITS.maxPages, resolve, reject });
    runNext();
  });
}

/** Test hook: close the worker now. */
export function stopPdfTextWorkerForTests() {
  stopWorker();
}
