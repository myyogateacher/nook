import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createUser, db, request, type Session } from "./support/harness";
import { ProposalCard, ProposalView } from "../src/inbox/InboxApp";
import type { ProposalDetail, ProposalSummary } from "../src/inbox/inboxApi";
import { bulkSummary } from "../src/inbox/inboxFormat";

/** v0.10.0 delegated-QA polish for the Inbox: stale proposals, named bulk failures, phone toast and targets. */

const id = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const summary = (overrides: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id, kind: "card_update", kindLabel: "Update card", title: "Alpha card", rationale: null, status: "pending",
  targetLabel: "Alpha", restricted: false, targetHref: `/tasks/${id}/card/${id}`, digest: "Due date", keyName: "agent",
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), resolvedAt: null, resultCode: null, rejectReason: null, ref: null,
  ...overrides
});
const noop = () => undefined;

describe("stale proposals (note 9)", () => {
  test("the list row and the proposal flag a pending proposal whose target changed", () => {
    const card = (item: ProposalSummary) => renderToStaticMarkup(<ProposalCard item={item} selected={false} busy={false} canApprove onOpen={noop} onApprove={noop} onReject={noop} />);
    expect(card(summary({ stale: true }))).toContain("Changed since the agent read it");
    expect(card(summary({ stale: false }))).not.toContain("Changed since the agent read it");
    expect(card(summary())).not.toContain("Changed since the agent read it");
    const detail: ProposalDetail = { ...summary({ stale: true }), preview: { fields: [{ name: "Due date", before: null, after: "2026-10-03" }] } };
    expect(renderToStaticMarkup(<ProposalView proposal={detail} busy={false} canApprove onBack={noop} onOpenPath={noop} onApprove={noop} onReject={noop} />)).toContain("Changed since the agent read it");
    const resolved: ProposalDetail = { ...detail, status: "failed", resultCode: "CARD_CHANGED" };
    expect(renderToStaticMarkup(<ProposalView proposal={resolved} busy={false} canApprove onBack={noop} onOpenPath={noop} onApprove={noop} onReject={noop} />)).not.toContain("Changed since the agent read it");
  });

  async function cardFor(owner: Session) {
    const board = await (await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Stale board" }) }, owner)).json() as { board: { id: string }; columns: Array<{ id: string }> };
    const created = await (await request(`/tasks/boards/${board.board.id}/cards`, { method: "POST", body: JSON.stringify({ columnId: board.columns[0]!.id, title: "Alpha card" }) }, owner)).json() as { card: { id: string; revision: number } };
    return created.card;
  }

  test("the list and detail payloads say stale when the card's revision moved past the proposal's base", async () => {
    const owner = await createUser("Inbox stale");
    const card = await cardFor(owner);
    const proposalId = crypto.randomUUID();
    db.query(`INSERT INTO proposals (id, owner_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
      VALUES (?, ?, 'agent', 'card_update', 'card', ?, 'Alpha card', ?, ?, ?)`)
      .run(proposalId, owner.userId, card.id, JSON.stringify({ cardId: card.id, baseRevision: card.revision, title: "Alpha card v2" }), new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    const listed = async () => ((await (await request("/inbox/proposals?status=pending&group=run", {}, owner)).json()) as { groups: Array<{ items: Array<{ id: string; stale: boolean }> }> }).groups.flatMap((group) => group.items).find((item) => item.id === proposalId)!;
    const detail = async () => ((await (await request(`/inbox/proposals/${proposalId}`, {}, owner)).json()) as { proposal: { stale: boolean } }).proposal;
    expect((await listed()).stale).toBe(false);
    expect((await detail()).stale).toBe(false);
    db.query("UPDATE cards SET revision = revision + 1 WHERE id = ?").run(card.id);
    expect((await listed()).stale).toBe(true);
    expect((await detail()).stale).toBe(true);
    // Reading never changes the proposal.
    expect((db.query("SELECT status FROM proposals WHERE id = ?").get(proposalId) as { status: string }).status).toBe("pending");
  });
});

test("bulk summaries name the failed items when titles are known (note 9)", () => {
  const titles = new Map([["a", "Alpha card"], ["b", "Beta card"], ["c", "Gamma"], ["d", "Delta"], ["e", "Echo"]]);
  const titleOf = (key: string) => titles.get(key);
  expect(bulkSummary([{ id: "a", status: "failed", code: "CARD_CHANGED" }, { id: "b", status: "applied" }], titleOf)).toBe("1 applied · 1 failed: Alpha card (card changed)");
  expect(bulkSummary(["a", "c", "d", "e"].map((key) => ({ id: key, status: "failed", code: "ROW_CHANGED" })), titleOf)).toBe("4 failed: Alpha card (row changed), Gamma (row changed), Delta (row changed) and 1 more");
  // Without titles (or with an unknown id) the summary keeps the short form.
  expect(bulkSummary([{ id: "zz", status: "failed", code: "CARD_CHANGED" }], titleOf)).toBe("1 failed (card changed)");
});

test("the phone approve toast sits above the sticky bar and phone targets are 44 px (F3, note 8)", async () => {
  const css = await Bun.file(new URL("../src/inbox/inbox.css", import.meta.url)).text();
  expect(css).toMatch(/\.inbox-detail-open \.inbox-toast \{ bottom: calc\(76px \+ env\(safe-area-inset-bottom\)\); \}/);
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.inbox-toggle button \{ min-height: 44px; \}/);
  expect(phone).toMatch(/\.inbox-facts dd \.inbox-link-button \{ min-height: 44px; \}/);
  const source = await Bun.file(new URL("../src/inbox/InboxApp.tsx", import.meta.url)).text();
  // The toast carries the same Open link as the desktop banner.
  expect(source).toMatch(/phoneToast\.ref && <button[^\n]*?\{refLabel\[phoneToast\.ref\.type\]\}/);
});
