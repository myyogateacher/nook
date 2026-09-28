import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { db } from "../db";
import { readPrivateFile, writePrivateFileAtomic } from "../storage";
import { readEmailPrefs } from "./prefs";
import { MAIL_CATEGORIES, type MailCategory } from "./templates/types";

/**
 * Signed one-click unsubscribe tokens (docs/plan/research/2026-09-28-outbound-email.md §B.2, T221).
 *
 * `base64url("1|<userId>|<category>|<epoch>") + "." + base64url(HMAC-SHA256(key, payload)[0:16])`.
 * A token can only turn its one category off. It never expires; bumping `email_prefs.unsub_epoch`
 * revokes every older token. It carries no address. The key is `mail-signing.key` in the data
 * directory (32 random bytes, 0600, written atomically like the VAPID keys).
 */

const KEY_FILE = "mail-signing.key";
let keyPromise: Promise<Buffer> | null = null;

async function loadKey() {
  const path = join(config.dataDir, KEY_FILE);
  if (existsSync(path)) {
    const stored = Buffer.from((await readPrivateFile(path)).toString().trim(), "base64");
    if (stored.length === 32) return stored;
    throw new Error("mail-signing.key is not a 32-byte key");
  }
  const key = randomBytes(32);
  await writePrivateFileAtomic(path, `${key.toString("base64")}\n`);
  return key;
}

export function mailSigningKey() {
  keyPromise ??= loadKey().catch((error) => { keyPromise = null; throw error; });
  return keyPromise;
}

const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest().subarray(0, 16);

export async function createUnsubscribeToken(userId: string, category: MailCategory) {
  const epoch = readEmailPrefs(userId).unsubEpoch;
  const payload = `1|${userId}|${category}|${epoch}`;
  return `${Buffer.from(payload).toString("base64url")}.${mac(await mailSigningKey(), payload).toString("base64url")}`;
}

/** The user and category a token names when its signature and epoch hold, else null. */
export async function verifyUnsubscribeToken(token: string): Promise<{ userId: string; category: MailCategory } | null> {
  if (typeof token !== "string" || token.length > 300) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const payload = Buffer.from(encoded, "base64url").toString();
  const expected = mac(await mailSigningKey(), payload);
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const [version, userId, category, epoch] = payload.split("|");
  if (version !== "1" || !userId || !category || !(MAIL_CATEGORIES as readonly string[]).includes(category) || !/^\d+$/.test(epoch ?? "")) return null;
  if (!db.query("SELECT 1 FROM users WHERE id = ?").get(userId)) return null;
  if (readEmailPrefs(userId).unsubEpoch !== Number(epoch)) return null;
  return { userId, category: category as MailCategory };
}

/** "Reset email links": every unsubscribe token issued so far stops working. */
export function bumpUnsubscribeEpoch(userId: string) {
  const timestamp = new Date().toISOString();
  db.query("INSERT OR IGNORE INTO email_prefs (user_id, updated_at) VALUES (?, ?)").run(userId, timestamp);
  db.query("UPDATE email_prefs SET unsub_epoch = unsub_epoch + 1, updated_at = ? WHERE user_id = ?").run(timestamp, userId);
}
