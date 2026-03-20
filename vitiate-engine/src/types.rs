use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct FuzzerConfig {
    pub max_input_len: Option<u32>,
    pub seed: Option<i64>,
    /// Grimoire structure-aware fuzzing control.
    /// `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
    pub grimoire: Option<bool>,
    /// Unicode-aware mutation control.
    /// `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
    pub unicode: Option<bool>,
    /// REDQUEEN transform-aware mutation control.
    /// `true` = force enable, `false` = force disable, absent = auto-detect (inverted: enabled for binary corpus).
    pub redqueen: Option<bool>,
    /// JSON mutation stage control.
    /// `true` = force enable, `false` = force disable, absent = auto-detect from corpus content.
    pub json_mutations: Option<bool>,
    /// Automatic seeding control. Default `true` when absent.
    /// When `false`, both detector seeds and default auto-seeds are suppressed.
    pub auto_seed: Option<bool>,
    /// Absolute path to an AFL/libfuzzer-format dictionary file.
    /// If provided, tokens are parsed via `Tokens::from_file()` and seeded
    /// into state metadata before any fuzz iterations execute.
    pub dictionary_path: Option<String>,
    /// Pre-seeded dictionary tokens from active bug detectors.
    /// Inserted into `Tokens` state metadata after user dictionary tokens.
    /// Exempt from `MAX_DICTIONARY_SIZE` cap; marked as pre-promoted to
    /// prevent CmpLog from re-discovering them.
    pub detector_tokens: Option<Vec<Buffer>>,
    /// Detector-contributed seed inputs queued during seed composition.
    pub detector_seeds: Option<Vec<Buffer>>,
}

#[napi]
pub enum ExitKind {
    Ok = 0,
    Crash = 1,
    Timeout = 2,
}

/// Result of evaluating a single fuzzing iteration.
///
/// These outcomes are mutually exclusive by design: LibAFL's `StdFuzzer::check_results()`
/// evaluates the objective (crash/timeout) first, and only evaluates coverage feedback if the
/// objective did not fire. An input is classified into exactly one of these categories.
#[derive(Debug, PartialEq)]
#[napi]
pub enum IterationResult {
    /// Input did not trigger new coverage or a crash/timeout.
    None = 0,
    /// Input discovered new coverage; added to the corpus.
    Interesting = 1,
    /// Input triggered a crash or timeout; added to the solutions corpus.
    Solution = 2,
}

#[napi(object)]
pub struct FuzzerStats {
    pub total_execs: i64,
    pub calibration_execs: i64,
    pub corpus_size: u32,
    pub solution_count: u32,
    pub coverage_edges: u32,
    pub coverage_features: u32,
    pub execs_per_sec: f64,
}

// Exit reason constants for BatchResult. Using string constants instead of a
// Rust enum because napi(string_enum) generates PascalCase values that would
// not match the existing lowercase JS comparisons. Constants give compile-time
// safety on the Rust side while keeping the JS interface unchanged.
pub(crate) const BATCH_EXIT_COMPLETED: &str = "completed";
pub(crate) const BATCH_EXIT_INTERESTING: &str = "interesting";
pub(crate) const BATCH_EXIT_SOLUTION: &str = "solution";
pub(crate) const BATCH_EXIT_ERROR: &str = "error";

/// Result of a batched fuzzing iteration loop.
///
/// Returned by `Fuzzer.runBatch()`. The batch exits early on the first
/// interesting input, solution, or unrecoverable error.
#[napi(object)]
pub struct BatchResult {
    /// Number of iterations completed in this batch (including the triggering
    /// iteration, if any).
    pub executions_completed: u32,
    /// Why the batch ended: `"completed"`, `"interesting"`, `"solution"`, or `"error"`.
    pub exit_reason: String,
    /// Copy of the input that caused early exit. Present when `exitReason`
    /// is not `"completed"`.
    pub triggering_input: Option<Buffer>,
    /// The `ExitKind` that triggered a solution (1=Crash, 2=Timeout).
    /// Present only when `exitReason` is `"solution"`.
    pub solution_exit_kind: Option<u32>,
}
