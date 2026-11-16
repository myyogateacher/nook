import { api } from "../../api";
import { MENTIONABLE_LIMIT_DEFAULT, type MentionCandidate } from "../../../shared/itemActivity";
import type { WorkKind } from "../../../shared/workRefs";
import { seedMentionAvatars } from "./mentionAvatars";

/** The item a mention is written on: the picker asks who can read it (docs/plan/MENTIONS.md §4). */
export type MentionTarget = { kind: WorkKind; id: string };

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; people: MentionCandidate[] }>();

/** People to suggest for "@query" on the item (GET /api/people/mentionable), cached for 30 s per query. */
export async function mentionablePeople(target: MentionTarget, q: string, signal?: AbortSignal): Promise<MentionCandidate[]> {
  const key = `${target.kind}:${target.id}:${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.people;
  const params = new URLSearchParams({ kind: target.kind, id: target.id, limit: String(MENTIONABLE_LIMIT_DEFAULT) });
  if (q) params.set("q", q);
  const { people } = await api<{ people: MentionCandidate[] }>(`/people/mentionable?${params}`, { signal });
  // The chips of people just picked show their picture at once.
  seedMentionAvatars(people);
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), people });
  return people;
}
