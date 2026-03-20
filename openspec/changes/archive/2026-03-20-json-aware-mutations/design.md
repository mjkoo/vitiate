## Context

The fuzzer's mutation pipeline has three tiers: (1) main-loop havoc mutations (byte-level + token splice), (2) post-havoc I2S replacement, (3) per-corpus-entry stages (REDQUEEN, Grimoire, Unicode). All operate on raw bytes or pre-analyzed metadata (generalized gaps, unicode regions). None understand JSON structure, so targets consuming JSON rely entirely on byte-level mutations to produce valid inputs with specific string values - which is extremely unlikely.

The `FeatureDetection` system already classifies corpus content as UTF-8 vs binary to auto-enable Grimoire/Unicode (text) or REDQUEEN (binary). JSON mutations fit naturally as a refinement of the UTF-8 classification.

## Goals / Non-Goals

**Goals:**

- Enable the fuzzer to perform targeted mutations within JSON structure (replace string values, keys, array elements) without breaking JSON syntax
- Auto-detect JSON-like corpus content and enable JSON mutations without user configuration
- Provide detector-contributed seeds that give JSON mutations valid starting material
- Keep mutation overhead low - byte-range operations, no deserialization

**Non-Goals:**

- Full JSON parse/serialize (serde_json or equivalent) - too expensive and too strict on input validity
- JSON generation from scratch (that's schema-aware fuzzing, a separate effort)
- Handling JSON5, JSONC, or other JSON supersets

## Decisions

### Decision 1: Byte-range scanning instead of JSON deserialization

JSON mutations operate directly on the byte buffer by scanning for structural boundaries rather than parsing into a value tree and re-serializing. This means:

- **String slot identification**: Scan for `"..."` sequences, tracking `\` escapes. A "string slot" is a byte range `[start, end)` covering a quoted string's content (excluding the quotes themselves).
- **Value range identification**: From a string slot or known position, scan forward/backward to identify the containing value's byte range. For non-string values (`true`, `false`, `null`, numbers), the value range is the contiguous token. For objects/arrays, bracket-match to find the extent.
- **Element boundary identification**: Within arrays `[...]` and objects `{...}`, locate the boundaries of individual elements by scanning for `,` at the current nesting depth.

**Why not serde_json:** Parse + serialize is ~100ns minimum for small inputs and scales with size. At 15k exec/sec, this overhead compounds. Byte scanning is O(n) in the worst case but typically touches only a small region around the mutation point. It also accepts "almost-JSON" inputs that would fail strict parsing - this is desirable since partially-valid JSON from prior byte mutations is still worth operating on.

**Alternative considered:** Regex-based string finding. Rejected because regex engines have their own overhead and backtracking risks, and the scanning logic is simple enough to implement directly.

### Decision 2: JSON mutations as a stage, not havoc mutators

JSON mutations run as a dedicated stage in the per-corpus-entry pipeline, following the same pattern as Grimoire and Unicode. The stage is inserted after Unicode in the pipeline: ... → Unicode → JSON → None.

**Why a stage instead of havoc mutators:** `HavocScheduledMutator` stacks multiple mutations per iteration (up to 64 in the default havoc). If a JSON mutator fires as mutation #5 in a stack of 20, the remaining 15 byte-level mutations (bit flips, byte flips, block delete) will almost certainly destroy the JSON structure the JSON mutator just carefully preserved. The whole point of JSON mutations is structure-preserving replacement - stacking byte mutations on top defeats that.

Grimoire and Unicode solved this same problem the same way: a dedicated `HavocScheduledMutator` wrapping only their own mutators, where stacking only applies mutations of the same kind to each other. Each iteration starts fresh from the original corpus entry, so no accumulated byte damage.

**Stage design:**
- `HavocScheduledMutator` wrapping the 3 JSON mutators
- `max_stack_pow = 3` (2..=8 stacked mutations per iteration) - allows combining mutations (e.g., replace a key AND a value in one iteration) without excessive depth
- 1-128 iterations per interesting corpus entry (selected uniformly, same as Grimoire/Unicode)
- Each iteration: clone original corpus entry → apply JSON-only mutations → evaluate coverage
- CmpLog entries drained and discarded (same as Grimoire/Unicode - no token promotion from stage runs)
- New edges added to corpus with `SchedulerTestcaseMetadata`

**Interaction with the havoc loop:** The stage → corpus → havoc cycle provides diversity naturally. The JSON stage produces clean structural variants that go into the corpus. The main havoc loop (byte-level) evolves them further. If havoc produces something interesting, the JSON stage fires again on the new entry.

### Decision 3: Three core JSON mutators

The mutation set is intentionally small:

1. **`JsonTokenReplaceString`**: Find a random string slot, replace its content with a dictionary token. This is the highest-value mutator - it directly produces inputs like `{"x":"__proto__"}` from `{"x":"1"}` when `__proto__` is in the dictionary.

2. **`JsonTokenReplaceKey`**: Find a random object key (a string slot followed by `:`), replace its content with a dictionary token. Produces `{"__proto__":"1"}` from `{"x":"1"}`.

3. **`JsonReplaceValue`**: Find a random JSON value (string, number, boolean, null, array, object) and replace it with either a dictionary token (as a quoted string), a random type-changed value (`null`, `true`, `false`, a small integer), or another value copied from elsewhere in the same input. Tests type confusion and structural edge cases.

**Why only three:** With stacking up to 8 in the JSON stage, three mutators provide enough variety. Additional structural mutators (nest value, delete element, swap values, duplicate element) are deferred to a follow-up once the core three prove effective.

### Decision 4: Fast JSON heuristic for auto-detection

Extend `FeatureDetection::scan_corpus_utf8` to also classify UTF-8 inputs as "JSON-like." The heuristic runs per corpus entry and checks:

1. **Starts like JSON**: First non-whitespace byte is one of `{`, `[`, `"`, `0-9`, `-`, `t`, `f`, `n`.
2. **Balanced brackets**: Count of `{` + `[` equals count of `}` + `]` (exact match), using escape-aware string tracking to exclude brackets inside double-quoted strings. Inputs with zero brackets are not JSON-like (they could be bare strings/numbers, but those aren't interesting mutation targets).
3. **JSON control character frequency**: The ratio of JSON-structural bytes (`"`, `:`, `,`, `{`, `}`, `[`, `]`) to total length exceeds a minimum threshold (e.g., 5%). This distinguishes JSON from prose that happens to start with a quote.

If the majority of UTF-8 corpus entries pass the heuristic, `json_mutations_enabled` is set to `true`. This follows the same tri-state pattern (`Option<bool>` config, deferred detection, single scan resolves all features).

The detection result is stored as a field on `FeatureDetection` (`json_mutations_enabled`), checked by `begin_stage()` and stage transition logic - consistent with how `grimoire_enabled`, `unicode_enabled`, and `redqueen_enabled` work. No state metadata needed.

**Why statistical over syntactic:** A full JSON parse is too strict - it rejects inputs that are "JSON-shaped" but have minor issues (trailing commas, unquoted keys, truncated by maxlen). The heuristic's job is to answer "is the fuzzer operating on JSON-like data?" not "is this valid JSON?". False positives are cheap (JSON mutators skip non-JSON inputs fast), false negatives miss optimization opportunities.

### Decision 5: Detector auto-seeding via `getSeeds()` interface

Add a `getSeeds(): Uint8Array[]` method to the `Detector` interface, parallel to the existing `getTokens()`. Detector seeds are collected by `DetectorManager` and passed to the engine via `FuzzerConfig.detectorSeeds`, following the same pattern as `detectorTokens`.

The prototype pollution detector seeds general JSON shapes containing its dictionary tokens:

```
{"__proto__":1}
[{"__proto__":1}]
{"constructor":{"prototype":{}}}
["__proto__"]
```

These are intentionally general - they exercise prototype-sensitive code paths across many targets, not just flatted. They also serve as valid JSON starting points for JSON mutations, addressing the bootstrapping problem.

**Seed composition happens in two layers:**

1. **TypeScript** decides what to include: collects detector seeds via `DetectorManager.getSeeds()` (unless `autoSeed` is false) and passes them in `FuzzerConfig.detectorSeeds`.
2. **Rust** composes the final seed queue at the first `getNextInput()` call: user seeds (already queued via `addSeed()`) first, then detector seeds (from config), then default seeds (if `!has_user_seeds && auto_seed_enabled`).

This keeps the NAPI surface minimal - `addSeed()` is the only seed method, used exclusively for user-provided corpus. Detector seeds are config, not API calls. The engine handles composition internally.

**Why not a separate `addDetectorSeed()` method:** It would duplicate `addSeed()` with different side effects (`has_user_seeds`), creating a confusing API with two nearly-identical methods. Passing detector seeds via config makes them declarative rather than imperative and avoids the question of which method to call.

Detector seeds do not suppress default auto-seeds. When only detector seeds are present (no user corpus), default auto-seeds are also added because the auto-seed trigger (`has_user_seeds == false`) fires regardless. Both coexist, ensuring the fuzzer always has diverse starting material.

### Decision 6: Extend default seeds with JSON shapes

Add to `DEFAULT_SEEDS`:

```rust
b"[]",              // empty JSON array
b"null",            // JSON null
b"[{}]",            // array containing object
b"{\"a\":\"b\"}",   // object with string value
```

These combine with the existing `b"{}"` to cover the five common JSON top-level shapes. They're cheap (deprioritized by the scheduler if they don't produce coverage) and provide starting material for JSON mutations even when no detector seeds or user seeds are present.

### Decision 7: `autoSeed` config toggle

Add an `autoSeed` boolean config field (default `true`) that controls all automatic seeding - both detector seeds and default auto-seeds. When `autoSeed` is `false`:

- The TypeScript fuzz loop passes an empty `detectorSeeds` array in config.
- The Rust `getNextInput()` skips adding default auto-seeds even when `has_user_seeds` is `false`.
- If the resulting seed queue is empty (no user seeds either), `getNextInput()` adds a single empty buffer `b""` as the minimum viable seed. LibAFL requires at least one corpus entry to function, so this is the absolute floor.

**Why a single toggle:** Detector seeds and default auto-seeds serve the same purpose (provide starting material when the user hasn't supplied corpus). Disabling one but not the other is not a meaningful configuration - either you want the fuzzer to bootstrap itself or you're providing your own carefully curated corpus. A single toggle keeps the config surface minimal.

**Why not auto-detect:** Unlike `grimoire`/`unicode`/`redqueen`/`jsonMutations`, auto-seeding has no tri-state semantics. It's purely a user preference: "I want to control exactly what seeds the fuzzer starts with." There's no corpus to analyze for auto-detection since auto-detection happens before seeds exist.

### Decision 8: Exclude auto-seeds from feature detection scan

The `auto_seed_count` mechanism tracks how many auto-seeded entries (detector seeds + default seeds) exist in the corpus so the deferred feature detection scan can skip them. Auto-seeds are guesses about what the target might consume - they should not influence the detection algorithms that infer which mutators are appropriate.

The detection scan skips the first `auto_seed_count` corpus entries (all auto-seeds are queued before any fuzzer-discovered inputs). Only user-provided seeds and fuzzer-discovered inputs inform the detection vote. Auto-seeds remain full corpus members for all other purposes: coverage tracking, scheduling, execution metrics, and mutation.

**Why exclude auto-seeds from detection:** Auto-seeds are all valid UTF-8 (and some are JSON). Including them would bias the detection toward text-mode features before the fuzzer has observed any real signal from the target. The purpose of deferred detection is to infer target characteristics from execution feedback, not from our own assumptions about what the target consumes.

**Why user seeds ARE included:** User seeds are deliberate signal - if a user provides JSON seeds, that's real information about the target's input format. The distinction is between "the fuzzer guessed" (auto-seeds) and "the user told us" (user seeds) or "the fuzzer proved" (discovered inputs).

## Risks / Trade-offs

**[Byte scanning correctness]** The string slot scanner must handle escape sequences correctly (`\"`, `\\`, `\uXXXX`). An off-by-one in escape tracking could misidentify string boundaries, producing invalid mutations. Mitigation: thorough unit tests with adversarial escape sequences; the consequence of a bug here is a `Skipped` result (scanner fails to find valid slots), not a crash.

**[Heuristic false positives]** The JSON heuristic might classify non-JSON inputs (e.g., CSV with balanced braces, code snippets) as JSON-like, enabling JSON mutations unnecessarily. Mitigation: JSON mutators skip fast on actual non-JSON (string slot scanning fails), so false positives cost only the iteration overhead of the JSON stage (1-128 iterations that all return `Skipped`).

**[Heuristic false negatives]** Bare JSON values (`"hello"`, `42`, `true`) won't pass the bracket-balance check (zero brackets). This is acceptable - these simple values aren't interesting mutation targets for JSON-aware mutations. Objects and arrays are where structural mutations matter.

**[Detector seed bias]** Detector seeds could bias the corpus toward a specific input shape, limiting exploration diversity. Mitigation: detector seeds are few (4-6 per detector), the scheduler deprioritizes low-coverage entries quickly, and they're a small minority in the corpus at the deferred detection threshold (10+ interesting inputs).

**[Stage overhead]** Running 1-128 JSON iterations per interesting input adds execution overhead. Mitigation: iterations that produce no new coverage are fast (JSON scanning + mutation + target execution + coverage check), and the stage only fires for interesting inputs. This is the same trade-off Grimoire and Unicode make.
