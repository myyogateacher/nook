import { useEffect, useSyncExternalStore } from "react";
import { resolvePeople } from "../workspaceApi";

/**
 * Pictures for mention chips (docs/plan/MENTIONS.md D1338, T353). A chip knows the person's id and the
 * name written in the text; its picture is looked up once per page load, batched (every chip on screen
 * in one `GET /api/people/resolve?users=`), and shared by every chip of that person. A picture is shown
 * to whoever can read the name (T353): the chip is only drawn where its text is readable. The picker's
 * rows seed the cache. `Avatar` loads only Nook's own avatar route (review L10); anything else is letters.
 */

const urls = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

const emit = () => { version += 1; for (const listener of listeners) listener(); };

/** Records pictures already known (the picker's rows). */
export function seedMentionAvatars(people: ReadonlyArray<{ id: string; avatarUrl: string | null }>) {
  let changed = false;
  for (const person of people) {
    const id = person.id.toLowerCase();
    if (urls.get(id) !== person.avatarUrl) { urls.set(id, person.avatarUrl); changed = true; }
  }
  if (changed) emit();
}

function flush() {
  timer = null;
  const ids = [...pending].slice(0, 200);
  for (const id of ids) pending.delete(id);
  if (!ids.length) return;
  resolvePeople({ users: ids }).then(({ people }) => {
    for (const id of ids) urls.set(id, null);
    for (const person of people) if (person.kind === "user" && !person.former) urls.set(person.id.toLowerCase(), person.avatarUrl ?? null);
    emit();
  }, () => { for (const id of ids) urls.set(id, null); emit(); });
  if (pending.size) timer = setTimeout(flush, 30);
}

function request(id: string) {
  if (urls.has(id) || pending.has(id)) return;
  pending.add(id);
  timer ??= setTimeout(flush, 30);
}

/** The picture of a mentioned person, or null (letters) until it is known or when there is none. */
export function useMentionAvatar(userId: string): string | null {
  const id = userId.toLowerCase();
  useEffect(() => { request(id); }, [id]);
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => 0);
  return urls.get(id) ?? null;
}

/** For tests: forget everything. */
export function resetMentionAvatars() { urls.clear(); pending.clear(); if (timer) clearTimeout(timer); timer = null; emit(); }
