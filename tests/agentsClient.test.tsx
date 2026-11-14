import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, locationUrl, NEW_AGENT, parseRoute, type Route } from "../src/router";
import { chatBackAction, chatGroup, chatRoute } from "../src/chatRoute";
import { childrenOf, leafForSibling, pathTo, shownBranch } from "../src/chat/chatTree";
import { classifyLink, hostOf, Markdown, splitStreaming, type RenderContext } from "../src/chat/markdown/render";
import { endsStream, parseFrame, type SequencedRunEvent } from "../src/chat/chatApi";
import { hubEntries, isNestedHubRoute } from "../src/settings/hubModel";
import { MODULES, MODULE_IDS, unavailableModules } from "../src/modules";
import { MODULE_IDS as SERVER_MODULE_IDS } from "../server/moduleIds";
import type { ChatMessage, ToolCallView } from "../shared/agents";
import { hasRef, nookGroups, nookWriteMode, orphanRefs, pickCounts, policyOptions, refKey, setRefPolicy, toggleRef } from "../src/chat/toolPicker";
import { grantSummary } from "../src/chat/LinkNookKeySheet";
import { callLabel, callOutcome, ConfirmationCard, ToolCallsDisclosure, TrifectaBadge } from "../src/chat/ToolDisclosure";

/**
 * The Chat client (Wave 40, agent chat plan §8, §13, §15 items 12 and 13): routes, the module
 * registry, the hub entries, the message tree, the SSE frame parser, and the Markdown renderer's
 * safety (no HTML, images as chips, link schemes allowlisted, external links through the sheet).
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const chatId = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const agentId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";

describe("routes (§13.1)", () => {
  test("/chat, /chat/new (with ?agent=), /chat/:id, and the Settings → Agents editor round-trip", () => {
    const rows: Array<[string, Route]> = [
      ["/chat", { app: "chat", chatId: null }],
      ["/chat/new", { app: "chat", chatId: null, newChat: true }],
      [`/chat/new?agent=${agentId}`, { app: "chat", chatId: null, newChat: true, agentId }],
      [`/chat/${chatId}`, { app: "chat", chatId }],
      ["/settings/agents", { app: "settings", section: "agents" }],
      [`/settings/agents/${agentId}`, { app: "settings", section: "agents", agentId }],
      [`/settings/agents/${NEW_AGENT}`, { app: "settings", section: "agents", agentId: NEW_AGENT }],
      ["/settings/ai", { app: "settings", section: "ai" }]
    ];
    for (const [path, route] of rows) {
      expect(parseRoute(path)).toEqual(route);
      expect(formatRoute(route)).toBe(path);
    }
    expect(parseRoute(`/chat/${chatId.toUpperCase()}`)).toEqual({ app: "chat", chatId });
    for (const path of ["/chat/nope", `/chat/${chatId}/extra`, "/chat/new/extra"]) expect(parseRoute(path)).toEqual({ app: "chat", chatId: null });
    expect(parseRoute("/chat/new?agent=garbage")).toEqual({ app: "chat", chatId: null, newChat: true });
    expect(parseRoute("/settings/agents/garbage")).toEqual({ app: "settings", section: null });
    expect(parseRoute("/chatx")).toEqual({ app: "home" });
    // The canonical-URL check keeps the agent query on /chat/new only.
    expect(locationUrl({ pathname: "/chat/new", search: `?agent=${agentId}` })).toBe(`/chat/new?agent=${agentId}`);
    expect(locationUrl({ pathname: `/chat/${chatId}`, search: "?x=1" })).toBe(`/chat/${chatId}`);
    expect(chatRoute(chatId)).toEqual({ app: "chat", chatId });
    expect(chatRoute(null, { newChat: true, agentId })).toEqual({ app: "chat", chatId: null, newChat: true, agentId });
  });

  test("in-app Back: history when this visit pushed entries, else the list, else Home", () => {
    expect(chatBackAction(chatRoute(chatId), 2)).toEqual({ kind: "history" });
    expect(chatBackAction(chatRoute(chatId), 0)).toEqual({ kind: "replace", route: chatRoute() });
    expect(chatBackAction(chatRoute(null, { newChat: true }), 0)).toEqual({ kind: "replace", route: chatRoute() });
    expect(chatBackAction(chatRoute(), 3)).toEqual({ kind: "home" });
  });

  test("the list groups chats by date, pinned first", () => {
    const now = new Date(2026, 9, 5, 12).getTime();
    expect(chatGroup(new Date(2026, 9, 5, 9).toISOString(), true, now)).toBe("Pinned");
    expect(chatGroup(new Date(2026, 9, 5, 9).toISOString(), false, now)).toBe("Today");
    expect(chatGroup(new Date(2026, 9, 4, 9).toISOString(), false, now)).toBe("Yesterday");
    expect(chatGroup(new Date(2026, 9, 1, 9).toISOString(), false, now)).toBe("Previous 7 days");
    expect(chatGroup(new Date(2026, 7, 1, 9).toISOString(), false, now)).toBe(new Date(2026, 7, 1).toLocaleDateString(undefined, { month: "long" }));
    expect(chatGroup("not a date", false, now)).toBe("Older");
  });
});

describe("the run stream's end (TODO `?after` overflow)", () => {
  test("`done` ends it; a snapshot ends it only when the run has ended (a live one is followed by its events and `done`)", () => {
    const snapshot = (status: string) => ({ seq: 0, type: "snapshot", data: { status, messageId: "m", content: "", messageStatus: "streaming", usage: null, errorCode: null, toolCalls: [], pendingConfirmation: null } }) as unknown as SequencedRunEvent;
    expect(endsStream({ seq: 9, type: "done", data: { status: "ok", messageId: "m" } })).toBe(true);
    expect(endsStream({ seq: 3, type: "delta", data: { messageId: "m", text: "x" } })).toBe(false);
    for (const status of ["running", "queued", "awaiting_confirmation"]) expect({ status, ends: endsStream(snapshot(status)) }).toEqual({ status, ends: false });
    for (const status of ["ok", "error", "cancelled", "interrupted", "timeout", "step_limit", "budget"]) expect({ status, ends: endsStream(snapshot(status)) }).toEqual({ status, ends: true });
  });
});

describe("the module and the hub", () => {
  test("Chat is the `agents` module, in step with the server, with a launcher tile and routes; guests never see it", () => {
    expect([...MODULE_IDS]).toEqual([...SERVER_MODULE_IDS]);
    const chat = MODULES.find((module) => module.id === "agents")!;
    expect(chat).toMatchObject({ label: "Chat", routeApps: ["chat"], launcher: { section: "chat", href: "/chat" } });
    expect(unavailableModules({ agents: false })).toEqual(["agents"]);
    expect(unavailableModules({ vault: false, agents: false })).toEqual(["vault", "agents"]);
    expect(unavailableModules({ agents: true })).toEqual([]);
  });

  test("Settings → Agents is for every role but guest; Settings → AI for admins; the editor is a nested page", () => {
    const ids = (role: "admin" | "member" | "viewer" | "guest") => hubEntries(role, { teamModuleEnabled: true }).map((entry) => entry.id);
    expect(ids("admin")).toContain("ai");
    expect(ids("admin")).toContain("agents");
    expect(ids("member")).toContain("agents");
    expect(ids("member")).not.toContain("ai");
    expect(ids("viewer")).toContain("agents");
    expect(ids("guest")).not.toContain("agents");
    expect(ids("guest")).not.toContain("ai");
    expect(isNestedHubRoute({ app: "settings", section: "agents", agentId })).toBe(true);
    expect(isNestedHubRoute({ app: "settings", section: "agents" })).toBe(false);
  });
});

describe("the message tree (D360)", () => {
  const at = (minute: number) => `2026-10-05T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const message = (id: string, parentId: string | null, role: "user" | "assistant", minute: number): ChatMessage => ({ id, parentId, role, content: id, status: "complete", errorCode: null, model: null, usage: null, runId: null, createdAt: at(minute), finishedAt: null });
  const messages = [message("u1", null, "user", 1), message("a1", "u1", "assistant", 2), message("u2", null, "user", 3), message("a2", "u2", "assistant", 4), message("a1b", "u1", "assistant", 5), message("u3", "a1b", "user", 6), message("a3", "u3", "assistant", 7)];

  test("the branch on screen follows the active leaf and counts siblings", () => {
    expect(pathTo(messages, "a3").map((item) => item.id)).toEqual(["u1", "a1b", "u3", "a3"]);
    expect(pathTo(messages, "a2").map((item) => item.id)).toEqual(["u2", "a2"]);
    // An unknown leaf shows the newest branch.
    expect(pathTo(messages, "zzz").map((item) => item.id)).toEqual(["u2", "a2"]);
    expect(pathTo(messages, null).map((item) => item.id)).toEqual(["u2", "a2"]);
    const shown = shownBranch(messages, "a3");
    expect(shown.map((item) => [item.message.id, item.index + 1, item.count])).toEqual([["u1", 1, 2], ["a1b", 2, 2], ["u3", 1, 1], ["a3", 1, 1]]);
    expect(childrenOf(messages, "u1").map((item) => item.id)).toEqual(["a1", "a1b"]);
    // Switching to the first answer of u1 lands on that answer (it has no children); to u2's branch, on a2.
    expect(leafForSibling(messages, messages[1]!)).toBe("a1");
    expect(leafForSibling(messages, messages[2]!)).toBe("a2");
  });
});

describe("the SSE reader", () => {
  test("parses frames with ids, events, and JSON data; skips comments and junk", () => {
    expect(parseFrame('id: 3\nevent: delta\ndata: {"messageId":"m","text":"hi"}')).toEqual({ seq: 3, type: "delta", data: { messageId: "m", text: "hi" } });
    expect(parseFrame(": ping")).toBeNull();
    expect(parseFrame("event: delta\ndata: not json")).toBeNull();
    expect(parseFrame("data: {}")).toBeNull();
  });
});

describe("Markdown (D370, T303, T304)", () => {
  const calls: string[] = [];
  const context: RenderContext = { onExternalLink: (href) => calls.push(`external:${href}`), onNookLink: (path) => calls.push(`nook:${path}`) };
  const render = (text: string, streaming = false) => renderToStaticMarkup(<Markdown text={text} context={context} streaming={streaming} />);

  test("renders the supported blocks without ever producing HTML from the text", () => {
    const html = render("# Title\n\nSome *em* and **strong** and `code` and ~~del~~.\n\n- one\n- [x] done\n\n1. first\n\n> quote\n\n```js\nconsole.log(1)\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n");
    expect(html).toContain("<h2 class=\"chat-md-heading chat-md-h1\">Title</h2>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<code class=\"chat-md-code\">code</code>");
    expect(html).toContain("<del>del</del>");
    expect(html).toContain("<ul>");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("aria-label=\"Done\" checked=\"\"");
    expect(html).not.toContain("[x]");
    expect(html).toContain("<ol start=\"1\">");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<code>console.log(1)</code></pre>");
    expect(html).toContain("Copy");
    expect(html).toContain("class=\"chat-md-table\"");
    expect(html).toContain("<hr/>");
  });

  test("raw HTML, scripts, and event handlers come out as text; images never load; bad link schemes are text", () => {
    const html = render("<script>alert(1)</script>\n\nInline <b onclick=\"x()\">bold</b> text\n\n![alt text](https://evil.example.test/x.png?q=secret)\n\n[js](javascript:alert(1)) [data](data:text/html;base64,AAAA) [vb](vbscript:x) [ok](https://docs.example.test/page?x=1) [mail](mailto:a@b.test) [nook](/notes/abc)");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;b onclick=&quot;x()&quot;&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("chat-md-image");
    expect(html).toContain("alt text · evil.example.test");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("vbscript:");
    expect(html).toContain("href=\"https://docs.example.test/page?x=1\"");
    expect(html).toContain("↗ docs.example.test");
    expect(html).toContain("href=\"mailto:a@b.test\"");
    expect(html).toContain("href=\"/notes/abc\"");
    expect(html).toContain("rel=\"noopener noreferrer\"");
    expect(classifyLink("javascript:alert(1)")).toEqual({ kind: "text" });
    expect(classifyLink("//evil.example.test/x")).toEqual({ kind: "text" });
    expect(classifyLink("/chat/abc").kind).toBe("nook");
    expect(classifyLink("HTTPS://x.example.test/").kind).toBe("external");
    expect(hostOf("ftp://x")).toBeNull();
  });

  test("nested emphasis and deep lists stay bounded and render; an unclosed fence streams as an open block", () => {
    const bomb = `${"*".repeat(400)}x${"*".repeat(400)}`;
    expect(render(bomb).length).toBeLessThan(20_000);
    const deep = Array.from({ length: 40 }, (_, index) => `${"  ".repeat(index)}- item`).join("\n");
    expect(render(deep)).toContain("<ul>");
    const open = render("Start\n\n```python\nprint(1)\n", true);
    expect(open).toContain("<code>print(1)");
    expect(splitStreaming("a\n\nb\n\n```\nc\n\nd")).toEqual({ settled: "a\n\nb\n\n", tail: "```\nc\n\nd" });
    expect(splitStreaming("no blank line")).toEqual({ settled: "", tail: "no blank line" });
  });

  test("no file in src/chat sets inner HTML, and no native select or confirm is used", () => {
    for (const path of ["chat/ChatApp.tsx", "chat/AiSettings.tsx", "chat/AgentsSettings.tsx", "chat/markdown/render.tsx"]) {
      const source = read(path);
      expect({ path, innerHtml: /dangerouslySetInnerHTML|innerHTML/.test(source) }).toEqual({ path, innerHtml: false });
      expect({ path, nativeSelect: /<select[\s>]/.test(source) }).toEqual({ path, nativeSelect: false });
    }
  });
});

describe("history and shells (§13.3)", () => {
  test("every sheet and menu in Chat closes on Back through useHistoryDialogGuard, and the shell is a split page", () => {
    const chat = read("chat/ChatApp.tsx");
    expect((chat.match(/useHistoryDialogGuard\(true, /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(chat).toContain("if (popStateClosedDialog(event)) return;");
    expect(chat).toContain(`<main className={\`app-page chat-app\${detailOpen ? " chat-detail-open" : ""}\`}>`);
    expect(chat).toContain('className="chat-layout split-layout"');
    expect(chat).toContain('className="chat-list-pane split-pane"');
    expect(chat).toContain('className="chat-pane split-pane"');
    expect(chat).toContain('<PageHeader title="Chat" />');
    const css = read("chat/chat.css");
    expect(css).toContain(".chat-app:not(.chat-detail-open) .chat-pane { display: none; }");
    expect(css).toContain(".chat-app.chat-detail-open .chat-list-pane { display: none; }");
    expect(css).not.toMatch(/\.chat-app\s*\{[^}]*overflow/);
    expect(read("chat/AiSettings.tsx")).toContain("useHistoryDialogGuard(true, onCancel, { blocked: busy })");
  });
});

describe("tools (Wave 41 AC-B: the picker model, disclosure, the confirmation card, history)", () => {
  const catalog = {
    servers: [{ id: "11111111-1111-4111-8111-111111111111", slug: "gh", name: "GitHub", enabled: true, status: "ok" as const, availability: "all" as const, tools: [
      { name: "search", title: null, description: "Search", readOnly: true, openWorld: true, policy: "auto" as const },
      { name: "create_issue", title: null, description: "Create", readOnly: false, openWorld: true, policy: "confirm" as const },
      { name: "nuke", title: null, description: "", readOnly: false, openWorld: true, policy: "off" as const }
    ] }],
    nook: { linked: true, linkState: "live" as const, tools: [
      { name: "list_notes", title: "List notes", module: "notes", write: false, proposable: false, scope: "notes:read", proposalScope: null },
      { name: "create_card", title: "Create a card", module: "tasks", write: true, proposable: true, scope: "tasks:write", proposalScope: "tasks:read" },
      { name: "move_card", title: "Move a card", module: "tasks", write: true, proposable: false, scope: "tasks:write", proposalScope: null }
    ] }
  };
  const serverId = catalog.servers[0]!.id;

  test("picks toggle, policies only get stricter, groups and counts follow the catalog, orphans are listed", () => {
    let refs = toggleRef([], { source: "server", serverId, toolName: "search", policy: null });
    refs = toggleRef(refs, { source: "nook", toolName: "list_notes" });
    expect(refs.length).toBe(2);
    expect(hasRef(refs, { source: "nook", toolName: "list_notes" })).toBe(true);
    expect(toggleRef(refs, { source: "nook", toolName: "list_notes" }).length).toBe(1);
    refs = setRefPolicy(refs, serverId, "search", "confirm");
    expect(refs[0]).toEqual({ source: "server", serverId, toolName: "search", policy: "confirm" });
    expect(policyOptions("auto").map((option) => option.value)).toEqual(["admin", "confirm", "off"]);
    expect(policyOptions("confirm").map((option) => option.value)).toEqual(["admin", "off"]);
    expect(policyOptions("off").map((option) => option.value)).toEqual(["admin"]);
    expect(nookGroups(catalog.nook.tools).map((group) => [group.label, group.tools.length])).toEqual([["Notes", 1], ["Tasks", 2]]);
    const counts = pickCounts(refs, catalog);
    expect(counts.perServer.get(serverId)).toBe(1);
    expect(counts.nook).toBe(1);
    expect(counts.total).toBe(2);
    expect(orphanRefs([...refs, { source: "server", serverId, toolName: "gone", policy: null }, { source: "nook", toolName: "submit_proposals" }], catalog).map(refKey)).toEqual([`server:${serverId}:gone`, "nook:submit_proposals"]);
    expect(nookWriteMode(catalog.nook.tools[0]!, false)).toBe("read");
    expect(nookWriteMode(catalog.nook.tools[1]!, false)).toBe("proposal");
    expect(nookWriteMode(catalog.nook.tools[2]!, false)).toBe("needs-direct");
    expect(nookWriteMode(catalog.nook.tools[2]!, true)).toBe("direct");
    expect(grantSummary([{ module: "notes", permission: "read", resource: null, active: true }, { module: "tasks", permission: "write", resource: { kind: "board", name: "Ops" }, active: true }, { module: "files", permission: "read", resource: null, active: false }])).toBe("Notes: read · Tasks: write (Ops)");
  });

  test("the disclosure names each call with its outcome; the confirmation card shows the arguments, Allow once, and Deny", () => {
    const calls: ToolCallView[] = [
      { id: "c1", tool: "search", server: "gh", serverId, argsPreview: "{\n  \"q\": \"bug\"\n}", resultPreview: "[{\"n\":1}]", ok: true, truncated: true, durationMs: 420, decision: null, proposalId: null },
      { id: "c2", tool: "create_card", server: "nook", serverId: null, argsPreview: "{}", resultPreview: "{\"proposed\":true}", ok: true, truncated: false, durationMs: 12, decision: "allowed", proposalId: "p1" },
      { id: "c3", tool: "create_issue", server: "gh", serverId, argsPreview: "{}", resultPreview: "{\"error\":\"refused\",\"code\":\"DENIED\"}", ok: false, truncated: false, durationMs: 3, decision: "denied", proposalId: null },
      { id: "c4", tool: "slow", server: "gh", serverId, argsPreview: "{}", resultPreview: null, ok: null, truncated: false, durationMs: null, decision: null, proposalId: null }
    ];
    expect(callLabel(calls[0]!)).toBe("Called gh/search");
    expect(calls.map(callOutcome)).toEqual(["Done", "Proposed in the Inbox", "Denied", "Running…"]);
    expect(callOutcome({ ...calls[2]!, decision: null, resultPreview: "{\"error\":\"x\",\"code\":\"TOOL_TIMEOUT\"}" })).toBe("The tool did not answer in time");
    const collapsed = renderToStaticMarkup(<ToolCallsDisclosure calls={calls} running />);
    expect(collapsed).toContain("Using 4 tools");
    expect(collapsed).toContain("(search, create_card, create_issue, slow)");
    expect(collapsed).toContain("aria-expanded=\"false\"");
    expect(collapsed).not.toContain("Called gh/search");
    expect(renderToStaticMarkup(<ToolCallsDisclosure calls={[]} running={false} />)).toBe("");
    const card = renderToStaticMarkup(<ConfirmationCard confirmation={{ confirmationId: "n3", argsHash: "h3", callId: "c3", tool: "create_issue", server: "gh", args: { title: "Refund bug", body: "<script>x</script>" }, expiresAt: new Date().toISOString(), proposal: false }} busy={false} onDecide={() => undefined} />);
    expect(card).toContain("The agent wants to run create_issue on gh");
    expect(card).toContain("&quot;title&quot;: &quot;Refund bug&quot;");
    expect(card).not.toContain("<script>");
    expect(card).toContain(">Allow once</button>");
    expect(card).toContain(">Deny</button>");
    expect(card).toContain("tabindex=\"-1\"");
    const proposal = renderToStaticMarkup(<ConfirmationCard confirmation={{ confirmationId: "n2", argsHash: "h2", callId: "c2", tool: "create_card", server: "nook", args: {}, expiresAt: new Date().toISOString(), proposal: true }} busy onDecide={() => undefined} />);
    expect(proposal).toContain("propose create_card in your Inbox");
    expect(proposal).toContain("disabled");
    expect(renderToStaticMarkup(<TrifectaBadge />)).toContain("reach outside services");
  });

  test("the new chat files set no inner HTML and use no native select; every sheet closes on Back", () => {
    for (const path of ["chat/ToolServers.tsx", "chat/LinkNookKeySheet.tsx", "chat/ToolDisclosure.tsx", "chat/AgentsSettings.tsx"]) {
      const source = read(path);
      expect({ path, innerHtml: /dangerouslySetInnerHTML|innerHTML/.test(source) }).toEqual({ path, innerHtml: false });
      expect({ path, nativeSelect: /<select[\s>]|window\.confirm\(/.test(source) }).toEqual({ path, nativeSelect: false });
    }
    expect(read("chat/ToolServers.tsx")).toContain("useHistoryDialogGuard(true, onCancel, { blocked: busy })");
    expect(read("chat/LinkNookKeySheet.tsx")).toContain("useHistoryDialogGuard(true, onClose, { blocked: busy })");
    // The confirmation card is inline (no history entry); the run's pending state comes back from the ring and the chat detail.
    expect(read("chat/ToolDisclosure.tsx")).not.toContain("useHistoryDialogGuard");
    expect(read("chat/ChatApp.tsx")).toContain("freshLive(next.activeRunId, message?.id ?? \"\", next.pendingConfirmation)");
  });
});
