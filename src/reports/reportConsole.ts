import { createContext } from "react";

/**
 * Opens the report's SQL console panel, optionally with SQL in it (Inspect → Open in console) and the
 * values its `{name:Type}` placeholders were bound with (D490, as sent); null where there is none
 * (readers, empty reports, tests).
 */
export const ReportConsoleContext = createContext<((sql?: string, params?: Record<string, string> | null) => void) | null>(null);
