import { expect, test } from "bun:test";
import { join } from "node:path";

test("AUTH_METHODS=google on an empty closed instance: the first Google account is the admin, the next is refused, passwords are off", () => {
  const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "googleProbe.ts")], { stdout: "pipe", stderr: "pipe" });
  const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
  const result = JSON.parse(output) as Record<string, any>;
  expect(result.about).toEqual({ hasUsers: false, authMethods: { password: false, google: true } });
  expect(result.first).toEqual({ location: "/", signedIn: true, role: "admin", bootstrap: "bootstrap" });
  expect(result.second).toEqual({ location: "/login#error=signup_closed", signedIn: false, exists: false });
  expect(result.login).toEqual({ status: 403, code: "PASSWORD_SIGNIN_DISABLED" });
  expect(result.register).toEqual({ status: 403, code: "PASSWORD_SIGNIN_DISABLED" });
}, 30_000);
