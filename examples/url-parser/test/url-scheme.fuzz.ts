import { fuzz } from "@vitiate/core";
import { validateScheme, ParseError } from "../src/url-parser.js";

fuzz("validate-scheme", (data: Buffer) => {
  try {
    validateScheme(data.toString("utf-8"));
  } catch (error) {
    // ParseError from unknown/missing scheme is expected - re-throw only
    // unexpected internal errors (like the planted "javascript" scheme bug).
    if (!(error instanceof ParseError)) {
      throw error;
    }
  }
});
