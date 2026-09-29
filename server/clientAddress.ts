import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { config } from "./config";

/**
 * The client address used for rate limits and audit entries, never for granting access (Wave 35
 * review N1; the access plan's TRUSTED_PROXY_HOPS, O-A7).
 *
 * - `TRUSTED_PROXY_HOPS=0` (default): the socket address; forwarding headers are ignored entirely.
 * - `N ≥ 1`: the N-th entry from the RIGHT of `X-Forwarded-For`, which is the entry the outermost
 *   trusted proxy added. Entries further left are client-controlled and never read. `X-Real-IP` and
 *   `Forwarded` are never read. A header with fewer than N entries, or a non-IP entry, falls back to
 *   the socket address.
 *
 * Addresses are normalised: IPv6 lower-cased without brackets, IPv4-mapped IPv6 as plain IPv4.
 */

export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = value.trim();
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]"));
  const kind = isIP(text);
  if (kind === 4) return text;
  if (kind !== 6) return null;
  const lower = text.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  return lower;
}

function socketAddress(c: Context) {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** The address for rate limits and audits (see above); "unknown" when there is none. */
export function clientAddress(c: Context, hops = config.trustedProxyHops): string {
  const socket = socketAddress(c);
  const fallback = normalizeIp(socket) ?? socket ?? "unknown";
  if (hops <= 0) return fallback;
  const header = c.req.header("X-Forwarded-For");
  if (!header) return fallback;
  const entries = header.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length < hops) return fallback;
  return normalizeIp(entries[entries.length - hops]) ?? fallback;
}
