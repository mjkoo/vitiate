/**
 * SSRF detector: hooks Node.js HTTP request APIs and checks target
 * hostnames against a configurable blocklist/allowlist.
 */
import { type Detector, VulnerabilityError } from "./types.js";
import {
  installHook,
  isDetectorActive,
  stashAndRethrow,
  type ModuleHook,
} from "./module-hook.js";
import { HostMatcher } from "./host-matcher.js";

const ENCODER = new TextEncoder();

/** Built-in blocklist of private and reserved IP ranges. */
const BUILTIN_BLOCKLIST = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "0.0.0.0/8",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "localhost",
  "metadata.google.internal",
];

const STATIC_TOKENS = [
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",
  "10.0.0.1",
  "192.168.0.1",
  "[::1]",
  "[fc00::1]",
  "[fe80::1]",
  "http://",
  "https://",
  "localhost",
  "metadata.google.internal",
];

/**
 * Extract hostname from the arguments passed to an HTTP request function.
 *
 * Handles string URL, URL object, and options object argument forms.
 * If both URL and options are provided, options fields override URL fields.
 */
function extractHostname(
  args: unknown[],
): { hostname: string; url?: string } | null {
  const first = args[0];
  const second = args[1];

  let hostnameFromUrl: string | undefined;
  let urlString: string | undefined;

  // Extract from first argument (string URL or URL object)
  if (typeof first === "string") {
    try {
      const parsed = new URL(first);
      hostnameFromUrl = parsed.hostname;
      urlString = first;
    } catch {
      // Malformed URL — pass through
      return null;
    }
  } else if (first instanceof URL) {
    hostnameFromUrl = first.hostname;
    urlString = first.href;
  } else if (
    typeof first === "object" &&
    first !== null &&
    "url" in first &&
    typeof (first as Record<string, unknown>).url === "string"
  ) {
    // Request object — extract URL from .url property (duck-typed to avoid
    // dependency on globalThis.Request which may not exist in all environments)
    try {
      const reqUrl = (first as Record<string, unknown>).url as string;
      const parsed = new URL(reqUrl);
      hostnameFromUrl = parsed.hostname;
      urlString = reqUrl;
    } catch {
      return null;
    }
  }

  // Extract from options object.
  // When both URL/string and options are provided (e.g. http.request(url, opts)),
  // use second arg as options. Otherwise, if first arg is a plain object (not a
  // URL), treat it as options (e.g. http.request({hostname: "..."})).
  // Request-like objects (with .url property) are NOT treated as options here —
  // they were already handled above for URL extraction only.
  const options =
    typeof second === "object" && second !== null && !(second instanceof URL)
      ? (second as Record<string, unknown>)
      : typeof first === "object" &&
          first !== null &&
          !(first instanceof URL) &&
          hostnameFromUrl === undefined
        ? (first as Record<string, unknown>)
        : null;

  if (options !== null) {
    // hostname takes precedence, then host (with port stripping)
    if (typeof options["hostname"] === "string" && options["hostname"] !== "") {
      return { hostname: options["hostname"], url: urlString };
    }
    if (typeof options["host"] === "string" && options["host"] !== "") {
      const host = options["host"];
      const stripped = stripPortFromHost(host);
      return { hostname: stripped, url: urlString };
    }
  }

  if (hostnameFromUrl !== undefined) {
    return { hostname: hostnameFromUrl, url: urlString };
  }

  return null;
}

/**
 * Strip port from a host string, with IPv6 awareness.
 * "[::1]:8080" → "::1", "10.0.0.1:8080" → "10.0.0.1"
 */
function stripPortFromHost(host: string): string {
  if (host.startsWith("[")) {
    // IPv6: extract between brackets
    const closeBracket = host.indexOf("]");
    if (closeBracket !== -1) {
      return host.slice(1, closeBracket);
    }
    return host;
  }
  // IPv4 or hostname: strip after last colon if it's a port
  const lastColon = host.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterColon = host.slice(lastColon + 1);
    if (/^\d+$/.test(afterColon)) {
      return host.slice(0, lastColon);
    }
  }
  return host;
}

export class SsrfDetector implements Detector {
  readonly name = "ssrf";
  readonly tier = 2 as const;

  private readonly blockedMatcher: HostMatcher;
  private readonly allowedMatcher: HostMatcher;
  private readonly blockedHosts: readonly string[];

  private hooks: ModuleHook[] = [];
  private originalFetch: typeof globalThis.fetch | undefined;

  constructor(
    blockedHosts: string | readonly string[] = [],
    allowedHosts: string | readonly string[] = [],
  ) {
    const normalizedBlocked =
      typeof blockedHosts === "string" ? [blockedHosts] : blockedHosts;
    const normalizedAllowed =
      typeof allowedHosts === "string" ? [allowedHosts] : allowedHosts;
    this.blockedHosts = normalizedBlocked;
    this.blockedMatcher = new HostMatcher([
      ...BUILTIN_BLOCKLIST,
      ...normalizedBlocked,
    ]);
    this.allowedMatcher = new HostMatcher([...normalizedAllowed]);
  }

  getTokens(): Uint8Array[] {
    const tokens = [...STATIC_TOKENS];

    for (const host of this.blockedHosts) {
      tokens.push(host);
      // Generate URL variants only for bare IPs and hostnames (not CIDRs or wildcards)
      if (!host.includes("/") && !host.startsWith("*.")) {
        tokens.push(`http://${host}`);
        tokens.push(`https://${host}`);
      }
    }

    return tokens.map((t) => ENCODER.encode(t));
  }

  setup(): void {
    if (this.hooks.length > 0 || this.originalFetch !== undefined) {
      throw new Error("SsrfDetector.setup() called twice without teardown()");
    }
    const checkArgs =
      (functionName: string) =>
      (...args: unknown[]) => {
        const result = extractHostname(args);
        if (result === null) return;
        this.checkHost(result.hostname, functionName, result.url);
      };

    // Hook http.request, http.get, https.request, https.get
    this.hooks.push(installHook("http", "request", checkArgs("http.request")));
    this.hooks.push(installHook("http", "get", checkArgs("http.get")));
    this.hooks.push(
      installHook("https", "request", checkArgs("https.request")),
    );
    this.hooks.push(installHook("https", "get", checkArgs("https.get")));

    // Hook http2.connect — the authority/hostname is the first argument.
    this.hooks.push(
      installHook("http2", "connect", (...args: unknown[]) => {
        const authority = args[0];
        if (typeof authority !== "string") return;
        try {
          const parsed = new URL(authority);
          this.checkHost(parsed.hostname, "http2.connect", authority);
        } catch {
          // Malformed URL — pass through
        }
      }),
    );

    // Hook globalThis.fetch via direct replacement
    this.originalFetch = globalThis.fetch;
    const checkHost = this.checkHost.bind(this);
    const origFetch = this.originalFetch;
    // Explicit parameter types match the fetch() signature. The wrapper
    // delegates to origFetch unchanged; the narrower type annotation
    // avoids exposing internal unknown[] args to the type checker.
    globalThis.fetch = function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (isDetectorActive()) {
        const args: unknown[] = [input];
        if (init !== undefined) args.push(init);
        const result = extractHostname(args);
        if (result !== null) {
          try {
            checkHost(result.hostname, "fetch", result.url);
          } catch (e) {
            stashAndRethrow(e);
          }
        }
      }
      return origFetch.call(globalThis, input, init);
    };
  }

  private checkHost(
    hostname: string,
    functionName: string,
    url?: string,
  ): void {
    // Policy: allowed > blocked > allow
    if (this.allowedMatcher.matches(hostname) !== null) return;

    const matchedRule = this.blockedMatcher.matches(hostname);
    if (matchedRule !== null) {
      const context: Record<string, unknown> = {
        function: functionName,
        hostname,
        matchedRule,
      };
      if (url !== undefined) {
        context["url"] = url;
      }
      throw new VulnerabilityError(this.name, "SSRF", context);
    }
  }

  beforeIteration(): void {
    // No-op: fires during target execution.
  }

  afterIteration(): void {
    // No-op: fires during target execution.
  }

  resetIteration(): void {
    // No-op: no per-iteration state.
  }

  teardown(): void {
    for (const hook of this.hooks) {
      hook.restore();
    }
    this.hooks = [];
    if (this.originalFetch !== undefined) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }
}
