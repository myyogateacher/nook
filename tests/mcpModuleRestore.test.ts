import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, type Session } from "./support/harness";
import { api, call, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";

const { mcpToolSpecs } = await import("../server/mcpTools");
const { NOOK_AGENT_TOOLS, isBinTool } = await import("../server/agents/nookBridge");

/**
 * D1385: every module item MCP can bin it can restore (forms, goals, contacts, companies, deals), and
 * time projects and townhall sessions gain bin_ and restore_ tools. Each needs its module's write
 * scope and `bin:write`; a bin counts against the Bin buckets, a restore does not; none is offered to
 * chat agents.
 */

let owner: Session;
let other: Session;

const shape = (name: string) => {
  const spec = mcpToolSpecs.find((item) => item.name === name);
  if (!spec) throw new Error(`missing ${name}`);
  return { scopes: [...spec.scopes], alsoRequires: [...(spec.alsoRequires ?? [])], write: spec.write, buckets: [...(spec.buckets ?? [])] };
};
const bin = ["bin_action", "bin_burst"];

beforeAll(async () => {
  owner = await createUser("MCP restore owner");
  other = await createUser("MCP restore other");
});

describe("module bin and restore tools (D1385)", () => {
  test("each restore pairs a bin, with the module's write scope and bin:write; never offered to agents", () => {
    const expected: Record<string, string> = {
      restore_form: "forms:write", restore_goal: "goals:write", restore_contact: "crm:write", restore_company: "crm:write", restore_deal: "crm:write",
      restore_time_project: "time:write", restore_townhall_session: "townhall:write"
    };
    for (const [name, scope] of Object.entries(expected)) {
      expect({ name, ...shape(name) }).toEqual({ name, scopes: [scope], alsoRequires: ["bin:write"], write: true, buckets: [] });
      const binName = name.replace(/^restore_/, "bin_");
      expect({ name: binName, ...shape(binName) }).toEqual({ name: binName, scopes: [scope], alsoRequires: ["bin:write"], write: true, buckets: bin });
      expect(isBinTool(name) && isBinTool(binName)).toBe(true);
      expect(NOOK_AGENT_TOOLS.has(name) || NOOK_AGENT_TOOLS.has(binName)).toBe(false);
    }
  });

  test("a key without bin:write lists none of them", async () => {
    const names = await toolNames(makeKey(owner, ["forms:write", "goals:write", "crm:write", "time:write", "townhall:write"]));
    expect(names.filter((name) => name.startsWith("bin_") || name.startsWith("restore_"))).toEqual([]);
    const withBin = await toolNames(makeKey(owner, ["time:write", "townhall:write", "bin:write"]));
    expect(withBin).toEqual(expect.arrayContaining(["bin_time_project", "restore_time_project", "bin_townhall_session", "restore_townhall_session"]));
  });

  test("bin and restore a time project and a townhall session; a restore by someone else is NOT_FOUND", async () => {
    const key = makeKey(owner, ["time:write", "townhall:write", "forms:write", "goals:write", "bin:write"]);
    const project = (await api(owner, "POST", "/time/projects", { name: "MCP bin project" })).body.project;
    expect(await ok(key, "bin_time_project", { projectId: project.id })).toMatchObject({ binned: true });
    expect((await api(owner, "GET", `/time/projects/${project.id}`)).status).toBe(404);
    const otherKey = makeKey(other, ["time:write", "bin:write"]);
    expect(await errorCode(otherKey, "restore_time_project", { projectId: project.id })).toBe("NOT_FOUND");
    expect(await ok(key, "restore_time_project", { projectId: project.id })).toMatchObject({ restored: true, folderName: "Time" });
    expect((await api(owner, "GET", `/time/projects/${project.id}`)).status).toBe(200);

    const session = (await api(owner, "POST", "/townhall/sessions", { title: "MCP bin session" })).body.session;
    expect(await ok(key, "bin_townhall_session", { sessionId: session.shortId })).toEqual({ binned: true });
    expect((await api(owner, "GET", `/townhall/sessions/${session.id}`)).status).toBe(404);
    expect(await ok(key, "restore_townhall_session", { sessionId: session.id })).toMatchObject({ restored: true, folderName: "Townhall" });
    expect((await api(owner, "GET", `/townhall/sessions/${session.id}`)).status).toBe(200);
    expect(await ok(key, "restore_townhall_session", { sessionId: session.id })).toEqual({ restored: true, alreadyRestored: true });

    const form = (await api(owner, "POST", "/forms", { kind: "form", title: "MCP bin form" })).body.form;
    await ok(key, "bin_form", { formId: form.id });
    expect(await ok(key, "restore_form", { formId: form.id })).toMatchObject({ restored: true, folderName: "Forms" });
    const goal = (await api(owner, "POST", "/goals", { title: "MCP bin goal" })).body.goal;
    await ok(key, "bin_goal", { goalId: goal.id });
    expect(await ok(key, "restore_goal", { goalId: goal.id })).toMatchObject({ restored: true, folderName: "Goals" });
  });

  test("contacts, companies, and deals restore into their book; a record in a binned book waits for it", async () => {
    const key = makeKey(owner, ["crm:write", "bin:write"]);
    const book = (await api(owner, "POST", "/crm/books", { name: "MCP restore book" })).body.book;
    const contact = (await api(owner, "POST", "/crm/contacts", { bookId: book.id, name: "Rae Restore" })).body.contact;
    const company = (await api(owner, "POST", "/crm/companies", { bookId: book.id, name: "Restore Co" })).body.company;
    for (const [tool, arg, id] of [["contact", "contactId", contact.id], ["company", "companyId", company.id]] as const) {
      await ok(key, `bin_${tool}`, { [arg]: id });
      expect(await ok(key, `restore_${tool}`, { [arg]: id })).toMatchObject({ restored: true, folderName: "MCP restore book" });
    }
    await ok(key, "bin_contact", { contactId: contact.id });
    expect((await api(owner, "DELETE", `/crm/books/${book.id}`)).status).toBeLessThan(300);
    expect(await errorCode(key, "restore_contact", { contactId: contact.id })).toBe("PARENT_IN_BIN");
    expect((await call(key, "restore_deal", { dealId: "not-a-uuid" })).isError).toBe(true);
  });
});
