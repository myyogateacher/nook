import { expect, test } from "bun:test";
import { request } from "./support/harness";
import { PROBE_TIMEOUT_MS, runProbe } from "./support/probe";

// v0.13.0 QA, A7: /api/about says whether two-factor can be set up here (a TOTP key is configured),
// and Settings → Security explains instead of offering a setup that would end in 503.

test("/api/about says two-factor is available when a TOTP key is configured, and nothing more about it", async () => {
  const about = await (await request("/about")).json() as Record<string, unknown>;
  expect(about.twoFactor).toBe(true);
  expect(JSON.stringify(about)).not.toMatch(/totp|encryption|secret/i);
});

test("without a TOTP key /api/about says two-factor is not available", () => {
  const probed = runProbe("noTotpKeyProbe.ts");
  const result = probed as { twoFactor: unknown; keys: string[] };
  expect(result.twoFactor).toBe(false);
  expect(result.keys).toEqual(["appName", "authMethods", "gitSha", "hasUsers", "openRegistration", "passwordReset", "twoFactor", "version"]);
}, PROBE_TIMEOUT_MS);

test("Settings → Security shows the explanation instead of the setup form when two-factor is off", async () => {
  const source = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  expect(source).toMatch(/appInfo\.twoFactor === false \? <div className="security-card setup-intro" role="status">[\s\S]*?\{TWO_FACTOR_OFF_TEXT\}[\s\S]*?: !secret \? <form className="security-card setup-intro" onSubmit=\{beginSetup\} noValidate/);
});
