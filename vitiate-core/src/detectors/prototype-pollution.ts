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

interface PrototypeSnapshot {
  name: string;
  proto: object;
  properties: Map<string | symbol, PropertyDescriptor>;
}

function captureSnapshot(name: string, proto: object): PrototypeSnapshot {
  const properties = new Map<string | symbol, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (!descriptor) continue;
    // Skip function-valued data properties (polyfills) — these are not
    // pollution targets and should not trigger false positives.
    if ("value" in descriptor && typeof descriptor.value === "function") {
      continue;
    }
    properties.set(key, { ...descriptor });
  }
  return { name, proto, properties };
}

/** Compare two property descriptors by all six possible fields. */
function descriptorChanged(
  a: PropertyDescriptor,
  b: PropertyDescriptor,
): boolean {
  return (
    a.value !== b.value ||
    a.writable !== b.writable ||
    a.enumerable !== b.enumerable ||
    a.configurable !== b.configurable ||
    a.get !== b.get ||
    a.set !== b.set
  );
}

/** Format a property key for display in error messages. */
function formatKey(key: string | symbol): string {
  return typeof key === "symbol" ? key.toString() : key;
}

export class PrototypePollutionDetector implements Detector {
  readonly name = "prototype-pollution";
  readonly tier = 1 as const;

  private snapshots: PrototypeSnapshot[] = [];
  private dirty = true;

  getTokens(): Uint8Array[] {
    return TOKENS.map((t) => ENCODER.encode(t));
  }

  setup(): void {
    // No-op: snapshot-based detector, no hooks to install.
  }

  beforeIteration(): void {
    this.dirty = true;
    this.snapshots = MONITORED_PROTOTYPES.map(({ name, proto }) =>
      captureSnapshot(name, proto),
    );
  }

  afterIteration(): void {
    let firstFinding: VulnerabilityError | undefined;

    for (const snapshot of this.snapshots) {
      const { name, proto, properties } = snapshot;
      const currentKeys = Reflect.ownKeys(proto);

      // Check for added or modified properties
      for (const key of currentKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (!descriptor) continue;
        // Skip function-valued data properties (polyfills) — matching
        // the captureSnapshot filter.
        if ("value" in descriptor && typeof descriptor.value === "function") {
          continue;
        }

        const prev = properties.get(key);
        if (prev === undefined) {
          firstFinding ??= new VulnerabilityError(
            this.name,
            "Prototype Pollution",
            {
              prototype: name,
              property: formatKey(key),
              changeType: "added",
              isAccessor: "get" in descriptor || "set" in descriptor,
            },
          );
        } else if (descriptorChanged(descriptor, prev)) {
          firstFinding ??= new VulnerabilityError(
            this.name,
            "Prototype Pollution",
            {
              prototype: name,
              property: formatKey(key),
              changeType: "modified",
            },
          );
        }
      }

      // Check for deleted properties. getOwnPropertyDescriptor works for
      // both string and symbol keys, unlike hasOwnProperty.
      for (const key of properties.keys()) {
        if (Object.getOwnPropertyDescriptor(proto, key) === undefined) {
          firstFinding ??= new VulnerabilityError(
            this.name,
            "Prototype Pollution",
            {
              prototype: name,
              property: formatKey(key),
              changeType: "deleted",
            },
          );
        }
      }
    }

    if (firstFinding) {
      throw firstFinding;
    }
    this.dirty = false;
  }

  resetIteration(): void {
    if (!this.dirty) return;
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

    // Remove added non-function properties.
    for (const key of Reflect.ownKeys(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor) continue;
      if ("value" in descriptor && typeof descriptor.value === "function") {
        continue;
      }
      if (!properties.has(key)) {
        Reflect.deleteProperty(proto, key);
      }
    }

    // Restore all snapshotted properties unconditionally.
    // defineProperty with the original descriptor is idempotent for
    // unchanged properties.
    for (const [key, descriptor] of properties) {
      Object.defineProperty(proto, key, descriptor);
    }
  }
}
