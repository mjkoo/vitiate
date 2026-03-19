use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, SchedulerTestcaseMetadata, Testcase};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::map::MapFeedbackMetadata;
use libafl::feedbacks::{
    CrashFeedback, MapIndexesMetadata, MaxMapFeedback, StateInitializer, TimeoutFeedback,
};
use libafl::inputs::BytesInput;
use libafl::mutators::Tokens;
use libafl::mutators::grimoire::{
    GrimoireExtensionMutator, GrimoireRandomDeleteMutator, GrimoireRecursiveReplacementMutator,
    GrimoireStringReplacementMutator,
};
use libafl::mutators::token_mutations::{AflppRedQueen, TokenInsert, TokenReplace};
use libafl::mutators::unicode::{
    UnicodeCategoryRandMutator, UnicodeCategoryTokenReplaceMutator, UnicodeSubcategoryRandMutator,
    UnicodeSubcategoryTokenReplaceMutator,
};
use libafl::mutators::{
    HavocMutationsType, HavocScheduledMutator, Mutator, havoc_mutations, tokens_mutations,
};
use libafl::observers::StdMapObserver;
use libafl::observers::cmp::CmpValuesMetadata;
use libafl::observers::map::{CanTrack, ExplicitTracking};
use libafl::schedulers::minimizer::TopRatedsMetadata;
use libafl::schedulers::powersched::{PowerSchedule, SchedulerMetadata};
use libafl::schedulers::testcase_score::CorpusPowerTestcaseScore;
use libafl::schedulers::{MinimizerScheduler, ProbabilitySamplingScheduler, Scheduler};
use libafl::stages::UnicodeIdentificationMetadata;
use libafl::state::{HasCorpus, HasExecutions, HasMaxSize, HasSolutions, StdState};
use libafl::{HasMetadata, HasNamedMetadata};
use libafl_bolts::rands::StdRand;
use libafl_bolts::tuples::{Merge, tuple_list, tuple_list_type};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::shmem_stash::{ShmemHandle, ShmemView};
use crate::types::{
    BATCH_EXIT_COMPLETED, BATCH_EXIT_ERROR, BATCH_EXIT_INTERESTING, BATCH_EXIT_SOLUTION,
    BatchResult, ExitKind, FuzzerConfig, FuzzerStats, IterationResult,
};
use crate::watchdog::{
    Watchdog, WatchdogShared, arm_watchdog_shared, disarm_watchdog_shared, run_target_with_shared,
    run_target_without_watchdog, shutdown_watchdog_shared,
};

mod calibration;
mod cmplog_metadata;
mod colorization;
mod coverage;
mod feature_detection;
mod generalization;
mod grimoire;
mod mutator;
mod stages;
#[cfg(test)]
mod tests;
mod token_tracker;
mod unicode;
use feature_detection::FeatureDetection;
use mutator::I2SSpliceReplace;
pub(crate) use stages::StageState;

use calibration::CalibrationState;
use cmplog_metadata::{build_aflpp_cmp_metadata, extract_tokens_from_cmplog, flatten_orig_cmpvals};
use token_tracker::TokenTracker;

pub(crate) const EDGES_OBSERVER_NAME: &str = "edges";
const DEFAULT_MAX_INPUT_LEN: u32 = 4096;

// Default seeds for auto-seeding when corpus is empty.
const DEFAULT_SEEDS: &[&[u8]] = &[
    b"",                 // empty
    b"\n",               // minimal valid ASCII
    b"0",                // numeric boundary
    b"\x00\x00\x00\x00", // binary/null-byte handling
    b"{}",               // empty JSON object
    b"test",             // short printable ASCII
];

/// Maximum power-of-two stacked mutations per Grimoire iteration (2^3 = 8 max).
const GRIMOIRE_MAX_STACK_POW: usize = 3;

/// Maximum power-of-two stacked mutations per unicode iteration (2^7 = 128 max).
/// Character-level mutations are small individually, so deeper stacking is appropriate.
const UNICODE_MAX_STACK_POW: usize = 7;

/// Maximum random iteration count for I2S and Grimoire stages (selected uniformly from 1..=N).
const STAGE_MAX_ITERATIONS: usize = 128;

/// Maximum input size for generalization. Inputs exceeding this are skipped.
const MAX_GENERALIZED_LEN: usize = 8192;

// Concrete LibAFL type aliases.
type CovObserver = StdMapObserver<'static, u8, false>;
/// CovObserver with index tracking enabled, needed by `MinimizerScheduler`.
type TrackingCovObserver = ExplicitTracking<CovObserver, true, false>;
type FuzzerFeedback = MaxMapFeedback<CovObserver, CovObserver>;
type CrashObjective = CrashFeedback;
type TimeoutObjective = TimeoutFeedback;
type FuzzerBaseScheduler = ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>;
type FuzzerScheduler = MinimizerScheduler<
    FuzzerBaseScheduler,
    libafl::schedulers::LenTimeMulTestcasePenalty,
    BytesInput,
    MapIndexesMetadata,
    TrackingCovObserver,
>;
type TokensMutationsType = tuple_list_type!(TokenInsert, TokenReplace);
type FuzzerMutationsType = <HavocMutationsType as Merge<TokensMutationsType>>::MergeResult;
type FuzzerMutator = HavocScheduledMutator<FuzzerMutationsType>;
type GrimoireMutationsType = tuple_list_type!(
    GrimoireExtensionMutator<BytesInput>,
    GrimoireRecursiveReplacementMutator<BytesInput>,
    GrimoireStringReplacementMutator<BytesInput>,
    GrimoireRandomDeleteMutator<BytesInput>,
    GrimoireRandomDeleteMutator<BytesInput>,
);
type GrimoireMutator = HavocScheduledMutator<GrimoireMutationsType>;
/// Unicode input type: (BytesInput, UnicodeIdentificationMetadata) tuple.
type UnicodeInput = (BytesInput, UnicodeIdentificationMetadata);
/// Unicode mutator pool: 1x category + 4x subcategory for both random and token replacement.
/// Subcategory mutators are weighted 4x relative to category mutators.
type UnicodeMutationsType = tuple_list_type!(
    UnicodeCategoryRandMutator,
    UnicodeSubcategoryRandMutator,
    UnicodeSubcategoryRandMutator,
    UnicodeSubcategoryRandMutator,
    UnicodeSubcategoryRandMutator,
    UnicodeCategoryTokenReplaceMutator,
    UnicodeSubcategoryTokenReplaceMutator,
    UnicodeSubcategoryTokenReplaceMutator,
    UnicodeSubcategoryTokenReplaceMutator,
    UnicodeSubcategoryTokenReplaceMutator,
);
type UnicodeMutator = HavocScheduledMutator<UnicodeMutationsType>;
type FuzzerState =
    StdState<InMemoryCorpus<BytesInput>, BytesInput, StdRand, InMemoryCorpus<BytesInput>>;

#[napi]
pub struct Fuzzer {
    state: FuzzerState,
    scheduler: FuzzerScheduler,
    feedback: FuzzerFeedback,
    crash_objective: CrashObjective,
    timeout_objective: TimeoutObjective,
    mutator: FuzzerMutator,
    i2s_mutator: I2SSpliceReplace,
    map_ptr: *mut u8,
    map_len: usize,
    _coverage_map: Buffer,
    max_input_len: u32,
    total_execs: u64,
    calibration_execs: u64,
    solution_count: u32,
    start_time: Instant,
    last_input: Option<BytesInput>,
    /// Corpus ID selected by the most recent `get_next_input()` - parent for depth tracking.
    last_corpus_id: Option<CorpusId>,
    /// Calibration lifecycle state (populated between calibrate_run / calibrate_finish).
    calibration: CalibrationState,
    /// Coverage map indices observed to differ between calibration runs (grows monotonically).
    unstable_entries: HashSet<usize>,
    /// CmpLog token candidate tracking and promotion into the mutation dictionary.
    token_tracker: TokenTracker,
    /// Tracks the lifecycle of the current multi-execution stage (I2S, etc.).
    stage_state: StageState,
    /// Corpus ID of the most recently added interesting input. Set by
    /// `report_result()` when it returns `Interesting`, consumed (cleared) by
    /// `begin_stage()`.
    last_interesting_corpus_id: Option<CorpusId>,
    /// The most recently generated stage input, stored so that `advance_stage()`
    /// can add it to the corpus if coverage evaluation deems it interesting.
    last_stage_input: Option<Vec<u8>>,
    /// Grimoire scheduled mutator operating on `GeneralizedInputMetadata`.
    grimoire_mutator: GrimoireMutator,
    /// REDQUEEN multi-mutator for transform-aware targeted replacements.
    redqueen_mutator: AflppRedQueen,
    /// Whether REDQUEEN ran for the current corpus entry (used to skip I2S).
    redqueen_ran_for_entry: bool,
    /// Unicode scheduled mutator operating on `(BytesInput, UnicodeIdentificationMetadata)`.
    unicode_mutator: UnicodeMutator,
    /// Feature auto-detection state for Grimoire, unicode, and REDQUEEN.
    features: FeatureDetection,
    /// Seeds awaiting initial verbatim evaluation (no mutation).
    /// Populated by `queue_seed()`, drained by `get_next_input()`.
    unevaluated_seeds: VecDeque<BytesInput>,
    /// Whether `add_seed()` was called at least once (user-provided seeds).
    has_user_seeds: bool,
    /// Owned watchdog shared state for arm/disarm/run_target during batch iterations.
    /// `None` when no watchdog was provided at construction.
    watchdog_shared: Option<Arc<WatchdogShared>>,
    /// Owned watchdog thread handle for deterministic shutdown.
    /// `None` when no watchdog was provided or after shutdown.
    watchdog_thread_handle: Option<thread::JoinHandle<()>>,
    /// Shmem view for stashing inputs during batch iterations.
    /// `None` when no shmem handle was provided at construction.
    shmem_view: Option<ShmemView>,
    /// Pre-allocated input buffer for `runBatch`. Reused across all batch
    /// calls to avoid per-iteration `Buffer` allocation. The buffer is
    /// `max_input_len` bytes and its contents are valid only during a single
    /// callback invocation. Stored to prevent V8 GC from reclaiming the
    /// backing memory referenced by `input_buffer_ptr`.
    _input_buffer: Buffer,
    /// Raw pointer into `input_buffer` for zero-copy writes during `runBatch`.
    input_buffer_ptr: *mut u8,
}

// SAFETY: `Fuzzer` contains `*mut u8` fields which are `!Send`. napi-rs
// requires `Send` for `#[napi]` classes. The raw pointers point into `Buffer`
// objects held as owned fields (`_coverage_map`, `input_buffer`), which
// prevents V8 GC from reclaiming the backing memory. Node.js `Buffer` uses a
// non-detachable `ArrayBuffer`, so the memory cannot be reallocated or moved.
// The `ShmemView` field contains a raw pointer into OS-level shared memory
// that is valid for the lifetime of the parent `ShmemHandle` (which outlives
// the Fuzzer in the fuzz loop). The `Fuzzer` is only ever used on the Node.js
// main thread and is never sent across threads.
unsafe impl Send for Fuzzer {}

#[napi]
impl Fuzzer {
    #[napi(constructor)]
    pub fn new(
        mut coverage_map: Buffer,
        config: Option<FuzzerConfig>,
        watchdog: Option<&mut Watchdog>,
        shmem_handle: Option<&ShmemHandle>,
    ) -> Result<Self> {
        let max_input_len = config
            .as_ref()
            .and_then(|c| c.max_input_len)
            .unwrap_or(DEFAULT_MAX_INPUT_LEN);
        let seed = config.as_ref().and_then(|c| c.seed);
        let grimoire_override = config.as_ref().and_then(|c| c.grimoire);
        let unicode_override = config.as_ref().and_then(|c| c.unicode);
        let redqueen_override = config.as_ref().and_then(|c| c.redqueen);
        let dictionary_path = config.as_ref().and_then(|c| c.dictionary_path.clone());
        let detector_tokens: Option<Vec<Vec<u8>>> = config
            .as_ref()
            .and_then(|c| c.detector_tokens.as_ref())
            .map(|tokens| tokens.iter().map(|b| b.to_vec()).collect());

        let map_ptr = coverage_map.as_mut_ptr();
        let map_len = coverage_map.len();

        // Create a temporary observer to initialize feedback.
        // The feedback only stores a Handle (name), not the observer itself.
        // SAFETY: `map_ptr` is valid for `map_len` bytes - it was just obtained
        // from `Buffer::as_mut_ptr()` and the `Buffer` is still alive (owned by
        // `coverage_map` on the stack). The observer is dropped before the
        // constructor returns (line below), so no aliasing persists.
        let temp_observer =
            unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };

        let mut feedback = MaxMapFeedback::new(&temp_observer);
        let mut crash_objective = CrashFeedback::new();
        let mut timeout_objective = TimeoutFeedback::new();

        let rand = match seed {
            // Negative i64 seeds intentionally wrap to u64 - JS has no native u64,
            // so callers pass i64 and we reinterpret the bits.
            Some(s) => StdRand::with_seed(s as u64),
            None => StdRand::new(),
        };

        let mut state = StdState::new(
            rand,
            InMemoryCorpus::<BytesInput>::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut crash_objective,
        )
        .map_err(|e| Error::from_reason(format!("Failed to create fuzzer state: {e}")))?;

        // Also initialize timeout objective state.
        timeout_objective
            .init_state(&mut state)
            .map_err(|e| Error::from_reason(format!("Failed to init timeout state: {e}")))?;

        let base_scheduler = ProbabilitySamplingScheduler::new();
        let tracking_observer = temp_observer.track_indices();
        let scheduler =
            MinimizerScheduler::non_metadata_removing(&tracking_observer, base_scheduler);
        let mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));
        let i2s_mutator = I2SSpliceReplace::new();
        let redqueen_mutator = AflppRedQueen::with_cmplog_options(true, true);
        let grimoire_mutator = HavocScheduledMutator::with_max_stack_pow(
            tuple_list!(
                GrimoireExtensionMutator::new(),
                GrimoireRecursiveReplacementMutator::new(),
                GrimoireStringReplacementMutator::new(),
                // Two delete mutators: matches LibAFL's default grimoire mutations,
                // which intentionally double-weights deletions.
                GrimoireRandomDeleteMutator::new(),
                GrimoireRandomDeleteMutator::new(),
            ),
            GRIMOIRE_MAX_STACK_POW,
        );
        let unicode_mutator = HavocScheduledMutator::with_max_stack_pow(
            tuple_list!(
                // 1x category random replacement.
                UnicodeCategoryRandMutator,
                // 4x subcategory random replacement (finer-grained, higher weight).
                UnicodeSubcategoryRandMutator,
                UnicodeSubcategoryRandMutator,
                UnicodeSubcategoryRandMutator,
                UnicodeSubcategoryRandMutator,
                // 1x category token replacement.
                UnicodeCategoryTokenReplaceMutator,
                // 4x subcategory token replacement.
                UnicodeSubcategoryTokenReplaceMutator,
                UnicodeSubcategoryTokenReplaceMutator,
                UnicodeSubcategoryTokenReplaceMutator,
                UnicodeSubcategoryTokenReplaceMutator,
            ),
            UNICODE_MAX_STACK_POW,
        );

        // Drop the tracking observer - feedback only holds a name-based Handle.
        // temp_observer was consumed by track_indices() above.
        drop(tracking_observer);

        // Set max input size on state for I2SRandReplace bounds.
        state.set_max_size(max_input_len as usize);

        state.metadata_map_mut().insert(CmpValuesMetadata::new());

        // Initialize power scheduling metadata with FAST strategy.
        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));

        // Initialize minimizer scheduler state: TopRatedsMetadata tracks the best
        // corpus entry per coverage edge for the MinimizerScheduler.
        state.add_metadata(TopRatedsMetadata::new());

        // Load user-provided dictionary tokens into state metadata before any
        // fuzz iterations, so TokenInsert/TokenReplace can use them from iteration one.
        if let Some(ref dict_path) = dictionary_path {
            let tokens = Tokens::from_file(dict_path).map_err(|e| {
                Error::from_reason(format!("Failed to load dictionary file '{dict_path}': {e}"))
            })?;
            state.add_metadata(tokens);
        }

        // Enable CmpLog recording after all fallible operations so an early
        // return doesn't leave CmpLog enabled without a Fuzzer to shut it down.
        // Disabled by shutdown(), not Drop, so non-deterministic GC cannot interfere.
        crate::cmplog::enable();

        // Insert detector tokens into the mutation dictionary after user tokens.
        // Mark each as pre-promoted so CmpLog won't re-discover them.
        let mut token_tracker = TokenTracker::new();
        if let Some(ref dt) = detector_tokens
            && !dt.is_empty()
        {
            if !state.has_metadata::<Tokens>() {
                state.add_metadata(Tokens::default());
            }
            // PANIC: Tokens metadata is guaranteed to exist - inserted above if absent.
            let tokens = state.metadata_mut::<Tokens>().unwrap();
            for bytes in dt {
                tokens.add_token(bytes);
                // Mark as pre-promoted to prevent CmpLog re-promotion.
                token_tracker.promoted.insert(bytes.clone());
            }
            token_tracker.pre_seeded_count = dt.len();
        }

        // Transfer watchdog ownership: clone the shared state and take the
        // thread handle. After this, the original Watchdog JS object is inert
        // (its shutdown() becomes a no-op since the thread handle was moved).
        let (watchdog_shared, watchdog_thread_handle) = match watchdog {
            Some(wd) => {
                let (shared, handle) = wd.take_internals();
                (Some(shared), handle)
            }
            None => (None, None),
        };

        // Extract the shmem view for internal stashing. The ShmemView is a
        // lightweight Copy type (just a pointer + length), so the original
        // ShmemHandle JS object remains usable for parent-side reads.
        let shmem_view = shmem_handle.map(|h| h.view());

        // Allocate pre-allocated input buffer for runBatch. This buffer is
        // reused across all batch calls to avoid per-iteration allocation.
        let mut input_buffer = Buffer::from(vec![0u8; max_input_len as usize]);
        let input_buffer_ptr = input_buffer.as_mut_ptr();

        Ok(Self {
            features: FeatureDetection::new(
                grimoire_override,
                unicode_override,
                redqueen_override,
                state.corpus().count(),
            ),
            state,
            scheduler,
            feedback,
            crash_objective,
            timeout_objective,
            mutator,
            i2s_mutator,
            map_ptr,
            map_len,
            _coverage_map: coverage_map,
            max_input_len,
            total_execs: 0,
            calibration_execs: 0,
            solution_count: 0,
            start_time: Instant::now(),
            last_input: None,
            last_corpus_id: None,
            calibration: CalibrationState::new(),
            unstable_entries: HashSet::new(),
            token_tracker,
            stage_state: StageState::None,
            last_interesting_corpus_id: None,
            last_stage_input: None,
            grimoire_mutator,
            redqueen_mutator,
            redqueen_ran_for_entry: false,
            unicode_mutator,
            unevaluated_seeds: VecDeque::new(),
            has_user_seeds: false,
            watchdog_shared,
            watchdog_thread_handle,
            shmem_view,
            _input_buffer: input_buffer,
            input_buffer_ptr,
        })
    }

    #[napi]
    pub fn add_seed(&mut self, input: Buffer) -> Result<()> {
        self.has_user_seeds = true;
        self.queue_seed(BytesInput::new(input.to_vec()));
        Ok(())
    }

    #[napi]
    pub fn get_next_input(&mut self) -> Result<Buffer> {
        let generated = self.generate_input()?;

        self.last_corpus_id = generated.parent_corpus_id;
        let buffer = Buffer::from(generated.bytes.as_slice());
        self.last_input = Some(BytesInput::new(generated.bytes));

        Ok(buffer)
    }

    #[napi]
    pub fn report_result(
        &mut self,
        exit_kind: ExitKind,
        exec_time_ns: f64,
    ) -> Result<IterationResult> {
        let input = self.last_input.take().ok_or_else(|| {
            Error::from_reason("reportResult called without a prior getNextInput")
        })?;

        let libafl_exit_kind = match exit_kind {
            ExitKind::Ok => LibaflExitKind::Ok,
            ExitKind::Crash => LibaflExitKind::Crash,
            ExitKind::Timeout => LibaflExitKind::Timeout,
        };

        // Seeds set last_corpus_id = None (they aren't in the corpus yet).
        // Mutated inputs always have Some(corpus_id) from the scheduler.
        let eval = self.evaluate_coverage(
            input.as_ref(),
            exec_time_ns,
            libafl_exit_kind,
            self.last_corpus_id,
        )?;

        let result = if eval.is_solution {
            let testcase = Testcase::new(input);
            self.state
                .solutions_mut()
                .add(testcase)
                .map_err(|e| Error::from_reason(format!("Failed to add solution: {e}")))?;
            self.solution_count += 1;
            IterationResult::Solution
        } else if eval.is_interesting {
            // Panic justification: `evaluate_coverage` guarantees `corpus_id` is `Some`
            // when `is_interesting` is `true` - it is set in the same code path that
            // sets `is_interesting`.
            let corpus_id = eval.corpus_id.unwrap();
            let exec_time = Duration::from_nanos(exec_time_ns as u64);

            // Prepare calibration state for upcoming calibrate_run() calls.
            self.calibration.begin(corpus_id, exec_time);

            // Store for beginStage() - consumed after calibration completes.
            self.last_interesting_corpus_id = Some(corpus_id);

            // Deferred detection: count interesting inputs from the main loop
            // (not stage-found). After threshold, scan corpus for UTF-8 and
            // resolve Grimoire, unicode, and REDQUEEN enable states in one pass.
            self.features.record_interesting(&self.state);

            IterationResult::Interesting
        } else {
            IterationResult::None
        };

        // Drain CmpLog accumulator, extract/promote tokens, build metadata.
        self.process_cmplog_and_tokens();

        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        Ok(result)
    }

    /// Perform one calibration iteration for the most recently added corpus entry.
    /// Returns `true` if more calibration runs are needed.
    #[napi]
    pub fn calibrate_run(&mut self, exec_time_ns: f64) -> Result<bool> {
        self.calibrate_run_impl(exec_time_ns)
    }

    /// Finalize calibration for the most recently added corpus entry.
    /// Updates per-testcase and global metadata with calibrated values.
    #[napi]
    pub fn calibrate_finish(&mut self) -> Result<()> {
        self.calibrate_finish_impl()
    }

    /// Initiate a mutational stage for the most recently calibrated corpus entry.
    ///
    /// Dispatches to I2S (when CmpLog data is available), Generalization, or Grimoire
    /// (when Grimoire is enabled). Returns the first stage-mutated input as a `Buffer`,
    /// or `null` if any of the following apply:
    /// - A stage is already active
    /// - No interesting corpus entry is pending
    /// - No applicable stage exists for the entry
    #[napi]
    pub fn begin_stage(&mut self) -> Result<Option<Buffer>> {
        self.begin_stage_impl()
    }

    /// Process the result of a stage execution and return the next candidate input.
    ///
    /// Returns the next stage-mutated input as a `Buffer`, or `null` if the stage is
    /// complete (iterations exhausted) or no stage is active.
    #[napi]
    pub fn advance_stage(
        &mut self,
        exit_kind: ExitKind,
        exec_time_ns: f64,
    ) -> Result<Option<Buffer>> {
        self.advance_stage_impl(exit_kind, exec_time_ns)
    }

    /// Cleanly terminate the current stage without evaluating the final execution's
    /// coverage. No-op if no stage is active.
    ///
    /// If the exit kind is Crash or Timeout, the current stage input is recorded
    /// as a solution (crash artifact writing is handled by JS, but this ensures
    /// `solution_count` and `FuzzerStats` reflect stage-found crashes).
    ///
    /// Errors if the internal solutions corpus fails to accept the entry.
    #[napi]
    pub fn abort_stage(&mut self, exit_kind: ExitKind) -> Result<()> {
        self.abort_stage_impl(exit_kind)
    }

    #[napi(getter)]
    pub fn cmp_log_entry_count(&self) -> u32 {
        self.state
            .metadata_map()
            .get::<CmpValuesMetadata>()
            .map_or(0, |m| m.list.len() as u32)
    }

    #[napi(getter)]
    pub fn stats(&self) -> FuzzerStats {
        let elapsed = self.start_time.elapsed().as_secs_f64();
        let execs_per_sec = if elapsed > 0.0 {
            self.total_execs as f64 / elapsed
        } else {
            0.0
        };

        let (coverage_edges, coverage_features) = self
            .state
            .named_metadata_map()
            .get::<MapFeedbackMetadata<u8>>(EDGES_OBSERVER_NAME)
            .map(|m| {
                (
                    m.num_covered_map_indexes,
                    compute_coverage_features(&m.history_map),
                )
            })
            .unwrap_or((0, 0));

        FuzzerStats {
            total_execs: self.total_execs as i64,
            calibration_execs: self.calibration_execs as i64,
            corpus_size: self.state.corpus().count() as u32,
            solution_count: self.solution_count,
            coverage_edges: coverage_edges as u32,
            coverage_features,
            execs_per_sec,
        }
    }

    /// Stash the current input to the owned shmem region.
    ///
    /// Delegates to the owned `ShmemHandle`'s seqlock write protocol.
    /// No-op if no `ShmemHandle` was provided at construction.
    ///
    /// Used by JS-orchestrated paths (calibration, stages, minimization)
    /// when the shmem handle is owned by the Fuzzer.
    #[napi]
    pub fn stash_input(&self, input: &[u8]) {
        if let Some(ref view) = self.shmem_view {
            view.stash_input(input);
        }
    }

    /// Run the target function with optional watchdog protection.
    ///
    /// If a Watchdog was provided at construction, arms it with `timeoutMs`,
    /// calls the target at the NAPI C level with V8 termination handling,
    /// disarms, and returns `{ exitKind, error?, result? }`.
    ///
    /// If no Watchdog was provided, calls the target directly without timeout
    /// enforcement and returns the same result shape.
    #[napi(ts_return_type = "{ exitKind: number; error?: Error; result?: unknown }")]
    pub fn run_target<'a>(
        &mut self,
        env: Env,
        #[napi(ts_arg_type = "(data: Buffer) => void | Promise<void>")] target: Unknown<'a>,
        input: Buffer,
        timeout_ms: f64,
    ) -> Result<Object<'a>> {
        match self.watchdog_shared {
            Some(ref shared) => run_target_with_shared(shared, env, target, input, timeout_ms),
            None => run_target_without_watchdog(env, target, input),
        }
    }

    /// Arm the owned watchdog with a timeout in milliseconds.
    ///
    /// No-op if no Watchdog was provided at construction. Used by the
    /// per-iteration fallback path for async targets that need to re-arm
    /// the watchdog before awaiting a Promise.
    #[napi]
    pub fn arm_watchdog(&self, timeout_ms: f64) {
        if let Some(ref shared) = self.watchdog_shared {
            arm_watchdog_shared(shared, timeout_ms);
        }
    }

    /// Returns `true` if the owned watchdog fired since the last `disarmWatchdog()`.
    ///
    /// Always returns `false` if no Watchdog was provided at construction.
    /// Used by the per-iteration fallback path for async targets to
    /// distinguish timeout from crash after awaiting a Promise.
    #[napi(getter)]
    pub fn did_watchdog_fire(&self) -> bool {
        self.watchdog_shared
            .as_ref()
            .is_some_and(|shared| shared.fired.load(std::sync::atomic::Ordering::Acquire))
    }

    /// Disarm the owned watchdog.
    ///
    /// No-op if no Watchdog was provided at construction. Used by the
    /// per-iteration fallback path for async targets.
    #[napi]
    pub fn disarm_watchdog(&self) {
        if let Some(ref shared) = self.watchdog_shared {
            disarm_watchdog_shared(shared);
        }
    }

    /// Disable CmpLog recording and shut down the owned watchdog thread.
    ///
    /// Disables CmpLog recording so non-deterministic GC of this Fuzzer
    /// cannot interfere with a future Fuzzer's CmpLog state. Signals the
    /// background watchdog thread to exit, wakes it via condvar, and joins
    /// it. No-op for the watchdog if none was provided at construction or
    /// if already shut down. Called from the fuzz loop's finally block.
    #[napi]
    pub fn shutdown(&mut self) {
        crate::cmplog::disable();
        if let Some(ref shared) = self.watchdog_shared {
            shutdown_watchdog_shared(shared, &mut self.watchdog_thread_handle);
        }
    }

    /// Run a batch of fuzzing iterations in a tight Rust-internal loop.
    ///
    /// For each iteration: generate/mutate input, stash to shmem, arm watchdog,
    /// call the JS callback, disarm watchdog, evaluate coverage, process CmpLog.
    /// Exits early on the first interesting input, solution, or callback error.
    ///
    /// The callback receives `(inputBuffer, inputLength)` and returns an
    /// `ExitKind` number (0=Ok, 1=Crash). Invalid return values are treated
    /// as Ok. The callback MUST NOT retain a reference to `inputBuffer`.
    #[napi]
    pub fn run_batch(
        &mut self,
        env: Env,
        #[napi(ts_arg_type = "(inputBuffer: Buffer, inputLength: number) => number")]
        callback: Unknown<'_>,
        batch_size: u32,
        timeout_ms: f64,
    ) -> Result<BatchResult> {
        if batch_size == 0 {
            return Ok(BatchResult {
                executions_completed: 0,
                exit_reason: BATCH_EXIT_COMPLETED.to_owned(),
                triggering_input: None,
                solution_exit_kind: None,
            });
        }

        let raw_env = env.raw();
        // SAFETY: raw_env is valid for the duration of this NAPI call.
        let callback_value = unsafe { Unknown::to_napi_value(raw_env, callback)? };

        let mut global: napi::sys::napi_value = std::ptr::null_mut();
        let status = unsafe { napi::sys::napi_get_global(raw_env, &mut global) };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_get_global failed in run_batch",
            ));
        }

        // Create a JS Buffer backed by the pre-allocated input buffer's memory.
        //
        // Created once per run_batch call, not per iteration. The napi_value
        // handle is scoped to the current HandleScope and becomes invalid after
        // this NAPI call returns - this is fine because run_batch is synchronous
        // and the handle is only used within this function.
        //
        // No finalizer is attached (None): the memory is externally owned by
        // self.input_buffer, so the GC must not free it. Multiple JS Buffers
        // over the same pointer are safe because we never create overlapping
        // live handles (one per run_batch invocation). The per-call creation
        // cost is negligible relative to the callback overhead.
        //
        // SAFETY: self.input_buffer_ptr is valid for self.max_input_len bytes,
        // backed by self.input_buffer which is alive for the duration of this call.
        let mut input_buffer_napi: napi::sys::napi_value = std::ptr::null_mut();
        let buf_status = unsafe {
            napi::sys::napi_create_external_buffer(
                raw_env,
                self.max_input_len as usize,
                self.input_buffer_ptr as *mut std::ffi::c_void,
                None,
                std::ptr::null_mut(),
                &mut input_buffer_napi,
            )
        };
        if buf_status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_create_external_buffer failed in run_batch",
            ));
        }

        let has_watchdog = self.watchdog_shared.is_some();
        let has_shmem = self.shmem_view.is_some();

        for iteration in 0..batch_size {
            // Generate next input (seed or mutation).
            let generated = match self.generate_input() {
                Ok(g) => g,
                Err(_) => {
                    // Infrastructure error (e.g., empty corpus with no seeds).
                    // Zero coverage map and return error.
                    unsafe {
                        std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
                    }
                    return Ok(BatchResult {
                        executions_completed: iteration,
                        exit_reason: BATCH_EXIT_ERROR.to_owned(),
                        triggering_input: None,
                        solution_exit_kind: None,
                    });
                }
            };

            let input_len = generated.bytes.len();
            let parent_corpus_id = generated.parent_corpus_id;

            // Write mutated bytes into the pre-allocated buffer.
            // SAFETY: input_len <= max_input_len (generate_input truncates).
            // input_buffer_ptr points into self.input_buffer which is alive.
            if input_len > 0 {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        generated.bytes.as_ptr(),
                        self.input_buffer_ptr,
                        input_len,
                    );
                }
            }

            // Stash input to shmem before callback (if handle present).
            if has_shmem {
                // SAFETY: shmem_view is Some when has_shmem is true.
                self.shmem_view
                    .as_ref()
                    .unwrap()
                    .stash_input(&generated.bytes);
            }

            // Arm watchdog before callback (if present).
            if has_watchdog {
                arm_watchdog_shared(self.watchdog_shared.as_ref().unwrap(), timeout_ms);
            }

            // Measure execution time around callback.
            let start = Instant::now();

            // Call JS callback: callback(inputBuffer, inputLength)
            // SAFETY: raw_env, callback_value, global, input_buffer_napi are valid.
            let mut input_len_value: napi::sys::napi_value = std::ptr::null_mut();
            let len_status = unsafe {
                napi::sys::napi_create_double(raw_env, input_len as f64, &mut input_len_value)
            };
            if len_status != napi::sys::Status::napi_ok {
                if has_watchdog {
                    let shared = self.watchdog_shared.as_ref().unwrap();
                    if shared.fired.load(std::sync::atomic::Ordering::Acquire) {
                        crate::v8_shim::v8_cancel_terminate();
                    }
                    disarm_watchdog_shared(shared);
                }
                return Err(Error::new(
                    Status::GenericFailure,
                    "napi_create_double failed in run_batch",
                ));
            }

            let args = [input_buffer_napi, input_len_value];
            let mut return_value: napi::sys::napi_value = std::ptr::null_mut();
            let call_status = unsafe {
                napi::sys::napi_call_function(
                    raw_env,
                    global,
                    callback_value,
                    2,
                    args.as_ptr(),
                    &mut return_value,
                )
            };

            let elapsed = start.elapsed();
            let exec_time_ns = elapsed.as_nanos() as f64;

            // Read `fired` BEFORE disarming: disarm_watchdog_shared resets
            // `fired` to false via swap(false, AcqRel), so any read after
            // disarm would always see false, preventing timeout detection.
            let timed_out = has_watchdog
                && self
                    .watchdog_shared
                    .as_ref()
                    .unwrap()
                    .fired
                    .load(std::sync::atomic::Ordering::Acquire);
            if timed_out {
                crate::v8_shim::v8_cancel_terminate();
            }

            // Disarm watchdog after callback returns (if present).
            if has_watchdog {
                disarm_watchdog_shared(self.watchdog_shared.as_ref().unwrap());
            }

            // Determine ExitKind from callback result.
            let exit_kind = if call_status == napi::sys::Status::napi_ok {
                // Read the return value as a number.
                let mut result_f64: f64 = 0.0;
                let get_status = unsafe {
                    napi::sys::napi_get_value_double(raw_env, return_value, &mut result_f64)
                };
                if get_status == napi::sys::Status::napi_ok {
                    match result_f64 as u32 {
                        1 => LibaflExitKind::Crash,
                        _ => LibaflExitKind::Ok, // 0 or any invalid value treated as Ok
                    }
                } else {
                    LibaflExitKind::Ok // non-numeric return treated as Ok
                }
            } else if call_status == napi::sys::Status::napi_pending_exception {
                // Callback threw or V8 terminated execution.
                // Clear the pending exception.
                let mut exception: napi::sys::napi_value = std::ptr::null_mut();
                let _ = unsafe {
                    napi::sys::napi_get_and_clear_last_exception(raw_env, &mut exception)
                };

                if timed_out {
                    LibaflExitKind::Timeout
                } else {
                    // Infrastructure-level error (not a normal callback return).
                    // Zero coverage map and return error.
                    unsafe {
                        std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
                    }
                    return Ok(BatchResult {
                        executions_completed: iteration + 1,
                        exit_reason: BATCH_EXIT_ERROR.to_owned(),
                        triggering_input: Some(Buffer::from(generated.bytes)),
                        solution_exit_kind: None,
                    });
                }
            } else {
                // NAPI failure (not an exception). Unrecoverable.
                unsafe {
                    std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
                }
                return Ok(BatchResult {
                    executions_completed: iteration + 1,
                    exit_reason: BATCH_EXIT_ERROR.to_owned(),
                    triggering_input: Some(Buffer::from(generated.bytes)),
                    solution_exit_kind: None,
                });
            };

            // Evaluate coverage.
            let eval = self.evaluate_coverage(
                &generated.bytes,
                exec_time_ns,
                exit_kind,
                parent_corpus_id,
            )?;

            // Process CmpLog entries.
            self.process_cmplog_and_tokens();

            // Increment execution counters.
            self.total_execs += 1;
            *self.state.executions_mut() += 1;

            // Handle results.
            if eval.is_solution {
                // Add to solutions corpus.
                let testcase = Testcase::new(BytesInput::new(generated.bytes.clone()));
                self.state
                    .solutions_mut()
                    .add(testcase)
                    .map_err(|e| Error::from_reason(format!("Failed to add solution: {e}")))?;
                self.solution_count += 1;

                let solution_exit_kind = match exit_kind {
                    LibaflExitKind::Crash => 1u32,
                    LibaflExitKind::Timeout => 2u32,
                    _ => 1u32, // shouldn't happen, but default to crash
                };

                return Ok(BatchResult {
                    executions_completed: iteration + 1,
                    exit_reason: BATCH_EXIT_SOLUTION.to_owned(),
                    triggering_input: Some(Buffer::from(generated.bytes)),
                    solution_exit_kind: Some(solution_exit_kind),
                });
            }

            if eval.is_interesting {
                // Panic justification: evaluate_coverage guarantees corpus_id is Some
                // when is_interesting is true.
                let corpus_id = eval.corpus_id.unwrap();
                let exec_time = Duration::from_nanos(exec_time_ns as u64);

                // Prepare calibration state for upcoming calibrate_run() calls.
                self.calibration.begin(corpus_id, exec_time);

                // Store for beginStage() - consumed after calibration completes.
                self.last_interesting_corpus_id = Some(corpus_id);

                // Record for feature auto-detection.
                self.features.record_interesting(&self.state);

                return Ok(BatchResult {
                    executions_completed: iteration + 1,
                    exit_reason: BATCH_EXIT_INTERESTING.to_owned(),
                    triggering_input: Some(Buffer::from(generated.bytes)),
                    solution_exit_kind: None,
                });
            }
        }

        // Full batch completed without interesting inputs or solutions.
        Ok(BatchResult {
            executions_completed: batch_size,
            exit_reason: BATCH_EXIT_COMPLETED.to_owned(),
            triggering_input: None,
            solution_exit_kind: None,
        })
    }
}

/// AFL-style hit-count bucket index for coverage feature computation.
///
/// Maps a raw edge hit count (0-255) to its bucket index (0-8):
/// - 0 -> 0 (not hit)
/// - 1 -> 1, 2 -> 2, 3 -> 3, 4-7 -> 4, 8-15 -> 5, 16-31 -> 6, 32-127 -> 7, 128-255 -> 8
///
/// Each edge contributes `bucket_index` features because lower buckets are necessarily
/// crossed on the way to the max. Summing across all edges gives `features >= edges`.
const FEATURE_BUCKET_INDEX: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 1usize;
    while i < 256 {
        table[i] = match i {
            1 => 1,
            2 => 2,
            3 => 3,
            4..=7 => 4,
            8..=15 => 5,
            16..=31 => 6,
            32..=127 => 7,
            128..=255 => 8,
            _ => unreachable!(),
        };
        i += 1;
    }
    table
};

/// Compute coverage features from a feedback history map.
///
/// For each non-zero entry, the bucket index represents how many distinct
/// hit-count thresholds that edge has crossed. Summing these gives a feature
/// count analogous to libFuzzer's `ft` metric.
pub(crate) fn compute_coverage_features(history_map: &[u8]) -> u32 {
    history_map
        .iter()
        .map(|&count| FEATURE_BUCKET_INDEX[count as usize] as u32)
        .sum()
}

/// Internal result of generating the next input (seed or mutation).
struct GeneratedInput {
    /// The input bytes (truncated to `max_input_len`).
    bytes: Vec<u8>,
    /// Parent corpus ID: `None` for seeds, `Some(id)` for mutations.
    parent_corpus_id: Option<CorpusId>,
}

impl Fuzzer {
    /// Queue a seed for verbatim evaluation during the initial seed phase.
    ///
    /// Seeds are stored as raw inputs and NOT added to the corpus upfront.
    /// `get_next_input()` drains this queue, and `report_result()` /
    /// `evaluate_coverage()` adds the seed to the corpus only if it produces
    /// novel coverage. This avoids phantom corpus entries with empty metadata.
    fn queue_seed(&mut self, input: BytesInput) {
        self.unevaluated_seeds.push_back(input);
    }

    /// Core input generation logic shared by `get_next_input` (allocates Buffer)
    /// and `run_batch` (writes into pre-allocated buffer).
    ///
    /// Handles auto-seeding, seed drain, corpus selection, and mutation.
    /// Returns the input bytes and parent corpus ID.
    fn generate_input(&mut self) -> Result<GeneratedInput> {
        // Auto-seed if corpus is empty and no seeds are queued.
        if self.state.corpus().count() == 0 && self.unevaluated_seeds.is_empty() {
            if (self.has_user_seeds || self.features.auto_seed_count > 0)
                && self.solution_count == 0
            {
                return Err(Error::from_reason(
                    "All seeds evaluated but none produced coverage. Possible causes:\n\
                     - the fuzz target does not execute any instrumented code paths\n\
                     - instrumentation is not active (check that the vitiate plugin is loaded \
                       and globalThis.__vitiate_cov is initialized)",
                ));
            }
            if self.features.auto_seed_count == 0 {
                for seed in DEFAULT_SEEDS {
                    self.queue_seed(BytesInput::new(seed.to_vec()));
                }
                self.features.set_auto_seed_count(DEFAULT_SEEDS.len());
            }
        }

        // All seeds crashed but none produced coverage.
        if self.state.corpus().count() == 0
            && self.unevaluated_seeds.is_empty()
            && self.solution_count > 0
        {
            return Err(Error::from_reason(
                "No seed produced coverage and the corpus is empty - the fuzzer \
                 cannot continue without at least one non-crashing seed that \
                 exercises instrumented code.",
            ));
        }

        // Drain unevaluated seeds first: return verbatim (no mutation).
        if let Some(seed_input) = self.unevaluated_seeds.pop_front() {
            let mut bytes: Vec<u8> = seed_input.into();
            bytes.truncate(self.max_input_len as usize);
            return Ok(GeneratedInput {
                bytes,
                parent_corpus_id: None,
            });
        }

        // Select a corpus entry and clone its input.
        let corpus_id = self
            .scheduler
            .next(&mut self.state)
            .map_err(|e| Error::from_reason(format!("Scheduler failed: {e}")))?;

        // Increment the fuzz count for the selected entry's path.
        if let Ok(entry) = self.state.corpus().get(corpus_id) {
            let tc = entry.borrow();
            if let Ok(meta) = tc.metadata::<SchedulerTestcaseMetadata>() {
                let idx = meta.n_fuzz_entry();
                drop(tc);
                if let Ok(psmeta) = self.state.metadata_mut::<SchedulerMetadata>() {
                    psmeta.n_fuzz_mut()[idx] = psmeta.n_fuzz()[idx].saturating_add(1);
                }
            }
        }

        let mut input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get input: {e}")))?;

        // Mutate the input: havoc first, then I2S replacement.
        let _ = self
            .mutator
            .mutate(&mut self.state, &mut input)
            .map_err(|e| Error::from_reason(format!("Mutation failed: {e}")))?;
        let _ = self
            .i2s_mutator
            .mutate(&mut self.state, &mut input)
            .map_err(|e| Error::from_reason(format!("I2S mutation failed: {e}")))?;

        // Enforce max_input_len.
        let mut bytes: Vec<u8> = input.into();
        bytes.truncate(self.max_input_len as usize);

        Ok(GeneratedInput {
            bytes,
            parent_corpus_id: Some(corpus_id),
        })
    }

    /// Process CmpLog entries after each iteration: drain accumulator, extract
    /// and promote tokens, build metadata for both REDQUEEN and I2S paths.
    ///
    /// Shared by `report_result` and `run_batch`.
    fn process_cmplog_and_tokens(&mut self) {
        let cmp_entries = crate::cmplog::drain();

        let extracted = extract_tokens_from_cmplog(&cmp_entries);
        self.token_tracker.process(&extracted, &mut self.state);

        let aflpp_metadata = build_aflpp_cmp_metadata(&cmp_entries);
        let flat_list = flatten_orig_cmpvals(&aflpp_metadata);

        self.state.metadata_map_mut().insert(aflpp_metadata);
        self.state
            .metadata_map_mut()
            .insert(CmpValuesMetadata { list: flat_list });
    }
}

// No manual Drop impl needed - CmpLog disable is handled by shutdown()
// (called from the fuzz loop's finally block), not Drop. This makes GC
// timing irrelevant. Other fields use default drop.
