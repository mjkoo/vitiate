/**
 * Host matching utility for SSRF detection.
 *
 * Compiles a list of host specifications (CIDR, IP, hostname, wildcard domain)
 * into an efficient matching structure. Used by the SSRF detector for both
 * blocklist and allowlist evaluation.
 */

interface Ipv4Rule {
  kind: "ipv4";
  spec: string;
  address: number;
  mask: number;
}

interface Ipv6Rule {
  kind: "ipv6";
  spec: string;
  address: bigint;
  mask: bigint;
}

interface HostnameRule {
  kind: "hostname";
  spec: string;
  hostname: string;
}

interface WildcardRule {
  kind: "wildcard";
  spec: string;
  suffix: string;
}

type Rule = Ipv4Rule | Ipv6Rule | HostnameRule | WildcardRule;

/** Parse an IPv4 address string to a 32-bit unsigned integer. Returns null if invalid. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

/** Parse an IPv6 address string to a 128-bit BigInt. Returns null if invalid. */
function parseIpv6(ip: string): bigint | null {
  // Strip brackets if present
  let addr = ip;
  if (addr.startsWith("[") && addr.endsWith("]")) {
    addr = addr.slice(1, -1);
  }

  // Detect mixed notation (RFC 4291 §2.5.5): e.g. ::ffff:127.0.0.1
  const isMixed = addr.includes(".");
  const targetGroups = isMixed ? 7 : 8;

  // Handle :: expansion
  const doubleColonIdx = addr.indexOf("::");
  let groups: string[];

  if (doubleColonIdx !== -1) {
    const left = addr.slice(0, doubleColonIdx);
    const right = addr.slice(doubleColonIdx + 2);
    const leftGroups = left === "" ? [] : left.split(":");
    const rightGroups = right === "" ? [] : right.split(":");
    const missing = targetGroups - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    groups = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    groups = addr.split(":");
  }

  if (groups.length !== targetGroups) return null;

  if (isMixed) {
    // Last group is a dotted-decimal IPv4 tail
    const ipv4Str = groups[groups.length - 1];
    if (ipv4Str === undefined) return null;
    const ipv4 = parseIpv4(ipv4Str);
    if (ipv4 === null) return null;

    let result = 0n;
    for (let i = 0; i < groups.length - 1; i++) {
      const group = groups[i];
      if (group === undefined || !/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      result = (result << 16n) | BigInt(parseInt(group, 16));
    }
    // Append the 32-bit IPv4 value
    result = (result << 32n) | BigInt(ipv4 >>> 0);
    return result;
  }

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

/** Check if a string looks like an IPv6 address (contains at least two colons). */
function looksLikeIpv6(s: string): boolean {
  // Count colons - IPv6 has at least 2
  let colons = 0;
  for (const ch of s) {
    if (ch === ":") colons++;
    if (colons >= 2) return true;
  }
  return false;
}

function parseRule(spec: string): Rule {
  const cidrIdx = spec.indexOf("/");

  if (cidrIdx !== -1) {
    // CIDR notation
    const hostPart = spec.slice(0, cidrIdx);
    const prefixStr = spec.slice(cidrIdx + 1);
    if (!/^\d+$/.test(prefixStr)) {
      throw new Error(`Invalid CIDR prefix: ${spec}`);
    }
    const prefixLen = Number(prefixStr);

    if (looksLikeIpv6(hostPart)) {
      const address = parseIpv6(hostPart);
      if (address === null) {
        throw new Error(`Invalid IPv6 address in CIDR: ${spec}`);
      }
      if (prefixLen > 128) {
        throw new Error(`Invalid IPv6 CIDR prefix length: ${spec}`);
      }
      const mask =
        prefixLen === 0
          ? 0n
          : ((1n << 128n) - 1n) << (128n - BigInt(prefixLen));
      return { kind: "ipv6", spec, address, mask };
    } else {
      const address = parseIpv4(hostPart);
      if (address === null) {
        throw new Error(`Invalid IPv4 address in CIDR: ${spec}`);
      }
      if (prefixLen > 32) {
        throw new Error(`Invalid IPv4 CIDR prefix length: ${spec}`);
      }
      const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
      return { kind: "ipv4", spec, address: (address & mask) >>> 0, mask };
    }
  }

  // Check for wildcard domain
  if (spec.startsWith("*.")) {
    const suffix = spec.slice(1).toLowerCase(); // ".corp.example.com"
    return { kind: "wildcard", spec, suffix };
  }

  // Try IPv6
  if (looksLikeIpv6(spec) || spec.startsWith("[")) {
    let addr = spec;
    if (addr.startsWith("[") && addr.endsWith("]")) {
      addr = addr.slice(1, -1);
    }
    const parsed = parseIpv6(addr);
    if (parsed !== null) {
      // Exact IPv6: /128 mask
      const mask = (1n << 128n) - 1n;
      return { kind: "ipv6", spec, address: parsed, mask };
    }
    throw new Error(`Invalid IPv6 address: ${spec}`);
  }

  // Try IPv4
  const ipv4 = parseIpv4(spec);
  if (ipv4 !== null) {
    // Exact IPv4: /32 mask
    const mask = 0xffffffff >>> 0;
    return { kind: "ipv4", spec, address: ipv4, mask };
  }

  // Hostname (case-insensitive)
  return { kind: "hostname", spec, hostname: spec.toLowerCase() };
}

/** Prefix for IPv4-mapped IPv6 addresses (::ffff:0:0/96). */
const IPV4_MAPPED_PREFIX = 0xffff00000000n;
/** Mask for the upper 96 bits of an IPv6 address. */
const IPV4_MAPPED_MASK = ((1n << 128n) - 1n) ^ ((1n << 32n) - 1n);

export class HostMatcher {
  private readonly rules: Rule[];

  constructor(specs: readonly string[]) {
    this.rules = specs.map(parseRule);
  }

  /**
   * Check if a hostname matches any rule.
   * Returns the specification string of the first matching rule, or null.
   */
  matches(hostname: string): string | null {
    if (this.rules.length === 0) return null;

    // Strip brackets from IPv6 literals
    let normalized = hostname;
    if (normalized.startsWith("[") && normalized.endsWith("]")) {
      normalized = normalized.slice(1, -1);
    }

    // Try to parse as IP
    const ipv4 = parseIpv4(normalized);
    if (ipv4 !== null) {
      for (const rule of this.rules) {
        if (rule.kind === "ipv4") {
          if (((ipv4 >>> 0) & rule.mask) === (rule.address & rule.mask)) {
            return rule.spec;
          }
        }
      }
      // Cross-match IPv4 input against IPv4-mapped IPv6 rules (::ffff:0:0/96)
      const mapped = IPV4_MAPPED_PREFIX | BigInt(ipv4 >>> 0);
      for (const rule of this.rules) {
        if (rule.kind === "ipv6") {
          if ((mapped & rule.mask) === (rule.address & rule.mask)) {
            return rule.spec;
          }
        }
      }
      return null;
    }

    if (looksLikeIpv6(normalized)) {
      const ipv6 = parseIpv6(normalized);
      if (ipv6 !== null) {
        for (const rule of this.rules) {
          if (rule.kind === "ipv6") {
            if ((ipv6 & rule.mask) === (rule.address & rule.mask)) {
              return rule.spec;
            }
          }
        }
        // Cross-match IPv4-mapped IPv6 (::ffff:x.x.x.x) against IPv4 rules
        if ((ipv6 & IPV4_MAPPED_MASK) === IPV4_MAPPED_PREFIX) {
          const embedded = Number(ipv6 & 0xffffffffn) >>> 0;
          for (const rule of this.rules) {
            if (rule.kind === "ipv4") {
              if (
                ((embedded >>> 0) & rule.mask) ===
                (rule.address & rule.mask)
              ) {
                return rule.spec;
              }
            }
          }
        }
        return null;
      }
    }

    // Hostname matching (case-insensitive)
    const lower = normalized.toLowerCase();
    for (const rule of this.rules) {
      if (rule.kind === "hostname" && lower === rule.hostname) {
        return rule.spec;
      }
      if (
        rule.kind === "wildcard" &&
        lower.endsWith(rule.suffix) &&
        lower.length > rule.suffix.length
      ) {
        return rule.spec;
      }
    }

    return null;
  }
}
