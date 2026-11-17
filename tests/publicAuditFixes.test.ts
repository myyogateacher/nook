import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./support/harness";

const { startEmailVerification, VERIFICATION_ITEM_DAY_CAP } = await import("../server/public/verification");
const { enqueueExternalMail, EXTERNAL_CAPS } = await import("../server/notify");
const { registerMailTemplate } = await import("../server/mail/registry");
const { layout } = await import("../server/mail/layout");
const mail = await import("../server/mail");

/**
 * Public-surface audit fixes (§B.8): verification codes are not capped by the item's shared
 * outside-mail cap (D822a, T508).
 */

let unregister: () => void;
let outboxBefore = 0;
beforeAll(() => {
  outboxBefore = (db.query("SELECT COALESCE(MAX(rowid), 0) AS id FROM mail_outbox").get() as { id: number }).id;
  mail.setMailTransportForTests(async () => ({ id: "msg" }));
  unregister = registerMailTemplate("test.audit_outside", {
    name: "test.audit_outside", class: "activity",
    render: (_data: { stopHref?: string }, context) => layout({ instanceName: context.instanceName, subject: "Hi", preheader: "Hi", eyebrow: "Test", title: "Hi", blocks: [], footer: { reason: "Test." } }),
    fixture: () => ({}),
    resolveExternal: () => ({ data: {} })
  }) as unknown as () => void;
});
afterAll(() => {
  // The suite shares one outbox: the ~45 codes queued here would fill a later file's dispatch batch
  // (MAIL_BATCH, oldest first), and the test template's row would outlive its template.
  db.query("DELETE FROM mail_outbox WHERE rowid > ? AND status = 'queued'").run(outboxBefore);
  unregister?.();
  mail.setMailTransportForTests(null);
});

describe("verification codes have their own per-item cap (D822a, T508)", () => {
  test("more strangers than the item's 30-a-day outside cap still get a code; the item's other mail is untouched", () => {
    const itemId = crypto.randomUUID();
    const results = Array.from({ length: EXTERNAL_CAPS.itemDay + 5 }, (_, index) =>
      db.transaction(() => startEmailVerification({ kind: "form", itemId, email: `person${index}@outside.test`, payload: {}, address: `10.0.0.${index}` }))());
    expect(results.every((result) => result.mailQueued)).toBe(true);
    // The item's own outside mail (another template) still has its full 30 a day.
    const other = enqueueExternalMail({ to: "someone@outside.test", template: "test.audit_outside", payload: {}, itemRef: { kind: "form", id: itemId } });
    expect(other).not.toBeNull();
    // Per-address caps still apply to codes.
    const same = Array.from({ length: EXTERNAL_CAPS.addressHour + 1 }, () => db.transaction(() => startEmailVerification({ kind: "form", itemId, email: "bomb@outside.test", payload: {}, address: "10.0.1.1" }))());
    expect(same.filter((result) => result.mailQueued).length).toBe(EXTERNAL_CAPS.addressHour);
    expect(VERIFICATION_ITEM_DAY_CAP).toBeGreaterThan(EXTERNAL_CAPS.itemDay);
  });
});
