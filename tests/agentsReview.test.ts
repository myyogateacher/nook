import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { api, errorCode, makeKey, ok } from "./support/mcpClient";
import { AGENT_BOUNDS } from "../shared/agents";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";

const { config } = await import("../server/config");
const { setAgentsKeyForTests, agentsStatus } = await import("../server/agents/status");
const { secretHint } = await import("../server/agents/secrets");
const { windowTurns } = await import("../server/agents/runs");
const { cutUsage, partialUsage } = await import("../server/agents/loop");
const { channelOf } = await import("../server/agents/stream");
const { listChats } = await import("../server/agents/chats");

/**
 * Wave 40 security review probes for the session API: the owner-privacy matrix across every role,
 * CSRF and anonymous access, the module-off lockout, the search index, the Bin's agent purge, the
 * resume endpoint's edges, SSE fan-out, the message window, and the secret hint.
 */

retireUsersAfterFile();
const fake = startFakeProvider(0);
let admin: Session;
let owner: Session;
let member: Session;
let viewer: Session;
let providerId: string;

const sseText = async (session: Session, runId: string, after = 0, { headersOnly = false } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${origin}/api/runs/${runId}/events?after=${after}`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
    if (headersOnly) controller.abort();
    const text = response.ok && !headersOnly ? await response.text().catch(() => "") : "";
    return { status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timer);
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  admin = await createUser("Review admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Review owner");
  member = await createUser("Review member");
  viewer = await createUser("Review viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Review fake", baseUrl: fake.baseUrl, apiKey: "sk-test-review-0001", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
});
afterAll(() => fake.stop());

describe("review: owner privacy on every route (T325, D73)", () => {
  test("another member, a viewer, and an admin get 404 on an owner's agent, chat, run, events, cancel, and Bin items", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Private", systemPrompt: "SECRET-PROMPT-7731", providerId })).body.agent as { id: string; revision: number };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string; revision: number };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "slow:60:a b c d e f g h i j k l m n o p q r s t u v w x y z" });
    expect(started.status).toBe(201);
    const runId = started.body.runId as string;
    const messageId = started.body.assistantMessage.id as string;
    for (const other of [member, viewer, admin]) {
      const probes: Array<[string, string, unknown?]> = [
        ["GET", `/agents/${agent.id}`], ["PATCH", `/agents/${agent.id}`, { name: "x", expectedRevision: 1 }], ["DELETE", `/agents/${agent.id}`],
        ["POST", "/chats", { agentId: agent.id }],
        ["GET", `/chats/${chat.id}`], ["PATCH", `/chats/${chat.id}`, { title: "x", expectedRevision: 1 }], ["DELETE", `/chats/${chat.id}`],
        ["POST", `/chats/${chat.id}/messages`, { content: "hi" }], ["POST", `/chats/${chat.id}/messages/${messageId}/regenerate`, {}],
        ["GET", `/chats/${chat.id}/run`], ["POST", `/runs/${runId}/cancel`, {}],
        ["POST", `/bin/chat/${chat.id}/restore`, {}], ["DELETE", `/bin/chat/${chat.id}`], ["POST", `/bin/agent/${agent.id}/restore`, {}], ["DELETE", `/bin/agent/${agent.id}`]
      ];
      for (const [method, path, body] of probes) {
        const response = await api(other, method, path, body);
        // Viewers are stopped by the role write gate (403) before the handler on the few writes it does not allowlist for them.
        const accepted = other === viewer && method !== "GET" ? [403, 404] : [404];
        expect({ who: other === viewer ? "viewer" : other === admin ? "admin" : "member", method, path, ok: accepted.includes(response.status) }).toMatchObject({ ok: true });
        expect(JSON.stringify(response.body)).not.toContain("SECRET-PROMPT");
      }
      // The live stream and the snapshot after the ring: 404, nothing streamed, for any `after`.
      for (const after of [0, 1, 999]) {
        const stream = await sseText(other, runId, after);
        expect({ after, status: stream.status, text: stream.text }).toEqual({ after, status: 404, text: "" });
      }
      // Lists never show it.
      expect((await api(other, "GET", "/chats")).body.chats?.some((item: { id: string }) => item.id === chat.id) ?? false).toBe(false);
      expect((await api(other, "GET", "/agents")).body.agents?.some((item: { id: string }) => item.id === agent.id) ?? false).toBe(false);
    }
    // The owner's own stream carries no-store and the run is still theirs.
    // Headers only: reading the live stream to its end would wait out the slow run.
    const mine = await sseText(owner, runId, 0, { headersOnly: true });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    await api(owner, "POST", `/runs/${runId}/cancel`, {});
    // MCP: a stranger's key with agents:read sees none of it, with or without a search.
    const stranger = makeKey(member, ["agents:read"]);
    expect((await ok(stranger, "list_chats", { query: "slow" })).chats).toEqual([]);
    expect((await ok(stranger, "list_agents")).agents.some((item: { id: string }) => item.id === agent.id)).toBe(false);
    await sleep(100);
  });

  test("anonymous requests are 401 everywhere in the module; writes without the CSRF header are 403", async () => {
    for (const path of ["/agents/status", "/agents", "/chats", `/runs/${crypto.randomUUID()}/events`, "/agents/admin/providers"]) {
      const response = await request(path);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
    const noCsrf = await request("/chats", { method: "POST", body: JSON.stringify({ agentId: crypto.randomUUID() }), headers: { Cookie: owner.cookie, Origin: origin } });
    expect(noCsrf.status).toBe(403);
    const adminNoCsrf = await request(`/agents/admin/providers/${providerId}`, { method: "PATCH", body: JSON.stringify({ name: "x", expectedRevision: 1 }), headers: { Cookie: admin.cookie, Origin: origin } });
    expect(adminNoCsrf.status).toBe(403);
  });
});

describe("review: module off by key mismatch", () => {
  test("with a key that does not open the stored secrets, admins can still list, remove, re-enter, and delete provider keys; the module comes back once every secret opens (M3)", async () => {
    const key = config.agents.key;
    const second = await api(admin, "POST", "/agents/admin/providers", { name: "Review second", baseUrl: fake.baseUrl, apiKey: "sk-test-review-second-0002", defaultModel: "gpt-6-luna" });
    expect(second.status).toBe(201);
    const secondId = second.body.provider.id as string;
    try {
      expect(setAgentsKeyForTests(Buffer.alloc(32, 123))).toEqual({ enabled: false, reason: "key_mismatch" });
      // Chat routes stay off; non-admins get nothing from the recovery routes.
      expect((await api(owner, "GET", "/chats")).status).toBe(503);
      expect((await api(owner, "GET", "/agents/admin/providers")).status).toBe(404);
      expect((await api(admin, "POST", "/agents/admin/providers", { name: "x", baseUrl: fake.baseUrl })).status).toBe(503);
      const list = await api(admin, "GET", "/agents/admin/providers");
      expect(list.status).toBe(200);
      expect(list.body.providers.map((item: { id: string; hasSecret: boolean }) => item.hasSecret)).toEqual([true, true]);
      expect((await api(admin, "GET", `/agents/admin/providers/${providerId}`)).status).toBe(200);
      // Remove one key: still one secret the key cannot open.
      const remove = await api(admin, "PATCH", `/agents/admin/providers/${providerId}`, { removeSecret: true, expectedRevision: 1 });
      expect(remove.status).toBe(200);
      expect(remove.body.provider).toMatchObject({ hasSecret: false, hint: null });
      expect((await api(admin, "GET", "/agents/status")).body).toMatchObject({ enabled: false, reason: "key_mismatch" });
      // Re-enter the other under the current key: everything opens, the module is on without a restart.
      const reenter = await api(admin, "PATCH", `/agents/admin/providers/${secondId}`, { apiKey: "sk-test-review-second-0003", expectedRevision: 1 });
      expect(reenter.status).toBe(200);
      expect(agentsStatus()).toEqual({ enabled: true, reason: null });
      expect((await api(admin, "GET", "/agents/status")).body).toMatchObject({ enabled: true, reason: null, hasProvider: true });
      // Only admins learn whether a provider exists (the empty Chat list's "add one" line).
      expect((await api(owner, "GET", "/agents/status")).body.hasProvider).toBeUndefined();
      expect((await api(owner, "GET", "/chats")).status).toBe(200);
      // Back to the mismatch with one failing secret: DELETE recovers too.
      expect(setAgentsKeyForTests(Buffer.alloc(32, 124))).toEqual({ enabled: false, reason: "key_mismatch" });
      expect((await api(admin, "DELETE", `/agents/admin/providers/${secondId}`)).status).toBe(200);
      expect(agentsStatus()).toEqual({ enabled: true, reason: null });
    } finally {
      setAgentsKeyForTests(key);
      await api(admin, "DELETE", `/agents/admin/providers/${secondId}`);
      await api(admin, "PATCH", `/agents/admin/providers/${providerId}`, { apiKey: "sk-test-review-0001", expectedRevision: 2 });
    }
    expect(agentsStatus().enabled).toBe(true);
  });

  test("the hint is shown only for secrets of 16 or more characters (L8)", () => {
    expect(secretHint("sk-abcdefg")).toBe("…");
    expect(secretHint("sk-abcdefghijkl")).toBe("…");
    expect(secretHint("sk-abcdefghijklm")).toBe("sk-…jklm");
  });
});

describe("review: search, Bin, and resume edges", () => {
  test("a search of only a double quote does not crash the route", async () => {
    const response = await api(owner, "GET", `/chats?q=${encodeURIComponent('"')}`);
    expect([200, 400]).toContain(response.status);
  });

  test("the FTS stage is scoped to the owner: 600 matching rows of other people's chats never crowd out the owner's hit (L4)", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Search", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const marker = `zq${crypto.randomUUID().slice(0, 8)}`;
    const others = Array.from({ length: 600 }, () => crypto.randomUUID());
    const insert = db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES (?, ?, '', ?)");
    const remove = db.query("DELETE FROM chat_fts WHERE chat_id = ?");
    db.transaction(() => { for (const [index, id] of others.entries()) insert.run(id, member.userId, `${marker} filler ${index}`); })();
    try {
      insert.run(chat.id, owner.userId, `${marker} mine`);
      expect(listChats(owner.userId, { q: marker }).map((item) => item.id)).toEqual([chat.id]);
      // The filler rows belong to nobody's live chat, so the member's search finds nothing either.
      expect(listChats(member.userId, { q: marker })).toEqual([]);
      // The index rows the app writes carry the owner.
      expect(db.query("SELECT owner_id FROM chat_fts WHERE chat_id = ? AND title = 'New chat'").get(chat.id)).toEqual({ owner_id: owner.userId });
    } finally {
      db.transaction(() => { for (const id of [...others, chat.id]) remove.run(id); })();
    }
  });

  test("purging an agent that has chats succeeds: the chats stay the owner's, read-only, shown without an agent (M2)", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "With chats", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    expect((await api(owner, "DELETE", `/agents/${agent.id}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/agent/${agent.id}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM agents WHERE id = ?").get(agent.id)).toBeNull();
    expect((await api(owner, "GET", "/bin")).body.items.some((item: { type: string; id: string }) => item.type === "agent" && item.id === agent.id)).toBe(false);
    const detail = await api(owner, "GET", `/chats/${chat.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.chat).toMatchObject({ id: chat.id, agentId: null, agentName: null });
    expect((await api(owner, "GET", "/chats")).body.chats.find((item: { id: string }) => item.id === chat.id)).toMatchObject({ agentId: null, agentName: null });
    const send = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "echo:hello" });
    expect(send.status).toBe(409);
    expect(send.body.code).toBe("AGENT_GONE");
    // The chat itself still goes to the Bin and purges.
    await api(owner, "DELETE", `/chats/${chat.id}`);
    expect((await api(owner, "DELETE", `/bin/chat/${chat.id}`)).status).toBe(200);
  });

  test("the hourly sweep carries on past an agent whose purge throws, and retries it later (M2)", async () => {
    const { sweepTable } = await import("../server/agents/bin");
    const stuck = (await api(owner, "POST", "/agents", { name: "Stuck", providerId })).body.agent as { id: string };
    const fine = (await api(owner, "POST", "/agents", { name: "Fine", providerId })).body.agent as { id: string };
    for (const id of [stuck.id, fine.id]) expect((await api(owner, "DELETE", `/agents/${id}`)).status).toBe(200);
    const past = "2000-01-01T00:00:00.000Z";
    db.query("UPDATE agents SET purge_after = ? WHERE id IN (?, ?)").run(past, stuck.id, fine.id);
    db.exec(`CREATE TRIGGER review_stuck_agent BEFORE DELETE ON agents WHEN OLD.id = '${stuck.id}' BEGIN SELECT RAISE(ABORT, 'review: stuck'); END`);
    try {
      const counts = await sweepTable("agents", new Date().toISOString());
      expect(counts).toMatchObject({ pending: 1 });
      expect(counts.purged).toBeGreaterThanOrEqual(1);
      expect(db.query("SELECT 1 FROM agents WHERE id = ?").get(fine.id)).toBeNull();
      expect(db.query("SELECT 1 FROM agents WHERE id = ?").get(stuck.id)).not.toBeNull();
    } finally {
      db.exec("DROP TRIGGER IF EXISTS review_stuck_agent");
    }
    // Next hour: the row is resumed and purged.
    const again = await sweepTable("agents", new Date().toISOString());
    expect(again.purged).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT 1 FROM agents WHERE id = ?").get(stuck.id)).toBeNull();
  });

  test("a resume with `after` beyond the ring of a finished run gets the snapshot (L7)", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Resume", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "echo:done quickly" });
    const runId = started.body.runId as string;
    await sseText(owner, runId, 0);
    await sleep(100);
    expect(channelOf(runId)?.closed).toBe(true);
    const beyond = await sseText(owner, runId, 999_999);
    expect(beyond.status).toBe(200);
    expect(beyond.text).toContain("event: snapshot");
    expect(beyond.text).toContain('"content":"done quickly"');
    expect(beyond.text).toContain('"status":"ok"');
  });

  test("SSE fan-out is capped: 4 streams per run and 12 per person, 429 beyond; closed streams free their slot (L6)", async () => {
    const { STREAM_CAPS, openStreamCounts } = await import("../server/agents/routes");
    expect(STREAM_CAPS).toEqual({ perRun: 4, perUser: 12 });
    const agent = (await api(owner, "POST", "/agents", { name: "Fanout", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "slow:80:a b c d e f g h i j k l m n o p q r s t u v w x y z" });
    const runId = started.body.runId as string;
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const opened: Response[] = [];
    for (const controller of controllers) opened.push(await fetch(`${origin}/api/runs/${runId}/events`, { headers: { Cookie: owner.cookie, Origin: origin }, signal: controller.signal }));
    expect(opened.map((response) => response.status)).toEqual([200, 200, 200, 200, 429, 429, 429, 429]);
    expect(opened[4]!.headers.get("retry-after")).toBe("2");
    expect((await opened[4]!.json()).code).toBe("TOO_MANY_STREAMS");
    expect(openStreamCounts(runId, owner.userId)).toEqual({ run: 4, user: 4 });
    // Another person's streams do not count against the owner (and get 404 anyway).
    expect((await sseText(member, runId, 0)).status).toBe(404);
    expect(openStreamCounts(runId, owner.userId)).toEqual({ run: 4, user: 4 });
    controllers[0]!.abort();
    for (let waited = 0; openStreamCounts(runId, owner.userId).run === 4 && waited < 40; waited += 1) await sleep(50);
    expect(openStreamCounts(runId, owner.userId)).toEqual({ run: 3, user: 3 });
    const again = await fetch(`${origin}/api/runs/${runId}/events`, { headers: { Cookie: owner.cookie, Origin: origin }, signal: controllers[0]!.signal }).catch(() => null);
    expect(again?.status ?? 200).toBe(200);
    for (const controller of controllers) controller.abort();
    await api(owner, "POST", `/runs/${runId}/cancel`, {});
    for (let waited = 0; openStreamCounts(runId, owner.userId).run > 0 && waited < 40; waited += 1) await sleep(50);
    expect(openStreamCounts(runId, owner.userId)).toEqual({ run: 0, user: 0 });
  });

  test("the live stream stops at the stored bound and the stored reply is cut with the marker (L5)", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Long", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "huge:300" });
    const runId = started.body.runId as string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let streamed = 0;
    try {
      const response = await fetch(`${origin}/api/runs/${runId}/events`, { headers: { Cookie: owner.cookie, Origin: origin }, signal: controller.signal });
      for (const frame of (await response.text()).split("\n\n")) {
        const data = frame.split("\n").find((line) => line.startsWith("data:"));
        if (frame.includes("event: delta") && data) streamed += (JSON.parse(data.slice(5)) as { text: string }).text.length;
      }
    } finally {
      clearTimeout(timer);
    }
    expect(streamed).toBeGreaterThan(0);
    expect(streamed).toBeLessThanOrEqual(AGENT_BOUNDS.assistantMessageChars);
    for (let waited = 0; (await api(owner, "GET", `/chats/${chat.id}`)).body.messages.at(-1).status === "streaming" && waited < 50; waited += 1) await sleep(100);
    const message = (await api(owner, "GET", `/chats/${chat.id}`)).body.messages.find((item: { id: string }) => item.id === started.body.assistantMessage.id) as { content: string; status: string };
    expect(message.status).toBe("complete");
    expect(message.content.length).toBeLessThanOrEqual(AGENT_BOUNDS.assistantMessageChars);
    expect(message.content.endsWith("[truncated: the reply was longer than allowed]")).toBe(true);
    // Charged for what was kept (TODO "usage charged on cut replies"): the provider reported 300 KiB ÷ 4
    // output tokens; the run, the message, and the day's usage count the provider's prompt plus the kept text ÷ 4.
    const kept = Math.ceil(AGENT_BOUNDS.assistantMessageChars / 4);
    const row = db.query("SELECT prompt_tokens, completion_tokens, tokens_estimated FROM agent_runs WHERE id = ?").get(runId) as { prompt_tokens: number; completion_tokens: number; tokens_estimated: number };
    expect(row).toMatchObject({ completion_tokens: kept, tokens_estimated: 1 });
    expect(row.completion_tokens).toBeLessThan(300 * 1024 / 4);
    expect(row.prompt_tokens).toBeGreaterThan(0);
    const stored = db.query("SELECT usage_json FROM chat_messages WHERE id = ?").get(started.body.assistantMessage.id) as { usage_json: string };
    expect(JSON.parse(stored.usage_json)).toMatchObject({ promptTokens: row.prompt_tokens, completionTokens: kept, estimated: true });
  });

  test("cut usage: within the bound the provider's figures stand; past it the output is the kept text ÷ 4, estimated", () => {
    const cap = AGENT_BOUNDS.assistantMessageChars;
    const reported = { promptTokens: 120, completionTokens: 90_000, estimated: false, cachedTokens: 40 };
    expect(cutUsage(reported, "x".repeat(cap))).toBe(reported);
    expect(cutUsage(reported, "x".repeat(cap + 1))).toEqual({ promptTokens: 120, completionTokens: Math.ceil(cap / 4), estimated: true, cachedTokens: 40 });
    // Never more than the provider reported.
    expect(cutUsage({ promptTokens: 5, completionTokens: 10, estimated: false }, "x".repeat(cap + 1))).toEqual({ promptTokens: 5, completionTokens: 10, estimated: true });
    // A stopped call that overflowed is charged the same way; one without a provider figure is estimated as before.
    expect(partialUsage({ started: true, content: "x".repeat(cap + 1), usage: reported, model: null, promptChars: 400 })).toEqual({ promptTokens: 120, completionTokens: Math.ceil(cap / 4), estimated: true, cachedTokens: 40 });
    expect(partialUsage({ started: true, content: "abcdefgh", usage: null, model: null, promptChars: 400 })).toEqual({ promptTokens: 100, completionTokens: 2, estimated: true });
  });

  test("MCP agents:read tools honour chat_roles, and editing an agent needs create_roles (L11)", async () => {
    const { writeAgentSettings, readAgentSettings } = await import("../server/agents/settings");
    const agent = (await api(owner, "POST", "/agents", { name: "Policy", providerId })).body.agent as { id: string; revision: number };
    const key = makeKey(owner, ["agents:read"]);
    expect((await ok(key, "list_agents")).agents.some((item: { id: string }) => item.id === agent.id)).toBe(true);
    const settings = readAgentSettings();
    writeAgentSettings(admin.userId, { chatRoles: ["admin"], createRoles: ["admin"] }, settings.revision);
    try {
      for (const tool of ["list_agents", "list_chats"] as const) expect({ tool, code: await errorCode(key, tool, {}) }).toEqual({ tool, code: "NOT_FOUND" });
      const patch = await api(owner, "PATCH", `/agents/${agent.id}`, { name: "Renamed", expectedRevision: agent.revision });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe("ROLE_REFUSED");
    } finally {
      writeAgentSettings(admin.userId, { chatRoles: settings.chatRoles, createRoles: settings.createRoles }, readAgentSettings().revision);
    }
    expect((await api(owner, "PATCH", `/agents/${agent.id}`, { name: "Renamed", expectedRevision: agent.revision })).status).toBe(200);
  });

  test("the message window keeps the system turn and the first message, then the newest turns that fit", () => {
    const agentRow = { system_prompt: "P".repeat(100) } as Parameters<typeof windowTurns>[0];
    const row = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content, status: "complete", parent_id: null } as unknown as Parameters<typeof windowTurns>[2][number]);
    const path = [row("1", "user", "first ".padEnd(1000, "f")), row("2", "assistant", "a".repeat(3000)), row("3", "user", "b".repeat(3000)), row("4", "assistant", "c".repeat(3000)), row("5", "user", "tail".padEnd(500, "t"))];
    const turns = windowTurns(agentRow, "Reviewer", path, 1024);
    // Budget: max(2048, 1024-1024) * 4 = 8192 characters.
    expect(turns[0]!.role).toBe("system");
    expect(turns[1]!.content.startsWith("first")).toBe(true);
    expect(turns.at(-1)!.content.startsWith("tail")).toBe(true);
    const total = turns.reduce((sum, turn) => sum + turn.content.length, 0);
    expect(total).toBeLessThanOrEqual(8192);
    // 100 + 1000 + 500 + 3000 + 3000 = 7600 fits; the oldest assistant turn (3000 more) does not.
    expect(turns.map((turn) => turn.content[0])).toEqual(["Y", "f", "b", "c", "t"]);
  });

  test("a provider's base URL is shape-checked at save time: private literals and plain http get 400 EGRESS_REFUSED (QA Q7)", async () => {
    for (const baseUrl of ["https://10.0.0.1/v1", "https://[::1]/v1", "https://169.254.169.254/latest", "http://203.0.113.9/v1", "https://127.0.0.2/v1"]) {
      const response = await api(admin, "POST", "/agents/admin/providers", { name: "Refused", baseUrl });
      expect({ baseUrl, status: response.status, code: response.body.code, field: response.body.field }).toEqual({ baseUrl, status: 400, code: "EGRESS_REFUSED", field: "baseUrl" });
    }
    // A listed loopback host (the fake provider) and a public name are accepted without DNS.
    const patch = await api(admin, "PATCH", `/agents/admin/providers/${providerId}`, { baseUrl: "https://api.example.test/v1", expectedRevision: 3 });
    expect(patch.status).toBe(200);
    expect((await api(admin, "PATCH", `/agents/admin/providers/${providerId}`, { baseUrl: fake.baseUrl, expectedRevision: 4 })).status).toBe(200);
  });

  test("the started run's messages come back in the contract's camelCase shape (QA Q12)", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Shape", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "echo:shape" });
    expect(started.status).toBe(201);
    for (const message of [started.body.userMessage, started.body.assistantMessage]) {
      // Wave 41 (AC-B) adds `toolCalls` to every message.
      expect(Object.keys(message).sort()).toEqual(["content", "createdAt", "errorCode", "finishedAt", "id", "model", "parentId", "role", "runId", "status", "toolCalls", "usage"]);
    }
    expect(started.body.userMessage).toMatchObject({ role: "user", content: "echo:shape", status: "complete", parentId: null });
    expect(started.body.assistantMessage).toMatchObject({ role: "assistant", status: "streaming", parentId: started.body.userMessage.id, runId: started.body.runId });
    // Regenerate only once the first run has ended (a run still live on the chat is a 409 RUN_ACTIVE; this raced before).
    for (let attempt = 0; attempt < 100 && (await api(owner, "GET", `/chats/${chat.id}`)).body.activeRunId !== null; attempt += 1) await sleep(50);
    const again = await api(owner, "POST", `/chats/${chat.id}/messages/${started.body.assistantMessage.id}/regenerate`, {});
    expect(again.status).toBe(201);
    expect(again.body.assistantMessage).toMatchObject({ role: "assistant", parentId: started.body.userMessage.id });
    expect("chat_id" in again.body.assistantMessage).toBe(false);
    await sleep(300);
  });

  test("members see the Chat module only once it can be used: a provider exists and their role may chat (QA Q5)", async () => {
    const { agentsFeature } = await import("../server/agents/status");
    const { writeAgentSettings, readAgentSettings } = await import("../server/agents/settings");
    const me = async (session: Session) => ((await api(session, "GET", "/auth/me")).body.features as { agents: boolean }).agents;
    expect(await me(admin)).toBe(true);
    expect(await me(owner)).toBe(true);
    expect(await me(viewer)).toBe(true);
    const settings = readAgentSettings();
    writeAgentSettings(admin.userId, { chatRoles: ["admin", "member"] }, settings.revision);
    try {
      expect(await me(viewer)).toBe(false);
      expect(await me(owner)).toBe(true);
    } finally {
      writeAgentSettings(admin.userId, { chatRoles: settings.chatRoles }, readAgentSettings().revision);
    }
    expect(agentsFeature("guest")).toBe(false);
    expect(agentsFeature("admin")).toBe(true);
  });

  test("cleanup: the review provider is removed so other files' agents fall back to their own default; without any provider members no longer see Chat", async () => {
    // Runs as a test, not in afterAll: retireUsersAfterFile's hook blocks the admin before any afterAll here.
    expect((await api(admin, "DELETE", `/agents/admin/providers/${providerId}`)).status).toBe(200);
    if ((await api(admin, "GET", "/agents/admin/providers")).body.providers.length === 0) {
      expect(((await api(owner, "GET", "/auth/me")).body.features as { agents: boolean }).agents).toBe(false);
      expect(((await api(admin, "GET", "/auth/me")).body.features as { agents: boolean }).agents).toBe(true);
    }
  });
});
