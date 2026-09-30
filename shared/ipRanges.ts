
/**
 * IP addresses and CIDR ranges, pure (no configuration, no Node APIs), shared by the client-address
 * helper (server/clientAddress.ts), the config (TRUSTED_PROXY_ADDRESSES), per-key allowlists
 * (server/ipAllowlist.ts), and the key form, which shows each entry's canonical form (review Q6). Addresses are canonical: brackets and zone ids dropped, IPv4-mapped IPv6
 * as IPv4, other IPv6 compressed and lower-cased (RFC 5952).
 */

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** 4 or 6 when `text` is a plain IPv4 or IPv6 address (no brackets, zone, or prefix), else 0 (as node:net isIP). */
export function isIP(text: string): 0 | 4 | 6 {
  if (IPV4.test(text)) return 4;
  if (!text.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(text) || text.includes(":::") || (text.match(/::/g)?.length ?? 0) > 1) return 0;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted && !IPV4.test(dotted[1]!)) return 0;
  const hexPart = dotted ? text.slice(0, -dotted[1]!.length) : text;
  if (hexPart.includes(".")) return 0;
  const groups = hexPart.split(":").filter((group) => group !== "");
  if (!groups.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return 0;
  if (!text.includes("::") && (text.startsWith(":") || text.endsWith(":"))) return 0;
  return ipv6Groups(text.toLowerCase()) ? 6 : 0;
}

/** The eight 16-bit groups of an IPv6 address (already checked by `isIP`), or null. */
export function ipv6Groups(text: string): number[] | null {
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
    // `::` stands for one or more zero groups (verification R1): with eight groups written out there is no room for it.
    if (l.length + r.length > 7) return null;
    groups = [...l, ...new Array<number>(Math.max(0, 8 - l.length - r.length)).fill(0), ...r];
  } else {
    groups = [...parse(head), ...tail];
  }
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** RFC 5952: lower-case hex, no leading zeros, the longest run (two or more) of zero groups as `::`. */
export function compressIpv6(groups: number[]) {
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

export type Range = { family: 4 | 6; network: bigint; prefix: number };

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
export const maskOf = (family: 4 | 6, prefix: number) => prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bitsOf(family) - prefix);

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


/** Whether `address` (any spelling) lies inside one of `ranges` (entries as parseEntry reads them). */
export function addressInRanges(ranges: readonly string[], address: string | null | undefined) {
  const canonical = normalizeIp(address);
  if (!canonical) return false;
  const client = parseEntry(canonical);
  if (!client) return false;
  return ranges.some((entry) => {
    const range = parseEntry(entry);
    return range !== null && rangeWithin(client, range);
  });
}
