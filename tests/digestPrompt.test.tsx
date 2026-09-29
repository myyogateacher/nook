import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createUser, db, request, type Session } from "./support/harness";
import { DIGEST_PROMPT_TITLE, digestPromptDone, DigestPromptCard } from "../src/today/DigestPrompt";

const mail = await import("../server/mail");
const { digestPromptVisible, DIGEST_PROMPT_AFTER_MS } = await import("../server/mail/digestPrompt");
const { readEmailPrefs } = await import("../server/mail/prefs");

/**
 * The one-time Today digest prompt (C4, D248): shown only with email on, a verified address, an
 * account at least 7 days old, the digest off, and no earlier answer; any answer settles it.
 */

const CATEGORIES = { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true };
const people: string[] = [];

beforeEach(() => mail.setMailTransportForTests(async () => ({ id: "msg_prompt" })));
afterEach(() => mail.setMailTransportForTests(null));
// The suite shares one database: never leave a digest scheduled for another file's tick.
afterAll(() => {
  db.query("UPDATE email_prefs SET digest = 'off', next_digest_at = NULL WHERE user_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(people));
});

async function person(label: string, { verified = true, ageDays = 8 } = {}) {
  const session = await createUser(label);
  people.push(session.userId);
  db.query("UPDATE users SET email_verified_at = ?, created_at = ? WHERE id = ?")
    .run(verified ? new Date().toISOString() : null, new Date(Date.now() - ageDays * 86_400_000).toISOString(), session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
const shown = async (session: Session) => (await call(session, "GET", "/mail/digest-prompt")).body.show as boolean;

describe("Today digest prompt (D248)", () => {
  test("shows only with email on, a verified address, a 7-day-old account, and the digest off", async () => {
    const ready = await person("Prompt ready");
    expect(await shown(ready)).toBe(true);
    expect(await shown(await person("Prompt unverified", { verified: false }))).toBe(false);
    expect(await shown(await person("Prompt new", { ageDays: 6 }))).toBe(false);
    expect(DIGEST_PROMPT_AFTER_MS).toBe(7 * 86_400_000);
    // Email off for this Nook.
    mail.setMailTransportForTests(null);
    expect(await shown(ready)).toBe(false);
    mail.setMailTransportForTests(async () => ({ id: "msg_prompt" }));
    // Email turned off by the person.
    const off = await person("Prompt email off");
    expect((await call(off, "PUT", "/mail/settings", { enabled: false, categories: CATEGORIES, digest: "off", digestLocalTime: "08:00", quietHours: null, tz: "UTC", revision: 0 })).status).toBe(200);
    expect(await shown(off)).toBe(false);
  });

  test("No thanks settles it for good, per person, and keeps every setting", async () => {
    const one = await person("Prompt dismiss");
    const other = await person("Prompt other");
    const dismissed = await call(one, "POST", "/mail/digest-prompt", { choice: "dismiss" });
    expect(dismissed.status).toBe(200);
    expect(await shown(one)).toBe(false);
    expect(await shown(other)).toBe(true);
    expect(readEmailPrefs(one.userId)).toMatchObject({ enabled: true, digest: "off", categories: CATEGORIES });
    // Dismissing twice is fine; the first time is kept.
    const first = (db.query("SELECT digest_prompt_at FROM email_prefs WHERE user_id = ?").get(one.userId) as { digest_prompt_at: string }).digest_prompt_at;
    expect((await call(one, "POST", "/mail/digest-prompt", { choice: "dismiss" })).status).toBe(200);
    expect(db.query("SELECT digest_prompt_at FROM email_prefs WHERE user_id = ?").get(one.userId)).toEqual({ digest_prompt_at: first });
  });

  test("choosing a cadence on the card turns the digest on in the browser's zone; turning it off later keeps the card away", async () => {
    const chooser = await person("Prompt daily");
    const chosen = await call(chooser, "POST", "/mail/digest-prompt", { choice: "daily", tz: "Asia/Kolkata" });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ show: false, digest: "daily", digestLocalTime: "08:00", tz: "Asia/Kolkata" });
    expect(readEmailPrefs(chooser.userId).nextDigestAt).not.toBeNull();
    const revision = readEmailPrefs(chooser.userId).revision;
    expect((await call(chooser, "PUT", "/mail/settings", { enabled: true, categories: CATEGORIES, digest: "off", digestLocalTime: "08:00", quietHours: null, tz: "Asia/Kolkata", revision })).status).toBe(200);
    expect(await shown(chooser)).toBe(false);
    // Bad input is refused; a cadence cannot be set from here when the prompt does not apply.
    expect((await call(chooser, "POST", "/mail/digest-prompt", { choice: "hourly" })).status).toBe(400);
    const unverified = await person("Prompt refused", { verified: false });
    expect((await call(unverified, "POST", "/mail/digest-prompt", { choice: "weekly" })).body.code).toBe("PROMPT_NOT_AVAILABLE");
    expect(readEmailPrefs(unverified.userId).digest).toBe("off");
  });

  test("a cadence chosen in Settings first also settles the prompt", async () => {
    const settings = await person("Prompt via settings");
    expect((await call(settings, "PUT", "/mail/settings", { enabled: true, categories: CATEGORIES, digest: "weekly", digestLocalTime: "07:00", quietHours: null, tz: "UTC", revision: 0 })).status).toBe(200);
    expect(digestPromptVisible(settings.userId)).toBe(false);
    const revision = readEmailPrefs(settings.userId).revision;
    expect((await call(settings, "PUT", "/mail/settings", { enabled: true, categories: CATEGORIES, digest: "off", digestLocalTime: "07:00", quietHours: null, tz: "UTC", revision })).status).toBe(200);
    expect(digestPromptVisible(settings.userId)).toBe(false);
  });

  test("the card: a titled region with three answers and a named close button; the done line names the cadence", () => {
    const markup = renderToStaticMarkup(<DigestPromptCard busy={false} error="" onChoose={() => undefined} />);
    expect(markup).toContain(DIGEST_PROMPT_TITLE);
    expect(markup).toContain('aria-labelledby="today-digest-title"');
    for (const label of ["Every morning", "Mondays only", "No thanks"]) expect(markup).toContain(`>${label}</button>`);
    expect(markup).toContain('aria-label="Dismiss the email digest suggestion"');
    expect(digestPromptDone("daily", "08:00")).toBe("Email digest on: every day at 08:00. Change it in Settings → Notifications.");
    expect(digestPromptDone("weekly", "07:30")).toContain("every Monday at 07:30");
    expect(digestPromptDone("dismiss", "08:00")).toBeNull();
  });
});
