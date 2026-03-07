/**
 * Vitest setup file - auto-initializes globals on import.
 */
export { initGlobals } from "./globals.js";
import { initGlobals } from "./globals.js";
import { warnUnknownVitiateEnvVars } from "./config.js";

// Auto-init when loaded as a Vitest setup file
await initGlobals();
warnUnknownVitiateEnvVars();
