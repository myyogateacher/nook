import { expect, test } from "bun:test";
import { formatRoute, parseRoute, sameRoute, type Route } from "../src/router";

const folderId = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const noteId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";

const rows: Array<[string, Route]> = [
  ["/", { app: "home" }],
  ["/notes", { app: "notes", folder: "all", noteId: null }],
  ["/notes/shared", { app: "notes", folder: "shared", noteId: null }],
  [`/notes/folder/${folderId}`, { app: "notes", folder: folderId, noteId: null }],
  [`/notes/${noteId}`, { app: "notes", folder: "all", noteId }],
  ["/files", { app: "files", folder: "all", documentId: null }],
  ["/files/shared", { app: "files", folder: "shared", documentId: null }],
  [`/files/folder/${folderId}`, { app: "files", folder: folderId, documentId: null }],
  [`/files/${noteId}`, { app: "files", folder: "all", documentId: noteId }],
  ["/tasks", { app: "tasks", boardId: null, cardId: null }],
  [`/tasks/${folderId}`, { app: "tasks", boardId: folderId, cardId: null }],
  [`/tasks/${folderId}/card/${noteId}`, { app: "tasks", boardId: folderId, cardId: noteId }],
  ["/bin", { app: "bin" }]
];

test("every route in the table parses and formats back to the same URL", () => {
  for (const [path, route] of rows) {
    expect(parseRoute(path)).toEqual(route);
    expect(formatRoute(route)).toBe(path);
    expect(sameRoute(parseRoute(formatRoute(route)), route)).toBe(true);
  }
});

test("trailing and doubled slashes are tolerated", () => {
  expect(parseRoute("/notes/")).toEqual({ app: "notes", folder: "all", noteId: null });
  expect(parseRoute(`//notes//folder//${folderId}/`)).toEqual({ app: "notes", folder: folderId, noteId: null });
  expect(parseRoute(`/notes/${noteId}//`)).toEqual({ app: "notes", folder: "all", noteId });
  expect(parseRoute("/bin/")).toEqual({ app: "bin" });
  expect(parseRoute("")).toEqual({ app: "home" });
});

test("malformed ids are dropped instead of thrown", () => {
  expect(parseRoute("/notes/not-a-uuid")).toEqual({ app: "notes", folder: "all", noteId: null });
  expect(parseRoute("/notes/folder/../../etc")).toEqual({ app: "notes", folder: "all", noteId: null });
  expect(parseRoute("/notes/folder/")).toEqual({ app: "notes", folder: "all", noteId: null });
  expect(parseRoute(`/files/${noteId}x`)).toEqual({ app: "files", folder: "all", documentId: null });
  expect(formatRoute({ app: "notes", folder: "bogus", noteId: "bogus" })).toBe("/notes");
});

test("unknown paths resolve to home", () => {
  for (const path of ["/api-like", "/notesx", "/bin/extra", "/index.html", "/settingsx"]) expect(parseRoute(path)).toEqual({ app: "home" });
});

test("a note id and a folder id are told apart by the folder prefix", () => {
  expect(parseRoute(`/notes/${folderId}`)).toEqual({ app: "notes", folder: "all", noteId: folderId });
  expect(parseRoute(`/notes/folder/${noteId}`)).toEqual({ app: "notes", folder: noteId, noteId: null });
});

test("an open note formats as its own URL regardless of the selected folder", () => {
  expect(formatRoute({ app: "notes", folder: folderId, noteId })).toBe(`/notes/${noteId}`);
  expect(sameRoute({ app: "notes", folder: "shared", noteId }, { app: "notes", folder: "all", noteId })).toBe(true);
  expect(sameRoute({ app: "notes", folder: "shared", noteId: null }, { app: "notes", folder: "all", noteId: null })).toBe(false);
  expect(sameRoute({ app: "home" }, { app: "bin" })).toBe(false);
});

test("uppercase ids normalise", () => {
  expect(parseRoute(`/notes/${noteId.toUpperCase()}`)).toEqual({ app: "notes", folder: "all", noteId });
  expect(parseRoute(`/notes/folder/${folderId.toUpperCase()}`)).toEqual({ app: "notes", folder: folderId, noteId: null });
  expect(parseRoute(`/files/${noteId.toUpperCase()}`)).toEqual({ app: "files", folder: "all", documentId: noteId });
});

test("format never escapes origin", () => {
  const hostile = ["//evil", "javascript:x", "../x", "/\\evil.example", "%2F%2Fevil", `${noteId}/../../x`, "https://evil.example"];
  const shape = /^\/(notes|files|tasks|bin)?(\/[a-z0-9/-]*)?$/;
  for (const value of hostile) {
    const routes: Route[] = [
      { app: "notes", folder: value, noteId: value },
      { app: "notes", folder: value, noteId: null },
      { app: "files", folder: value, documentId: value },
      { app: "files", folder: value, documentId: null },
      { app: "tasks", boardId: value, cardId: value },
      { app: "tasks", boardId: noteId, cardId: value },
      { app: "tasks", boardId: value, cardId: value, full: true },
      { app: "tasks", boardId: noteId, cardId: value, full: true }
    ];
    for (const route of routes) {
      const url = formatRoute(route);
      expect(url.startsWith("/")).toBe(true);
      expect(url.startsWith("//")).toBe(false);
      expect(url).toMatch(shape);
    }
  }
});

test("Team routes: /team, /team/:userId (lowercased), and malformed ids open the list", () => {
  const userId = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
  expect(parseRoute("/team")).toEqual({ app: "team", userId: null });
  expect(parseRoute("/team/")).toEqual({ app: "team", userId: null });
  expect(parseRoute(`/team/${userId}`)).toEqual({ app: "team", userId });
  expect(parseRoute(`/team/${userId.toUpperCase()}`)).toEqual({ app: "team", userId });
  expect(parseRoute("/team/garbage")).toEqual({ app: "team", userId: null });
  expect(parseRoute(`/team/${userId}/extra`)).toEqual({ app: "team", userId: null });
  expect(formatRoute({ app: "team", userId: null })).toBe("/settings/team/members");
  expect(formatRoute({ app: "team", userId: userId.toUpperCase() })).toBe(`/settings/team/members/${userId}`);
  expect(formatRoute({ app: "team", userId: "garbage" })).toBe("/settings/team/members");
  // Wave 18: the Invites panel, parsed before the id rule, and round-tripped.
  expect(parseRoute("/team/invites")).toEqual({ app: "team", userId: null, invites: true });
  expect(formatRoute({ app: "team", userId: null, invites: true })).toBe("/settings/team/invites");
  expect(formatRoute(parseRoute("/team/invites"))).toBe("/settings/team/invites");
  expect(parseRoute("/team/invites/extra")).toEqual({ app: "team", userId: null });
  expect(parseRoute("/team/INVITES")).toEqual({ app: "team", userId: null });
  expect(formatRoute(parseRoute(`/team/${userId}`))).toBe(`/settings/team/members/${userId}`);
  expect(sameRoute({ app: "team", userId: null }, { app: "team", userId })).toBe(false);
});
