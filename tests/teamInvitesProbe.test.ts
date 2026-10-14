import { expect, test } from "bun:test";
import { PROBE_TIMEOUT_MS, runProbe } from "./support/probe";

test("with ALLOW_REGISTRATION=false an invite opens registration once, with its role; the empty instance's first account is still the admin", () => {
  const probed = runProbe("teamInvitesProbe.ts");
  const result = probed;
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
}, PROBE_TIMEOUT_MS);
