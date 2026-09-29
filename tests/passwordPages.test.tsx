import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRoute } from "../src/router";
import { ChangePasswordCard, passwordChangedText } from "../src/auth/ChangePassword";
import { FORGOT_OFF_TEXT, FORGOT_SENT_TEXT, ForgotPasswordPage, ResetPasswordPage, secondFactorBody, takeNewResetLink, takePasswordLinkFromLocation } from "../src/auth/passwordPages";

/** Client pieces of Wave 30: the forgot / reset pages, the Settings card, and their wiring. */

const history = () => {
  const calls: string[] = [];
  return { calls, value: { state: { keep: 1 }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { calls.push(String(url)); } } };
};

describe("password links", () => {
  test("the reset token is read from the fragment and stripped at once (T220)", () => {
    const token = "r".repeat(43);
    const { calls, value } = history();
    expect(takePasswordLinkFromLocation({ pathname: "/reset-password", hash: `#token=${token}` }, value)).toEqual({ kind: "reset", token });
    expect(calls).toEqual(["/reset-password"]);
  });

  test("a malformed token is dropped (and still stripped); /forgot-password needs no token; other paths are not password pages", () => {
    const { calls, value } = history();
    expect(takePasswordLinkFromLocation({ pathname: "/reset-password/", hash: "#token=short" }, value)).toEqual({ kind: "reset", token: null });
    expect(calls).toEqual(["/reset-password"]);
    expect(takePasswordLinkFromLocation({ pathname: "/forgot-password", hash: "" }, value)).toEqual({ kind: "forgot" });
    expect(takePasswordLinkFromLocation({ pathname: "/verify-email", hash: "#token=x" }, value)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("a second reset link pasted into the same tab is read and stripped; other moves are left alone (A5)", async () => {
    const token = "s".repeat(43);
    const { calls, value } = history();
    expect(takeNewResetLink({ pathname: "/reset-password", hash: `#token=${token}` }, value)).toEqual({ kind: "reset", token });
    expect(calls).toEqual(["/reset-password"]);
    // The stripped entry (no fragment), another page, or a fragment elsewhere: nothing to take.
    expect(takeNewResetLink({ pathname: "/reset-password", hash: "" }, value)).toBeNull();
    expect(takeNewResetLink({ pathname: "/", hash: `#token=${token}` }, value)).toBeNull();
    expect(calls).toHaveLength(1);
    // App listens for both popstate and hashchange, before its route handlers, and remounts the
    // reset page per token so the new one is checked.
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    expect(app).toContain('window.addEventListener("hashchange", onMove);');
    expect(app).toContain("<ResetPasswordPage key={passwordLink.token ?? \"\"}");
    expect(app.match(/if \(resetLinkEvents\.has\(event\)\) return;/g)).toHaveLength(2);
  });

  test("both paths fall back to Home in the app router (no app of their own)", () => {
    expect(parseRoute("/forgot-password")).toEqual({ app: "home" });
    expect(parseRoute("/reset-password")).toEqual({ app: "home" });
  });
});

describe("forgot page (T224)", () => {
  test("neutral copy: the same line for every address, and email off points at an admin", () => {
    expect(FORGOT_SENT_TEXT).toBe("If that address has a verified account, we sent a link. It works for 30 minutes.");
    expect(FORGOT_OFF_TEXT).toContain("Ask an admin");
    const markup = renderToStaticMarkup(<ForgotPasswordPage onBack={() => undefined} />);
    expect(markup).toContain("Send reset link");
    expect(markup).toContain('type="email"');
    expect(markup).toContain("Back to sign in");
    expect(markup).not.toMatch(/no account|not found|doesn.t exist/i);
  });
});

describe("reset page", () => {
  test("without a token it says the link is not valid and offers a new one", () => {
    const markup = renderToStaticMarkup(<ResetPasswordPage token={null} onSignIn={() => undefined} onForgot={() => undefined} />);
    expect(markup).toContain("This link is not valid");
    expect(markup).toContain("Ask for a new link");
  });

  test("signed in on this browser, a dead link offers Open Nook instead of the forgot page", () => {
    const markup = renderToStaticMarkup(<ResetPasswordPage token={null} signedIn onSignIn={() => undefined} onForgot={() => undefined} />);
    expect(markup).toContain("Open Nook");
    expect(markup).not.toContain("Ask for a new link");
    expect(markup).not.toContain("Back to sign in");
  });

  test("with a token it checks first, before any form", () => {
    const markup = renderToStaticMarkup(<ResetPasswordPage token={"t".repeat(43)} onSignIn={() => undefined} onForgot={() => undefined} />);
    expect(markup).toContain("Checking your link");
    expect(markup).not.toContain("<form");
  });

  test("the second factor goes in the body only when needed", () => {
    const form = new FormData();
    form.set("totpCode", " 123456 ");
    form.set("recoveryCode", "ABCDE-FGHIJ");
    expect(secondFactorBody(form, false, false)).toEqual({});
    expect(secondFactorBody(form, true, false)).toEqual({ totpCode: "123456" });
    expect(secondFactorBody(form, true, true)).toEqual({ recoveryCode: "ABCDE-FGHIJ" });
  });
});

describe("Settings → Security → Password", () => {
  test("a closed card with a Change password button", () => {
    const markup = renderToStaticMarkup(<ChangePasswordCard totpEnabled={false} />);
    expect(markup).toContain("Change password");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("<form");
  });

  test("the done line counts the other sessions", () => {
    expect(passwordChangedText(0)).toBe("Password changed. No other devices were signed in.");
    expect(passwordChangedText(1)).toBe("Password changed. 1 other session was signed out.");
    expect(passwordChangedText(3)).toBe("Password changed. 3 other sessions were signed out.");
  });
});

describe("wiring", () => {
  test("the sign-in form links to /forgot-password; Settings shows the card; signed-out Back/Forward is handled", async () => {
    const source = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    expect(source).toContain('href={FORGOT_PATH} onClick={(event) => { event.preventDefault(); onForgotPassword(); }}>Forgot password?</a>');
    expect(source).toContain("<ChangePasswordCard totpEnabled={state.enabled} />");
    expect(source).toContain('window.history.pushState({ nookPasswordPage: "forgot" }, "", FORGOT_PATH)');
    expect(source).toMatch(/if \(session\) return;\n\s+const onPopState = \(event: PopStateEvent\) => \{\n\s+if \(resetLinkEvents\.has\(event\)\) return;\n\s+const link = takePasswordLinkFromLocation\(\);/);
    // Signed in, a Back onto an old /forgot-password entry shows the app, not the signed-out page (QA).
    expect(source).toContain('if (passwordLink?.kind === "forgot" && !session) return <ForgotPasswordPage');
  });

  test("the pages put the previous tab title back when they close (QA)", async () => {
    const source = await Bun.file(new URL("../src/auth/passwordPages.tsx", import.meta.url)).text();
    expect(source).toContain('useEffect(() => pageTitle("Forgot password · Nook"), []);');
    expect(source).toContain('useEffect(() => pageTitle("Reset password · Nook"), []);');
  });

  test("links and switches on the password pages are 44 px targets", async () => {
    const css = await Bun.file(new URL("../src/auth/auth.css", import.meta.url)).text();
    expect(css).toContain(".password-card .text-button, .password-card .inline-auth-switch { min-height: 44px; }");
    expect(css).toContain(".inline-auth-switch { min-height: 44px; }");
    expect(css).toContain(".password-change-summary .secondary-button { min-height: 44px;");
  });
});
