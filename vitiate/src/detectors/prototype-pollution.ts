/**
 * Prototype pollution detector: snapshots built-in prototypes before each
 * iteration and diffs after execution to detect unauthorized modifications.
 */
import { type Detector, VulnerabilityError } from "./types.js";

const ENCODER = new TextEncoder();

/** All built-in prototypes monitored for pollution. */
const MONITORED_PROTOTYPES: Array<{ name: string; proto: object }> = [
  { name: "Object.prototype", proto: Object.prototype },
  { name: "Array.prototype", proto: Array.prototype },
  { name: "String.prototype", proto: String.prototype },
  { name: "Number.prototype", proto: Number.prototype },
  { name: "Boolean.prototype", proto: Boolean.prototype },
  { name: "Function.prototype", proto: Function.prototype },
  { name: "RegExp.prototype", proto: RegExp.prototype },
  { name: "Date.prototype", proto: Date.prototype },
  { name: "Map.prototype", proto: Map.prototype },
  { name: "Set.prototype", proto: Set.prototype },
  { name: "Promise.prototype", proto: Promise.prototype },
  { name: "Error.prototype", proto: Error.prototype },
  { name: "WeakMap.prototype", proto: WeakMap.prototype },
  { name: "WeakSet.prototype", proto: WeakSet.prototype },
  { name: "ArrayBuffer.prototype", proto: ArrayBuffer.prototype },
  { name: "Int8Array.prototype", proto: Int8Array.prototype },
  { name: "Uint8Array.prototype", proto: Uint8Array.prototype },
  { name: "Int16Array.prototype", proto: Int16Array.prototype },
  { name: "Uint16Array.prototype", proto: Uint16Array.prototype },
  { name: "Int32Array.prototype", proto: Int32Array.prototype },
  { name: "Uint32Array.prototype", proto: Uint32Array.prototype },
  { name: "Float32Array.prototype", proto: Float32Array.prototype },
  { name: "Float64Array.prototype", proto: Float64Array.prototype },
  { name: "BigInt64Array.prototype", proto: BigInt64Array.prototype },
  { name: "BigUint64Array.prototype", proto: BigUint64Array.prototype },
];

const TOKENS = [
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
];

interface PropertySnapshot {
  value: unknown;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
}

interface PrototypeSnapshot {
  name: string;
  proto: object;
  properties: Map<string, PropertySnapshot>;
}

function captureSnapshot(name: string, proto: object): PrototypeSnapshot {
  const properties = new Map<string, PropertySnapshot>();
  for (const key of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    // Skip accessor properties (get/set) — they have no value field.
    // Skip function-valued data properties (polyfills).
    if (
      descriptor &&
      "value" in descriptor &&
      typeof descriptor.value !== "function"
    ) {
      properties.set(key, {
        value: descriptor.value,
        writable: descriptor.writable ?? false,
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
      });
    }
  }
  return { name, proto, properties };
}

export class PrototypePollutionDetector implements Detector {
  readonly name = "prototype-pollution";
  readonly tier = 1 as const;

  private snapshots: PrototypeSnapshot[] = [];

  getTokens(): Uint8Array[] {
    return TOKENS.map((t) => ENCODER.encode(t));
  }

  setup(): void {
    // No-op: snapshot-based detector, no hooks to install.
  }

  beforeIteration(): void {
    this.snapshots = MONITORED_PROTOTYPES.map(({ name, proto }) =>
      captureSnapshot(name, proto),
    );
  }

  afterIteration(): void {
    let firstFinding: VulnerabilityError | undefined;

    for (const snapshot of this.snapshots) {
      const { name, proto, properties } = snapshot;
      const currentKeys = Object.getOwnPropertyNames(proto);

      // Check for added or modified properties
      for (const key of currentKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        // Skip accessor properties (get/set) and function-valued data
        // properties (polyfills) — matching the captureSnapshot filter.
        if (
          descriptor &&
          (!("value" in descriptor) || typeof descriptor.value === "function")
        ) {
          continue;
        }

        const prev = properties.get(key);
        if (prev === undefined) {
          firstFinding ??= new VulnerabilityError(
            this.name,
            "Prototype Pollution",
            {
              prototype: name,
              property: key,
              changeType: "added",
              newValue: descriptor?.value,
            },
          );
        } else if (descriptor && descriptor.value !== prev.value) {
          firstFinding ??= new VulnerabilityError(
            this.name,
            "Prototype Pollution",
            {
              prototype: name,
              property: key,
              changeType: "modified",
              originalValue: prev.value,
              newValue: descriptor.value,
            },
          );
        }
      }

      // Check for deleted properties
      for (const key of properties.keys()) {
        if (!Object.prototype.hasOwnProperty.call(proto, key)) {
          // Property was deleted entirely (not replaced by a function/polyfill)
          firstFinding ??= new VulnerabilityError(
            this.name,
            "Prototype Pollution",
            {
              prototype: name,
              property: key,
              changeType: "deleted",
              originalValue: properties.get(key)?.value,
            },
          );
        }
        // If the property exists but is now a function, we ignore it
        // (polyfill scenario). If it exists and is non-function with a
        // different value, the "modified" check above already caught it.
      }
    }

    if (firstFinding) {
      throw firstFinding;
    }
  }

  resetIteration(): void {
    for (const snapshot of this.snapshots) {
      this.restorePrototype(snapshot);
    }
  }

  teardown(): void {
    this.snapshots = [];
  }

  /** Restore a prototype to its snapshot state. */
  private restorePrototype(snapshot: PrototypeSnapshot): void {
    const { proto, properties } = snapshot;

    // Remove added non-function data properties.
    // Skip accessor properties (get/set) and function-valued data properties,
    // matching the captureSnapshot filter — these were never snapshotted.
    for (const key of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor || !("value" in descriptor)) continue;
      if (typeof descriptor.value === "function") continue;
      if (!properties.has(key)) {
        delete (proto as Record<string, unknown>)[key];
      }
    }

    // Restore modified/deleted properties
    for (const [key, snap] of properties) {
      const current = Object.getOwnPropertyDescriptor(proto, key);
      if (!current || current.value !== snap.value) {
        Object.defineProperty(proto, key, {
          value: snap.value,
          writable: snap.writable,
          enumerable: snap.enumerable,
          configurable: snap.configurable,
        });
      }
    }
  }
}
