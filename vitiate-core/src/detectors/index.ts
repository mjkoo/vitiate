export { VulnerabilityError } from "./types.js";
export type { Detector } from "./types.js";
export {
  DetectorManager,
  KNOWN_DETECTOR_KEYS,
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./manager.js";
export {
  installHook,
  isDetectorActive,
  type ModuleHook,
} from "./module-hook.js";
