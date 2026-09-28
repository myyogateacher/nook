// Which Today sections a user has hidden (D53): per user, in this browser only (localStorage).
// Nothing is stored on the server; a missing or unreadable value shows every section.

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export const hiddenSectionsKey = (userId: string) => `mynotes:today:hidden:${userId}`;

const browserStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Retired sections whose saved "hidden" choice carries over to their replacement (agent inbox D158). */
const RENAMED_SECTIONS: Record<string, string> = { agentDrafts: "proposals" };

export function readHiddenSections(userId: string, storage: StorageLike | null = browserStorage()): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(hiddenSectionsKey(userId)) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[a-z][A-Za-z]{1,31}$/.test(item)).map((item) => RENAMED_SECTIONS[item] ?? item))] : [];
  } catch {
    return [];
  }
}

export function writeHiddenSections(userId: string, hidden: readonly string[], storage: StorageLike | null = browserStorage()) {
  try {
    storage?.setItem(hiddenSectionsKey(userId), JSON.stringify([...new Set(hidden)].sort()));
  } catch {
    // Private mode or a full quota: the choice lasts for this page only.
  }
}

/** Shows or hides one section. */
export function toggleHidden(hidden: readonly string[], name: string, visible: boolean) {
  return visible ? hidden.filter((item) => item !== name) : [...new Set([...hidden, name])];
}
