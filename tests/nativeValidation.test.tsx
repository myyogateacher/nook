import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CONFIRM_PASSWORD_TEXT, RECOVERY_CODE_TEXT, securityFormProblem, SIX_DIGIT_CODE_TEXT } from "../src/auth/fieldChecks";
import { routineProblem } from "../src/inbox/RoutinesPane";
import { FormError } from "../src/ui/FormError";

// 2026-10-13: no form in the app shows the browser's "Please fill in this field" bubble. Every form
// sets noValidate and says what is missing itself, in an alert that is scrolled into view.

const SRC = join(import.meta.dir, "..", "src");
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : path.endsWith(".tsx") ? [path] : [];
});

/** Each `<form …>` opening tag in a source, with JSX braces (arrow functions' `=>`) skipped. */
function formTags(text: string) {
  const tags: { line: number; tag: string }[] = [];
  const opening = /<form[\s>]/g;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    let depth = 0;
    let end = match.index;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) break;
    }
    tags.push({ line: text.slice(0, match.index).split("\n").length, tag: text.slice(match.index, end + 1) });
  }
  return tags;
}

test("every <form> in src/ sets noValidate, so none shows a native validation bubble", () => {
  const missing: string[] = [];
  let forms = 0;
  for (const file of sources(SRC)) {
    for (const { line, tag } of formTags(readFileSync(file, "utf8"))) {
      forms += 1;
      if (!/\bnoValidate\b/.test(tag)) missing.push(`${relative(SRC, file)}:${line}`);
    }
  }
  expect(forms).toBeGreaterThan(50);
  expect(missing).toEqual([]);
});

test("the scanner sees past arrow functions in a form's attributes", () => {
  expect(formTags(`<form className="x" onSubmit={(event) => { event.preventDefault(); }} noValidate>`)[0]!.tag).toContain("noValidate");
  expect(formTags(`<form onSubmit={(event) => submit(event)}>`)[0]!.tag).not.toContain("noValidate");
});

test("the Security forms are noValidate and carry no native constraints", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  const security = app.slice(app.indexOf("const securitySection ="), app.indexOf("const content = route.app ==="));
  expect(security.length).toBeGreaterThan(1000);
  for (const name of ["view-recovery-form", "disable-totp-form", "setup-intro\" onSubmit", "verify-totp-form"]) expect(security).toContain(name);
  expect(security).not.toMatch(/["}]\s+required\b/);
  expect(security).not.toContain("pattern=");
  const fields = app.slice(app.indexOf("const reauthField ="), app.indexOf("const codeBody ="));
  expect(fields).not.toMatch(/["}]\s+required\b/);
  expect(fields).not.toContain("pattern=");
  expect(fields).toContain('aria-required="true"');
});

const formData = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

test("the Security forms' own check says what is missing, the way the API key forms do", () => {
  expect(CONFIRM_PASSWORD_TEXT).toBe("Enter your password to confirm.");
  expect(SIX_DIGIT_CODE_TEXT).toBe("Enter the six-digit code from your authenticator app.");
  expect(securityFormProblem(formData({ password: "", code: "" }))).toEqual({ field: "password", message: CONFIRM_PASSWORD_TEXT });
  expect(securityFormProblem(formData({ password: "a long password", code: "12a456" }))).toEqual({ field: "code", message: SIX_DIGIT_CODE_TEXT });
  expect(securityFormProblem(formData({ password: "a long password", code: " 123456 " }))).toBeNull();
  // The Google route has no password field: only the code is checked.
  expect(securityFormProblem(formData({ code: "12345" }))).toEqual({ field: "code", message: SIX_DIGIT_CODE_TEXT });
  expect(securityFormProblem(formData({ recoveryCode: "ABCDE" }))).toEqual({ field: "recoveryCode", message: RECOVERY_CODE_TEXT });
  expect(securityFormProblem(formData({ recoveryCode: "ABCDE-FGHIJ" }))).toBeNull();
  expect(securityFormProblem(formData({}))).toBeNull();
});

test("the routine form checks its own fields", () => {
  const form = { name: "Weekly review", instructions: "Tidy the board", outputKinds: ["card_create" as const], cadence: "daily" as const, time: "08:00", maxProposals: "25", expireDays: "14" };
  expect(routineProblem(form)).toBeNull();
  expect(routineProblem({ ...form, name: "  " })?.field).toBe("name");
  expect(routineProblem({ ...form, instructions: "" })?.field).toBe("instructions");
  expect(routineProblem({ ...form, outputKinds: [] })?.message).toBe("Choose at least one kind of change.");
  expect(routineProblem({ ...form, time: "" })?.field).toBe("time");
  expect(routineProblem({ ...form, cadence: "manual", time: "" })).toBeNull();
  expect(routineProblem({ ...form, maxProposals: "0" })?.field).toBe("maxProposals");
  expect(routineProblem({ ...form, maxProposals: "101" })?.field).toBe("maxProposals");
  expect(routineProblem({ ...form, expireDays: "2.5" })?.field).toBe("expireDays");
});

test("a form's error line is an alert", () => {
  expect(renderToStaticMarkup(<FormError message="Enter your password to confirm." id="security-error-disable" />)).toBe('<p id="security-error-disable" class="form-error" role="alert">Enter your password to confirm.</p>');
  expect(renderToStaticMarkup(<FormError message="" />)).toBe("");
  expect(renderToStaticMarkup(<FormError message="Nope" className="file-dialog-error" />)).toContain('class="file-dialog-error" role="alert"');
});
