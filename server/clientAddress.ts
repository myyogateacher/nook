import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { config } from "./config";
import { addressInRanges, compressIpv6, ipv6Groups, normalizeIp } from "./ipRanges";

export { normalizeIp };

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

/**
 * Whether forwarding headers may be read for this connection (Wave 34 review S1): only with
 * TRUSTED_PROXY_HOPS ≥ 1, and, when TRUSTED_PROXY_ADDRESSES is set, only when the connection comes
 * from one of those proxies. Anyone reaching Nook around the proxy is then seen as themselves.
 */
function forwardingTrusted(socket: string | null, hops: number, proxies: readonly string[]) {
  if (hops <= 0) return false;
  return proxies.length === 0 || addressInRanges(proxies, socket);
}

/**
 * The client's exact canonical address (not its /64 bucket), by the same rule as clientAddress,
 * for per-key IP allowlists (Wave 34, server/ipAllowlist.ts); null when there is none. Forwarding
 * headers count only with TRUSTED_PROXY_HOPS ≥ 1, and only the entry the outermost trusted proxy
 * added: entries further left are client-controlled and never read (T211).
 */
export function clientIp(c: Context, hops = config.trustedProxyHops, proxies: readonly string[] = config.trustedProxyAddresses): string | null {
  const socket = normalizeIp(socketAddress(c));
  if (!forwardingTrusted(socket, hops, proxies)) return socket;
  const header = c.req.header("X-Forwarded-For");
  if (!header) return socket;
  const entries = header.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length < hops) return socket;
  return normalizeIp(entries[entries.length - hops]) ?? socket;
}

/** The client's rate-limit bucket (see above); "unknown" when there is none. */
export function clientAddress(c: Context, hops = config.trustedProxyHops, proxies: readonly string[] = config.trustedProxyAddresses): string {
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
  if (!header || !forwardingTrusted(normalizeIp(socket), hops, proxies)) return fallback;
  const entries = header.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length < hops) return fallback;
  return addressBucket(entries[entries.length - hops]) ?? fallback;
}
