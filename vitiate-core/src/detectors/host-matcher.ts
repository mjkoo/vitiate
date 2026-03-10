/**
 * Host matching utility for SSRF detection.
 *
 * Compiles a list of host specifications (CIDR, IP, hostname, wildcard domain)
 * into an efficient matching structure. Used by the SSRF detector for both
 * blocklist and allowlist evaluation.
 *
 * Uses ipaddr.js for robust IP parsing — handles octal notation, hex notation,
 * single-integer IPs, IPv4-mapped IPv6, and other edge cases that bypass
 * naive parsers.
 */
import ipaddr from "ipaddr.js";

interface Ipv4CidrRule {
  kind: "ipv4-cidr";
  spec: string;
  cidr: [ipaddr.IPv4, number];
}

interface Ipv6CidrRule {
  kind: "ipv6-cidr";
  spec: string;
  cidr: [ipaddr.IPv6, number];
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

type Rule = Ipv4CidrRule | Ipv6CidrRule | HostnameRule | WildcardRule;

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

    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      addr = ipaddr.parse(hostPart);
    } catch {
      throw new Error(`Invalid IP address in CIDR: ${spec}`);
    }
    if (addr.kind() === "ipv4") {
      if (prefixLen > 32) {
        throw new Error(`Invalid IPv4 CIDR prefix length: ${spec}`);
      }
      return {
        kind: "ipv4-cidr",
        spec,
        cidr: [addr as ipaddr.IPv4, prefixLen],
      };
    } else {
      if (prefixLen > 128) {
        throw new Error(`Invalid IPv6 CIDR prefix length: ${spec}`);
      }
      return {
        kind: "ipv6-cidr",
        spec,
        cidr: [addr as ipaddr.IPv6, prefixLen],
      };
    }
  }

  // Check for wildcard domain
  if (spec.startsWith("*.")) {
    const suffix = spec.slice(1).toLowerCase(); // ".corp.example.com"
    return { kind: "wildcard", spec, suffix };
  }

  // Try to parse as IP address
  try {
    const addr = ipaddr.parse(
      spec.startsWith("[") && spec.endsWith("]") ? spec.slice(1, -1) : spec,
    );
    if (addr.kind() === "ipv4") {
      return { kind: "ipv4-cidr", spec, cidr: [addr as ipaddr.IPv4, 32] };
    } else {
      return { kind: "ipv6-cidr", spec, cidr: [addr as ipaddr.IPv6, 128] };
    }
  } catch {
    // Not an IP — treat as hostname
  }

  // Hostname (case-insensitive)
  return { kind: "hostname", spec, hostname: spec.toLowerCase() };
}

/**
 * Try to parse a hostname string as an IP address using ipaddr.js.
 * Handles octal, hex, single-integer, and IPv4-mapped IPv6 forms.
 * Returns the parsed address or null.
 */
function tryParseIp(hostname: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  let normalized = hostname;
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  try {
    // ipaddr.process() normalizes IPv4-mapped IPv6 (::ffff:1.2.3.4) to IPv4,
    // which is what we want for matching rules.
    return ipaddr.process(normalized);
  } catch {
    // Not a valid IP
    return null;
  }
}

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

    const addr = tryParseIp(hostname);
    if (addr !== null) {
      for (const rule of this.rules) {
        if (rule.kind === "ipv4-cidr" && addr.kind() === "ipv4") {
          if (addr.match(rule.cidr)) {
            return rule.spec;
          }
        }
        if (rule.kind === "ipv6-cidr" && addr.kind() === "ipv6") {
          if (addr.match(rule.cidr)) {
            return rule.spec;
          }
        }
        // Cross-match: IPv4 address against IPv6 rules via IPv4-mapped form
        if (rule.kind === "ipv6-cidr" && addr.kind() === "ipv4") {
          const mapped = (addr as ipaddr.IPv4).toIPv4MappedAddress();
          if (mapped.match(rule.cidr)) {
            return rule.spec;
          }
        }
        // Cross-match: IPv4-mapped IPv6 against IPv4 rules
        if (
          rule.kind === "ipv4-cidr" &&
          addr.kind() === "ipv6" &&
          (addr as ipaddr.IPv6).isIPv4MappedAddress()
        ) {
          const embedded = (addr as ipaddr.IPv6).toIPv4Address();
          if (embedded.match(rule.cidr)) {
            return rule.spec;
          }
        }
      }
      return null;
    }

    // Hostname matching (case-insensitive)
    const lower = hostname.toLowerCase();
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
