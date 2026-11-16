/**
 * D1386: the card face goal badge (one batched read for every card on screen; nothing for a card with
 * no goal) and the key result sparkline (from the goal's history), rendered with happy-dom.
 */
import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";

installDom();

const { CardGoalBadge, cardGoalTitle, forgetCardGoals, resetCardGoalsForTests } = await import("../src/goals/CardGoalBadge");
const { KrSparkline, sparkLabel, sparkPoints } = await import("../src/goals/KrSparkline");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const card = (id: string) => ({ id, board_id: "board", title: id });
const goal = (title: string, progress: number) => ({ id: title, title, href: `/goals/${title}`, progress, health: "on_track" });

describe("card face goal badge", () => {
  test("every card on screen asks in one read; one goal shows its progress, several their count", async () => {
    resetCardGoalsForTests();
    const api = mockApi({ [`GET /goals/for-cards?ids=${A},${B},${C}`]: () => ({ cards: { [A]: [goal("Launch", 0.45)], [B]: [goal("Launch", 0.45), goal("Hire", 0.1)] } }) });
    const view = await render(<div>{[A, B, C].map((id) => <span key={id} data-card={id}><CardGoalBadge card={card(id)} /></span>)}</div>);
    await view.waitFor(() => view.container.querySelector(`[data-card="${B}"] .goals-card-badge`));
    expect(api.calls).toHaveLength(1);
    expect(view.container.querySelector(`[data-card="${A}"]`)!.textContent).toBe("45%");
    expect(view.container.querySelector(`[data-card="${A}"] .goals-card-badge`)!.getAttribute("title")).toBe("Contributes to Launch (45%)");
    expect(view.container.querySelector(`[data-card="${B}"]`)!.textContent).toBe("2");
    expect(view.container.querySelector(`[data-card="${C}"]`)!.textContent).toBe("");
  });

  test("answers are kept; a card whose goals changed asks again", async () => {
    resetCardGoalsForTests();
    let answer = { [A]: [goal("Launch", 0.2)] } as Record<string, unknown>;
    const api = mockApi({ [`GET /goals/for-cards?ids=${A}`]: () => ({ cards: answer }) });
    const view = await render(<CardGoalBadge card={card(A)} />);
    await view.waitFor(() => view.container.textContent === "20%");
    await render(<CardGoalBadge card={card(A)} />);
    expect(api.calls).toHaveLength(1);
    answer = {};
    forgetCardGoals(A);
    await view.waitFor(() => view.container.textContent === "");
    expect(api.calls).toHaveLength(2);
    expect(cardGoalTitle([goal("A", 0.5), goal("B", 1)])).toBe("Contributes to 2 goals: A (50%), B (100%)");
  });
});

describe("key result sparkline", () => {
  test("points run oldest first inside the box; one point draws nothing", async () => {
    expect(sparkPoints([0, 1], 72, 20)).toBe("1.0,19.0 71.0,1.0");
    expect(sparkPoints([0.5])).toBe("");
    expect(sparkLabel([0.1, 0.3, 0.45])).toBe("Progress over time: 10% to 45%, 3 updates");
    const none = await render(<KrSparkline points={[{ at: "2026-11-01T00:00:00Z", progress: 0.2 }]} />);
    expect(none.container.innerHTML).toBe("");
    const view = await render(<KrSparkline points={[{ at: "2026-11-03T00:00:00Z", progress: 0.6 }, { at: "2026-11-01T00:00:00Z", progress: 0.2 }]} />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Progress over time: 20% to 60%, 2 updates");
  });
});
