import { fuzz } from "@vitiate/core";
// npm alias: "flatted-vulnerable" -> npm:flatted@3.4.1
// Bypasses the workspace-level pnpm override that forces flatted >= 3.4.2
import { parse } from "flatted-vulnerable";

// Detector config (prototypePollution: true) is set in the plugin-level
// vitest config - no per-test override needed. autoSeed is disabled so
// the E2E test proves the mutation engine finds the vulnerability without
// hand-crafted seeds - detector tokens (__proto__ etc.) in the dictionary
// are sufficient.
fuzz(
  "flatted-parse-prototype-pollution",
  (data: Buffer) => {
    const input = data.toString("utf-8");
    try {
      return parse(input);
    } catch {
      // flatted.parse() will throw on invalid JSON - that's expected,
      // we only care about inputs that parse successfully but pollute prototypes
    }
  },
  { autoSeed: false },
);
