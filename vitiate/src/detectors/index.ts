export { VulnerabilityError } from "./vulnerability-error.js";
export type { Detector } from "./types.js";
export { DetectorManager, KNOWN_DETECTOR_KEYS } from "./manager.js";
export {
  installHook,
  isDetectorActive,
  type ModuleHook,
} from "./module-hook.js";
export {
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./early-hooks.js";
