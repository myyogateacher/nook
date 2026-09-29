import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangePasswordCard } from "../src/auth/ChangePassword";
import { collectProblems, confirmPasswordProblem, emailProblem, newPasswordProblem, secondFactorProblem } from "../src/auth/fieldChecks";
import { PasswordInput, ResetPasswordPage, SecondFactorField } from "../src/auth/passwordPages";

// v0.13.0 QA, A4: the password and register forms check their fields themselves and show the
// problem under the field, never as the browser's validation bubble.

test("the field checks match the server's rules", () => {
  expect(emailProblem("")).toBe("Enter your email address.");
  expect(emailProblem("  nobody ")).toBe("Enter a valid email address.");
  expect(emailProblem(" fxa-1@nook.test ")).toBeNull();
  expect(newPasswordProblem("short1")).toBe("Use at least 12 characters.");
  expect(newPasswordProblem("x".repeat(12))).toBeNull();
  expect(newPasswordProblem("x".repeat(257))).toBe("Use at most 256 characters.");
  expect(confirmPasswordProblem("a".repeat(12), "")).toBe("Enter the new password again.");
  expect(confirmPasswordProblem("a".repeat(12), "b".repeat(12))).toBe("The two passwords do not match.");
  expect(confirmPasswordProblem("a".repeat(12), "a".repeat(12))).toBeNull();
  expect(secondFactorProblem("12345", false)).toBe("Enter the six-digit code from your app.");
  expect(secondFactorProblem(" 123456 ", false)).toBeNull();
  expect(secondFactorProblem("ABCDE", true)).toBe("Enter one complete recovery code.");
  expect(secondFactorProblem("ABCDE-FGHIJ-KLMNO", true)).toBeNull();
  expect(collectProblems({ a: null, b: "B", c: "C" })).toEqual({ b: "B", c: "C" });
});

test("password fields have no native constraints and show their error inline", () => {
  const plain = renderToStaticMarkup(<PasswordInput name="newPassword" label="New password" autoComplete="new-password" />);
  expect(plain).not.toContain("required");
  expect(plain).not.toContain("minlength");
  expect(plain).not.toContain("aria-invalid");
  const invalid = renderToStaticMarkup(<PasswordInput name="newPassword" label="New password" autoComplete="new-password" error="Use at least 12 characters." />);
  expect(invalid).toContain('aria-invalid="true"');
  expect(invalid).toContain('class="form-error field-error"');
  expect(invalid).toContain("Use at least 12 characters.");
  const code = renderToStaticMarkup(<SecondFactorField recovery={false} onToggle={() => undefined} error="Enter the six-digit code from your app." />);
  expect(code).not.toContain("pattern=");
  expect(code).not.toContain("required");
  expect(code).toContain("Enter the six-digit code from your app.");
});

test("the change-password, reset, sign-in, register, and invite forms set noValidate", async () => {
  // The change form only renders when opened; its source is checked instead.
  const change = await Bun.file(new URL("../src/auth/ChangePassword.tsx", import.meta.url)).text();
  expect(change).toContain("onSubmit={submit} noValidate onChange={(event) => { setError(\"\"); fields.clear(fieldName(event.target)); }}");
  expect(renderToStaticMarkup(<ChangePasswordCard totpEnabled={false} />)).not.toContain("<form");
  const pages = await Bun.file(new URL("../src/auth/passwordPages.tsx", import.meta.url)).text();
  expect(pages.match(/<form className="auth-form" onSubmit={submit} noValidate/g)).toHaveLength(2);
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  expect(app).toContain('<form onSubmit={submit} className="auth-form" noValidate');
  expect(app).not.toMatch(/id="auth-password"[^>]*\b(required|minLength)\b/);
  const invite = await Bun.file(new URL("../src/auth/InviteRegister.tsx", import.meta.url)).text();
  expect(invite).toContain('<form onSubmit={submit} className="auth-form" noValidate');
  expect(invite).not.toContain("minLength={12}");
  // The reset page's dead state renders without a form (nothing to validate).
  expect(renderToStaticMarkup(<ResetPasswordPage token={null} onSignIn={() => undefined} onForgot={() => undefined} />)).not.toContain("<form");
});
