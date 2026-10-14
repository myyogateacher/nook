import { logger } from "../log";

const slog = logger("knowledge");
/**
 * Hooks other modules call without importing the knowledge module (no import cycles):
 * - Notes tells it a note was published (plan §9: a source re-indexes after a publish, debounced 60 s).
 * - Notes, Files, and folders tell it who can read an item changed: its sharing, the Bin, a restore,
 *   or a purge (Wave 44 fixes, M1). A source its base's owner can no longer read loses its chunks at once.
 * - Team tells it an account was unblocked (M2): that owner's bases resume indexing; and (2026-10-08)
 *   that people joined or left a group, or a group was deleted: their bases' sources are checked again.
 * - Settings → AI tells it a provider changed or was removed (M3), or the budgets were raised (LOW-3).
 * Every hook runs its listeners after the caller's own write, and never throws.
 */

function run<T>(listeners: ReadonlySet<(value: T) => void>, value: T, what: string) {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      slog.error(`A knowledge ${what} hook failed`, error);
    }
  }
}

function hook<T>(what: string) {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener: (value: T) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    fire(value: T) { run(listeners, value, what); }
  };
}

const published = hook<string>("publish");
export const onNotePublished = published.on;
/** Called by server/noteDrafts.ts after a publish committed. Never throws. */
export const notePublishedHook = published.fire;

/** What changed: notes or Files documents, or folders (every note and file in them). `purged`: the rows are gone for good. */
export type SourceAccessChange = { kind: "note" | "document"; ids: readonly string[]; purged?: boolean } | { kind: "folder"; ids: readonly string[] };
const access = hook<SourceAccessChange>("access");
export const onSourceAccessChanged = access.on;
/** Called after a share change, a move to the Bin, a restore, or a purge committed. Never throws. */
export function sourceAccessChangedHook(change: SourceAccessChange) {
  if (change.ids.length > 0) access.fire(change);
}

const unblocked = hook<string>("unblock");
export const onUserUnblocked = unblocked.on;
/** Called by server/team/service.ts after an unblock committed. Never throws. */
export const userUnblockedHook = unblocked.fire;

/** A provider's address changed (`changed`), it was removed (`removed`), or the budgets were raised (`budget`). */
export type ProviderEvent = { kind: "changed" | "removed"; providerId: string } | { kind: "budget" };
const provider = hook<ProviderEvent>("provider");
export const onKnowledgeProviderEvent = provider.on;
/** Called by server/agents/providers.ts and server/agents/settings.ts after their write committed. Never throws. */
export const knowledgeProviderHook = provider.fire;

const groups = hook<readonly string[]>("group membership");
export const onGroupMembershipChanged = groups.on;
/**
 * Called by Team (server/team/groups.ts, templates.ts, memberAccess.ts) after people joined or left
 * a group, or a group was deleted (2026-10-08): `userIds` are the people whose reach changed. Their
 * knowledge bases' note and file sources are checked again at once. Never throws.
 */
export function groupMembershipChangedHook(userIds: readonly string[]) {
  if (userIds.length > 0) groups.fire([...new Set(userIds)]);
}
