import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { request } from "./support/harness";
import { registrationPrompt } from "../src/auth/registrationPrompt";
import { CardTitleField, singleLineTitle } from "../src/tasks/CardTitleField";
import { replacesInvitesRoute } from "../src/team/TeamApp";

const root = join(import.meta.dir, "..", "src");

test("/team/invites is replaced with /team for anyone but admins (QA note 10)", () => {
  expect(replacesInvitesRoute({ userId: null, invites: true }, "member")).toBe(true);
  expect(replacesInvitesRoute({ userId: null, invites: true }, "viewer")).toBe(true);
  expect(replacesInvitesRoute({ userId: null, invites: true }, "admin")).toBe(false);
  expect(replacesInvitesRoute({ userId: null, invites: false }, "member")).toBe(false);
});

test("the card drawer title wraps instead of being cut off (QA note 12)", async () => {
  const markup = renderToStaticMarkup(<CardTitleField id="t" className="task-card-title-input task-card-title-field" value="A long card title" onValueChange={() => undefined} aria-label="Card title" />);
  expect(markup).toMatch(/^<textarea[^>]*rows="1"/);
  expect(markup).toContain('aria-label="Card title"');
  expect(singleLineTitle("one\ntwo\r\nthree")).toBe("one two three");
  const css = await Bun.file(join(root, "tasks", "tasks.css")).text();
  expect(css).toMatch(/\.task-card-title-field \{[^}]*max-height: calc\(2 \* 1\.3em \+ 16px\)/);
  expect(css).toMatch(/\.task-card-title-static \{ display: -webkit-box;[^}]*-webkit-line-clamp: 2; \}/);
});

test("the login screen offers the first account only on a fresh instance (QA note 13)", async () => {
  expect(registrationPrompt({ hasUsers: false, openRegistration: false })).toBe("Setting up Nook? Create the first account");
  expect(registrationPrompt({ hasUsers: true, openRegistration: false })).toBeNull();
  expect(registrationPrompt({ hasUsers: true, openRegistration: true })).toBe("New here? Create an account");
  expect(registrationPrompt(null)).toBeNull();
  expect(registrationPrompt({})).toBeNull();
  // The about endpoint answers yes or no, never a count.
  const about = await (await request("/about")).json() as Record<string, unknown>;
  expect(typeof about.hasUsers).toBe("boolean");
  expect(typeof about.openRegistration).toBe("boolean");
  expect(Object.keys(about).sort()).toEqual(["gitSha", "hasUsers", "openRegistration", "version"]);
});

test("the proposal push switch is named by its visible label (QA note 7)", async () => {
  const source = await Bun.file(join(root, "notifications", "NotificationSettings.tsx")).text();
  expect(source).toContain('<strong id="proposal-push-name">Push new proposals</strong>');
  expect(source).toMatch(/role="switch"[^>]*aria-labelledby="proposal-push-name"/);
});
