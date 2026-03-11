---
title: How Vitiate Works
description: Architecture overview of Vitiate's instrumentation, coverage tracking, and mutation engine.
---

Vitiate's fuzzing pipeline has four phases: build-time instrumentation, runtime initialization, the fuzz loop, and crash recovery.

## 1. Build-Time Instrumentation

When Vitest loads your code, Vitiate's Vite plugin intercepts each module and runs it through an [SWC](https://swc.rs/) WASM plugin before it reaches the browser/Node.js runtime.

The plugin inserts two kinds of instrumentation:

**Edge coverage counters** — At every branch point (function entry, if/else, loop, switch case, ternary), the plugin inserts a counter increment:

```js
__vitiate_cov[42]++; // edge ID 42
```

Each edge gets a deterministic ID derived from the file path and source location. The coverage map is a fixed-size array (default: 65,536 slots) where each slot counts how many times that edge was hit.

**Comparison tracing** — For equality and relational comparisons (`==`, `===`, `<`, `>=`, etc.), the plugin inserts a tracing call:

```js
__vitiate_trace_cmp(leftOperand, rightOperand, operationType);
```

This powers the CmpLog mutation strategy: the engine observes what values are being compared and uses them to generate targeted mutations.

## 2. Runtime Initialization

The setup file (`@vitiate/core/setup`) initializes two globals before any test code runs:

- `globalThis.__vitiate_cov` — A `Buffer` backed by shared memory. In fuzzing mode, this buffer is allocated by the Rust engine and shared zero-copy between JavaScript and Rust. In regression mode, it is a plain buffer (coverage is tracked but not used for feedback).
- `globalThis.__vitiate_trace_cmp` — A function that records comparison operands for the CmpLog system.

The zero-copy shared memory is critical for performance: the Rust engine reads the coverage map directly from the same memory that JavaScript writes to, with no serialization or copying.

## 3. The Fuzz Loop

Each fuzzing iteration follows this cycle:

1. **Get next input:** The Rust engine selects a corpus entry, applies mutations, and returns the mutated bytes to JavaScript via `getNextInput()`.
2. **Reset coverage:** The coverage map is zeroed so this iteration's coverage is measured in isolation.
3. **Run the target:** The fuzz target function is called with the input bytes.
4. **Report result:** JavaScript calls `reportResult()` with the outcome (ok, crash, or timeout). The Rust engine reads the coverage map to evaluate feedback.
5. **Evaluate feedback:** If the input triggered new coverage (edges not seen before), it is added to the corpus. If it caused a crash, it is saved as a solution.

### Mutation Strategies

The engine applies several mutation strategies, selected and stacked automatically:

- **Havoc:** Random byte-level mutations — bit flips, byte insertions, deletions, substitutions, and block operations. The bread-and-butter strategy that generates most of the corpus growth.
- **CmpLog / I2S:** Comparison-guided mutations. The engine observes values from `__vitiate_trace_cmp()` calls and substitutes them into the input, letting the fuzzer bypass magic-value checks like `if (header === "MAGIC")`.
- **Grimoire:** Structure-aware mutations for text-based targets. The engine identifies structural patterns in corpus entries (which bytes affect coverage vs. which are "filler") and mutates while preserving structure. Auto-enabled when corpus entries are valid UTF-8.
- **Unicode:** Character-level mutations that operate on Unicode categories and subcategories rather than raw bytes. Useful for targets that process text with locale or encoding sensitivity.

### Corpus Management

The corpus is managed by the Rust engine using LibAFL's `MaxMapFeedback`:

- An input is "interesting" if it triggers an edge counter value higher than any previous input for that edge
- Interesting inputs are added to the corpus
- The scheduler selects inputs for mutation based on recency and execution speed
- Corpus minimization (`-merge 1`) uses set-cover to find the smallest subset that maintains the same total coverage

## 4. Crash Recovery

Vitiate uses a supervisor/child process architecture:

- The **supervisor** (parent process) allocates shared memory, spawns the child, and monitors it
- The **child** (worker process) runs the actual fuzz loop
- When the child crashes or is killed (e.g., by a timeout watchdog), the supervisor reads the crashing input from shared memory, writes the crash artifact, and spawns a new child to continue fuzzing

Crash artifacts are automatically **minimized**: the engine systematically removes bytes from the crashing input to find the smallest input that still triggers the same crash. This makes crash artifacts easier to understand and debug.
