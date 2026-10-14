import { expect, test } from "bun:test";
import { PROBE_TIMEOUT_MS, runProbe } from "./support/probe";

test("AUTH_METHODS=google on an empty closed instance: the first Google account is the admin, the next is refused, passwords are off", () => {
  const probed = runProbe("googleProbe.ts");
  const result = probed;
  expect(result.about).toEqual({ hasUsers: false, authMethods: { password: false, google: true } });
  expect(result.first).toEqual({ location: "/", signedIn: true, role: "admin", bootstrap: "bootstrap" });
  expect(result.second).toEqual({ location: "/login#error=signup_closed", signedIn: false, exists: false });
  expect(result.login).toEqual({ status: 403, code: "PASSWORD_SIGNIN_DISABLED" });
  expect(result.register).toEqual({ status: 403, code: "PASSWORD_SIGNIN_DISABLED" });
}, PROBE_TIMEOUT_MS);
