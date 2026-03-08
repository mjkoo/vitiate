export { VulnerabilityError } from "./vulnerability-error.js";
export type { Detector } from "./types.js";
export { DetectorManager } from "./manager.js";
export {
  installHook,
  setDetectorActive,
  isDetectorActive,
  type ModuleHook,
} from "./module-hook.js";
export {
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./early-hooks.js";
