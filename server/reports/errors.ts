import { ChError } from "./clickhouse";
import { GuardError } from "./sqlGuard";
import { AllowlistError } from "./allowlist";

/**
 * Errors of the reports module. Routes answer `{ error, code, ...details }` with the status; a guard
 * refusal is 400 `GUARD` with the guard's own code in `guard`, a ClickHouse failure is 502 with its
 * code and name. Missing and forbidden are the same 404 (T168 parity).
 */
export class ReportError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 502 | 503 | 504, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReportError";
  }
}

export const reportNotFound = () => new ReportError(404, "NOT_FOUND", "Report not found");
export const datasourceNotFound = () => new ReportError(404, "NOT_FOUND", "Data source not found");

/** Any error of the module's helpers as a ReportError (others are rethrown). */
export function asReportError(error: unknown): ReportError {
  if (error instanceof ReportError) return error;
  if (error instanceof GuardError) return new ReportError(400, "GUARD", error.message, { guard: error.code });
  if (error instanceof AllowlistError) return new ReportError(400, "INVALID_ALLOWLIST", error.message);
  if (error instanceof ChError) {
    const status = error.code === "TIMEOUT" ? 504 : 502;
    return new ReportError(status, error.code, error.message, { ...(error.chCode !== null ? { chCode: error.chCode } : {}), ...(error.chName ? { chName: error.chName } : {}) });
  }
  throw error;
}
