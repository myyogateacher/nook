import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, avatarInitial, AvatarView, isAvatarPath } from "../src/ui/Avatar";
import { currentReturnPath, GOOGLE_ONLY_HINT, GOOGLE_ONLY_PASSWORD_TEXT, GoogleButton, googleErrorMessage, googleStartUrl, linkRequiredText, takeGoogleSettingsResult, takeGoogleSignInResult } from "../src/auth/googleSignIn";
import { resetLines } from "../src/team/TeamGoogle";
import { draftFrom } from "../src/access/accessModel";
import { takeInviteFromLocation } from "../src/auth/inviteLink";
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
    const withImage = renderToStaticMarkup(<Avatar className="team-avatar" name="Asha Rao" url="/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000" />);
    expect(withImage).toContain('class="team-avatar avatar-has-image"');
    expect(withImage).toContain('<img src="/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000" alt=""');
    expect(withImage).toContain('referrerPolicy="no-referrer"');
    expect(withImage).toContain('aria-hidden="true"');
    expect(withImage).not.toContain(">A<");
    expect(renderToStaticMarkup(<Avatar className="team-avatar" name="asha" url={null} />)).toBe('<span class="team-avatar" aria-hidden="true">A</span>');
    expect(renderToStaticMarkup(<Avatar className="team-avatar" name="  " />)).toBe('<span class="team-avatar" aria-hidden="true">?</span>');
    // A custom fallback (the task cards' two initials) stands in for the letter.
    expect(renderToStaticMarkup(<Avatar className="task-avatar" name="Asha Rao" fallback="AR" />)).toBe('<span class="task-avatar" aria-hidden="true">AR</span>');
    expect(avatarInitial("émile")).toBe("É");
  });

  test("only Nook's own avatar route is loaded; anything else shows the letters (L10)", () => {
    expect(isAvatarPath("/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000")).toBe(true);
    for (const url of ["https://lh3.googleusercontent.com/a/x", "//evil.test/api/users/x/avatar?v=y", "javascript:alert(1)", "data:image/png;base64,AAAA", "/api/files/abc", "/api/users/x/avatar?v=y", "/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000&x=1", "", null, undefined]) {
      expect({ url, image: isAvatarPath(url) }).toEqual({ url, image: false });
      expect(renderToStaticMarkup(<Avatar className="team-avatar" name="Zed" url={url} />)).toBe('<span class="team-avatar" aria-hidden="true">Z</span>');
    }
  });

  test("a picture that fails to load falls back to the letters", () => {
    let failed = 0;
    const view = AvatarView({ className: "access-avatar", name: "Bo", url: "/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000", failed: false, onError: () => { failed += 1; } });
    const image = findElement(view, "img")!;
    expect(image).not.toBeNull();
    (image.props.onError as () => void)();
    expect(failed).toBe(1);
    expect(renderToStaticMarkup(AvatarView({ className: "access-avatar", name: "Bo", url: "/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000", failed: true, onError: () => undefined }))).toBe('<span class="access-avatar" aria-hidden="true">B</span>');
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
    for (const code of ["denied", "expired", "failed", "unverified", "not_allowed", "signup_closed", "blocked", "invite_invalid", "invite_expired", "invite_mismatch", "already_linked", "link_mismatch", "reauth_mismatch", "reauth_stale", "link_required", "rate_limited"]) {
      expect(googleErrorMessage(code).length).toBeGreaterThan(10);
    }
    expect(googleErrorMessage("something_new")).toBe(googleErrorMessage("failed"));
    // link_required points at both ways forward while passwords are on, and only at the admin otherwise.
    expect(linkRequiredText(true)).toContain("Settings → Security → Link Google");
    expect(linkRequiredText(true)).toContain("admin");
    expect(linkRequiredText(false)).not.toContain("password");
    expect(linkRequiredText(false)).toContain("admin");
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
    for (const file of ["auth/googleSignIn.tsx", "auth/accountAuth.tsx", "auth/GoogleAccountCard.tsx", "ui/Avatar.tsx", "team/TeamGoogle.tsx"]) {
      const source = readFileSync(join(src, file), "utf8");
      expect({ file, native: /<select|window\.(confirm|alert|prompt)\(/.test(source) }).toEqual({ file, native: false });
    }
  });
});

describe("Team → Google sign-in and the Settings link dialog (review HIGH-1, L3, L6)", () => {
  test("reset counts read as plain lines, zeros left out", () => {
    const zero = { sessions: 0, keys: 0, feeds: 0, items: 0, shares: 0, groupGrants: 0, invites: 0, routines: 0, password: 0, twoFactor: 0 };
    expect(resetLines(zero)).toEqual(["Nothing to remove: no sessions, keys, sharing, or password."]);
    expect(resetLines({ ...zero, sessions: 1, items: 2, shares: 3, password: 1, twoFactor: 1 })).toEqual(["1 signed-in session ends", "2 shared items become private", "3 people lose access to those items", "The password is removed", "Two-factor authentication is removed"]);
  });

  test("the dialogs are the app's own history layers, and the forms validate inline", () => {
    const team = readFileSync(join(src, "team", "TeamGoogle.tsx"), "utf8");
    expect(team).toContain("<KeysDialog");
    expect(team).toContain("Reset this account first");
    const card = readFileSync(join(src, "auth", "GoogleAccountCard.tsx"), "utf8");
    expect(card).toContain("<KeysDialog");
    expect(card).toContain("noValidate");
    expect(card).toContain('"/auth/google/link"');
    const dialog = readFileSync(join(src, "keys", "KeysDialog.tsx"), "utf8");
    expect(dialog).toContain("useHistoryDialogGuard(");
    const teamApp = readFileSync(join(src, "team", "TeamApp.tsx"), "utf8");
    expect(teamApp).toContain("<TeamGoogleCard");
  });
});

describe("end-user QA fixes (U1–U11)", () => {
  const app = () => readFileSync(join(src, "App.tsx"), "utf8");

  test("U1: the forgot and reset pages say passwords are off in google mode", () => {
    const pages = readFileSync(join(src, "auth", "passwordPages.tsx"), "utf8");
    expect(pages).toContain("setGoogleOnly(info.authMethods?.password === false)");
    expect(pages).toContain('code === "PASSWORD_SIGNIN_DISABLED"');
    expect(GOOGLE_ONLY_PASSWORD_TEXT).toContain("Google only");
  });

  test("U2: sign-in, register, and invite render a placeholder until the methods are known", () => {
    expect(app()).toContain('!methodsKnown ? <div className="auth-methods-placeholder"');
    const invite = readFileSync(join(src, "auth", "InviteRegister.tsx"), "utf8");
    expect(invite).toContain('{!methods && <div className="auth-methods-placeholder"');
    expect(readFileSync(join(src, "auth", "auth.css"), "utf8")).toMatch(/\.auth-methods-placeholder \{ min-height: \d+px; \}/);
  });

  test("U3: Access sheet rows keep the picture from the server", () => {
    const draft = draftFrom({ etag: "x", kind: "board", title: "B", owner: { id: "o", displayName: "O" }, audience: "selected", people: [{ id: "p", displayName: "P", teamRole: "member", kind: "person", level: "view", via: "direct", blocked: false, avatarUrl: "/api/users/3f1c2b1e-1111-4a2b-9c3d-222233334444/avatar?v=8e7d6c5b-5555-4666-8777-888899990000" }], groups: [], levels: ["view"], yourLevel: "owner", shareWithGuests: true, inheritable: false } as never);
    expect(draft.people[0]!.avatarUrl).toContain("/avatar?v=");
  });

  test("U4: the header, sidebar footers, Settings, and comments draw the shared Avatar", () => {
    expect(readFileSync(join(src, "AppShell.tsx"), "utf8")).toContain('<Avatar className="app-user-avatar"');
    expect(app()).toContain('className="app-user-avatar settings-avatar"');
    expect(app()).toContain('<strong className="footer-identity"><Avatar');
    expect(readFileSync(join(src, "files", "FilesApp.tsx"), "utf8")).toContain('<strong className="footer-identity"><Avatar');
    expect(readFileSync(join(src, "tasks", "CardDialog.tsx"), "utf8")).toContain("url={comment.author_avatar_url}");
    expect(readFileSync(join(src, "appShell.css"), "utf8")).toMatch(/@media \(max-width: 760px\) \{\s*\.app-home-user \{ display: inline-flex;/);
  });

  test("U5–U7: the Google-only hint, Google messages beside the button, and a way out of the code step", () => {
    expect(GOOGLE_ONLY_HINT).toBe("This Nook signs people in with Google. Use the Google account with your Nook email address. If that does not work, ask your admin.");
    expect(app()).toContain('<p className="auth-google-only">{GOOGLE_ONLY_HINT}</p>');
    expect(app()).toContain('<div className="auth-google-notice" role="alert">');
    expect(app()).toContain("Cancel and use another account");
    expect(app()).toContain('api("/auth/google/cancel"');
  });

  test("U8: an invite page reached back from Google reads the invite from the server, not a URL", () => {
    const invite = readFileSync(join(src, "auth", "InviteRegister.tsx"), "utf8");
    expect(invite).toContain('api<InvitePreview>("/auth/google/invite")');
    const history = { state: null, replaceState: () => undefined };
    expect(takeInviteFromLocation({ pathname: "/register", hash: "#google-error=invite_mismatch" }, history)).toEqual({ onRegister: true, token: null, googleError: "invite_mismatch" });
  });

  test("U11: Google confirmation happens before New key and Rotate open", () => {
    const keys = readFileSync(join(src, "keys", "KeysSettings.tsx"), "utf8");
    expect(keys).toContain("|| needsGoogle}><Plus");
    expect(keys).toContain("onRotate={needsGoogle ? undefined");
    expect(keys).toContain('returnTo="/settings/mcp" startable={false}');
    const account: AccountAuth = { methods: { password: true, google: true }, hasPassword: false, google: { email: "g@nook.test" }, reauth: "google", reauthUntil: null, passwordReset: true };
    expect(renderToStaticMarkup(<GoogleReauthNotice account={account} returnTo="/" startable={false} />)).not.toContain("href=");
  });
});

