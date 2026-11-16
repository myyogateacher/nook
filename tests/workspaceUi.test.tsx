import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Target } from "lucide-react";
import { installDom, mockApi, render } from "./support/dom";
import { EmptyState } from "../src/ui/EmptyState";
import { ModuleHome } from "../src/ui/ModuleHome";
import { HealthChip, percentOf, ProgressBar, ProgressRing } from "../src/ui/progress/Progress";
import { DurationChip, DurationInput, elapsedSeconds, TimerChip } from "../src/ui/time/Duration";
import { MoneyText } from "../src/ui/money/Money";
import { previewFires, scheduleRule, scheduleSummary, weekOrder, type ScheduleValue } from "../src/ui/schedule/SchedulePicker";
import { PersonChip, personText } from "../src/ui/people/People";
import { groupLinks, LinkedItemsPanel, relationText, WorkRefChip } from "../src/ui/links/WorkLinks";
import { mergeTimeline } from "../src/ui/activity/ItemTimeline";
import { dropTarget, KanbanBoard, type KanbanItem } from "../src/ui/kanban/KanbanBoard";
import { orderQuestions, QaList, type QaQuestion } from "../src/ui/live/QaList";
import { cloudSizes, LivePoll } from "../src/ui/live/LiveWidgets";
import { PresenterView } from "../src/ui/live/PresenterView";
import { insightOption, formatInsightValue } from "../src/ui/insights/Insights";
import { EmbedCard } from "../src/ui/embeds/EmbedCard";
import { contrast, PUBLIC_DARK, PUBLIC_LIGHT, publicAccent } from "../src/public/publicTheme";
import { PublicNotFound, PublicPageShell } from "../src/public/PublicPageShell";
import { publicPageFor } from "../src/public/PublicApp";
import { primeUnits } from "../src/ui/units";
import { duplicateQuestion, moveQuestion, newQuestion, problemsByQuestion, QuestionSetEditor, removeQuestion } from "../src/ui/questions/QuestionSetEditor";
import { questionSetProblems, type QuestionSet } from "../shared/questions";
import type { WorkLinkView } from "../shared/workRefs";

/** The shared workspace components (D837–D839, docs/plan/WORKSPACE_MODULES.md §E.3). */
installDom("http://nook.test/goals");

const account = { displayName: "Ana Silva", onHome: () => undefined, onSettings: () => undefined, onSignOut: () => undefined };

describe("ModuleHome and EmptyState", () => {
  test("the title row is the page header (D1274): the h1, one primary action, ⋯; tabs as the current page, filters and search", () => {
    const markup = renderToStaticMarkup(<ModuleHome icon={Target} title="Goals" heading="Q1 2027 goals" {...account} primary={{ label: "New goal", onClick: () => undefined }}
      tabs={[{ id: "all", label: "All", count: 3 }, { id: "mine", label: "Mine" }]} activeTab="mine" search={{ value: "", onChange: () => undefined, placeholder: "Search goals", label: "Search goals" }}
      menu={[{ id: "x", label: "Import", onSelect: () => undefined }]}><p>content</p></ModuleHome>);
    expect(markup).toContain('<main class="app-page ui-module-home">');
    // One header row: the module's icon and h1, then its actions; no Home button or account row (the sidebar has them).
    expect(markup).toMatch(/<header class="app-page-header page-header ui-module-header"><div class="page-header-title"><span class="ui-module-icon" aria-hidden="true">.*?<h1 id="module-goals-title" class="ui-module-title" tabindex="-1">Q1 2027 goals<\/h1><\/div><div class="page-header-actions"><div class="ui-module-actions">/);
    expect(markup).not.toContain("ui-module-title-row");
    expect(markup).not.toContain("app-home-button");
    expect(markup).not.toContain("app-account");
    expect(markup).toContain('aria-keyshortcuts="n">New goal</button>');
    expect(markup).toMatch(/aria-current="page"[^>]*>Mine</);
    expect(markup).toContain('aria-label="More Goals actions"');
    expect(markup).toContain('aria-keyshortcuts="/"');
    expect(markup).not.toContain("has-detail");
  });

  test("n runs the primary action and / focuses the search, but not while typing", async () => {
    let created = 0;
    const view = await render(<ModuleHome icon={Target} title="Goals" {...account} primary={{ label: "New goal", onClick: () => { created += 1; } }} search={{ value: "", onChange: () => undefined, placeholder: "Search", label: "Search" }}><p>x</p></ModuleHome>);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(created).toBe(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    const input = view.container.querySelector("input[type=search]")!;
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    expect(created).toBe(1);
  });

  test("an empty state is one sentence and one action", () => {
    const markup = renderToStaticMarkup(<EmptyState icon={Target} title="No goals in Q1 2027" action={{ label: "New goal", onClick: () => undefined }}>Goals you own show here.</EmptyState>);
    expect(markup).toContain('<h2 class="ui-empty-title">No goals in Q1 2027</h2>');
    expect(markup.match(/<button/g)).toHaveLength(1);
  });
});

describe("progress, durations, money, schedules", () => {
  test("progress has its text and a valid value; over budget is said, not only colored", () => {
    expect(percentOf(0.624)).toBe(62);
    expect(percentOf(Number.NaN)).toBe(0);
    const over = renderToStaticMarkup(<ProgressBar label="Budget" value={1.2} valueText="6h of 5h" meter />);
    expect(over).toContain('role="meter"');
    expect(over).toContain('aria-valuenow="100"');
    expect(over).toContain('aria-valuetext="6h of 5h, over"');
    expect(renderToStaticMarkup(<ProgressRing value={0.5} label="Done" />)).toContain('aria-valuetext="50%"');
    const chip = renderToStaticMarkup(<HealthChip tone="warning" label="At risk" />);
    expect(chip).toContain('data-tone="warning"');
    expect(chip).toContain("<svg");
    expect(chip).toContain("At risk");
  });

  test("durations: chip, over an estimate, and the timer's elapsed time", () => {
    primeUnits();
    expect(renderToStaticMarkup(<DurationChip seconds={12000} of={18000} label="Logged" />)).toContain('aria-label="Logged: 3h 20m of 5h"');
    expect(renderToStaticMarkup(<DurationChip seconds={20000} of={18000} />)).toContain("over");
    expect(elapsedSeconds("2026-11-13T10:00:00Z", Date.parse("2026-11-13T10:42:10Z"))).toBe(2530);
    expect(renderToStaticMarkup(<TimerChip running={null} onStart={() => undefined} onStop={() => undefined} />)).toContain('aria-label="Start timer"');
    expect(renderToStaticMarkup(<TimerChip running={{ startedAt: new Date(Date.now() - 65_000).toISOString(), label: "MYT-12" }} onStart={() => undefined} onStop={() => undefined} />)).toContain('aria-label="Stop timer on MYT-12"');
  });

  test("DurationInput reads what people type and writes it back in their format", async () => {
    primeUnits({ durationFormat: "hm" });
    const seen: Array<number | null> = [];
    function Field() { const [value, setValue] = useState<number | null>(null); return <DurationInput label="Time" value={value} onChange={(next) => { seen.push(next); setValue(next); }} />; }
    const view = await render(<Field />);
    const input = view.container.querySelector("input")!;
    const { act } = await import("react");
    const type = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    };
    await type("1h30");
    expect(seen.at(-1)).toBe(5400);
    expect(input.value).toBe("1h 30m");
    await type("soon");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Use 1h 30m");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  test("money is formatted with Intl, tabular", () => {
    expect(renderToStaticMarkup(<MoneyText money={{ amount: 123450, currency: "USD" }} />)).toContain("$1,234.50");
  });

  test("schedules: week order, summary, the rule, and the preview from shared nextFires", () => {
    expect(weekOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(weekOrder(0)[0]).toBe(0);
    const value: ScheduleValue = { weekdays: [5, 1, 2, 3, 4], at: "09:00", everyNWeeks: 1, tz: "Europe/Berlin", zoneMode: "fixed" };
    expect(scheduleSummary(value)).toBe("Weekdays at 09:00");
    expect(scheduleSummary({ ...value, weekdays: [1], everyNWeeks: 2, zoneMode: "each" })).toBe("Mondays at 09:00, every 2 weeks in each person's time zone");
    expect(scheduleRule(value)).toEqual({ cadence: { weekdays: [1, 2, 3, 4, 5], at: "09:00" } });
    // Friday 13 Nov 2026 10:00 UTC → next Mon, Tue, Wed at 09:00 Berlin (08:00 UTC), shown in UTC.
    expect(previewFires(value, Date.parse("2026-11-13T10:00:00Z"), 3, "UTC").map((text) => text.replace(/\s+/g, " "))).toHaveLength(3);
    expect(previewFires(value, Date.parse("2026-11-13T10:00:00Z"), 1, "UTC")[0]).toMatch(/16.*08:00/);
  });
});

describe("people and links", () => {
  test("a contact whose book you cannot read is only 'A contact' (T503); a former member says so", () => {
    expect(personText({ kind: "contact", id: "c", hidden: true })).toEqual({ name: "A contact", detail: null });
    const former = renderToStaticMarkup(<PersonChip person={{ kind: "user", id: "u", name: "Ravi", former: true }} />);
    expect(former).toContain("Former member");
    const hidden = renderToStaticMarkup(<PersonChip person={{ kind: "contact", id: "c", hidden: true }} />);
    expect(hidden).toContain("A contact");
    expect(hidden).not.toContain("<button");
  });

  test("an unreadable link shows its kind's icon and no title or href (T501)", () => {
    const markup = renderToStaticMarkup(<WorkRefChip summary={{ kind: "goal", hidden: true }} />);
    expect(markup).toContain("An item you can&#x27;t open");
    expect(markup).not.toContain("href");
    const open = renderToStaticMarkup(<WorkRefChip summary={{ kind: "card", id: "k", key: "MYT-12", title: "Ship it", href: "/tasks/MYT-12", icon: "square-check", status: { label: "Doing", tone: "info" } }} />);
    expect(open).toContain('href="/tasks/MYT-12"');
    expect(open).toContain("MYT-12");
  });

  test("links group by how they read from this side", () => {
    const link = (id: string, relation: WorkLinkView["relation"], direction: "in" | "out"): WorkLinkView => ({ id, relation, direction, source: "work_links", createdAt: null, other: { kind: "note", hidden: true } });
    expect(relationText({ relation: "contributes", direction: "out" })).toBe("contributes to");
    expect(groupLinks([link("1", "blocks", "in"), link("2", "contributes", "out"), link("3", "contributes", "out")]).map((group) => [group.label, group.items.length])).toEqual([["contributes to", 2], ["is blocked by", 1]]);
  });

  test("the Linked panel loads links and removes only work_links ones", async () => {
    const api = mockApi({
      "GET /links?kind=goal&id=g1": () => ({ links: [
        { id: "l1", relation: "relates", direction: "out", source: "work_links", createdAt: null, other: { kind: "card", id: "k", title: "Ship it", href: "/tasks/MYT-12", icon: "square-check" } },
        { id: "l2", relation: "relates", direction: "out", source: "card_relations", createdAt: null, other: { kind: "card", id: "k2", title: "Other", href: "/tasks/MYT-13", icon: "square-check" } }
      ] }),
      "DELETE /links/l1": () => ({})
    });
    const view = await render(<LinkedItemsPanel item={{ kind: "goal", id: "g1" }} canEdit />);
    await view.waitFor(() => view.container.textContent?.includes("Ship it"));
    const removes = view.container.querySelectorAll('button[aria-label^="Remove link"]');
    expect(removes).toHaveLength(1);
    await view.click(removes[0]!);
    await view.waitFor(() => !view.container.textContent?.includes("Ship it"));
    expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/links/l1")).toBe(true);
  });
});

describe("timeline, board, live widgets", () => {
  test("comments and activity interleave by time; replies stay under their comment; the switch hides activity", () => {
    const comment = (id: string, at: string, parentId: string | null = null) => ({ id, itemKind: "goal" as const, itemId: "g", parentId, authorId: "u", authorName: "Ana", body: id, deleted: false, createdAt: at, updatedAt: at, canEdit: false });
    const entry = (id: string, at: string) => ({ id, itemKind: "goal" as const, itemId: "g", kind: "created", actorId: "u", actorName: "Ana", via: null, payload: {}, createdAt: at });
    const comments = [comment("c1", "2026-01-02"), comment("r1", "2026-01-03", "c1")];
    const activity = [entry("a1", "2026-01-01"), entry("a2", "2026-01-04")];
    expect(mergeTimeline(comments, activity, { showActivity: true, order: "asc" }).map((item) => item.id)).toEqual(["a1", "c1", "a2"]);
    expect(mergeTimeline(comments, activity, { showActivity: true, order: "desc" }).map((item) => item.id)).toEqual(["a2", "c1", "a1"]);
    expect(mergeTimeline(comments, activity, { showActivity: false, order: "asc" }).map((item) => item.id)).toEqual(["c1"]);
    // A "commented" entry is the comment itself (D1364): shown once, as the comment.
    const commented = { ...entry("a3", "2026-01-02"), kind: "commented" };
    expect(mergeTimeline(comments, [...activity, commented], { showActivity: true, order: "asc" }).map((item) => item.id)).toEqual(["a1", "c1", "a2"]);
  });

  test("a drop lands before the first card whose middle is below the pointer", () => {
    const columns = [{ id: "a", left: 0, right: 280, cards: [{ id: "1", top: 0, bottom: 100 }, { id: "2", top: 110, bottom: 210 }] }, { id: "b", left: 300, right: 580, cards: [] }];
    expect(dropTarget(columns, 100, 40, "x")).toEqual({ columnId: "a", index: 0 });
    expect(dropTarget(columns, 100, 170, "x")).toEqual({ columnId: "a", index: 2 });
    expect(dropTarget(columns, 100, 170, "1")).toEqual({ columnId: "a", index: 1 });
    expect(dropTarget(columns, 400, 10, "1")).toEqual({ columnId: "b", index: 0 });
    expect(dropTarget(columns, 290, 10, "1")).toBeNull();
  });

  test("Alt+arrows move a card between stages and within one, and say so", async () => {
    const moves: unknown[] = [];
    const items: Array<KanbanItem & { title: string }> = [{ id: "d1", columnId: "lead", title: "Acme" }, { id: "d2", columnId: "lead", title: "Globex" }];
    const view = await render(<KanbanBoard phone={false} label="Deals" columns={[{ id: "lead", title: "Lead" }, { id: "won", title: "Won", total: "$1" }]} items={items}
      itemLabel={(item) => item.title} renderCard={(item) => <strong>{item.title}</strong>} onOpen={() => undefined} onMove={(move) => moves.push(move)} />);
    const card = view.container.querySelector<HTMLElement>('[data-kanban-item="d1"]')!;
    const { act } = await import("react");
    await act(async () => { card.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })); });
    await act(async () => { card.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })); });
    expect(moves).toEqual([{ itemId: "d1", toColumnId: "won", toIndex: 0 }, { itemId: "d1", toColumnId: "lead", toIndex: 1 }]);
    expect(view.container.textContent).toContain("Acme moved to Lead, position 2");
    expect(view.container.querySelector(".ui-kanban-total")?.textContent).toBe("$1");
  });

  test("on phones one stage shows under a strip of stages with counts", () => {
    const markup = renderToStaticMarkup(<KanbanBoard phone label="Deals" columns={[{ id: "a", title: "Lead" }, { id: "b", title: "Won" }]} items={[{ id: "1", columnId: "a" }, { id: "2", columnId: "b" }, { id: "3", columnId: "b" }]}
      itemLabel={(item) => item.id} renderCard={(item) => item.id} onOpen={() => undefined} onMove={() => undefined} />);
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/data-kanban-column=/g)).toHaveLength(1);
    expect(markup).toMatch(/Won<\/span><span class="ui-kanban-count ui-tabular">2/);
  });

  test("Q&A: pinned first, answered last, hidden and others' pending only for moderators", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
    const list: QaQuestion[] = [
      { id: "a", text: "a", author: null, votes: 1, voted: false, status: "approved", createdAt: at(1) },
      { id: "b", text: "b", author: null, votes: 9, voted: false, status: "answered", createdAt: at(2) },
      { id: "c", text: "c", author: null, votes: 5, voted: false, status: "approved", createdAt: at(3) },
      { id: "d", text: "d", author: null, votes: 0, voted: false, status: "approved", pinned: true, createdAt: at(4) },
      { id: "e", text: "e", author: null, votes: 7, voted: false, status: "hidden", createdAt: at(5) },
      { id: "f", text: "f", author: null, votes: 0, voted: false, status: "pending", createdAt: at(6), mine: true },
      { id: "g", text: "g", author: null, votes: 0, voted: false, status: "pending", createdAt: at(7) }
    ];
    expect(orderQuestions(list, "top", false).map((item) => item.id)).toEqual(["d", "c", "a", "f", "b"]);
    expect(orderQuestions(list, "recent", true).map((item) => item.id)).toEqual(["d", "g", "f", "e", "c", "a", "b"]);
    const markup = renderToStaticMarkup(<QaList questions={list} sort="top" onSort={() => undefined} onUpvote={() => undefined} />);
    expect(markup).toContain('aria-label="Upvote, 5 votes"');
    expect(markup).toContain("Now answering");
  });

  test("a poll shows choices until this person votes, then the results; a word cloud scales by log count", () => {
    const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    expect(renderToStaticMarkup(<LivePoll question="Q?" options={options} counts={{ a: 3, b: 1 }} onVote={() => undefined} />)).toContain('type="radio"');
    const results = renderToStaticMarkup(<LivePoll question="Q?" options={options} counts={{ a: 3, b: 1 }} myVote={["a"]} onVote={() => undefined} />);
    expect(results).toContain("3 · 75%");
    expect(results).toContain("A (your vote)");
    expect(renderToStaticMarkup(<LivePoll question="Q?" options={options} counts={{ a: 3 }} onVote={() => undefined} resultsHidden myVote={["a"]} />)).toContain("Results show when the poll closes.");
    expect(cloudSizes([{ text: "a", count: 1 }, { text: "b", count: 100 }], 10, 50)).toEqual([10, 50]);
    expect(cloudSizes([{ text: "a", count: 4 }], 10, 50)).toEqual([30]);
  });

  test("the presenter view leaves on Escape and steps with the arrows", async () => {
    let left = 0, next = 0;
    await render(<PresenterView title="All-hands" onExit={() => { left += 1; }} onNext={() => { next += 1; }}><p>slide</p></PresenterView>);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect([left, next]).toEqual([1, 1]);
  });

  test("insights format units and give every chart a table", () => {
    expect(formatInsightValue(5400, "duration")).toBe("1h 30m");
    expect(formatInsightValue(0.625, "percent")).toBe("63%");
    expect(formatInsightValue(null)).toBe("—");
    // Several series: the legend is one scrolling row above the plot, so it never wraps into it at 375 px.
    const legendOption = insightOption("bar", ["A"], [{ name: "Consulting", values: [1] }, { name: "Internal", values: [2] }, { name: "Support", values: [3] }], "number") as { legend?: { type?: string }; grid: { top: number } };
    expect(legendOption.legend?.type).toBe("scroll");
    expect(legendOption.grid.top).toBe(36);
    const option = insightOption("stacked", ["A"], [{ name: "x", values: [1] }], "number") as { series: Array<{ stack?: string; type: string }> };
    expect(option.series[0]).toMatchObject({ type: "bar", stack: "total" });
  });

  test("an embed the reader cannot open says only that (T513)", () => {
    const markup = renderToStaticMarkup(<EmbedCard icon={Target} word="Goal" title="Secret" unavailable />);
    expect(markup).toContain("Goal unavailable");
    expect(markup).not.toContain("Secret");
  });
});

describe("public pages (§E.6, D831)", () => {
  test("every text pair is at least 4.5:1 and the decorative accent at least 3:1, light and dark", () => {
    for (const theme of [PUBLIC_LIGHT, PUBLIC_DARK]) {
      for (const [text, background] of [[theme.text, theme.background], [theme.text, theme.card], [theme.muted, theme.card], [theme.muted, theme.background], [theme.accentText, theme.card], [theme.onAccent, theme.accentText], [theme.error, theme.card]] as const) {
        expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme.accent, theme.card)).toBeGreaterThanOrEqual(3);
    }
  });

  test("a module accent is used only when it keeps the contrast; anything else falls back", () => {
    expect(publicAccent("#1d4ed8")).toEqual({ accent: "#1d4ed8", accentText: "#1d4ed8" });
    expect(publicAccent("#fde047")).toEqual({ accent: PUBLIC_LIGHT.accent, accentText: PUBLIC_LIGHT.accentText });
    expect(publicAccent("red; background: url(x)")).toEqual({ accent: PUBLIC_LIGHT.accent, accentText: PUBLIC_LIGHT.accentText });
  });

  test("the shell names the workspace and the app, ignores off-site logos, and misses look the same", () => {
    const markup = renderToStaticMarkup(<PublicPageShell workspaceName="Acme" appName="Nook" logoUrl="https://evil.test/x.png" title="Survey"><p>body</p></PublicPageShell>);
    expect(markup).toContain("Acme");
    expect(markup).toContain("Powered by <strong>Nook</strong>");
    expect(markup).not.toContain("evil.test");
    expect(renderToStaticMarkup(<PublicNotFound appName="Nook" />)).toContain("This link is not available");
    // A path no module claims (Forms has /p/f, Bookings /p/book) is the one PublicNotFound.
    expect(publicPageFor("/p/unclaimed/abc")).toBeNull();
  });
});

describe("the question set editor", () => {
  const base: QuestionSet = { version: 1, sections: [], endings: [], logic: [{ id: "l1", when: { all: [{ questionId: "a", op: "answered" }] }, then: { show: ["b"] } }],
    questions: [{ id: "a", type: "short_text", title: "A" }, { id: "b", type: "short_text", title: "B" }, { id: "c", type: "short_text", title: "C" }] };

  test("new questions carry what their type needs and pass the shared validation once titled", () => {
    for (const type of ["single_choice", "rating", "scale", "matrix", "hidden", "nps", "contact"] as const) {
      const question = { ...newQuestion(type), title: "Title" };
      expect(questionSetProblems({ ...base, logic: [], questions: [question] })).toEqual([]);
    }
  });

  test("move, duplicate with fresh ids, and remove with the rules that name it", () => {
    expect(moveQuestion(base, 0, 1).questions.map((question) => question.id)).toEqual(["b", "a", "c"]);
    expect(moveQuestion(base, 0, -1)).toBe(base);
    const copy = duplicateQuestion({ id: "x", type: "single_choice", title: "X", options: [{ id: "o", label: "O" }] });
    expect(copy.id).not.toBe("x");
    expect(copy.options![0]!.id).not.toBe("o");
    expect(removeQuestion(base, "b").logic).toEqual([]);
    expect(problemsByQuestion([{ path: "questions.2.options", message: "Add an option" }, { path: "logic.0", message: "x" }])).toEqual(new Map([[2, ["Add an option"]]]));
  });

  test("Backspace in an empty title deletes the question; Ctrl+D duplicates", async () => {
    let current: QuestionSet = { ...base, logic: [], questions: [{ id: "a", type: "short_text", title: "A" }, { id: "b", type: "short_text", title: "" }] };
    function Editor() { const [set, setSet] = useState(current); current = set; return <QuestionSetEditor set={set} onChange={setSet} />; }
    const view = await render(<Editor />);
    const { act } = await import("react");
    const empty = view.container.querySelector<HTMLTextAreaElement>('[data-q-title="b"]')!;
    await act(async () => { empty.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })); });
    expect(current.questions.map((question) => question.id)).toEqual(["a"]);
    const first = view.container.querySelector<HTMLTextAreaElement>('[data-q-title="a"]')!;
    await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true })); });
    expect(current.questions).toHaveLength(2);
    expect(current.questions[1]!.title).toBe("A");
  });
});

describe("phone layouts (Wave 2 integration)", () => {
  test("the card dialog's body and sections keep one column the width of the screen, so a wide slot cannot push the dialog past 375 px", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
    const tasks = css("tasks/tasks.css");
    // An implicit grid track sizes to its widest item (a long goal chip measured 741 px at 375).
    expect(tasks).toMatch(/\.task-card-dialog-body \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(tasks).toMatch(/\.task-card-section \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css("goals/goals.css")).toContain(".goals-card-goals li { min-width: 0; max-width: 100%; }");
  });
});
