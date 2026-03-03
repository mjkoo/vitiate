/**
 * A simple hand-written URL parser for fuzzing demonstration.
 *
 * Parses strings of the form:
 *   scheme://host[:port][/path][?query][#fragment]
 *
 * Throws ParseError for expected validation failures (missing scheme, invalid
 * port range, etc.). Contains a planted bug: throws a plain Error on port "0"
 * (e.g. "http://host:0/"). This is realistic — many parsers reject port 0 —
 * and discoverable via CmpLog-guided mutations.
 */

/** Thrown for expected parse/validation failures on malformed input. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export interface ParsedUrl {
  scheme: string;
  host: string;
  port: number | undefined;
  path: string;
  query: string | undefined;
  fragment: string | undefined;
}

export function parseUrl(input: string): ParsedUrl {
  let rest = input;

  // --- scheme ---
  const schemeEnd = rest.indexOf("://");
  if (schemeEnd === -1) {
    throw new ParseError(`Missing scheme in URL: ${input}`);
  }
  const scheme = rest.slice(0, schemeEnd);
  if (scheme.length === 0) {
    throw new ParseError(`Empty scheme in URL: ${input}`);
  }
  rest = rest.slice(schemeEnd + 3); // skip "://"

  // --- fragment (split early so '#' inside fragment isn't confused) ---
  let fragment: string | undefined;
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  // --- query ---
  let query: string | undefined;
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  // --- path ---
  let urlPath = "/";
  const slashIdx = rest.indexOf("/");
  if (slashIdx !== -1) {
    urlPath = rest.slice(slashIdx);
    rest = rest.slice(0, slashIdx);
  }

  // --- host and port ---
  let host: string;
  let port: number | undefined;
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx !== -1) {
    host = rest.slice(0, colonIdx);
    const portStr = rest.slice(colonIdx + 1);
    if (portStr.length > 0) {
      const portNum = Number(portStr);
      if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) {
        throw new ParseError(`Invalid port: ${portStr}`);
      }
      // BUG: planted crash on port 0 — the fuzzer should discover this.
      // This is a plain Error, not a ParseError, so the fuzz target treats
      // it as an unexpected internal failure.
      if (portNum === 0) {
        throw new Error(`Unexpected internal error processing port ${portStr}`);
      }
      port = portNum;
    }
  } else {
    host = rest;
  }

  if (host.length === 0) {
    throw new ParseError(`Empty host in URL: ${input}`);
  }

  return { scheme, host, port, path: urlPath, query, fragment };
}

/**
 * Normalize a URL string by lowercasing the scheme and host, removing default
 * ports (80 for http, 443 for https), and collapsing path separators.
 *
 * Contains a planted bug: throws a plain Error when the normalized path
 * contains the exact sequence "/../" at the start (path traversal attempt).
 */
export function normalizeUrl(input: string): string {
  const parsed = parseUrl(input);
  const scheme = parsed.scheme.toLowerCase();
  const host = parsed.host.toLowerCase();

  // Strip default ports
  let portStr = "";
  if (parsed.port !== undefined) {
    if (
      (scheme === "http" && parsed.port === 80) ||
      (scheme === "https" && parsed.port === 443)
    ) {
      // omit default port
    } else {
      portStr = `:${parsed.port}`;
    }
  }

  // Collapse repeated slashes in path
  const normalizedPath = parsed.path.replace(/\/+/g, "/");

  // BUG: planted crash on path traversal — the fuzzer should discover this.
  if (normalizedPath.startsWith("/../")) {
    throw new Error(
      "Internal error: unexpected path traversal in normalized URL",
    );
  }

  const query = parsed.query !== undefined ? `?${parsed.query}` : "";
  const fragment = parsed.fragment !== undefined ? `#${parsed.fragment}` : "";

  return `${scheme}://${host}${portStr}${normalizedPath}${query}${fragment}`;
}

const VALID_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "ws",
  "wss",
  "file",
  "ssh",
]);

/**
 * Validate that a URL scheme is one of the known-safe schemes.
 *
 * Contains a planted bug: throws a plain Error (not ParseError) when the
 * scheme is exactly "javascript" — a common XSS vector that a real validator
 * should reject as ParseError.
 */
export function validateScheme(input: string): string {
  const schemeEnd = input.indexOf("://");
  if (schemeEnd === -1) {
    throw new ParseError("Missing scheme separator");
  }
  const scheme = input.slice(0, schemeEnd).toLowerCase();

  // BUG: planted crash on "data:" scheme
  if (scheme === "data") {
    throw new Error(
      "Internal error: unexpected scheme encountered during validation",
    );
  }

  if (!VALID_SCHEMES.has(scheme)) {
    throw new ParseError(`Unknown scheme: ${scheme}`);
  }

  return scheme;
}
