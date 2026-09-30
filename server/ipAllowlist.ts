import { isIP } from "node:net";
import { config } from "./config";
import { normalizeIp } from "./clientAddress";

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

type Range = { family: 4 | 6; network: bigint; prefix: number };

function toBigInt(address: string, family: 4 | 6): bigint {
  if (family === 4) return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
  // The canonical IPv6 form from normalizeIp: expand `::` to the missing zero groups.
  const [head, tail] = address.includes("::") ? address.split("::") as [string, string] : [address, null];
  const left = head ? head.split(":") : [];
  const right = tail === null ? [] : tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...new Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

const bitsOf = (family: 4 | 6) => family === 4 ? 32 : 128;
const maskOf = (family: 4 | 6, prefix: number) => prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bitsOf(family) - prefix);

function fromBigInt(value: bigint, family: 4 | 6) {
  if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16));
  return normalizeIp(groups.join(":"))!;
}

/** One entry parsed: an address (a full-length range) or a CIDR range; null when it is not one. */
export function parseEntry(text: string): Range | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf("/");
  const rawAddress = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const address = normalizeIp(rawAddress);
  if (!address || rawAddress.includes("%")) return null;
  const family = isIP(address) === 4 ? 4 : 6;
  let prefix = bitsOf(family);
  if (slash >= 0) {
    const part = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(part)) return null;
    prefix = Number(part);
    // An IPv4-mapped range written in IPv6 (::ffff:10.0.0.0/104) is its IPv4 range.
    if (family === 4 && isIP(rawAddress.replace(/^\[|\]$/g, "")) === 6) prefix -= 96;
    // /0 is every address: not a restriction, so it is refused rather than stored.
    if (prefix < 1 || prefix > bitsOf(family)) return null;
  }
  return { family, network: toBigInt(address, family) & maskOf(family, prefix), prefix };
}

/** The canonical text of a range: `10.0.0.0/8`, `2001:db8::/32`, or a bare address for a single one. */
export const formatEntry = (range: Range) =>
  range.prefix === bitsOf(range.family) ? fromBigInt(range.network, range.family) : `${fromBigInt(range.network, range.family)}/${range.prefix}`;

/** Whether `inner` lies entirely inside `outer`. */
export const rangeWithin = (inner: Range, outer: Range) =>
  inner.family === outer.family && outer.prefix <= inner.prefix && (inner.network & maskOf(outer.family, outer.prefix)) === outer.network;

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
export function addressAllowed(list: readonly string[], address: string | null) {
  const canonical = normalizeIp(address);
  if (!canonical) return false;
  const client = parseEntry(canonical);
  if (!client) return false;
  return list.some((entry) => {
    const range = parseEntry(entry);
    return range !== null && rangeWithin(client, range);
  });
}

/** Whether `next` only narrows `current` (D278): every next range lies inside a current one. */
export function allowlistNarrows(current: readonly string[] | null, next: readonly string[]) {
  if (current === null) return true;
  const held = current.map(parseEntry).filter((range): range is Range => range !== null);
  return next.every((entry) => {
    const range = parseEntry(entry);
    return range !== null && held.some((outer) => rangeWithin(range, outer));
  });
}
