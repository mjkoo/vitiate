import { fuzz } from "@vitiate/core";
// npm alias: "flatted-vulnerable" -> npm:flatted@3.4.1
// Bypasses the workspace-level pnpm override that forces flatted >= 3.4.2
import { parse } from "flatted-vulnerable";

/**
 * Simulate a realistic consumer of flatted.parse() output.
 *
 * The flatted vulnerability (GHSA-rf6f-7fwh-wjgh) doesn't directly mutate
 * prototypes inside parse() - it returns objects containing references to
 * built-in prototypes (e.g. Array.prototype). The pollution happens when
 * the caller uses the result normally (assigning properties, merging, etc).
 *
 * This harness performs a shallow property copy on the parsed result,
 * which is a common pattern (Object.assign, spread, config merge).
 * If parse() leaked a prototype reference, writing to it here triggers
 * the prototype pollution detector.
 */
function shallowMerge(target: Record<string, unknown>, source: unknown): void {
  if (typeof source !== "object" || source === null) return;
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === "object" && value !== null) {
      // Recursive merge - a very common pattern in config/options handling.
      // If `value` is actually Array.prototype, this writes to it.
      (value as Record<string, unknown>)["__merged__"] = true;
    }
    target[key] = value;
  }
}

fuzz(
  "flatted-parse-prototype-pollution",
  (data: Buffer) => {
    const input = data.toString("utf-8");
    try {
      const result = parse(input);
      // Simulate a consumer merging parsed config/data
      const config: Record<string, unknown> = {};
      shallowMerge(config, result);
    } catch {
      // flatted.parse() will throw on invalid JSON - that's expected,
      // we only care about inputs that parse successfully but pollute prototypes
    }
  },
  {
    detectors: {
      prototypePollution: true,
    },
  },
);
