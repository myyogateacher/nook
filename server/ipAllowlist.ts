import { config } from "./config";
import { addressInRanges, formatEntry, parseEntry, rangeWithin, type Range } from "./ipRanges";

export { formatEntry, parseEntry, rangeWithin };

/**
 * Per-key IP allowlists (Wave 34, access plan D284, O-A7, T211): at most ten addresses or CIDR
 * ranges, IPv4 and IPv6. A key with a list works only from a client address inside one of them,
 * on MCP and REST alike, checked on every request.
 *
 * The client address is only meaningful when the server knows how many trusted proxies sit in
 * front of it, so the allowlist is **offered and enforced only when `TRUSTED_PROXY_HOPS` is 1 or
 * more** (the plan's rule). With 0 the server reads the socket address, which behind an
 * unannounced proxy is the proxy's own address for every client, and the server cannot tell that
 * case apart from a direct connection; a list checked against it would be theatre. A key that
 * already holds a list while the setting is 0 is refused (fail closed) rather than let through.
 */

export const IP_ALLOWLIST_MAX = 10;

/** Whether this server can offer and check allowlists. */
export const ipAllowlistAvailable = (hops = config.trustedProxyHops) => hops >= 1;

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}

/** A request's list, validated and canonical (duplicates dropped); throws AllowlistError. */
export function normalizeAllowlist(entries: readonly string[]): string[] {
  if (entries.length > IP_ALLOWLIST_MAX) throw new AllowlistError(`A key can list at most ${IP_ALLOWLIST_MAX} addresses or ranges`);
  const out: string[] = [];
  for (const entry of entries) {
    const range = parseEntry(entry);
    if (!range) throw new AllowlistError("Each allowed address must be an IPv4 or IPv6 address, or a range such as 203.0.113.0/24");
    const text = formatEntry(range);
    if (!out.includes(text)) out.push(text);
  }
  if (!out.length) throw new AllowlistError("List at least one address, or leave the allowlist off");
  return out;
}

/** The stored list (JSON), or null when the key has none. A list that no longer parses allows nothing. */
export function storedAllowlist(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Whether `address` (any spelling) lies inside one entry of `list`. */
export const addressAllowed = (list: readonly string[], address: string | null) => addressInRanges(list, address);

/** Whether `next` only narrows `current` (D278): every next range lies inside a current one. */
export function allowlistNarrows(current: readonly string[] | null, next: readonly string[]) {
  if (current === null) return true;
  const held = current.map(parseEntry).filter((range): range is Range => range !== null);
  return next.every((entry) => {
    const range = parseEntry(entry);
    return range !== null && held.some((outer) => rangeWithin(range, outer));
  });
}
