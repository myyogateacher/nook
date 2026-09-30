import { expect, test } from "bun:test";
import { join } from "node:path";

test("the first registration becomes the only admin, and the host CLI manages roles within the last-admin rule", () => {
  const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "teamBootstrapProbe.ts")], { stdout: "pipe", stderr: "pipe" });
  const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
  const result = JSON.parse(output) as Record<string, any>;
  // With ALLOW_REGISTRATION=false two racing "first" registrations let exactly one through.
  expect(result.statuses).toEqual([201, 403]);
  expect(result.winnerRole).toBe("admin");
  expect(result.roles).toEqual([{ role: "admin", count: 1 }]);
  expect(result.bootstrap).toEqual([{ via: "bootstrap", action: "bootstrap_admin", to_role: "admin", actor_id: null }]);
  expect(result.list).toEqual([
    [expect.stringMatching(/^(first|second)@example\.test$/), "admin", "active"],
    ["member@example.test", "member", "active"]
  ]);
  // The only admin cannot be demoted, even from the host.
  expect(result.lastAdmin.code).toBe(1);
  expect(result.lastAdmin.err).toContain("LAST_ADMIN");
  expect(result.promote.code).toBe(0);
  // Every role is selectable from the host; unknown accounts and commands fail.
  expect(result.viewer).toBe(0);
  expect(result.unknown).toBe(1);
  expect(result.notBlocked.code).toBe(1);
  expect(result.notBlocked.err).toContain("NOT_BLOCKED");
  expect(result.usage).toBe(2);
  // The promotion, then the demotion to viewer (the first admin remains, so it is allowed).
  expect(result.cliEvents).toEqual([
    { via: "cli", action: "role_change", from_role: "member", to_role: "admin", actor_id: null },
    { via: "cli", action: "role_change", from_role: "admin", to_role: "viewer", actor_id: null }
  ]);
  expect(result.cliAudit).toEqual({ count: 2 });
}, 30_000);

test("with accounts but no active admin, boot warns and the next registration becomes the admin", () => {
  const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "noActiveAdminProbe.ts")], { stdout: "pipe", stderr: "pipe" });
  const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
  const result = JSON.parse(output) as Record<string, any>;
  // A fresh, empty install is not a lockout.
  expect(result.emptyWarned).toBe(false);
  expect(result.bootWarnings).toHaveLength(1);
  expect(result.bootWarnings[0]).toContain("bun server/team-admin.ts set-role <email> admin");
  expect(result.statuses).toEqual([201, 201]);
  // Only the first registration while nobody can manage the team is promoted; the next gets the
  // SIGNUP_ROLE default, guest (D80).
  expect(result.roles).toEqual(["admin", "guest"]);
  expect(result.events).toEqual([{ via: "bootstrap", action: "bootstrap_admin", to_role: "admin", actor_id: null }]);
  expect(result.afterWarned).toBe(false);
}, 30_000);
