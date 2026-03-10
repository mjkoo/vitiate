import { fuzz } from "@vitiate/core";
import { parseUrl, normalizeUrl, ParseError } from "../src/url-parser.js";

fuzz("parse-url", (data: Buffer) => {
  try {
    parseUrl(data.toString("utf-8"));
  } catch (error) {
    // Expected parse validation errors on malformed input are fine —
    // re-throw only unexpected internal errors (like the planted port-0 bug).
    if (!(error instanceof ParseError)) {
      throw error;
    }
  }
});

fuzz("normalize-url", (data: Buffer) => {
  try {
    normalizeUrl(data.toString("utf-8"));
  } catch (error) {
    // ParseError from malformed input is expected — re-throw only
    // unexpected internal errors (like the planted path-traversal bug).
    if (!(error instanceof ParseError)) {
      throw error;
    }
  }
});
