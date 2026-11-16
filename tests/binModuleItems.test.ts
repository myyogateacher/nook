import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";

/**
 * D1380: the Bin's workspace-module items carry the in-app path they open at once restored (the
 * module's own friendly path), and a contact book restores to "Contacts", never "Default".
 */

type Json = Record<string, any>;
let owner: Session;

const api = async (method: string, path: string, body?: unknown) => {
  const payload = body === undefined && method !== "GET" ? {} : body;
  const response = await request(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, owner);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Json };
};

const binned = async (type: string, id: string) => {
  const list = await api("GET", `/bin?type=${type}`);
  expect(list.status).toBe(200);
  return (list.body.items as Json[]).find((item) => item.id === id);
};

beforeAll(async () => {
  owner = await createUser("Bin module owner");
});

describe("Bin module items (D1380)", () => {
  test("a binned form, goal, time project, townhall session, and booking type list their module path", async () => {
    const form = (await api("POST", "/forms", { kind: "form", title: "Bin form" })).body.form as Json;
    expect((await api("DELETE", `/forms/${form.id}`)).status).toBe(200);
    expect(await binned("form", form.id)).toMatchObject({ type: "form", folder_name: "Forms", href: form.href ?? expect.stringMatching(/^\/forms\/bin-form-[0-9a-z]{10}$/) });

    const goal = (await api("POST", "/goals", { title: "Bin goal" })).body.goal as Json;
    expect((await api("DELETE", `/goals/${goal.id}`)).status).toBeLessThan(300);
    expect(await binned("goal", goal.id)).toMatchObject({ type: "goal", href: goal.href });

    const project = (await api("POST", "/time/projects", { name: "Bin project" })).body.project as Json;
    expect((await api("DELETE", `/time/projects/${project.id}`)).status).toBeLessThan(300);
    expect(await binned("time_project", project.id)).toMatchObject({ type: "time_project", folder_name: "Time", href: expect.stringMatching(/^\/time\/projects\/bin-project-[0-9a-z]{10}$/) });

    const session = (await api("POST", "/townhall/sessions", { title: "Bin townhall" })).body.session as Json;
    expect((await api("DELETE", `/townhall/sessions/${session.id}`)).status).toBeLessThan(300);
    expect(await binned("townhall_session", session.id)).toMatchObject({ type: "townhall_session", href: session.href });

    const type = (await api("POST", "/bookings/types", { title: "Bin call", minNotice: 0 })).body.type as Json;
    expect((await api("DELETE", `/bookings/types/${type.id}`)).status).toBeLessThan(300);
    expect(await binned("booking_type", type.id)).toMatchObject({ type: "booking_type", folder_name: "Bookings", href: type.href });
  });

  test("a contact lists its book and path; a contact book restores to Contacts", async () => {
    const book = (await api("POST", "/crm/books", { name: "Bin book" })).body.book as Json;
    const contact = (await api("POST", "/crm/contacts", { bookId: book.id, name: "Bin Person" })).body.contact as Json;
    expect((await api("DELETE", `/crm/contacts/${contact.id}`)).status).toBeLessThan(300);
    expect(await binned("contact", contact.id)).toMatchObject({ type: "contact", folder_name: "Bin book", href: expect.stringMatching(/^\/contacts\/bin-person-[0-9a-z]{10}$/) });

    expect((await api("DELETE", `/crm/books/${book.id}`)).status).toBeLessThan(300);
    const listed = await binned("contact_book", book.id);
    expect(listed).toMatchObject({ type: "contact_book", folder_name: "Contacts", href: expect.stringMatching(/^\/contacts\?book=[0-9a-z]{10}$/) });
    const restored = await api("POST", `/bin/contact_book/${book.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.folderName).toBe("Contacts");
  });
});
