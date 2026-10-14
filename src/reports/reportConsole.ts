import { createContext } from "react";

/** Opens the report's SQL console panel, optionally with SQL in it (Inspect → Open in console); null where there is none (readers, empty reports, tests). */
export const ReportConsoleContext = createContext<((sql?: string) => void) | null>(null);
