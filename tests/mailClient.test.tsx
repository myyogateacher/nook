import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, parseSettingsPath, settingsDocumentTitle, settingsPath, settingsTitleScope } from "../src/router";
import { renderToStaticMarkup } from "react-dom/server";
import { takeMailLinkFromLocation, UnsubscribeDone, unsubscribeCategory, verifyErrorText } from "../src/auth/mailPages";
import { emailOffText } from "../src/notifications/EmailSettings";
import { HALF_HOURS, prefsInput, type EmailPrefs } from "../src/notifications/emailApi";
import { digestNote, digestTimeOptions, suppressionCopy } from "../src/notifications/EmailSettings";

/** Client pieces of Wave 28: routes, mail link pages, and the email settings request body. */

describe("email off (3a/6)", () => {
  test("members are sent to an admin; admins get the OPERATIONS pointer", () => {
    expect(emailOffText("member")).toBe("Email is off on this Nook. Ask an admin to turn it on.");
    expect(emailOffText("viewer")).toBe("Email is off on this Nook. Ask an admin to turn it on.");
    expect(emailOffText("admin")).toContain("OPERATIONS → Email");
  });

  test("a failed verify link offers a new one only while email is on", () => {
    expect(verifyErrorText("expired", "", true)).toBe("Send a new one from Settings → Notifications.");
    expect(verifyErrorText("expired", "", false)).toBe("Email is off on this Nook.");
    expect(verifyErrorText("invalid", "", false)).toBe("It may have been used already or copied incompletely. Email is off on this Nook.");
    expect(verifyErrorText("invalid", "", false)).not.toContain("Send a new one");
    expect(verifyErrorText("error", "Boom", false)).toBe("Boom");
  });

  test("the mail link card's Open Nook text button is a 44 px target", async () => {
    const css = await Bun.file(new URL("../src/notifications/notifications.css", import.meta.url)).text();
    expect(css).toContain(".mail-link-card .text-button { min-height: 44px; }");
  });
});

describe("routes", () => {
  test("/team/email is the admin Email log; /settings/:section is a Settings entry over Home", () => {
    expect(parseRoute("/team/email")).toEqual({ app: "team", userId: null, email: true });
    expect(formatRoute({ app: "team", userId: null, email: true })).toBe("/team/email");
    expect(parseRoute("/team/email/x")).toEqual({ app: "team", userId: null });
    for (const section of ["security", "modules", "mcp", "notifications", "about"] as const) {
      expect(parseSettingsPath(settingsPath(section))).toBe(section);
      expect(parseRoute(settingsPath(section))).toEqual({ app: "home" });
    }
    expect(parseSettingsPath("/settings/nope")).toBeNull();
    expect(parseSettingsPath("/settings")).toBeNull();
    expect(parseSettingsPath("/settings/notifications/")).toBe("notifications");
  });
});

describe("mail link pages", () => {
  const history = () => {
    const calls: string[] = [];
    return { calls, value: { state: { keep: 1 }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { calls.push(String(url)); } } };
  };

  test("the verify token is read from the fragment and stripped at once (T220)", () => {
    const token = "a".repeat(43);
    const h = history();
    expect(takeMailLinkFromLocation({ pathname: "/verify-email", hash: `#token=${token}` }, h.value)).toEqual({ kind: "verify", token });
    expect(h.calls).toEqual(["/verify-email"]);
    expect(takeMailLinkFromLocation({ pathname: "/verify-email", hash: "#token=short" }, history().value)).toEqual({ kind: "verify", token: null });
    expect(takeMailLinkFromLocation({ pathname: "/notes", hash: "" }, history().value)).toBeNull();
  });

  test("the unsubscribe page reads its category for display only", () => {
    const payload = Buffer.from(`1|${crypto.randomUUID()}|sharing|0`).toString("base64url");
    const token = `${payload}.${"b".repeat(22)}`;
    const h = history();
    expect(takeMailLinkFromLocation({ pathname: "/mail/unsubscribe", hash: `#t=${token}` }, h.value)).toEqual({ kind: "unsubscribe", token });
    expect(h.calls).toEqual(["/mail/unsubscribe"]);
    expect(unsubscribeCategory(token)).toBe("sharing");
    expect(unsubscribeCategory(`${Buffer.from("1|x|security|0").toString("base64url")}.${"b".repeat(22)}`)).toBeNull();
  });

  test("Settings names its section in the document title and restores the title on close", () => {
    expect(settingsDocumentTitle("notifications")).toBe("Settings · Notifications · Nook");
    expect(settingsDocumentTitle("mcp")).toBe("Settings · API keys · Nook");
    const doc = { title: "Home · Nook" };
    const scope = settingsTitleScope(doc);
    scope.show("notifications");
    expect(doc.title).toBe("Settings · Notifications · Nook");
    scope.show("security");
    expect(doc.title).toBe("Settings · Security · Nook");
    scope.restore();
    expect(doc.title).toBe("Home · Nook");
  });

  test("the done state is neutral, since the server answers 200 for any token (L5)", () => {
    const markup = renderToStaticMarkup(<UnsubscribeDone label="Shared with you" onManage={() => undefined} />);
    expect(markup).toContain("If this link is current, “Shared with you” emails are now off. Check <a href=\"/settings/notifications\">Settings → Notifications → Email</a> to be sure.");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("emails are off<");
  });
});

describe("email settings body", () => {
  const prefs: EmailPrefs = { enabled: true, categories: { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true }, digest: "off", digestLocalTime: "08:00", quietStart: "22:00", quietEnd: "07:30", tz: "Europe/Berlin", revision: 3, updatedAt: null };
  test("keeps the stored zone, quiet hours, and digest cadence", () => {
    expect(prefsInput(prefs, { enabled: false })).toEqual({ enabled: false, categories: prefs.categories, digest: "off", digestLocalTime: "08:00", quietHours: { start: "22:00", end: "07:30" }, tz: "Europe/Berlin", revision: 3 });
    expect(prefsInput({ ...prefs, quietStart: null, quietEnd: null }).quietHours).toBeNull();
    expect(HALF_HOURS).toHaveLength(48);
    expect(HALF_HOURS.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
    expect(prefsInput({ ...prefs, digest: "weekly", digestLocalTime: "07:30" }).digest).toBe("weekly");
  });

  test("digest times: a stored off-grid time is kept, and times inside quiet hours are disabled", () => {
    const options = digestTimeOptions("08:10", "22:00", "07:30");
    expect(options.find((option) => option.value === "08:10")).toEqual({ value: "08:10", label: "08:10", disabled: false });
    expect(options.find((option) => option.value === "23:00")!.disabled).toBe(true);
    expect(options.find((option) => option.value === "07:30")!.disabled).toBe(false);
    expect(options).toHaveLength(49);
    expect(digestNote({ digest: "off", nextDigestAt: null, tz: "UTC" })).not.toContain("Next:");
    expect(digestNote({ digest: "daily", nextDigestAt: "2026-09-29T08:00:00.000Z", tz: "UTC" })).toContain("Next:");
  });
});

describe("the bounced notice (Wave 29)", () => {
  test("says why mail stopped, and that security email still goes", () => {
    const address = "person@example.test";
    expect(suppressionCopy({ address, suppression: { reason: "bounce", since: "2026-09-28T00:00:00.000Z", until: null } })).toContain("bounced");
    expect(suppressionCopy({ address, suppression: { reason: "complaint", since: "2026-09-28T00:00:00.000Z", until: null } })).toContain("reported as spam");
    const soft = suppressionCopy({ address, suppression: { reason: "soft", since: "2026-09-28T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" } });
    expect(soft).toContain("paused it until");
    for (const reason of ["bounce", "complaint", "soft"] as const) expect(suppressionCopy({ address, suppression: { reason, since: "x", until: null } })).toContain("Security emails still go");
  });
});
