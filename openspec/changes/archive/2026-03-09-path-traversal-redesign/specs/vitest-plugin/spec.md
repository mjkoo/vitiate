## ADDED Requirements

### Requirement: Hook import bail-out optimization

The `rewriteHookedImports` function SHALL perform a quick bail-out check before parsing: if the source code does not reference any hooked module in an import-like context, the function SHALL return `null` without invoking `es-module-lexer`.

The bail-out check for each hooked module SHALL use patterns that match how the module appears in import or require statements, not bare substring matching. For `child_process`, `code.includes("child_process")` is sufficiently specific. For `fs`, the check SHALL use patterns that avoid matching unrelated occurrences of the substring "fs" (e.g., in identifiers like `offset`, function names, or comments). Suitable patterns include checking for `'"fs"'`, `"'fs'"`, `'"fs/'`, or `"'fs/"`.

The bail-out is a performance optimization only — false positives (proceeding to parse when no hooked imports exist) are acceptable, but false negatives (skipping a file that does contain hooked imports) are not.

#### Scenario: File without fs or child_process imports skips parsing

- **WHEN** `rewriteHookedImports` is called with source code that does not contain any hooked module import
- **THEN** the function SHALL return `null` without calling `es-module-lexer`

#### Scenario: File with fs import proceeds to parsing

- **WHEN** `rewriteHookedImports` is called with source code containing `import { readFile } from "fs"`
- **THEN** the bail-out check SHALL detect the hooked module reference
- **AND** the function SHALL proceed to parse and potentially rewrite imports

#### Scenario: File containing "fs" in identifier does not trigger parsing

- **WHEN** `rewriteHookedImports` is called with source code containing `const offset = 42` but no `fs` module import
- **THEN** the bail-out check SHALL NOT treat `offset` as a reference to the `fs` module
- **AND** the function SHALL return `null` (assuming no other hooked module is referenced)

#### Scenario: File with fs/promises import proceeds to parsing

- **WHEN** `rewriteHookedImports` is called with source code containing `import { readFile } from "fs/promises"`
- **THEN** the bail-out check SHALL detect the hooked module reference
- **AND** the function SHALL proceed to parse and potentially rewrite imports
