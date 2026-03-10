import { describe, it, expect } from "vitest";
import { HostMatcher } from "./host-matcher.js";

describe("HostMatcher", () => {
  describe("empty matcher", () => {
    it("matches nothing", () => {
      const matcher = new HostMatcher([]);
      expect(matcher.matches("anything")).toBeNull();
      expect(matcher.matches("10.0.0.1")).toBeNull();
      expect(matcher.matches("::1")).toBeNull();
    });
  });

  describe("IPv4 exact match", () => {
    it("matches exact IPv4 address", () => {
      const matcher = new HostMatcher(["192.168.1.1"]);
      expect(matcher.matches("192.168.1.1")).toBe("192.168.1.1");
    });

    it("returns null for non-matching IPv4", () => {
      const matcher = new HostMatcher(["192.168.1.1"]);
      expect(matcher.matches("192.168.1.2")).toBeNull();
    });
  });

  describe("IPv4 CIDR", () => {
    it("matches address within CIDR range", () => {
      const matcher = new HostMatcher(["10.0.0.0/8"]);
      expect(matcher.matches("10.255.0.1")).toBe("10.0.0.0/8");
    });

    it("returns null for address outside CIDR range", () => {
      const matcher = new HostMatcher(["10.0.0.0/8"]);
      expect(matcher.matches("11.0.0.1")).toBeNull();
    });

    it("matches boundary addresses in /24", () => {
      const matcher = new HostMatcher(["192.168.1.0/24"]);
      expect(matcher.matches("192.168.1.0")).toBe("192.168.1.0/24");
      expect(matcher.matches("192.168.1.255")).toBe("192.168.1.0/24");
      expect(matcher.matches("192.168.2.0")).toBeNull();
    });

    it("matches /32 as exact IP", () => {
      const matcher = new HostMatcher(["10.0.0.1/32"]);
      expect(matcher.matches("10.0.0.1")).toBe("10.0.0.1/32");
      expect(matcher.matches("10.0.0.2")).toBeNull();
    });

    it("matches /0 as any IPv4", () => {
      const matcher = new HostMatcher(["0.0.0.0/0"]);
      expect(matcher.matches("1.2.3.4")).toBe("0.0.0.0/0");
      expect(matcher.matches("255.255.255.255")).toBe("0.0.0.0/0");
    });

    it("rejects invalid prefix length >32", () => {
      expect(() => new HostMatcher(["10.0.0.0/33"])).toThrow(
        /invalid.*prefix/i,
      );
    });
  });

  describe("IPv6 exact match", () => {
    it("matches exact IPv6 address", () => {
      const matcher = new HostMatcher(["::1"]);
      expect(matcher.matches("::1")).toBe("::1");
    });

    it("matches bracketed IPv6 in input", () => {
      const matcher = new HostMatcher(["::1"]);
      expect(matcher.matches("[::1]")).toBe("::1");
    });

    it("matches bracketed IPv6 in spec", () => {
      const matcher = new HostMatcher(["[::1]"]);
      expect(matcher.matches("::1")).toBe("[::1]");
    });
  });

  describe("IPv6 CIDR", () => {
    it("matches address within CIDR range", () => {
      const matcher = new HostMatcher(["fe80::/10"]);
      expect(matcher.matches("fe80::1")).toBe("fe80::/10");
    });

    it("returns null for address outside range", () => {
      const matcher = new HostMatcher(["fe80::/10"]);
      expect(matcher.matches("2001:db8::1")).toBeNull();
    });

    it("matches fc00::/7 (ULA range)", () => {
      const matcher = new HostMatcher(["fc00::/7"]);
      expect(matcher.matches("fc00::1")).toBe("fc00::/7");
      expect(matcher.matches("fdff::1")).toBe("fc00::/7");
    });

    it("rejects invalid prefix length >128", () => {
      expect(() => new HostMatcher(["::1/129"])).toThrow(/invalid.*prefix/i);
    });
  });

  describe("hostname matching", () => {
    it("matches exact hostname case-insensitively", () => {
      const matcher = new HostMatcher(["Metadata.Google.Internal"]);
      expect(matcher.matches("metadata.google.internal")).toBe(
        "Metadata.Google.Internal",
      );
    });

    it("returns original spec string", () => {
      const matcher = new HostMatcher(["Metadata.Google.Internal"]);
      expect(matcher.matches("METADATA.GOOGLE.INTERNAL")).toBe(
        "Metadata.Google.Internal",
      );
    });

    it("returns null for non-matching hostname", () => {
      const matcher = new HostMatcher(["example.com"]);
      expect(matcher.matches("other.com")).toBeNull();
    });
  });

  describe("wildcard domain matching", () => {
    it("matches subdomain", () => {
      const matcher = new HostMatcher(["*.corp.example.com"]);
      expect(matcher.matches("api.corp.example.com")).toBe(
        "*.corp.example.com",
      );
    });

    it("does not match base domain", () => {
      const matcher = new HostMatcher(["*.corp.example.com"]);
      expect(matcher.matches("corp.example.com")).toBeNull();
    });

    it("matches deeply nested subdomain", () => {
      const matcher = new HostMatcher(["*.corp.example.com"]);
      expect(matcher.matches("a.b.c.corp.example.com")).toBe(
        "*.corp.example.com",
      );
    });

    it("case-insensitive wildcard matching", () => {
      const matcher = new HostMatcher(["*.Example.COM"]);
      expect(matcher.matches("sub.example.com")).toBe("*.Example.COM");
    });
  });

  describe("IPv4-mapped IPv6", () => {
    it("parses mixed notation ::ffff:127.0.0.1", () => {
      const matcher = new HostMatcher(["::ffff:127.0.0.1"]);
      expect(matcher.matches("::ffff:127.0.0.1")).toBe("::ffff:127.0.0.1");
    });

    it("cross-matches IPv4-mapped IPv6 against IPv4 CIDR rules", () => {
      const matcher = new HostMatcher(["127.0.0.0/8"]);
      expect(matcher.matches("::ffff:127.0.0.1")).toBe("127.0.0.0/8");
    });

    it("cross-matches IPv4-mapped IPv6 against exact IPv4 rule", () => {
      const matcher = new HostMatcher(["10.0.0.1"]);
      expect(matcher.matches("::ffff:10.0.0.1")).toBe("10.0.0.1");
    });

    it("cross-matches bracketed IPv4-mapped IPv6", () => {
      const matcher = new HostMatcher(["192.168.0.0/16"]);
      expect(matcher.matches("[::ffff:192.168.1.1]")).toBe("192.168.0.0/16");
    });

    it("does not cross-match non-mapped IPv6 addresses", () => {
      const matcher = new HostMatcher(["127.0.0.0/8"]);
      // ::1 is not an IPv4-mapped address
      expect(matcher.matches("::1")).toBeNull();
    });

    it("does not cross-match different IPv4-mapped prefix", () => {
      const matcher = new HostMatcher(["10.0.0.0/8"]);
      // ::fffe:10.0.0.1 has wrong prefix (not ::ffff:)
      // This will be parsed as pure hex groups, not cross-matched
      expect(matcher.matches("::fffe:a00:1")).toBeNull();
    });

    it("parses mixed notation with explicit groups", () => {
      const matcher = new HostMatcher(["0:0:0:0:0:ffff:10.0.0.1"]);
      expect(matcher.matches("::ffff:10.0.0.1")).toBe(
        "0:0:0:0:0:ffff:10.0.0.1",
      );
    });

    it("cross-matches IPv4 input against IPv4-mapped IPv6 rule", () => {
      const matcher = new HostMatcher(["::ffff:10.0.0.1"]);
      expect(matcher.matches("10.0.0.1")).toBe("::ffff:10.0.0.1");
    });

    it("cross-matches IPv4 input against IPv4-mapped IPv6 CIDR rule", () => {
      // ::ffff:0:0/96 covers all IPv4-mapped addresses
      const matcher = new HostMatcher(["::ffff:0:0/96"]);
      expect(matcher.matches("192.168.1.1")).toBe("::ffff:0:0/96");
    });
  });

  describe("construction-time validation", () => {
    it("rejects malformed IPv4 in CIDR", () => {
      expect(() => new HostMatcher(["999.0.0.0/8"])).toThrow();
    });

    it("rejects malformed IPv6 in CIDR", () => {
      expect(() => new HostMatcher(["zzzz::/10"])).toThrow();
    });
  });

  describe("multiple rules", () => {
    it("returns first matching rule", () => {
      const matcher = new HostMatcher([
        "10.0.0.0/8",
        "10.0.0.1",
        "*.example.com",
      ]);
      // The CIDR rule should match first
      expect(matcher.matches("10.0.0.1")).toBe("10.0.0.0/8");
    });

    it("matches hostname when IP rules don't match", () => {
      const matcher = new HostMatcher([
        "10.0.0.0/8",
        "metadata.google.internal",
      ]);
      expect(matcher.matches("metadata.google.internal")).toBe(
        "metadata.google.internal",
      );
    });
  });
});
