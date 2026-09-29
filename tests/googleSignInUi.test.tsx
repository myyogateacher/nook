import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, avatarInitial, AvatarView } from "../src/ui/Avatar";
import { currentReturnPath, GoogleButton, googleErrorMessage, googleStartUrl, takeGoogleSettingsResult, takeGoogleSignInResult } from "../src/auth/googleSignIn";
import { asksForPassword, googleConfirmed, GoogleReauthNotice, reauthPassword, type AccountAuth } from "../src/auth/accountAuth";
import { googleSettingsNotice, PasswordStateCard } from "../src/auth/GoogleAccountCard";

/**
 * Wave 35 client pieces: the shared Avatar (D299), the Google sign-in helpers and button (D300), and
 * the re-authentication and Settings states (D297). Rendered without a DOM, like the other UI tests.
 */

const src = join(import.meta.dir, "..", "src");

/** Finds the first element of `type` in a rendered element tree. */
function findElement(node: unknown, type: string): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return Array.isArray(node) ? node.map((child) => findElement(child, type)).find(Boolean) ?? null : null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  return findElement(element.props.children, type);
}

describe("the shared Avatar (D299)", () => {
  test("shows the picture when there is a URL, and the letter otherwise", () => {
    const withImage = renderToStaticMarkup(<Avatar className="team-avatar" name="Asha Rao" url="/api/users/u/avatar?v=1" />);
    expect(withImage).toContain('class="team-avatar avatar-has-image"');
    expect(withImage).toContain('<img src="/api/users/u/avatar?v=1" alt=""');
    expect(withImage).toContain('referrerPolicy="no-referrer"');
    expect(withImage).toContain('aria-hidden="true"');
    expect(withImage).not.toContain(">A<");
    expect(renderToStaticMarkup(<Avatar className="team-avatar" name="asha" url={null} />)).toBe('<span class="team-avatar" aria-hidden="true">A</span>');
    expect(renderToStaticMarkup(<Avatar className="team-avatar" name="  " />)).toBe('<span class="team-avatar" aria-hidden="true">?</span>');
    // A custom fallback (the task cards' two initials) stands in for the letter.
    expect(renderToStaticMarkup(<Avatar className="task-avatar" name="Asha Rao" fallback="AR" />)).toBe('<span class="task-avatar" aria-hidden="true">AR</span>');
    expect(avatarInitial("émile")).toBe("É");
  });

  test("a picture that fails to load falls back to the letters", () => {
    let failed = 0;
    const view = AvatarView({ className: "access-avatar", name: "Bo", url: "/api/users/u/avatar?v=2", failed: false, onError: () => { failed += 1; } });
    const image = findElement(view, "img")!;
    expect(image).not.toBeNull();
    (image.props.onError as () => void)();
    expect(failed).toBe(1);
    expect(renderToStaticMarkup(AvatarView({ className: "access-avatar", name: "Bo", url: "/api/users/u/avatar?v=2", failed: true, onError: () => undefined }))).toBe('<span class="access-avatar" aria-hidden="true">B</span>');
  });

  test("every place that drew a letter avatar uses the component", () => {
    for (const file of ["team/TeamApp.tsx", "access/AccessSheet.tsx", "tasks/CardFace.tsx", "tasks/boardViewParts.tsx"]) {
      const source = readFileSync(join(src, file), "utf8");
      expect({ file, uses: source.includes("<Avatar ") }).toEqual({ file, uses: true });
      expect({ file, letter: /charAt\(0\)|\{initials\([^)]*\)\}<\/span>|\{initialOf\(/.test(source) }).toEqual({ file, letter: false });
    }
  });
});

describe("Google sign-in helpers (D300)", () => {
  test("the start URL and the return path", () => {
    expect(googleStartUrl("signin", "/")).toBe("/api/auth/google/start");
    expect(googleStartUrl("signin", "/tasks/my?q=x")).toBe("/api/auth/google/start?return=%2Ftasks%2Fmy%3Fq%3Dx");
    expect(googleStartUrl("reauth", "/settings/mcp")).toBe("/api/auth/google/start?intent=reauth&return=%2Fsettings%2Fmcp");
    expect(currentReturnPath({ pathname: "/notes/abc", search: "?x=1" })).toBe("/notes/abc?x=1");
    for (const pathname of ["/login", "/register", "/forgot-password", "/reset-password"]) expect(currentReturnPath({ pathname, search: "" })).toBe("/");
    expect(currentReturnPath({ pathname: "//evil.test", search: "" })).toBe("/");
  });

  test("results are read once from the fragment and stripped from the address bar", () => {
    const calls: unknown[][] = [];
    const history = { state: { depth: 3 }, replaceState: (...args: unknown[]) => { calls.push(args); } };
    expect(takeGoogleSignInResult({ pathname: "/login", hash: "#error=signup_closed" }, history)).toEqual({ kind: "error", code: "signup_closed" });
    expect(calls.at(-1)).toEqual([null, "", "/"]);
    expect(takeGoogleSignInResult({ pathname: "/login", hash: "#google=code" }, history)).toEqual({ kind: "code" });
    expect(takeGoogleSignInResult({ pathname: "/login", hash: "#error=<script>" }, history)).toBeNull();
    expect(takeGoogleSignInResult({ pathname: "/notes", hash: "#error=x" }, history)).toBeNull();
    expect(takeGoogleSettingsResult({ pathname: "/settings/security", search: "", hash: "#google=linked" }, history)).toEqual({ kind: "linked" });
    expect(calls.at(-1)).toEqual([{ depth: 3 }, "", "/settings/security"]);
    expect(takeGoogleSettingsResult({ pathname: "/settings/mcp", search: "", hash: "#google-error=reauth_mismatch" }, history)).toEqual({ kind: "error", code: "reauth_mismatch" });
    expect(takeGoogleSettingsResult({ pathname: "/settings/mcp", search: "", hash: "#other=1" }, history)).toBeNull();
  });

  test("every server error code has its own message; unknown codes read as a failure", () => {
    for (const code of ["denied", "expired", "failed", "unverified", "not_allowed", "signup_closed", "blocked", "invite_invalid", "invite_expired", "invite_mismatch", "already_linked", "link_mismatch", "reauth_mismatch", "rate_limited"]) {
      expect(googleErrorMessage(code).length).toBeGreaterThan(10);
    }
    expect(googleErrorMessage("something_new")).toBe(googleErrorMessage("failed"));
    expect(googleSettingsNotice({ kind: "reauthed" })?.tone).toBe("ok");
    expect(googleSettingsNotice({ kind: "error", code: "link_mismatch" })).toEqual({ tone: "error", text: googleErrorMessage("link_mismatch") });
  });

  test("the button is a same-origin link with the inline mark: no Google script, image, or font", () => {
    const html = renderToStaticMarkup(<GoogleButton href="/api/auth/google/start" />);
    expect(html).toContain('href="/api/auth/google/start"');
    expect(html).toContain("<svg");
    expect(html).toContain("Continue with Google");
    for (const file of ["auth/googleSignIn.tsx", "auth/accountAuth.tsx", "auth/GoogleAccountCard.tsx", "auth/InviteRegister.tsx", "App.tsx"]) {
      const source = readFileSync(join(src, file), "utf8");
      expect({ file, remote: /accounts\.google\.com|gstatic|googleapis|googleusercontent|gsi\/client/.test(source) }).toEqual({ file, remote: false });
    }
    const css = readFileSync(join(src, "auth", "auth.css"), "utf8");
    expect(css).toMatch(/\.google-button \{[^}]*min-height: 44px/);
  });
});

describe("re-authentication and Settings states (D297)", () => {
  const account = (overrides: Partial<AccountAuth> = {}): AccountAuth => ({ methods: { password: true, google: true }, hasPassword: false, google: { email: "g@nook.test" }, reauth: "google", reauthUntil: null, passwordReset: true, ...overrides });

  test("which proof a prompt asks for, and the body it sends", () => {
    expect(asksForPassword(null)).toBe(true);
    expect(asksForPassword(account({ reauth: "password" }))).toBe(true);
    expect(asksForPassword(account())).toBe(false);
    expect(reauthPassword("secret")).toEqual({ password: "secret" });
    expect(reauthPassword("")).toEqual({});
    expect(reauthPassword(null)).toEqual({});
    expect(googleConfirmed(account({ reauthUntil: new Date(Date.now() + 60_000).toISOString() }))).toBe(true);
    expect(googleConfirmed(account({ reauthUntil: new Date(Date.now() - 1).toISOString() }))).toBe(false);
  });

  test("the Google confirmation notice", () => {
    const pending = renderToStaticMarkup(<GoogleReauthNotice account={account()} returnTo="/settings/mcp" />);
    expect(pending).toContain('href="/api/auth/google/start?intent=reauth&amp;return=%2Fsettings%2Fmcp"');
    expect(pending).toContain("Confirm with Google");
    expect(renderToStaticMarkup(<GoogleReauthNotice account={account({ reauthUntil: new Date(Date.now() + 60_000).toISOString() })} returnTo="/" />)).toContain("Confirmed with Google until");
    expect(renderToStaticMarkup(<GoogleReauthNotice account={account({ reauth: "none", google: null })} returnTo="/" />)).toContain("cannot confirm changes here");
  });

  test("the password card explains instead of offering a form that cannot work", () => {
    expect(renderToStaticMarkup(<PasswordStateCard account={account()} />)).toContain("Forgot password?");
    expect(renderToStaticMarkup(<PasswordStateCard account={account({ passwordReset: false })} />)).toContain("Email is not set up");
    expect(renderToStaticMarkup(<PasswordStateCard account={account({ methods: { password: false, google: true } })} />)).toContain("Google only");
  });

  test("no native select, confirm, alert, or prompt in the new client code (D91)", () => {
    for (const file of ["auth/googleSignIn.tsx", "auth/accountAuth.tsx", "auth/GoogleAccountCard.tsx", "ui/Avatar.tsx"]) {
      const source = readFileSync(join(src, file), "utf8");
      expect({ file, native: /<select|window\.(confirm|alert|prompt)\(/.test(source) }).toEqual({ file, native: false });
    }
  });
});
