import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, parseSettingsPath, settingsPath } from "../src/router";
import { takeMailLinkFromLocation, unsubscribeCategory } from "../src/auth/mailPages";
import { HALF_HOURS, prefsInput, type EmailPrefs } from "../src/notifications/emailApi";

/** Client pieces of Wave 28: routes, mail link pages, and the email settings request body. */

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
});

describe("email settings body", () => {
  const prefs: EmailPrefs = { enabled: true, categories: { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true }, digest: "off", digestLocalTime: "08:00", quietStart: "22:00", quietEnd: "07:30", tz: "Europe/Berlin", revision: 3, updatedAt: null };
  test("keeps the stored zone and quiet hours, and never asks for a digest yet", () => {
    expect(prefsInput(prefs, { enabled: false })).toEqual({ enabled: false, categories: prefs.categories, digest: "off", digestLocalTime: "08:00", quietHours: { start: "22:00", end: "07:30" }, tz: "Europe/Berlin", revision: 3 });
    expect(prefsInput({ ...prefs, quietStart: null, quietEnd: null }).quietHours).toBeNull();
    expect(HALF_HOURS).toHaveLength(48);
    expect(HALF_HOURS.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
  });
});
