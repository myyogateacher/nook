import { expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";

/** Today's `whiteboardsRecent` section (Wave 23, §10.7): the five newest boards the caller can read. */

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function create(owner: Session, name: string) {
  const result = await api(owner, "POST", "/whiteboards", { name });
  expect(result.status).toBe(201);
  return result.body.whiteboard;
}

test("Today lists the five newest boards the caller can read", async () => {
  const owner = await createUser("WB today");
  for (const name of ["a", "b", "c", "d", "e", "f"]) await create(owner, name);
  const today = await api(owner, "GET", "/today?tz=UTC");
  expect(today.body.sections.whiteboardsRecent).toMatchObject({ more: true, href: "/whiteboards" });
  expect(today.body.sections.whiteboardsRecent.items.map((item: { name: string }) => item.name)).toEqual(["f", "e", "d", "c", "b"]);
});
