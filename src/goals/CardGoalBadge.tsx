import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { api } from "../api";
import type { CardSlotCard } from "../ui/cardSlots";
import "./goals.css";

/**
 * The card face's goal badge (D1386; TODO.md "a card face goal badge (needs a batched read)"): a card
 * that contributes to a goal shows ◎ and the goal's progress, or the number of goals when several.
 * Every card on screen asks within one tick, and those asks go out as ONE read
 * (GET /api/goals/for-cards?ids=…, 200 cards a request); answers are kept for the session, and the
 * card dialog's Goals field forgets a card's answer when it adds or removes a goal.
 */

export type CardGoal = { id: string; title: string; href: string; progress: number; health: string };

const CHUNK = 200;
const known = new Map<string, CardGoal[]>();
const listeners = new Map<string, Set<(goals: CardGoal[]) => void>>();
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const ids = [...queued];
  queued = new Set();
  for (let at = 0; at < ids.length; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    let cards: Record<string, CardGoal[]> = {};
    try {
      cards = (await api<{ cards: Record<string, CardGoal[]> }>(`/goals/for-cards?ids=${chunk.join(",")}`)).cards;
    } catch {
      // No badge on failure; a later ask tries again.
      for (const id of chunk) known.delete(id);
      continue;
    }
    for (const id of chunk) {
      const goals = cards[id] ?? [];
      known.set(id, goals);
      for (const listener of listeners.get(id) ?? []) listener(goals);
    }
  }
}

/** Asks for a card's goals (batched); the listener hears the answer. Returns the unsubscribe. */
export function watchCardGoals(cardId: string, listener: (goals: CardGoal[]) => void) {
  const set = listeners.get(cardId) ?? new Set();
  set.add(listener);
  listeners.set(cardId, set);
  const cached = known.get(cardId);
  if (cached) listener(cached);
  else if (!queued.has(cardId)) {
    queued.add(cardId);
    timer ??= setTimeout(() => { void flush(); }, 0);
  }
  return () => { set.delete(listener); if (!set.size) listeners.delete(cardId); };
}

/** The card's goals changed (the dialog's Goals field): ask again for every badge showing it. */
export function forgetCardGoals(cardId: string) {
  known.delete(cardId);
  if (listeners.has(cardId) && !queued.has(cardId)) {
    queued.add(cardId);
    timer ??= setTimeout(() => { void flush(); }, 0);
  }
}

/** Tests: forget every answer. */
export function resetCardGoalsForTests() { known.clear(); listeners.clear(); queued = new Set(); if (timer) clearTimeout(timer); timer = null; }

const pct = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;

/** "Contributes to Launch v2 (45%)" or "Contributes to 2 goals: A (45%), B (10%)". */
export function cardGoalTitle(goals: readonly CardGoal[]) {
  const named = goals.map((goal) => `${goal.title} (${pct(goal.progress)})`);
  return goals.length === 1 ? `Contributes to ${named[0]}` : `Contributes to ${goals.length} goals: ${named.join(", ")}`;
}

export function CardGoalBadge({ card }: { card: CardSlotCard }) {
  const [goals, setGoals] = useState<CardGoal[]>(() => known.get(card.id) ?? []);
  useEffect(() => watchCardGoals(card.id, setGoals), [card.id]);
  if (!goals.length) return null;
  const one = goals.length === 1 ? goals[0]! : null;
  return <span className={`task-card-count goals-card-badge${one ? ` health-${one.health}` : ""}`} title={cardGoalTitle(goals)}>
    <Target />{one ? pct(one.progress) : goals.length}
  </span>;
}
