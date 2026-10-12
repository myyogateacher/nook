import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../src/api";
import { dropSharedChat, forkFailureText, serverMessage, syncSharedChat } from "../src/chat/sharedChatState";
import type { ChatSummary } from "../shared/agents";
import { agentKeysRoute } from "../src/chat/AgentsSettings";
import { keyTabOf } from "../src/keys/keyTabs";
import { formatRoute } from "../src/router";

/**
 * Wave 43 fixes 2, client: "Shared with me" follows the open shared chat (QA L1: a rename shows,
 * an unshare or delete removes it, coming back to the tab reloads it), and Continue as a copy shows
 * the server's message (QA L2: "no longer available" to a recipient whose agent is in the Bin).
 */

const source = readFileSync(join(import.meta.dir, "..", "src", "chat", "ChatApp.tsx"), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = (n: number, title: string): ChatSummary => ({
  id: id(n), agentId: id(90), agentName: "Helper", agentIcon: null, title, pinned: false, activeLeafId: null, revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", running: false, yourLevel: "view", ownerName: "Ana", copiedFrom: null
} as ChatSummary);

describe("QA L1: the Shared with me list", () => {
  test("a rename of the open chat shows in the list; nothing else changes, and an unchanged list stays the same object", () => {
    const list = [summary(1, "Old title"), summary(2, "Other")];
    const renamed = syncSharedChat(list, { id: id(1), title: "New title", updatedAt: "2026-10-02T00:00:00.000Z" })!;
    expect(renamed.map((chat) => chat.title)).toEqual(["New title", "Other"]);
    expect(renamed[0]!.updatedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(renamed[1]).toBe(list[1]!);
    expect(list[0]!.title).toBe("Old title");
    expect(syncSharedChat(renamed, renamed[0]!)).toBe(renamed);
    expect(syncSharedChat(list, { id: id(3), title: "Not listed", updatedAt: "x" })).toBe(list);
    expect(syncSharedChat(null, { id: id(1), title: "x", updatedAt: "x" })).toBeNull();
  });

  test("an unshared or deleted chat leaves the list", () => {
    const list = [summary(1, "Gone soon"), summary(2, "Stays")];
    expect(dropSharedChat(list, id(1))!.map((chat) => chat.id)).toEqual([id(2)]);
    expect(dropSharedChat(list, id(3))).toBe(list);
    expect(dropSharedChat(null, id(1))).toBeNull();
  });

  test("ChatApp wires the updates stream, the 404, and visibility to the list", () => {
    // chat_changed (a rename, an access change) reloads the lists after the detail.
    expect(source).toContain('if (event.type === "chat_changed") listChanged = true;');
    expect(source).toMatch(/if \(listChanged\) \{\s*listChanged = false;\s*void loadChatsRef\.current\(queryRef\.current\);/);
    // gone (the stream's event, or a 404/403 on reconnect) drops the item at once.
    expect(source).toContain('if (ended === "gone") gone();');
    expect(source).toContain("if (reason instanceof ApiError && (reason.status === 404 || reason.status === 403)) { gone(); return; }");
    expect(source).toContain("setSharedChats((list) => dropSharedChat(list, updatesChatId));");
    // A 404 on reloading the open chat drops it too.
    expect(source).toContain("setSharedChats((list) => dropSharedChat(list, chatId));");
    // The open shared chat's title is the list's.
    expect(source).toContain("setSharedChats((list) => syncSharedChat(list, sharedTitle))");
    // Coming back to the tab reloads the lists.
    expect(source).toMatch(/const regained = tabVisible && !wasVisible\.current;[\s\S]{0,200}if \(regained && status\?\.enabled && status\.canChat\) void loadChats\(queryRef\.current\);/);
  });
});

describe("QA L2: Continue as a copy says what the server says", () => {
  const refused = (status: number, payload: unknown) => new ApiError(typeof (payload as { error?: unknown })?.error === "string" ? (payload as { error: string }).error : `Request failed (${status})`, status, payload);

  test("a recipient whose chat's agent is in its owner's Bin reads \"no longer available\", never the Bin", () => {
    const text = forkFailureText(refused(409, { error: "This chat's agent is no longer available; start a new chat with another agent", code: "AGENT_GONE" }));
    expect(text).toBe("This chat's agent is no longer available; start a new chat with another agent");
    expect(text).not.toContain("Bin");
    // The agent's owner is told it is in their Bin (the server's text for them).
    expect(forkFailureText(refused(409, { error: "This chat's agent is in the Bin; restore it to continue", code: "AGENT_GONE" }))).toBe("This chat's agent is in the Bin; restore it to continue");
    expect(forkFailureText(refused(403, { error: "You can read this chat, but its agent is not shared with you, so you cannot continue it", code: "AGENT_NOT_SHARED" }))).toContain("its agent is not shared with you");
  });

  test("a generic line only when the server sent no message", () => {
    expect(forkFailureText(refused(409, { code: "AGENT_GONE" }))).toBe("This chat's agent is no longer available, so you cannot continue this chat");
    expect(forkFailureText(refused(403, { code: "AGENT_NOT_SHARED" }))).toBe("Its agent is not shared with you, so you cannot continue this chat");
    expect(forkFailureText(refused(500, {}))).toBe("Could not copy the chat");
    expect(forkFailureText(new TypeError("Failed to fetch"))).toBe("Could not copy the chat");
    expect(serverMessage(refused(409, { error: "  " }))).toBeNull();
    expect(source).toContain("notify.error(forkFailureText(reason));");
    expect(source).not.toContain('code === "AGENT_GONE" ? ERROR_TEXT.AGENT_GONE!');
  });
});

describe("Manage API keys from an agent's Link Nook key sheet", () => {
  test("opens the General tab by its own URL, where every linkable key is listed", () => {
    expect(formatRoute(agentKeysRoute())).toBe("/settings/keys/general");
    // A linkable key: a general key with Nook read grants, never agents:run (T318), so on General with Chat on or off.
    const linkable = { kind: "general" as const, grants: [{ module: "notes", permission: "read" }, { module: "tasks", permission: "read" }] };
    expect(keyTabOf(linkable as never, { vault: true, agents: true })).toBe("general");
    expect(keyTabOf(linkable as never, { vault: true, agents: false })).toBe("general");
    const editor = readFileSync(join(import.meta.dir, "..", "src", "chat", "AgentsSettings.tsx"), "utf8");
    expect(editor).not.toContain('navigate({ app: "settings", section: "mcp" })');
    expect(editor.match(/navigate\(keysRoute\)/g)).toHaveLength(2);
  });
});
