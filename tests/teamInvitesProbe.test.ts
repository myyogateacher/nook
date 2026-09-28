import { expect, test } from "bun:test";
import { join } from "node:path";

test("with ALLOW_REGISTRATION=false an invite opens registration once, with its role; the empty instance's first account is still the admin", () => {
  const probe = Bun.spawnSync(["bun", join(import.meta.dir, "support", "teamInvitesProbe.ts")], { stdout: "pipe", stderr: "pipe" });
  const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
  const result = JSON.parse(output) as Record<string, any>;
  // Bootstrap wins over any token on an empty instance (D163).
  expect(result.first).toEqual({ status: 201, role: "admin" });
  expect(result.closed).toBe(403);
  expect(result.created).toBe(201);
  expect(result.bogus).toBe(404);
  // The invite bypasses only ALLOW_REGISTRATION (D162): its role, once, and the allowlist still applies.
  expect(result.invited).toEqual({ status: 201, role: "viewer" });
  expect(result.reused).toEqual({ status: 404, code: "INVITE_INVALID" });
  expect(result.outsider).toBe(403);
  expect(result.roles).toEqual([{ email: "first@example.test", role: "admin" }, { email: "viewer@example.test", role: "viewer" }]);
}, 30_000);
