import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { api, makeKey, ok, errorCode as mcpErrorCode, toolNames } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { withoutNookAutoTools } from "./support/nookAuto";

const { config } = await import("../server/config");
const { modelTimeouts } = await import("../server/agents/loop");
const { markInterruptedRuns, activeRuns } = await import("../server/agents/runs");
const { RING_SIZE, channelOf } = await import("../server/agents/stream");
const { mcpToolSpecs, toolVisible, loadLiveKey } = await import("../server/mcpTools");
const { createApiKey } = await import("../server/apiKeys");

/**
 * The loop and private chats (agent chat plan §15 items 1, 5, 8; Wave 40 AC-A): a fake
 * OpenAI-compatible provider on loopback, streaming, usage accounting, Stop mid-stream, provider
 * 5xx and stalls, budgets refused before the call, SSE resume from the ring and the snapshot,
 * message-tree branching and Regenerate, concurrency slots, the Bin, the MCP read tools, roles,
 * and the boot sweep that marks live runs interrupted.
 */

retireUsersAfterFile();
// C2: this file covers the linked-key model; the automatic Nook tools are off for its run.
withoutNookAutoTools();
const fake = startFakeProvider(0);
let admin: Session;
let member: Session;
let providerId: string;

type SseEvent = { seq: number; type: string; data: Record<string, any> };
async function readEvents(session: Session, runId: string, options: { after?: number; until?: (events: SseEvent[]) => boolean; abortAfterMs?: number } = {}): Promise<{ status: number; events: SseEvent[]; text: string }> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/runs/${runId}/events?after=${options.after ?? 0}`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  if (response.status !== 200 || !response.body) return { status: response.status, events: [], text: await response.text() };
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const events: SseEvent[] = [];
  let text = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = options.abortAfterMs ? setTimeout(() => controller.abort(), options.abortAfterMs) : null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      text += piece;
      buffer += piece;
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf("\n\n");
        if (frame.startsWith(":")) continue;
        const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
        events.push({ seq: Number(lines.id), type: lines.event, data: JSON.parse(lines.data) });
      }
      if (options.until?.(events)) { controller.abort(); break; }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { status: 200, events, text };
}

const finished = (events: SseEvent[]) => events.some((event) => event.type === "done" || event.type === "snapshot");
const textOf = (events: SseEvent[]) => events.filter((event) => event.type === "delta").map((event) => event.data.text).join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function newAgent(session: Session, patch: Record<string, unknown> = {}) {
  const created = await api(session, "POST", "/agents", { name: "Helper", description: "Answers", systemPrompt: "You are Helper.", ...patch });
  expect(created.status).toBe(201);
  return created.body.agent as { id: string; revision: number };
}
async function newChat(session: Session, agentId: string) {
  const created = await api(session, "POST", "/chats", { agentId });
  expect(created.status).toBe(201);
  return created.body.chat as { id: string; revision: number };
}
async function send(session: Session, chatId: string, content: string, parentId?: string | null) {
  const started = await api(session, "POST", `/chats/${chatId}/messages`, { content, ...(parentId !== undefined ? { parentId } : {}) });
  return started;
}
async function sendAndWait(session: Session, chatId: string, content: string, parentId?: string | null) {
  const started = await send(session, chatId, content, parentId);
  expect(started.status).toBe(201);
  const stream = await readEvents(session, started.body.runId, { until: finished });
  return { started: started.body as { runId: string; userMessage: { id: string } | null; assistantMessage: { id: string } }, events: stream.events };
}

beforeAll(async () => {
  admin = await createUser("Chat admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Chat member");
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0001", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
});
afterAll(() => fake.stop());

describe("providers and policy (admin, §4.1)", () => {
  test("the provider is the default, lists models, and tests with a one-token completion; limits and CAS hold", async () => {
    const listed = await api(admin, "GET", "/agents/admin/providers");
    expect(listed.body.providers.map((provider: { id: string; isDefault: boolean; hasSecret: boolean; hint: string }) => [provider.id === providerId, provider.isDefault, provider.hasSecret, provider.hint])).toContainEqual([true, true, true, "sk-…0001"]);
    const models = await api(admin, "GET", `/agents/admin/providers/${providerId}/models`);
    expect(models.status).toBe(200);
    expect(models.body.models).toEqual(["gpt-6-luna", "gpt-6-mini", "text-embedding-3-small"]);
    const tested = await api(admin, "POST", `/agents/admin/providers/${providerId}/test`, {});
    expect(tested.body.test).toMatchObject({ ok: true, models: { ok: true, count: 3 }, completion: { ok: true, model: "gpt-6-luna" } });
    const completion = fake.calls.filter((call) => call.path === "/v1/chat/completions").at(-1)!;
    expect(completion.body).toMatchObject({ model: "gpt-6-luna", stream: true, stream_options: { include_usage: true }, max_completion_tokens: 1 });
    expect(completion.headers.authorization).toBe("Bearer sk-test-fake-key-0001");
    // A provider pointing at a refused address is refused at creation, not at run time.
    expect((await api(admin, "POST", "/agents/admin/providers", { name: "Self", baseUrl: `${origin}/v1` })).status).toBe(400);
    expect((await api(admin, "POST", "/agents/admin/providers", { name: "Creds", baseUrl: "https://u:p@api.example.test/v1" })).status).toBe(400);
    // Settings: defaults, CAS, and the public-links policy off by default (AC-O1).
    const settings = await api(admin, "GET", "/agents/admin/settings");
    expect(settings.body.settings).toMatchObject({ createRoles: ["admin", "member"], chatRoles: ["admin", "member", "viewer"], dailyTokensUser: 500_000, dailyTokensKey: 200_000, dailyTokensInstance: 0, publicChatLinks: false, auditRetentionDays: 30, agentsPerUser: 50 });
    const written = await api(admin, "PUT", "/agents/admin/settings", { agentsPerUser: 3, expectedRevision: settings.body.settings.revision });
    expect(written.status).toBe(200);
    expect(written.body.settings.agentsPerUser).toBe(3);
    expect((await api(admin, "PUT", "/agents/admin/settings", { agentsPerUser: 4, expectedRevision: settings.body.settings.revision })).status).toBe(409);
    // Wave 43 (AC-D): the public-links policy can be turned on now (and is turned off again here).
    const publicOn = await api(admin, "PUT", "/agents/admin/settings", { publicChatLinks: true, expectedRevision: written.body.settings.revision });
    expect(publicOn.status).toBe(200);
    expect(publicOn.body.settings.publicChatLinks).toBe(true);
    await api(admin, "PUT", "/agents/admin/settings", { agentsPerUser: 50, publicChatLinks: false, expectedRevision: publicOn.body.settings.revision });
    // Usage is counts only.
    const usage = await api(admin, "GET", "/agents/admin/usage?group=user");
    expect(usage.status).toBe(200);
    expect(JSON.stringify(usage.body)).not.toContain("content");
  });
});

describe("agents (§5.1)", () => {
  test("members create, edit with CAS, and bin their own agents; others get 404; viewers cannot create", async () => {
    const agent = await newAgent(member, { maxSteps: 3, model: "gpt-6-mini", starters: ["Summarise my day", "Draft a reply"] });
    const read = await api(member, "GET", `/agents/${agent.id}`);
    expect(read.body.agent).toMatchObject({ name: "Helper", systemPrompt: "You are Helper.", maxSteps: 3, model: "gpt-6-mini", starters: ["Summarise my day", "Draft a reply"], isOwner: true });
    expect((await api(admin, "GET", `/agents/${agent.id}`)).status).toBe(404);
    expect((await api(admin, "PATCH", `/agents/${agent.id}`, { name: "Taken", expectedRevision: 1 })).status).toBe(404);
    const patched = await api(member, "PATCH", `/agents/${agent.id}`, { name: "Helper 2", maxSteps: 30, expectedRevision: agent.revision });
    expect(patched.status).toBe(400);
    const patched2 = await api(member, "PATCH", `/agents/${agent.id}`, { name: "Helper 2", maxSteps: 25, expectedRevision: agent.revision });
    expect(patched2.status).toBe(200);
    expect((await api(member, "PATCH", `/agents/${agent.id}`, { name: "Stale", expectedRevision: agent.revision })).status).toBe(409);
    expect((await api(member, "GET", "/agents")).body.agents.some((item: { id: string }) => item.id === agent.id)).toBe(true);
    expect((await api(member, "POST", "/agents", { name: "Bad provider", providerId: crypto.randomUUID() })).status).toBe(400);
    const viewer = await createUser("Chat viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect((await api(viewer, "POST", "/agents", { name: "Nope" })).status).toBe(403);
    expect((await api(viewer, "GET", "/agents")).status).toBe(200);
    const guest = await createUser("Chat guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await api(guest, "GET", "/agents")).status).toBe(404);
    expect((await api(guest, "GET", "/chats")).status).toBe(404);
    expect((await api(guest, "GET", "/auth/me")).body.features.agents).toBe(false);
    // Bin: listed, restorable, purgeable by the owner only.
    expect((await api(member, "DELETE", `/agents/${agent.id}`)).status).toBe(200);
    expect((await api(member, "GET", `/agents/${agent.id}`)).status).toBe(404);
    const bin = await api(member, "GET", "/bin");
    expect(bin.body.items.some((item: { type: string; id: string }) => item.type === "agent" && item.id === agent.id)).toBe(true);
    expect((await api(admin, "GET", "/bin")).body.items.some((item: { id: string }) => item.id === agent.id)).toBe(false);
    expect((await api(member, "POST", `/bin/agent/${agent.id}/restore`, {})).status).toBe(200);
    expect((await api(member, "GET", `/agents/${agent.id}`)).status).toBe(200);
    await api(member, "DELETE", `/agents/${agent.id}`);
    expect((await api(member, "DELETE", `/bin/agent/${agent.id}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM agents WHERE id = ?").get(agent.id)).toBeNull();
  });
});

describe("the loop against the fake provider (§2.1–§2.4)", () => {
  test("a message streams deltas, records usage, titles the chat, and the preamble plus prompt go out as the system turn", async () => {
    const agent = await newAgent(member, { systemPrompt: "Be brief." });
    const chat = await newChat(member, agent.id);
    const { started, events } = await sendAndWait(member, chat.id, "echo:Hello there, this is streamed.");
    expect(events[0]).toMatchObject({ seq: 1, type: "run", data: { runId: started.runId, chatId: chat.id, messageId: started.assistantMessage.id, userMessageId: started.userMessage!.id } });
    expect(textOf(events)).toBe("Hello there, this is streamed.");
    const usage = events.find((event) => event.type === "usage")!;
    expect(usage.data.usage).toMatchObject({ completionTokens: 8, estimated: false });
    expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "ok", messageId: started.assistantMessage.id } });
    const detail = await api(member, "GET", `/chats/${chat.id}`);
    expect(detail.body.chat).toMatchObject({ title: "echo:Hello there, this is streamed.", activeLeafId: started.assistantMessage.id, running: false });
    const assistant = detail.body.messages.find((message: { id: string }) => message.id === started.assistantMessage.id);
    expect(assistant).toMatchObject({ role: "assistant", content: "Hello there, this is streamed.", status: "complete", model: "gpt-6-luna", parentId: started.userMessage!.id });
    expect(assistant.usage).toMatchObject({ completionTokens: 8 });
    const call = fake.calls.filter((item) => item.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ role: string; content: string }>; tools?: unknown };
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[0]!.content).toContain("You are running inside Nook for Chat member.");
    expect(call.messages[0]!.content).toContain("Be brief.");
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "echo:Hello there, this is streamed." });
    expect(call.tools).toBeUndefined();
    const mine = await api(member, "GET", "/agents/usage");
    expect(mine.body.usage).toMatchObject({ budget: 500_000 });
    expect(mine.body.usage.completionTokens).toBeGreaterThanOrEqual(8);
    expect(mine.body.usage.runs).toBeGreaterThanOrEqual(1);
    const run = db.query("SELECT status, prompt_tokens, completion_tokens, steps, first_token_at FROM agent_runs WHERE id = ?").get(started.runId) as { status: string; completion_tokens: number; steps: number; first_token_at: string | null };
    expect(run).toMatchObject({ status: "ok", completion_tokens: 8, steps: 1 });
    expect(run.first_token_at).not.toBeNull();
    // Audit rows carry ids and counts, never bodies.
    for (const row of db.query("SELECT metadata_json FROM audit_log WHERE event_type LIKE 'agents.run.%'").all() as Array<{ metadata_json: string }>) expect(row.metadata_json).not.toContain("Hello there");
    // A second turn carries the first exchange.
    const second = await sendAndWait(member, chat.id, "echo:Second.");
    const call2 = fake.calls.filter((item) => item.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ role: string; content: string }> };
    expect(call2.messages.map((turn) => turn.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second.events.at(-1)!.data.status).toBe("ok");
  });

  test("estimated usage when the server sends none; a tool call the model emits with no tools offered ends the answer with a reason (Wave 41 QA L9)", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const { events } = await sendAndWait(member, chat.id, "nousage:Four words of text");
    expect(events.find((event) => event.type === "usage")!.data.usage.estimated).toBe(true);
    const { events: tool } = await sendAndWait(member, chat.id, "tool:");
    expect(tool.at(-1)!.data.status).toBe("ok");
    expect(textOf(tool)).toBe("[The model tried to use a tool, but no tools were available to it here, so the answer stops.]");
  });

  test("Stop cancels mid-stream and keeps the partial text; a second stream resumes from the ring with ?after", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const started = await send(member, chat.id, "slow:40:one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty");
    expect(started.status).toBe(201);
    // While it runs, the chat is busy (409) and the user's slot counts.
    expect((await send(member, chat.id, "echo:again")).status).toBe(409);
    const first = await readEvents(member, started.body.runId, { until: (events) => events.filter((event) => event.type === "delta").length >= 3 });
    const seen = first.events.at(-1)!.seq;
    expect(seen).toBeGreaterThanOrEqual(3);
    // The run goes on without a reader; a resume replays only what came after `seen`.
    await sleep(100);
    const resumed = await readEvents(member, started.body.runId, { after: seen, until: (events) => events.filter((event) => event.type === "delta").length >= 2 });
    expect(resumed.events[0]!.seq).toBe(seen + 1);
    expect(resumed.events.every((event) => event.seq > seen)).toBe(true);
    // Stop.
    const cancelled = await api(member, "POST", `/runs/${started.body.runId}/cancel`, {});
    expect(cancelled.body.status).toBe("cancelled");
    const tail = await readEvents(member, started.body.runId, { after: 0, until: finished });
    expect(tail.events.at(-1)).toMatchObject({ type: "done", data: { status: "cancelled" } });
    const detail = await api(member, "GET", `/chats/${chat.id}`);
    const assistant = detail.body.messages.find((message: { id: string }) => message.id === started.body.assistantMessage.id);
    expect(assistant.status).toBe("cancelled");
    expect(assistant.content.length).toBeGreaterThan(0);
    expect(assistant.content.length).toBeLessThan(120);
    expect((db.query("SELECT status FROM agent_runs WHERE id = ?").get(started.body.runId) as { status: string }).status).toBe("cancelled");
    expect(activeRuns().some((run) => run.runId === started.body.runId)).toBe(false);
    // Cancelling again, or someone else's run, is 404 or a no-op.
    expect((await api(admin, "POST", `/runs/${started.body.runId}/cancel`, {})).status).toBe(404);
    expect((await api(admin, "GET", `/runs/${started.body.runId}/events`)).status).toBe(404);
    expect((await api(member, "POST", `/runs/${started.body.runId}/cancel`, {})).body.status).toBe("cancelled");
  });

  test("a resume past the ring, or after the channel is gone, gets a snapshot built from the database", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const { started } = await sendAndWait(member, chat.id, "echo:Snapshot me.");
    const channel = channelOf(started.runId)!;
    expect(channel.closed).toBe(true);
    // Overflow: the ring forgot its first events (as after RING_SIZE more), and the client is behind them.
    expect(RING_SIZE).toBe(2000);
    (channel as unknown as { ring: unknown[] }).ring.splice(0, 2);
    const late = await readEvents(member, started.runId, { after: 1 });
    // The snapshot, then a proper `done`, as every stream ends (TODO "`?after` overflow").
    expect(late.events).toHaveLength(2);
    expect(late.events[0]).toMatchObject({ type: "snapshot", data: { status: "ok", messageId: started.assistantMessage.id, content: "Snapshot me.", messageStatus: "complete" } });
    expect(late.events[1]).toMatchObject({ type: "done", seq: channel.lastSeq, data: { status: "ok", messageId: started.assistantMessage.id } });
    // A run whose channel expired gives the same snapshot.
    const { started: second } = await sendAndWait(member, chat.id, "echo:Later.");
    channelOf(second.runId)!.dispose();
    (await import("../server/agents/stream")).resetChannelsForTests();
    const gone = await readEvents(member, second.runId, { after: 0 });
    expect(gone.events[0]).toMatchObject({ type: "snapshot", data: { content: "Later.", status: "ok" } });
    expect(gone.events.slice(1)).toEqual([{ type: "done", seq: 0, data: { status: "ok", messageId: second.assistantMessage.id } }]);
  });

  test("a resume past the ring of a live run: the snapshot (still running), then the live events, then `done`", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const started = (await send(member, chat.id, "slow:80:alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu")).body as { runId: string; assistantMessage: { id: string } };
    await readEvents(member, started.runId, { until: (events) => events.filter((event) => event.type === "delta").length >= 2 });
    const channel = channelOf(started.runId)!;
    expect(channel.closed).toBe(false);
    (channel as unknown as { ring: unknown[] }).ring.splice(0, 2);
    const resumed = await readEvents(member, started.runId, { after: 1, until: (events) => events.some((event) => event.type === "done") });
    const types = resumed.events.map((event) => event.type);
    expect(types[0]).toBe("snapshot");
    expect(resumed.events[0]!.data.status).toBe("running");
    expect(types.filter((type) => type === "snapshot")).toHaveLength(1);
    expect(types.at(-1)).toBe("done");
    expect(types.filter((type) => type === "done")).toHaveLength(1);
    // Live events after the snapshot arrive in order with no repeats.
    const seqs = resumed.events.slice(1).map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(resumed.events.at(-1)!.data).toMatchObject({ status: "ok", messageId: started.assistantMessage.id });
  });

  test("provider 5xx, 401, a stall, and an oversized stream end the run as errors with a message and no key in it", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const failed = await sendAndWait(member, chat.id, "status:500");
    const error = failed.events.find((event) => event.type === "error")!;
    expect(error.data.code).toBe("PROVIDER_ERROR");
    expect(error.data.message).toContain("HTTP 500");
    expect(error.data.message).not.toContain("sk-secret");
    expect(failed.events.at(-1)).toMatchObject({ type: "done", data: { status: "error" } });
    let detail = await api(member, "GET", `/chats/${chat.id}`);
    expect(detail.body.messages.find((message: { id: string }) => message.id === failed.started.assistantMessage.id)).toMatchObject({ status: "error", errorCode: "PROVIDER_ERROR" });
    const refused = await sendAndWait(member, chat.id, "status:401");
    expect(refused.events.find((event) => event.type === "error")!.data.message).toContain("refused the API key");
    const previous = { ...modelTimeouts };
    Object.assign(modelTimeouts, { firstByteMs: 2000, idleMs: 400, totalMs: 5000 });
    try {
      const stalled = await sendAndWait(member, chat.id, "stall:");
      expect(stalled.events.find((event) => event.type === "error")!.data.code).toBe("MODEL_TIMEOUT");
      expect(textOf(stalled.events)).toBe("Starting…");
      detail = await api(member, "GET", `/chats/${chat.id}`);
      expect(detail.body.messages.find((message: { id: string }) => message.id === stalled.started.assistantMessage.id)).toMatchObject({ status: "error", errorCode: "MODEL_TIMEOUT", content: "Starting…" });
    } finally {
      Object.assign(modelTimeouts, previous);
    }
    const redirected = await sendAndWait(member, chat.id, "redirect:");
    expect(redirected.events.find((event) => event.type === "error")!.data.code).toBe("EGRESS_REFUSED");
    // The chat's agent in the Bin: sending is refused until it is restored.
    await api(member, "DELETE", `/agents/${agent.id}`);
    expect((await send(member, chat.id, "echo:no agent")).status).toBe(409);
    expect((await api(member, "GET", `/chats/${chat.id}`)).status).toBe(200);
    await api(member, "POST", `/bin/agent/${agent.id}/restore`, {});
    expect((await send(member, chat.id, "echo:back")).status).toBe(201);
  });

  test("budgets are checked before the call and refused with 429, then lifted", async () => {
    const budgetUser = await createUser("Budget member");
    const agent = await newAgent(budgetUser);
    const chat = await newChat(budgetUser, agent.id);
    await sendAndWait(budgetUser, chat.id, "echo:spend some tokens here");
    const used = (await api(budgetUser, "GET", "/agents/usage")).body.usage;
    expect(used.promptTokens + used.completionTokens).toBeGreaterThan(0);
    const settings = (await api(admin, "GET", "/agents/admin/settings")).body.settings;
    const put = async (patch: Record<string, unknown>) => {
      const current = (await api(admin, "GET", "/agents/admin/settings")).body.settings;
      expect((await api(admin, "PUT", "/agents/admin/settings", { ...patch, expectedRevision: current.revision })).status).toBe(200);
    };
    try {
      await put({ dailyTokensUser: used.promptTokens + used.completionTokens });
      const calls = fake.calls.length;
      const refused = await send(budgetUser, chat.id, "echo:over");
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe("BUDGET_EXCEEDED");
      expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(fake.calls.length).toBe(calls);
      expect((await api(budgetUser, "GET", `/chats/${chat.id}`)).body.messages.filter((message: { content: string }) => message.content === "echo:over")).toHaveLength(0);
      // Someone who used nothing today is not affected; the instance budget applies to everyone.
      const fresh = await createUser("Budget fresh");
      const other = await newChat(fresh, (await newAgent(fresh)).id);
      const fine = await sendAndWait(fresh, other.id, "echo:fine");
      expect(fine.events.at(-1)!.data.status).toBe("ok");
      await put({ dailyTokensUser: 500_000, dailyTokensInstance: 1 });
      expect((await send(fresh, other.id, "echo:instance")).status).toBe(429);
    } finally {
      await put({ dailyTokensUser: settings.dailyTokensUser, dailyTokensInstance: settings.dailyTokensInstance });
    }
    expect((await send(budgetUser, chat.id, "echo:ok again")).status).toBe(201);
  });

  test("editing makes a sibling branch, regenerate a sibling assistant turn, and the switcher moves the active leaf with CAS", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const first = await sendAndWait(member, chat.id, "echo:Version one.");
    const userId = first.started.userMessage!.id;
    // Edit: a sibling under the same parent (the root here), which becomes the active branch.
    const edited = await sendAndWait(member, chat.id, "echo:Version two.", null);
    let detail = await api(member, "GET", `/chats/${chat.id}`);
    const roots = detail.body.messages.filter((message: { parentId: string | null; role: string }) => message.parentId === null && message.role === "user");
    expect(roots.map((message: { content: string }) => message.content)).toEqual(["echo:Version one.", "echo:Version two."]);
    expect(detail.body.chat.activeLeafId).toBe(edited.started.assistantMessage.id);
    // Regenerate the first branch's answer: a second assistant child of the first user turn.
    const regenerated = await api(member, "POST", `/chats/${chat.id}/messages/${first.started.assistantMessage.id}/regenerate`, {});
    expect(regenerated.status).toBe(201);
    await readEvents(member, regenerated.body.runId, { until: finished });
    detail = await api(member, "GET", `/chats/${chat.id}`);
    const answers = detail.body.messages.filter((message: { parentId: string | null }) => message.parentId === userId);
    expect(answers).toHaveLength(2);
    expect(answers.map((message: { content: string }) => message.content)).toEqual(["Version one.", "Version one."]);
    expect(detail.body.chat.activeLeafId).toBe(regenerated.body.assistantMessage.id);
    // Retry a user turn with no answer: a child.
    const retried = await api(member, "POST", `/chats/${chat.id}/messages/${userId}/regenerate`, {});
    expect(retried.status).toBe(201);
    await readEvents(member, retried.body.runId, { until: finished });
    detail = await api(member, "GET", `/chats/${chat.id}`);
    expect(detail.body.messages.filter((message: { parentId: string | null }) => message.parentId === userId)).toHaveLength(3);
    // Switch the branch with CAS; a message of another chat is 404.
    const revision = (await api(member, "GET", `/chats/${chat.id}`)).body.chat.revision;
    expect((await api(member, "PATCH", `/chats/${chat.id}`, { activeLeafId: edited.started.assistantMessage.id, expectedRevision: revision })).body.chat.activeLeafId).toBe(edited.started.assistantMessage.id);
    expect((await api(member, "PATCH", `/chats/${chat.id}`, { activeLeafId: first.started.assistantMessage.id, expectedRevision: revision })).status).toBe(409);
    expect((await api(member, "PATCH", `/chats/${chat.id}`, { activeLeafId: crypto.randomUUID(), expectedRevision: revision + 1 })).status).toBe(404);
    // Rename and pin.
    const renamed = await api(member, "PATCH", `/chats/${chat.id}`, { title: "Branches", pinned: true, expectedRevision: revision + 1 });
    expect(renamed.body.chat).toMatchObject({ title: "Branches", pinned: true });
    expect((await api(member, "GET", "/chats?q=Branches")).body.chats.map((item: { id: string }) => item.id)).toContain(chat.id);
    expect((await api(member, "GET", "/chats?q=zzzznothing")).body.chats).toHaveLength(0);
    // Nothing was deleted by branching.
    expect(detail.body.messages.length).toBe(6);
  });

  test("slots: two runs per user, 409 per chat, 503 for the instance; a disconnect never cancels", async () => {
    const agent = await newAgent(member);
    const chats = await Promise.all([newChat(member, agent.id), newChat(member, agent.id), newChat(member, agent.id)]);
    const a = await send(member, chats[0]!.id, "slow:60:a b c d e f g h i j k l m n o p");
    const b = await send(member, chats[1]!.id, "slow:60:a b c d e f g h i j k l m n o p");
    expect([a.status, b.status]).toEqual([201, 201]);
    const third = await send(member, chats[2]!.id, "echo:third");
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("AGENT_BUSY");
    // A reader that leaves early changes nothing.
    await readEvents(member, a.body.runId, { until: (events) => events.length >= 2 });
    const previous = config.agents.maxConcurrentRuns;
    config.agents.maxConcurrentRuns = 2;
    try {
      const other = await newChat(admin, (await newAgent(admin)).id);
      const full = await request(`/chats/${other.id}/messages`, { method: "POST", body: JSON.stringify({ content: "echo:full" }) }, admin);
      expect(full.status).toBe(503);
      // A full instance clears with time: Retry-After, as the 429s carry it.
      expect(full.headers.get("retry-after")).toBe("5");
      expect(await full.json()).toMatchObject({ code: "AGENT_BUSY", retryAfterSeconds: 5 });
    } finally {
      config.agents.maxConcurrentRuns = previous;
    }
    await Promise.all([readEvents(member, a.body.runId, { until: finished }), readEvents(member, b.body.runId, { until: finished })]);
    expect((await api(member, "GET", `/chats/${chats[0]!.id}`)).body.messages.find((message: { id: string }) => message.id === a.body.assistantMessage.id).status).toBe("complete");
  });

  test("chats go to the Bin with their runs cancelled, restore, and purge with their messages", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const started = await send(member, chat.id, "slow:50:a b c d e f g h i j k l");
    expect((await api(member, "DELETE", `/chats/${chat.id}`)).status).toBe(200);
    expect((await api(member, "GET", `/chats/${chat.id}`)).status).toBe(404);
    expect((await api(member, "GET", "/chats")).body.chats.some((item: { id: string }) => item.id === chat.id)).toBe(false);
    await sleep(150);
    expect((db.query("SELECT status FROM agent_runs WHERE id = ?").get(started.body.runId) as { status: string }).status).toBe("cancelled");
    const bin = (await api(member, "GET", "/bin")).body.items.find((item: { type: string; id: string }) => item.type === "chat" && item.id === chat.id);
    expect(bin).toMatchObject({ title: "slow:50:a b c d e f g h i j k l", folder_name: "Chat", can_purge: true });
    expect((await api(admin, "POST", `/bin/chat/${chat.id}/restore`, {})).status).toBe(404);
    expect((await api(member, "POST", `/bin/chat/${chat.id}/restore`, {})).status).toBe(200);
    expect((await api(member, "GET", `/chats/${chat.id}`)).status).toBe(200);
    await api(member, "DELETE", `/chats/${chat.id}`);
    expect((await api(member, "DELETE", `/bin/chat/${chat.id}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?").get(chat.id)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_runs WHERE chat_id = ?").get(chat.id)).toEqual({ count: 0 });
  });

  test("a restart marks live runs and their streaming messages interrupted (D344)", async () => {
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    const started = await send(member, chat.id, "slow:50:a b c d e f g h i j k l m n o p q r s t");
    await sleep(120);
    const lines: string[] = [];
    expect(markInterruptedRuns((line) => lines.push(line))).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/marked interrupted/);
    expect((db.query("SELECT status FROM agent_runs WHERE id = ?").get(started.body.runId) as { status: string }).status).toBe("interrupted");
    const message = await api(member, "GET", `/chats/${chat.id}`);
    expect(message.body.messages.find((item: { id: string }) => item.id === started.body.assistantMessage.id).status).toBe("interrupted");
    expect(message.body.activeRunId).toBeNull();
    (await import("../server/agents/runs")).resetRunsForTests();
    await sleep(100);
    // The later finish of the orphaned loop must not resurrect it as complete.
    expect((db.query("SELECT status FROM agent_runs WHERE id = ?").get(started.body.runId) as { status: string }).status).not.toBe("ok");
  });

  test("viewers chat when the policy allows and not otherwise; messages are bounded", async () => {
    const viewer = await createUser("Chat viewer 2");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    // A viewer owns no agent in this slice, so they have nothing to chat with yet, but the routes answer.
    expect((await api(viewer, "GET", "/chats")).status).toBe(200);
    expect((await api(viewer, "POST", "/chats", { agentId: crypto.randomUUID() })).status).toBe(404);
    const settings = (await api(admin, "GET", "/agents/admin/settings")).body.settings;
    await api(admin, "PUT", "/agents/admin/settings", { chatRoles: ["admin", "member"], expectedRevision: settings.revision });
    try {
      // The client reads this 403 ROLE_REFUSED as an access loss and keeps the ACCESS_REVOKED explanation (src/chat/accessNotice.tsx).
      expect(await api(viewer, "GET", "/chats")).toMatchObject({ status: 403, body: { code: "ROLE_REFUSED" } });
      expect(await api(viewer, "GET", `/runs/${crypto.randomUUID()}/events`)).toMatchObject({ status: 403, body: { code: "ROLE_REFUSED" } });
      expect((await api(viewer, "GET", "/agents/status")).body.canChat).toBe(false);
    } finally {
      const latest = (await api(admin, "GET", "/agents/admin/settings")).body.settings;
      await api(admin, "PUT", "/agents/admin/settings", { chatRoles: ["admin", "member", "viewer"], expectedRevision: latest.revision });
    }
    const agent = await newAgent(member);
    const chat = await newChat(member, agent.id);
    expect((await send(member, chat.id, "x".repeat(33 * 1024))).status).toBe(400);
    expect((await send(member, chat.id, "   ")).status).toBe(400);
    expect((await api(member, "POST", `/chats/${chat.id}/messages`, { content: "hi", parentId: crypto.randomUUID() })).status).toBe(404);
  });
});

describe("MCP tools (agents:read, D281)", () => {
  test("list_agents, list_chats, and get_chat read only the key owner's own, never the prompt; other scopes see no tools", async () => {
    const owner = await createUser("Chat MCP owner");
    const agent = await newAgent(owner, { systemPrompt: "SECRET PROMPT TEXT" });
    const chat = await newChat(owner, agent.id);
    await sendAndWait(owner, chat.id, "echo:Over MCP.");
    const key = makeKey(owner, ["agents:read"]);
    expect(await toolNames(key)).toEqual(["get_chat", "list_agents", "list_attachments", "list_chats", "read_attachment_text", "search_knowledge"]);
    const agents = await ok(key, "list_agents");
    expect(agents.agents.map((item: { id: string }) => item.id)).toContain(agent.id);
    expect(JSON.stringify(agents)).not.toContain("SECRET PROMPT");
    const chats = await ok(key, "list_chats", { query: "Over" });
    expect(chats.chats.map((item: { id: string }) => item.id)).toEqual([chat.id]);
    const read = await ok(key, "get_chat", { chatId: chat.id });
    expect(read.messages.map((message: { role: string; content: string }) => [message.role, message.content])).toEqual([["user", "echo:Over MCP."], ["assistant", "Over MCP."]]);
    expect(read.chat.url).toBe(`${origin}/chat/${chat.id}`);
    // Someone else's chat is NOT_FOUND; a key without the scope sees no agent tools.
    const stranger = makeKey(member, ["agents:read"]);
    expect(await mcpErrorCode(stranger, "get_chat", { chatId: chat.id })).toBe("NOT_FOUND");
    expect((await ok(stranger, "list_chats")).chats.some((item: { id: string }) => item.id === chat.id)).toBe(false);
    const notes = makeKey(owner, ["notes:read"]);
    expect((await toolNames(notes)).some((name) => name.startsWith("list_agents") || name === "get_chat")).toBe(false);
    expect(await mcpErrorCode(notes, "list_agents")).toBe("SCOPE_REQUIRED");
    // Every agent tool declares its access and is read-only (D281).
    for (const spec of mcpToolSpecs.filter((item) => ["list_agents", "list_chats", "get_chat"].includes(item.name))) {
      expect(spec.write).toBe(false);
      // Wave 42: list_agents also answers run-only keys, narrowed to the agents their grant names (a list tool).
      // Wave 44 (AC-E): list_chats and get_chat are `global`, hidden from a key whose agents:read names only chosen knowledge bases.
      expect(spec.access.mode).toBe(spec.name === "list_agents" ? "list" : "global");
    }
    const grantKey = createApiKey(owner.userId, { name: "Grant", surfaces: "mcp", grants: [{ module: "agents", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const live = loadLiveKey(grantKey.id)!;
    expect(mcpToolSpecs.filter((spec) => toolVisible(spec, live)).map((spec) => spec.name).sort()).toEqual(["get_chat", "list_agents", "list_attachments", "list_chats", "read_attachment_text", "search_knowledge"]);
  });
});
