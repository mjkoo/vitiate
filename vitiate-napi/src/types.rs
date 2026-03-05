use napi_derive::napi;

#[napi(object)]
pub struct FuzzerConfig {
    pub max_input_len: Option<u32>,
    pub seed: Option<i64>,
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
    pub corpus_size: u32,
    pub solution_count: u32,
    pub coverage_edges: u32,
    pub execs_per_sec: f64,
}
