import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountActions, InboxNavContext } from "../src/AppShell";
import { diffStats, lineDiff } from "../src/diff/lineDiff";
import { InboxApp, ProposalCard, ProposalView, RejectDialog } from "../src/inbox/InboxApp";
import type { ProposalDetail, ProposalSummary } from "../src/inbox/inboxApi";
import { actionLabel, bulkConfirmText, bulkSummary, expiresText, failureText, groupTitle, inboxBackAction, rejectedText, rejectEffectText, statusLabel } from "../src/inbox/inboxFormat";
import { hiddenModuleForApp, hiddenTodaySections, MODULES, ModulesContext } from "../src/modules";
import { formatRoute, parseRoute } from "../src/router";
import { safeNotificationPath } from "../src/notifications/notificationsApi";
import { readHiddenSections } from "../src/today/todayPreferences";
import { TODAY_SECTIONS } from "../src/today/todaySections";
import { RoleContext } from "../src/team/roleAccess";

/** The Inbox client (agent inbox §9, §13 Wave A: tests/inboxApp.test.tsx). */

const id = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const summary = (overrides: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id, kind: "card_update", kindLabel: "Update card", title: "Pay insurance", rationale: null, status: "pending",
  targetLabel: "Home › To do", restricted: false, targetHref: `/tasks/${id}/card/${id}`, digest: "Due date, Tags", keyName: "cron-box",
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 13.5 * 86_400_000).toISOString(), resolvedAt: null, resultCode: null, rejectReason: null, ref: null,
  ...overrides
});
const noop = () => undefined;

describe("Inbox routes", () => {
  test("parse and format /inbox, History, and one proposal; malformed paths open the list", () => {
    expect(parseRoute("/inbox")).toEqual({ app: "inbox", view: "pending", proposalId: null });
    expect(parseRoute("/inbox/history")).toEqual({ app: "inbox", view: "history", proposalId: null });
    expect(parseRoute(`/inbox/p/${id.toUpperCase()}`)).toEqual({ app: "inbox", view: "pending", proposalId: id });
    expect(parseRoute(`/inbox/history/p/${id}`)).toEqual({ app: "inbox", view: "history", proposalId: id });
    expect(parseRoute("/inbox/p/nope")).toEqual({ app: "inbox", view: "pending", proposalId: null });
    expect(parseRoute(`/inbox/p/${id}/extra`)).toEqual({ app: "inbox", view: "pending", proposalId: null });
    for (const path of ["/inbox", "/inbox/history", `/inbox/p/${id}`, `/inbox/history/p/${id}`]) expect(formatRoute(parseRoute(path))).toBe(path);
    expect(inboxBackAction(id, 1)).toEqual({ kind: "history" });
    expect(inboxBackAction(id, 0)).toEqual({ kind: "list" });
    expect(inboxBackAction(null, 0)).toEqual({ kind: "home" });
  });

  test("proposal notifications open the Inbox and nothing else new", () => {
    expect(safeNotificationPath("/inbox")).toBe("/inbox");
    expect(safeNotificationPath("/inbox/p/x")).toBe("/notifications");
    expect(safeNotificationPath("https://evil.example/inbox")).toBe("/notifications");
  });
});

describe("Inbox module and Today", () => {
  test("the Modules toggle hides the button, the routes, and the Proposals section (D157)", () => {
    const inbox = MODULES.find((module) => module.id === "inbox")!;
    expect(inbox.launcher).toBeUndefined();
    expect(inbox.headerItem).toBe("inbox");
    expect(hiddenModuleForApp(["inbox"], "inbox")).toBe("inbox");
    expect(hiddenTodaySections(["inbox"])).toEqual(["proposals"]);
    const account = { displayName: "Ada", onSettings: noop, onSignOut: noop };
    const nav = { role: "member" as const, openInbox: noop, onInbox: false };
    const shown = renderToStaticMarkup(<InboxNavContext.Provider value={nav}><AccountActions {...account} /></InboxNavContext.Provider>);
    expect(shown).toContain('aria-label="Inbox"');
    expect(renderToStaticMarkup(<ModulesContext.Provider value={["inbox"]}><InboxNavContext.Provider value={nav}><AccountActions {...account} /></InboxNavContext.Provider></ModulesContext.Provider>)).not.toContain('title="Inbox"');
    expect(renderToStaticMarkup(<InboxNavContext.Provider value={{ ...nav, role: "guest" }}><AccountActions {...account} /></InboxNavContext.Provider>)).not.toContain('title="Inbox"');
    expect(renderToStaticMarkup(<InboxNavContext.Provider value={{ ...nav, onInbox: true }}><AccountActions {...account} /></InboxNavContext.Provider>)).not.toContain('title="Inbox"');
  });

  test("Proposals awaiting you is in the Today group and links to the proposal; a hidden Drafts from agents carries over", () => {
    const def = TODAY_SECTIONS.proposals!;
    expect(def.group).toBe("today");
    expect(def.title).toBe("Proposals awaiting you");
    expect(TODAY_SECTIONS.agentDrafts).toBeUndefined();
    const row = def.row!({ id, kind: "card_update", kindLabel: "Update card", title: "Pay insurance", keyName: "laptop", created_at: new Date().toISOString() }, "");
    expect(row.route).toEqual({ app: "inbox", view: "pending", proposalId: id });
    expect(row.meta).toContain("Update card · Key “laptop”");
    const storage = { getItem: () => JSON.stringify(["agentDrafts", "files"]), setItem: noop };
    expect(readHiddenSections("u1", storage)).toEqual(["proposals", "files"]);
  });
});

describe("Inbox copy", () => {
  test("labels name the item, failures say nothing was applied, bulk results summarise per item", () => {
    expect(actionLabel("Approve", { kind: "card_update", title: "Pay insurance" })).toBe("Approve: update card Pay insurance");
    expect(failureText("CARD_CHANGED")).toBe("The card changed since the agent read it (CARD_CHANGED). Nothing was applied.");
    expect(failureText(null)).toBe("The change could not be applied. Nothing was applied.");
    expect(statusLabel("applied", "PUBLISHED_IN_EDITOR")).toBe("Published in the editor");
    expect(expiresText(new Date(Date.now() + 13.5 * 86_400_000).toISOString())).toBe("expires in 13 days");
    expect(groupTitle({ routine: null, key: { name: "laptop" } })).toBe("Key “laptop”");
    expect(bulkSummary([{ id: "a", status: "applied" }, { id: "b", status: "applied" }, { id: "c", status: "failed", code: "CARD_CHANGED" }])).toBe("2 applied · 1 failed (card changed)");
    expect(bulkConfirmText([{ kind: "card_create" }, { kind: "card_update" }, { kind: "row_update" }])).toBe("Apply 3 changes: 2 cards, 1 row");
    const diff = lineDiff("a\nb", "a\nc\nd");
    expect(diff.map((line) => `${line.kind}:${line.text}`)).toEqual(["same:a", "add:c", "add:d", "remove:b"]);
    expect(diffStats(diff).label).toBe("+2 −1 lines");
  });
});

describe("Inbox rendering", () => {
  test("agent text renders as text, never as markup (T127), with named Approve and Reject", () => {
    const markup = renderToStaticMarkup(<ProposalCard item={summary({ title: "<img src=x onerror=alert(1)>" })} selected={false} busy={false} canApprove onOpen={noop} onApprove={noop} onReject={noop} />);
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('aria-label="Approve: update card &lt;img src=x onerror=alert(1)&gt;"');
    expect(markup).toContain('aria-label="Reject: update card &lt;img src=x onerror=alert(1)&gt;"');
    expect(markup).toContain("<article");
    // Viewers see Reject only.
    const viewer = renderToStaticMarkup(<ProposalCard item={summary()} selected={false} busy={false} canApprove={false} onOpen={noop} onApprove={noop} onReject={noop} />);
    expect(viewer).not.toContain("Approve:");
    expect(viewer).toContain("Reject:");
  });

  test("the proposal view labels the agent's rationale and shows before and after in words", () => {
    const detail: ProposalDetail = { ...summary({ rationale: "Due date passed.\n**bold?**" }), preview: { fields: [{ name: "Due date", before: null, after: "2026-10-03" }] } };
    const markup = renderToStaticMarkup(<ProposalView proposal={detail} busy={false} canApprove onBack={noop} onOpenPath={noop} onApprove={noop} onReject={noop} />);
    expect(markup).toContain("Written by the agent");
    expect(markup).toContain("**bold?**");
    expect(markup).toContain("<th scope=\"col\">Before</th>");
    expect(markup).toContain("<em>(none)</em>");
    expect(markup).toContain("2026-10-03");
    const restricted = renderToStaticMarkup(<ProposalView proposal={{ ...detail, restricted: true, preview: { restricted: true } }} busy={false} canApprove onBack={noop} onOpenPath={noop} onApprove={noop} onReject={noop} />);
    expect(restricted).toContain("cannot be shown or approved");
    expect(restricted).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Approve: /);
    const note: ProposalDetail = { ...summary({ kind: "note_draft", kindLabel: "Note draft", targetHref: `/notes/${id}` }), preview: { markdown: { published: "a", draft: "a\nb", draftChanged: false } } };
    const noteMarkup = renderToStaticMarkup(<ProposalView proposal={note} busy={false} canApprove onBack={noop} onOpenPath={noop} onApprove={noop} onReject={noop} />);
    expect(noteMarkup).toContain('class="diff-view inbox-diff"');
    expect(noteMarkup).toContain("+1 −0 lines");
    expect(noteMarkup).toContain(">Open note</button>");
    expect(noteMarkup).toContain("Approve and publish");
  });

  test("the Inbox page starts loading with Home, the segments, and no launcher tile", () => {
    const globals = globalThis as { window?: unknown };
    const previous = globals.window;
    globals.window = { location: { pathname: "/inbox" } };
    try {
      const markup = renderToStaticMarkup(<RoleContext.Provider value="member"><InboxApp displayName="Ada" navigate={noop} flash={noop} onHome={noop} onSettings={noop} onSignOut={noop} onOpenPath={noop} /></RoleContext.Provider>);
      expect(markup).toContain(">Home</button>");
      expect(markup).toContain("<h1 id=\"inbox-title\">Inbox</h1>");
      expect(markup).toContain('aria-pressed="true">Pending');
      expect(markup).toContain(">History</button>");
      expect(markup).toContain("Loading proposals…");
    } finally {
      globals.window = previous;
    }
  });

  test("the reject dialog says exactly what happens to a note draft (review H1)", () => {
    const note = (rejectEffect?: "restore" | "discard" | "keep") => summary({ kind: "note_draft", kindLabel: "Note draft", ...(rejectEffect ? { rejectEffect } : {}) });
    expect(rejectEffectText([note("restore")])).toBe("Your earlier draft will be restored.");
    expect(rejectEffectText([note("discard")])).toBe("The agent's draft will be discarded.");
    expect(rejectEffectText([note("keep")])).toBe("The draft stays as it is.");
    expect(rejectEffectText([note()])).toBe("The draft stays as it is.");
    expect(rejectEffectText([summary()])).toBe("Nothing changes.");
    expect(rejectEffectText([summary(), summary()])).toBe("Nothing changes.");
    expect(rejectEffectText([note("restore"), note("discard"), note("discard"), summary()])).toBe("1 earlier draft will be restored. 2 agent drafts will be discarded. Nothing else changes.");
    expect(rejectedText("restored")).toBe("Rejected. Your earlier draft was restored.");
    expect(rejectedText(undefined)).toBe("Rejected");
    const markup = renderToStaticMarkup(<RejectDialog label="Weekly" count={1} effect={rejectEffectText([note("restore")])} onClose={noop} onReject={async () => undefined} />);
    expect(markup).toContain("Your earlier draft will be restored.");
    expect(markup).not.toContain("Nothing changes");
  });

  test("44 px touch targets at 390 px (§9.2)", async () => {
    const css = await Bun.file(new URL("../src/inbox/inbox.css", import.meta.url)).text();
    for (const selector of [".inbox-action {", ".inbox-segments button {", ".inbox-back {", ".inbox-link-button {"]) {
      const rule = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
      expect({ selector, touch: /min-height: 44px/.test(rule) }).toEqual({ selector, touch: true });
    }
  });
});
