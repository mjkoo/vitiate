## Why

Users who want coverage-guided fuzzing of their dependencies (e.g., finding bugs in libraries they consume) cannot opt in. Three independent exclusion layers prevent node_modules instrumentation - a configurable `createFilter` exclude pattern in the instrument plugin, a hardcoded bail-out in the hooks plugin, and Vitest's default externalization of node_modules - and there is no single configuration point to override all three.

## What Changes

- Unify all three node_modules exclusion layers behind the existing `InstrumentOptions.exclude` config. When a user removes `**/node_modules/**` from exclude (or replaces it with a narrower pattern), the SWC instrumentation plugin and the hooks plugin both respect the change, and Vitest dependency inlining is configured automatically.
- When node_modules instrumentation is enabled (exclude pattern no longer covers node_modules), automatically configure Vitest's `server.deps.inline` so that the target packages are pulled through the Vite transform pipeline instead of being externalized.
- Vitiate's own packages (`@vitiate/core`, `@vitiate/engine`, `@vitiate/swc-plugin`) remain unconditionally excluded regardless of user configuration (already handled, no change needed).

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `vitest-plugin`: The hooks plugin's node_modules bail-out must respect the resolved exclude patterns instead of being hardcoded. The instrument plugin must configure `server.deps.inline` when node_modules are not excluded.

## Impact

- `vitiate-core/src/plugin.ts`: Remove hardcoded node_modules check in hooks plugin transform; replace with filter-aware check. Add `server.deps.inline` configuration in instrument plugin's `config()` hook.
- `vitiate-core/src/config.ts`: Possibly extend `resolveInstrumentOptions` to expose whether node_modules are excluded (for the inline deps logic).
- Existing behavior unchanged for default configuration - the default exclude already contains `**/node_modules/**`.
