import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatRoute, locationUrl, parseRoute, routeFromLocation, sameRoute } from "../src/router";
import { parentTasksRoute, tasksBackAction, tasksRoute } from "../src/tasksRoute";
import { parseBoardSearch } from "../src/tasks/boardUrl";

// WAVE_13_TASK_CARD_UX.md §4.6 router changes and the §10 risk note: the Tasks query must reach
// `parseRoute`, or a reload or Back silently drops the board's view and filters.
const board = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const card = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";

test("a Tasks location keeps its query only when the search is passed", () => {
  const location = { pathname: `/tasks/${board}`, search: "?view=table&flag=urgent" };
  const route = routeFromLocation(location);
  expect(route).toEqual({ app: "tasks", boardId: board, cardId: null, query: parseBoardSearch(location.search) });
  expect(formatRoute(route)).toBe(`/tasks/${board}?view=table&q=priority:urgent`);
  // Without the search the view is lost: the regression the call-site check below prevents.
  expect(parseRoute(location.pathname)).toEqual({ app: "tasks", boardId: board, cardId: null });
  expect(sameRoute(route, parseRoute(location.pathname))).toBe(false);
});

test("card URLs carry the board query forward, and closing returns to the same view", () => {
  const route = parseRoute(`/tasks/${board}/card/${card}`, "?view=list&group=assignee");
  expect(formatRoute(route)).toBe(`/tasks/${board}/card/${card}?view=list&group=assignee`);
  if (route.app !== "tasks") throw new Error("not tasks");
  expect(formatRoute(parentTasksRoute(route)!)).toBe(`/tasks/${board}?view=list&group=assignee`);
  expect(tasksBackAction(route, 0)).toEqual({ kind: "replace", route: tasksRoute(board, null, false, route.query) });
  // The board list never carries a board's query.
  expect(formatRoute(parentTasksRoute(tasksRoute(board, null, false, route.query))!)).toBe("/tasks");
  expect(formatRoute(tasksRoute(null, null, false, route.query))).toBe("/tasks");
});

test("an href with its own query parses like a location; other apps ignore the search", () => {
  expect(parseRoute(`/tasks/${board}?view=calendar&month=2026-10`)).toEqual(routeFromLocation({ pathname: `/tasks/${board}`, search: "?view=calendar&month=2026-10" }));
  expect(parseRoute("/calendar/month/2026-10", "?view=table")).toEqual({ app: "calendar", view: "month", month: "2026-10", eventId: null });
  expect(parseRoute("/notes", "?q=secret")).toEqual({ app: "notes", folder: "all", noteId: null });
  expect(parseRoute("/tasks", "?view=table")).toEqual({ app: "tasks", boardId: null, cardId: null });
  expect(parseRoute(`/tasks/${board}`, "?view=board")).toEqual({ app: "tasks", boardId: board, cardId: null });
  expect(locationUrl({ pathname: `/tasks/${board}`, search: "?view=table" })).toBe(`/tasks/${board}?view=table`);
  expect(locationUrl({ pathname: "/notes", search: "?x=1" })).toBe("/notes");
  expect(locationUrl({ pathname: "/tasksx", search: "?x=1" })).toBe("/tasksx");
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every Tasks call site reads the current URL with its query", () => {
  const root = join(import.meta.dir, "..", "src");
  const files = [join(root, "App.tsx"), join(root, "tasksRoute.ts"), ...sources(join(root, "tasks"))];
  const offenders = files.filter((file) => /parseRoute\(\s*(window\.)?location\.pathname\s*\)/.test(readFileSync(file, "utf8")));
  expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([]);
  // App.tsx compares Tasks URLs with the query included.
  const app = readFileSync(join(root, "App.tsx"), "utf8");
  expect(app).not.toMatch(/formatRoute\(route\) !== window\.location\.pathname/);
  expect(app).toContain("url === locationUrl(window.location)");
});
