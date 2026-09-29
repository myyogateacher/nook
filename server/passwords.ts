/**
 * The one place a password is checked against a stored hash (Wave 35, D294).
 *
 * Accounts created through Google, and accounts whose password was voided when Google was linked
 * to an unverified address (D293), store UNUSABLE_PASSWORD. It is not a PHC string, so no password
 * can hash to it, and `Bun.password.verify` would throw on it: every caller goes through
 * `verifyPassword`, which refuses any hash starting with "!" before hashing anything.
 */
export const UNUSABLE_PASSWORD = "!unusable:google";

/** Whether a stored hash can ever verify (false for the sentinel and anything else starting with "!"). */
export const isUsablePasswordHash = (hash: string | null | undefined): hash is string => typeof hash === "string" && hash.length > 0 && !hash.startsWith("!");

export async function verifyPassword(plain: string | null | undefined, hash: string | null | undefined) {
  if (!isUsablePasswordHash(hash) || !plain) return false;
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

export const hashPassword = (value: string) => Bun.password.hash(value, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
