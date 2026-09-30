import { readHistorySnapshot } from "./mobileNavigation";

export type AppSection = "home" | "notes" | "files" | "tasks" | "collections" | "calendar" | "notifications" | "bin" | "team" | "inbox" | "whiteboards" | "vault";

const historyKey = "mynotes.app-shell";
const historyVersion = 1;

export type MyNotesAppHistoryState = {
  [historyKey]: {
    version: number;
    userId: string;
    section: AppSection;
  };
};

export function createAppHistoryState(userId: string, section: AppSection, currentState: unknown): MyNotesAppHistoryState {
  const base = currentState && typeof currentState === "object" ? currentState as Record<string, unknown> : {};
  return { ...base, [historyKey]: { version: historyVersion, userId, section } };
}

export function readAppHistorySection(state: unknown, userId: string): AppSection | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[historyKey];
  if (!value || typeof value !== "object") return null;
  const entry = value as { version?: unknown; userId?: unknown; section?: unknown };
  if (entry.version !== historyVersion || entry.userId !== userId) return null;
  return entry.section === "home" || entry.section === "notes" || entry.section === "files" || entry.section === "tasks" || entry.section === "collections" || entry.section === "calendar" || entry.section === "notifications" || entry.section === "bin" || entry.section === "team" || entry.section === "inbox" || entry.section === "whiteboards" || entry.section === "vault" ? entry.section : null;
}

// Entries written before the app shell existed carry only a Notes panel snapshot.
export function resolveAppHistorySection(state: unknown, userId: string): AppSection | null {
  return readAppHistorySection(state, userId) ?? (readHistorySnapshot(state, userId) ? "notes" : null);
}

const depthKey = "mynotes.depth";

// How many entries this app pushed below the current one. Entries without the key (legacy, or the
// first entry of a visit) count as 0, so in-app Back never leaves the SPA from them.
export function readHistoryDepth(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const depth = (state as Record<string, unknown>)[depthKey];
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

export function withHistoryDepth<T extends object>(state: T, depth: number): T & { [depthKey]: number } {
  return { ...state, [depthKey]: Math.max(0, Math.floor(depth)) };
}

export type StartupRouteState = "ready" | "loading" | "retry";

// Whether a route change can be applied yet: "loading" while the first data load for this user is
// in flight, "retry" once that load failed (the caller reloads and applies the newest route).
export function startupRouteState(userId: string, appliedUserId: string | null, failedUserId: string | null): StartupRouteState {
  if (appliedUserId === userId) return "ready";
  return failedUserId === userId ? "retry" : "loading";
}
