## MODIFIED Requirements

### Requirement: Plugin factory function

The `vitiatePlugin(options?)` function SHALL accept the following option change:

- The `cacheDir` option (string, optional) SHALL be replaced by `dataDir` (string, optional). When set, the value SHALL be resolved relative to the Vite project root and stored as the global test data root directory. When not set, the default is `.vitiate/` relative to the project root.

All other plugin options (`instrument`, `fuzz`, `coverageMapSize`) SHALL remain unchanged.

#### Scenario: Plugin with dataDir

- **WHEN** `vitiatePlugin({ dataDir: ".fuzzing" })` is called
- **THEN** the plugin's `config()` hook stores the absolute path of `.fuzzing` resolved relative to the Vite project root as module-scoped state
- **AND** the corpus management module uses this value as the test data root

#### Scenario: Plugin without dataDir uses default

- **WHEN** `vitiatePlugin()` is called without `dataDir`
- **THEN** the test data root defaults to `.vitiate/` relative to the project root

#### Scenario: cacheDir option no longer recognized

- **WHEN** `vitiatePlugin({ cacheDir: ".fuzz-cache" })` is called
- **THEN** the `cacheDir` option SHALL be ignored or produce a warning (it is no longer a valid option)
