/**
 * The confirm dialogs' fields under the 2026-10-12 rule (THREAT_MODEL MEDIUM-3): Google first for an
 * account with Google linked, "Use password instead" when it has one, and the code only on the
 * password route or for the actions that change the factors.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { asksForCode, passwordAlternative, type AccountAuth } from "../src/auth/accountAuth";
import { reauthBody, ReauthFields, reauthProblems } from "../src/auth/GoogleAccountCard";
import { googleErrorMessage } from "../src/auth/googleSignIn";
import { ChangePasswordCard } from "../src/auth/ChangePassword";

const later = new Date(Date.now() + 4 * 60_000).toISOString();
const account = (extra: Partial<AccountAuth>): AccountAuth => ({ methods: { password: true, google: true }, hasPassword: false, google: { email: "greauth-01@nook.test" }, reauth: "google", reauthUntil: null, passwordReset: false, ...extra });
const fields = (props: Partial<Parameters<typeof ReauthFields>[0]> & { account: AccountAuth }) =>
  renderToStaticMarkup(<ReauthFields totpEnabled={false} errors={{}} idPrefix="t" returnTo="/settings/keys" disabled={false} {...props} />);

describe("confirm fields (2026-10-12)", () => {
  test("Google only, two-factor on: Google alone for keys and the vault, the code too for factor changes", () => {
    const google = account({});
    const plain = fields({ account: google, totpEnabled: true });
    expect(plain).toContain("Confirm with Google");
    expect(plain).not.toContain('name="password"');
    expect(plain).not.toContain('name="totpCode"');
    expect(plain).not.toContain("Use password instead");
    const factor = fields({ account: google, totpEnabled: true, secondFactor: true });
    expect(factor).toContain('name="totpCode"');
    expect(factor).toContain("Use a recovery code");
  });

  test("password and Google: Google first with Use password instead", () => {
    const both = account({ hasPassword: true });
    expect(passwordAlternative(both)).toBe(true);
    const markup = fields({ account: both });
    expect(markup).toContain("Use password instead");
    expect(markup).not.toContain('name="password"');
  });

  test("password only: unchanged (password, plus the code with two-factor on)", () => {
    const password = account({ reauth: "password", hasPassword: true, google: null });
    const markup = fields({ account: password, totpEnabled: true });
    expect(markup).toContain('name="password"');
    expect(markup).toContain('name="totpCode"');
    expect(markup).not.toContain("Use password instead");
    expect(asksForCode(true, true)).toBe(true);
    expect(asksForCode(true, false)).toBe(false);
    expect(asksForCode(true, false, true)).toBe(true);
    expect(asksForCode(false, true, true)).toBe(false);
  });

  test("confirmed shows until when; expired offers Confirm with Google again", () => {
    expect(fields({ account: account({ reauthUntil: later }) })).toContain("Confirmed with Google until");
    const again = fields({ account: account({ reauthUntil: later }), expired: true });
    expect(again).toContain("Confirm with Google again");
    expect(again).toContain("ran out");
  });

  test("the body and checks follow the fields on screen", () => {
    const form = new FormData();
    expect(reauthBody(form)).toEqual({});
    form.set("recoveryCode", " ABCDE-FGHIJ ");
    expect(reauthBody(form)).toEqual({ recoveryCode: "ABCDE-FGHIJ" });
    const empty = new FormData();
    empty.set("password", "");
    empty.set("totpCode", "12");
    expect(Object.keys(reauthProblems(empty)).sort()).toEqual(["password", "totpCode"]);
  });

  test("no dead-end copy: the old reauth_stale code tells the user what to do", () => {
    const text = googleErrorMessage("reauth_stale");
    expect(text).toContain("Confirm with Google again");
    expect(text).not.toContain("does not count");
  });

  test("a Google account with no password sets one from Settings", () => {
    expect(renderToStaticMarkup(<ChangePasswordCard totpEnabled={false} account={account({})} />)).toContain("Set password");
  });
});
