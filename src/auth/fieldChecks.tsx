import { useCallback, useState } from "react";

/**
 * The app's own checks for the sign-in, register, invite, change-password, and reset-password forms
 * (v0.13.0 QA, A4). Those forms set `noValidate`, so the browser never shows its own validation
 * bubble; each problem is shown under its field in the app's error style instead, and a server
 * error is cleared as soon as the form changes or is sent again. The server still checks everything.
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export type FieldErrors = Record<string, string>;

export function emailProblem(value: string) {
  const email = value.trim();
  if (!email) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

/** A new password: the server's length rule (12 to 256 characters). */
export function newPasswordProblem(value: string) {
  if (value.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (value.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function confirmPasswordProblem(password: string, confirmation: string) {
  if (!confirmation) return "Enter the new password again.";
  return password === confirmation ? null : "The two passwords do not match.";
}

/** The second-factor field: six digits, or one complete recovery code. */
export function secondFactorProblem(value: string, recovery: boolean) {
  const code = value.trim();
  if (recovery) return code.length >= 10 ? null : "Enter one complete recovery code.";
  return /^\d{6}$/.test(code) ? null : "Enter the six-digit code from your app.";
}

/** Only the fields that have a problem. */
export function collectProblems(checks: Record<string, string | null>): FieldErrors {
  const problems: FieldErrors = {};
  for (const [name, problem] of Object.entries(checks)) if (problem) problems[name] = problem;
  return problems;
}

/**
 * Field errors for one form. `show` sets them and focuses the first field that has one (true when
 * there were any); `clear` drops one field's error (or all of them) as the person edits.
 */
export function useFieldErrors() {
  const [errors, setErrors] = useState<FieldErrors>({});
  const show = useCallback((form: HTMLFormElement, problems: FieldErrors) => {
    setErrors(problems);
    const first = Object.keys(problems)[0];
    if (!first) return false;
    const field = form.elements.namedItem(first);
    if (field instanceof HTMLElement) field.focus();
    return true;
  }, []);
  const clear = useCallback((name?: string) => {
    setErrors((current) => {
      if (name === undefined) return Object.keys(current).length ? {} : current;
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }, []);
  return { errors, show, clear };
}

/** The name of the field an input or change event came from. */
export function fieldName(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.name : undefined;
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <small id={id} className="form-error field-error" role="alert">{message}</small> : null;
}

export const CONFIRM_PASSWORD_TEXT = "Enter your password to confirm.";
export const SIX_DIGIT_CODE_TEXT = "Enter the six-digit code from your authenticator app.";
export const RECOVERY_CODE_TEXT = "Enter one complete recovery code.";

/**
 * The Security forms' own check (2026-10-13; they set `noValidate` like the API key forms): the
 * first missing or malformed field of a form, with what to say. Only the fields the form shows are
 * checked; a field the form does not have is absent from `form`.
 */
export function securityFormProblem(form: HTMLFormElement | FormData): { field: string; message: string } | null {
  const data = form instanceof FormData ? form : new FormData(form);
  const value = (name: string) => { const raw = data.get(name); return raw === null ? null : String(raw); };
  const password = value("password");
  if (password !== null && !password) return { field: "password", message: CONFIRM_PASSWORD_TEXT };
  const recovery = value("recoveryCode");
  if (recovery !== null && recovery.trim().length < 10) return { field: "recoveryCode", message: RECOVERY_CODE_TEXT };
  const code = value("code");
  if (code !== null && !/^\d{6}$/.test(code.trim())) return { field: "code", message: SIX_DIGIT_CODE_TEXT };
  return null;
}
