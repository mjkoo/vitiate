import { fuzz } from "vitiate";
import { parseUrl, ParseError } from "../src/url-parser.js";

fuzz("parse-url-async", async (data: Buffer) => {
  await Promise.resolve();
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
