import { afterAll, describe, expect, test } from "bun:test";
import { hashPassword, setPasswordCostForTests, verifyPassword } from "../server/passwords";

/**
 * The harness lowers the argon2id cost of new hashes so auth-flow tests stay fast under host load;
 * production keeps m=64 MiB, t=3, and a hash of either cost verifies.
 */
describe("password hash cost", () => {
  afterAll(() => setPasswordCostForTests(true));

  test("production hashes use m=65536, t=3; the test cost is only for tests, and both verify", async () => {
    setPasswordCostForTests(false);
    const production = await hashPassword("correct horse battery staple");
    expect(production).toStartWith("$argon2id$v=19$m=65536,t=3,");
    setPasswordCostForTests(true);
    const cheap = await hashPassword("correct horse battery staple");
    expect(cheap).toStartWith("$argon2id$v=19$m=4096,t=2,");
    expect(await verifyPassword("correct horse battery staple", production)).toBe(true);
    expect(await verifyPassword("correct horse battery staple", cheap)).toBe(true);
    expect(await verifyPassword("wrong", cheap)).toBe(false);
  }, 20_000);
});
