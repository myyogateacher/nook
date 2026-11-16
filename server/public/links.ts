import { createHash, randomBytes } from "node:crypto";
import { audit, db, now } from "../db";
import { readWorkspaceSettings } from "../workspaceSettings";
import { PUBLIC_TOKEN_PATTERN, type PublicLinkKind } from "../../shared/publicPages";

/**
 * Public links (docs/plan/WORKSPACE_MODULES.md §B.8, D810, T507): secret URLs for forms, booking
 * types, a booking's manage page, a time-poll guest, a townhall session. The token is 32 random bytes
 * (base64url, 43 characters), returned once at creation; only its SHA-256 is stored (the D362/D66
 * pattern), so a lookup is by hash and a database read never reveals a working link.
 *
 * `readPublicLink` answers null for anything that does not open now: unknown, malformed, revoked,
 * expired, used up, the kind's policy off, or the module's own `opens` check (binned, closed). Callers
 * answer every null with the same 404 body (PUBLIC_NOT_FOUND).
 */

export type PublicLink = {
  id: string; kind: PublicLinkKind; itemId: string; tokenPrefix: string; createdBy: string | null; createdAt: string; expiresAt: string | null;
  maxUses: number | null; useCount: number; revokedAt: string | null; lastUsedAt: string | null; settings: Record<string, unknown>;
};

type Row = { id: string; kind: PublicLinkKind; item_id: string; token_prefix: string; created_by: string | null; created_at: string; expires_at: string | null;
  max_uses: number | null; use_count: number; revoked_at: string | null; last_used_at: string | null; settings_json: string };

const toLink = (row: Row): PublicLink => ({
  id: row.id, kind: row.kind, itemId: row.item_id, tokenPrefix: row.token_prefix, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at,
  maxUses: row.max_uses, useCount: row.use_count, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at, settings: JSON.parse(row.settings_json) as Record<string, unknown>
});

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The admin policy a kind falls under (§G.1 Q2: on by default): booking pages and their manage pages,
 * townhall audience links (D1382: their own switch since 160), and everything else (forms, polls,
 * a time poll's guest link) under public forms.
 */
export function publicPolicyAllows(kind: PublicLinkKind) {
  const settings = readWorkspaceSettings();
  if (kind === "townhall_session") return settings.publicTownhall;
  return kind === "booking_type" || kind === "booking_manage" ? settings.publicBookingPages : settings.publicForms;
}

/** Default per-link submissions per hour (§B.8); a link's `settings.perHour` may lower it. */
export const LINK_SUBMISSIONS_PER_HOUR = 300;

/** Creates a link; returns it with its token (shown once). Call inside the owning write's transaction. */
export function createPublicLink(input: { kind: PublicLinkKind; itemId: string; createdBy: string | null; expiresAt?: string | null; maxUses?: number | null; settings?: Record<string, unknown> }) {
  const token = randomBytes(32).toString("base64url");
  const id = Bun.randomUUIDv7();
  const settings = JSON.stringify(input.settings ?? {});
  if (settings.length > 4096) throw new Error("Public link settings are too large");
  db.query(`INSERT INTO public_links (id, kind, item_id, token_hash, token_prefix, created_by, created_at, expires_at, max_uses, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.kind, input.itemId, tokenHash(token), token.slice(0, 6), input.createdBy, now(), input.expiresAt ?? null, input.maxUses ?? null, settings);
  audit(input.createdBy, null, "public.link_created", { linkId: id, kind: input.kind, itemId: input.itemId, expires: input.expiresAt !== undefined && input.expiresAt !== null, maxUses: input.maxUses ?? null });
  return { link: getPublicLink(id)!, token };
}

export function getPublicLink(id: string): PublicLink | null {
  const row = db.query("SELECT * FROM public_links WHERE id = ?").get(id) as Row | null;
  return row ? toLink(row) : null;
}

export function listPublicLinks(kind: PublicLinkKind, itemId: string, options: { includeRevoked?: boolean } = {}): PublicLink[] {
  return (db.query(`SELECT * FROM public_links WHERE kind = ? AND item_id = ?${options.includeRevoked ? "" : " AND revoked_at IS NULL"} ORDER BY created_at DESC`).all(kind, itemId) as Row[]).map(toLink);
}

/** Revokes a link (its routes 404 at once). Returns false when it was already revoked or does not exist. */
export function revokePublicLink(id: string, actorId: string | null) {
  const changed = db.query("UPDATE public_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id).changes === 1;
  if (changed) audit(actorId, null, "public.link_revoked", { linkId: id });
  return changed;
}

/** Revokes every link of an item (a form deleted, a booking type binned). */
export function revokePublicLinksOf(kind: PublicLinkKind, itemId: string, actorId: string | null) {
  const changed = db.query("UPDATE public_links SET revoked_at = ? WHERE kind = ? AND item_id = ? AND revoked_at IS NULL").run(now(), kind, itemId).changes;
  if (changed) audit(actorId, null, "public.links_revoked", { kind, itemId, count: changed });
  return changed;
}

/**
 * The link a token opens now, or null (see the file comment). `opens` is the module's own check on
 * the item (live, open, not binned); it runs only after the token matched.
 */
export function readPublicLink(kind: PublicLinkKind, token: string, options: { opens?: (link: PublicLink) => boolean; nowMs?: number } = {}): PublicLink | null {
  if (typeof token !== "string" || !PUBLIC_TOKEN_PATTERN.test(token)) return null;
  const row = db.query("SELECT * FROM public_links WHERE token_hash = ?").get(tokenHash(token)) as Row | null;
  if (!row || row.kind !== kind || row.revoked_at !== null) return null;
  const nowMs = options.nowMs ?? Date.now();
  if (row.expires_at !== null && Date.parse(row.expires_at) <= nowMs) return null;
  if (row.max_uses !== null && row.use_count >= row.max_uses) return null;
  if (!publicPolicyAllows(kind)) return null;
  const link = toLink(row);
  return options.opens && !options.opens(link) ? null : link;
}

/**
 * Counts one accepted submission against the link: false (nothing counted) when the link is used up
 * or its hour is full (the durable per-link limit, §B.8). Call inside the submission's transaction.
 */
export function consumePublicLink(link: PublicLink, nowMs = Date.now()): boolean {
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  const perHour = typeof link.settings.perHour === "number" && link.settings.perHour > 0 ? Math.min(link.settings.perHour, LINK_SUBMISSIONS_PER_HOUR) : LINK_SUBMISSIONS_PER_HOUR;
  const used = (db.query("SELECT submissions FROM public_link_usage WHERE link_id = ? AND hour = ?").get(link.id, hour) as { submissions: number } | null)?.submissions ?? 0;
  if (used >= perHour) return false;
  const counted = db.query("UPDATE public_links SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR use_count < max_uses)").run(new Date(nowMs).toISOString(), link.id).changes;
  if (counted !== 1) return false;
  db.query("INSERT INTO public_link_usage (link_id, hour, submissions) VALUES (?, ?, 1) ON CONFLICT (link_id, hour) DO UPDATE SET submissions = submissions + 1").run(link.id, hour);
  return true;
}
