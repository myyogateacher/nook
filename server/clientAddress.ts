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
 * Addresses are canonical (S3), so every spelling of one address shares one bucket: brackets and
 * zone ids (`%eth0`) dropped, IPv4-mapped IPv6 in any spelling as plain IPv4, other IPv6 compressed
 * and lower-cased (RFC 5952). IPv6 is then bucketed by its /64, the block one client usually holds.
 */

/** The eight 16-bit groups of an IPv6 address (already checked by `isIP`), or null. */
function ipv6Groups(text: string): number[] | null {
  let head = text;
  const tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(head);
  if (dotted) {
    const bytes = dotted[1]!.split(".").map(Number);
    tail.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
    head = head.slice(0, -dotted[1]!.length);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const parse = (part: string) => part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  let groups: number[];
  if (head.includes("::")) {
    const [left, right] = head.split("::") as [string, string];
    const l = parse(left), r = [...parse(right), ...tail];
    groups = [...l, ...new Array<number>(Math.max(0, 8 - l.length - r.length)).fill(0), ...r];
  } else {
    groups = [...parse(head), ...tail];
  }
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** RFC 5952: lower-case hex, no leading zeros, the longest run (two or more) of zero groups as `::`. */
function compressIpv6(groups: number[]) {
  let best = -1, bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) { best = index; bestLength = end - index; }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLength).join(":")}`;
}

/** The canonical form of one address (see above), or null when it is not an IP address. */
export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = value.trim();
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]"));
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const kind = isIP(text);
  if (kind === 4) return text;
  if (kind !== 6) return null;
  const groups = ipv6Groups(text.toLowerCase());
  if (!groups) return null;
  // ::ffff:a.b.c.d, ::ffff:hhhh:hhhh, 0:0:0:0:0:ffff:…, with or without leading zeros.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  }
  return compressIpv6(groups);
}

/** The rate-limit bucket of an address: IPv4 as is, IPv6 as its /64 (for example `2001:db8:1:2::/64`). */
export function addressBucket(value: string | null | undefined): string | null {
  const canonical = normalizeIp(value);
  if (!canonical || !canonical.includes(":")) return canonical;
  const groups = ipv6Groups(canonical)!;
  return `${compressIpv6([...groups.slice(0, 4), 0, 0, 0, 0])}/64`;
}

let warnedForwardedIgnored = false;
/** Test hooks for the once-per-process warning below. */
export const forwardedWarningLogged = () => warnedForwardedIgnored;
export function resetForwardedWarning() {
  warnedForwardedIgnored = false;
}

function socketAddress(c: Context) {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** The client's rate-limit bucket (see above); "unknown" when there is none. */
export function clientAddress(c: Context, hops = config.trustedProxyHops): string {
  const socket = socketAddress(c);
  const fallback = addressBucket(socket) ?? socket ?? "unknown";
  const header = c.req.header("X-Forwarded-For");
  if (hops <= 0) {
    // S8: once per process, and never the address: behind a proxy every client shares one bucket.
    if (header && !warnedForwardedIgnored) {
      warnedForwardedIgnored = true;
      console.warn("A request carried X-Forwarded-For but TRUSTED_PROXY_HOPS is 0, so rate limits see the proxy's address for every client. Behind a reverse proxy, set TRUSTED_PROXY_HOPS (see docs/OPERATIONS.md).");
    }
    return fallback;
  }
  if (!header) return fallback;
  const entries = header.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length < hops) return fallback;
  return addressBucket(entries[entries.length - hops]) ?? fallback;
}
