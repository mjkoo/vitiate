use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, SchedulerTestcaseMetadata, Testcase};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::map::MapFeedbackMetadata;
use libafl::feedbacks::{
    AflMapFeedback, CrashFeedback, MapIndexesMetadata, StateInitializer, TimeoutFeedback,
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
use crate::types::{BatchResult, ExitKind, FuzzerConfig, FuzzerStats, IterationResult};
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
mod json;
mod mutator;
mod run_batch;
mod stages;
#[cfg(test)]
mod tests;
mod token_tracker;
mod unicode;
use feature_detection::FeatureDetection;
use mutator::I2SSpliceReplace;
pub(crate) use stages::{StageKind, StageState};

use calibration::CalibrationState;
use cmplog_metadata::{build_aflpp_cmp_metadata, extract_tokens_from_cmplog, flatten_orig_cmpvals};
use token_tracker::TokenTracker;

pub(crate) const EDGES_OBSERVER_NAME: &str = "edges";
const DEFAULT_MAX_INPUT_LEN: u32 = 4096;

// Default seeds for auto-seeding when no user seeds are provided.
const DEFAULT_SEEDS: &[&[u8]] = &[
    b"",                 // empty
    b"\n",               // minimal valid ASCII
    b"0",                // numeric boundary
    b"\x00\x00\x00\x00", // binary/null-byte handling
    b"{}",               // empty JSON object
    b"test",             // short printable ASCII
    b"[]",               // empty JSON array
    b"null",             // JSON null
    b"[{}]",             // array containing object
    b"{\"a\":\"b\"}",    // object with string value
];

/// Maximum power-of-two stacked mutations per Grimoire iteration (2^3 = 8 max).
const GRIMOIRE_MAX_STACK_POW: usize = 3;

/// Maximum power-of-two stacked mutations per unicode iteration (2^7 = 128 max).
/// Character-level mutations are small individually, so deeper stacking is appropriate.
const UNICODE_MAX_STACK_POW: usize = 7;

/// Maximum power-of-two stacked mutations per JSON iteration (2^3 = 8 max).
/// Allows combining mutations (e.g., replace a key AND a value in one iteration).
const JSON_MAX_STACK_POW: usize = 3;

/// Maximum random iteration count for I2S and Grimoire stages (selected uniformly from 1..=N).
const STAGE_MAX_ITERATIONS: usize = 128;

/// Maximum input size for generalization. Inputs exceeding this are skipped.
const MAX_GENERALIZED_LEN: usize = 8192;

/// Maximum number of target executions the generalization stage may spend on a
/// single corpus entry before it is finalized early. Bounds the previously
/// uncapped Offset/Delimiter/Bracket sweep (design review C2) to the same
/// magnitude as the REDQUEEN candidate cap, so a large input cannot monopolize
/// the fuzz loop with generalization execs.
const MAX_GENERALIZATION_EXECS: u32 = 2048;

// Concrete LibAFL type aliases.
type CovObserver = StdMapObserver<'static, u8, false>;
/// CovObserver with index tracking enabled, needed by `MinimizerScheduler`.
type TrackingCovObserver = ExplicitTracking<CovObserver, true, false>;
type FuzzerFeedback = AflMapFeedback<CovObserver, CovObserver>;
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
type JsonMutationsType = tuple_list_type!(
    json::JsonTokenReplaceString,
    json::JsonTokenReplaceKey,
    json::JsonReplaceValue,
);
type JsonMutator = HavocScheduledMutator<JsonMutationsType>;
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
    /// Coverage map indices masked from feedback because they have proven flaky
    /// across multiple corpus entries (grows monotonically). Populated only once
    /// an edge crosses `UNSTABLE_ENTRY_THRESHOLD` in `edge_flaky_entries`.
    unstable_entries: HashSet<usize>,
    /// Per-edge count of distinct corpus entries whose calibration found the edge
    /// flaky. An edge is added to `unstable_entries` only after this reaches
    /// `UNSTABLE_ENTRY_THRESHOLD`, so a single entry's nondeterminism never masks
    /// an edge on its own (design review C4).
    edge_flaky_entries: HashMap<usize, u32>,
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
    /// Target executions spent by the generalization stage on the current entry.
    /// Reset when generalization begins; caps the stage at `MAX_GENERALIZATION_EXECS`.
    generalization_execs: u32,
    /// Count of interesting entries offered to `begin_stage`. Drives the C2
    /// expensive-stage gate: the first `EXPENSIVE_STAGE_WARMUP` entries always run
    /// the expensive stages (colorization/REDQUEEN + structure-aware stages);
    /// afterward they run on a sampled fraction to bound stage amplification.
    expensive_stage_entries: u64,
    /// Unicode scheduled mutator operating on `(BytesInput, UnicodeIdentificationMetadata)`.
    unicode_mutator: UnicodeMutator,
    /// JSON scheduled mutator wrapping JSON-aware mutators.
    json_mutator: JsonMutator,
    /// Feature auto-detection state for Grimoire, unicode, REDQUEEN, and JSON.
    features: FeatureDetection,
    /// Seeds awaiting initial verbatim evaluation (no mutation).
    /// Populated by `queue_seed()`, drained by `get_next_input()`.
    unevaluated_seeds: VecDeque<BytesInput>,
    /// Whether `add_seed()` was called at least once (user-provided seeds).
    has_user_seeds: bool,
    /// Whether automatic seeding (detector seeds + default auto-seeds) is enabled.
    auto_seed_enabled: bool,
    /// Detector-contributed seed inputs, queued during seed composition.
    detector_seeds: Vec<Vec<u8>>,
    /// Whether seed composition has been performed (prevents re-running).
    seeds_composed: bool,
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
// main thread and is never sent across threads. Holding `&mut self` across
// the JS callback in `run_batch` (napi_call_function) is sound only because
// of the documented no-reentrancy invariant: the callback never calls back
// into this (or any) Fuzzer, so the exclusive borrow is never aliased.
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
        // Install the engine panic hook (idempotent); see crate::install_panic_hook.
        crate::install_panic_hook();

        let max_input_len = config
            .as_ref()
            .and_then(|c| c.max_input_len)
            .unwrap_or(DEFAULT_MAX_INPUT_LEN);
        let seed = config.as_ref().and_then(|c| c.seed);
        let grimoire_override = config.as_ref().and_then(|c| c.grimoire);
        let unicode_override = config.as_ref().and_then(|c| c.unicode);
        let redqueen_override = config.as_ref().and_then(|c| c.redqueen);
        let json_mutations_override = config.as_ref().and_then(|c| c.json_mutations);
        let auto_seed_enabled = config.as_ref().and_then(|c| c.auto_seed).unwrap_or(true);
        let dictionary_path = config.as_ref().and_then(|c| c.dictionary_path.clone());
        let detector_tokens: Option<Vec<Vec<u8>>> = config
            .as_ref()
            .and_then(|c| c.detector_tokens.as_ref())
            .map(|tokens| tokens.iter().map(|b| b.to_vec()).collect());
        let detector_seeds: Vec<Vec<u8>> = config
            .as_ref()
            .and_then(|c| c.detector_seeds.as_ref())
            .map(|seeds| seeds.iter().map(|b| b.to_vec()).collect())
            .unwrap_or_default();

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

        let mut feedback = AflMapFeedback::new(&temp_observer);
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
        let json_mutator = HavocScheduledMutator::with_max_stack_pow(
            tuple_list!(
                json::JsonTokenReplaceString,
                json::JsonTokenReplaceKey,
                json::JsonReplaceValue,
            ),
            JSON_MAX_STACK_POW,
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
                json_mutations_override,
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
            edge_flaky_entries: HashMap::new(),
            token_tracker,
            stage_state: StageState::None,
            last_interesting_corpus_id: None,
            last_stage_input: None,
            grimoire_mutator,
            redqueen_mutator,
            redqueen_ran_for_entry: false,
            generalization_execs: 0,
            expensive_stage_entries: 0,
            unicode_mutator,
            json_mutator,
            unevaluated_seeds: VecDeque::new(),
            has_user_seeds: false,
            auto_seed_enabled,
            detector_seeds,
            seeds_composed: false,
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
        // Invariant (mirrors run_batch): any path below that returns without
        // calling process_cmplog_and_tokens() must drain-and-discard CmpLog
        // first. All error exits here are terminal (the thrown exception
        // aborts the run), so this is defense-in-depth for consistency with
        // run_batch rather than a reachable leak.
        let Some(input) = self.last_input.take() else {
            let _ = crate::cmplog::drain();
            return Err(Error::from_reason(
                "reportResult called without a prior getNextInput",
            ));
        };

        let libafl_exit_kind = match exit_kind {
            ExitKind::Ok => LibaflExitKind::Ok,
            ExitKind::Crash => LibaflExitKind::Crash,
            ExitKind::Timeout => LibaflExitKind::Timeout,
        };

        // Seeds set last_corpus_id = None (they aren't in the corpus yet).
        // Mutated inputs always have Some(corpus_id) from the scheduler.
        let eval = match self.evaluate_coverage(
            input.as_ref(),
            exec_time_ns,
            libafl_exit_kind,
            self.last_corpus_id,
        ) {
            Ok(eval) => eval,
            Err(e) => {
                let _ = crate::cmplog::drain();
                return Err(e);
            }
        };

        let result = if eval.is_solution {
            let testcase = Testcase::new(input);
            if let Err(e) = self.state.solutions_mut().add(testcase) {
                let _ = crate::cmplog::drain();
                return Err(Error::from_reason(format!("Failed to add solution: {e}")));
            }
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
    /// `solution_count` and `FuzzerStats` reflect stage-found crashes) and the
    /// aborted execution is counted as a target invocation.
    ///
    /// An Ok exit kind abandons the stage without executing the pending
    /// candidate (e.g. the fuzz-time budget expired): no solution is recorded
    /// and no execution is counted.
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

    /// Execution rate over all target executions (main loop, stages, and
    /// calibration) for the given elapsed seconds.
    fn execs_per_sec_at(&self, elapsed: f64) -> f64 {
        if elapsed > 0.0 {
            (self.total_execs + self.calibration_execs) as f64 / elapsed
        } else {
            0.0
        }
    }

    #[napi(getter)]
    pub fn stats(&self) -> FuzzerStats {
        let execs_per_sec = self.execs_per_sec_at(self.start_time.elapsed().as_secs_f64());

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
    /// No-op if no Watchdog was provided at construction, or if the timeout
    /// is non-finite or non-positive (no timeout enforcement). Used by the
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

    /// Disable CmpLog recording, shut down the owned watchdog thread, and
    /// clear the shmem stash.
    ///
    /// Disables CmpLog recording so non-deterministic GC of this Fuzzer
    /// cannot interfere with a future Fuzzer's CmpLog state. Signals the
    /// background watchdog thread to exit, wakes it via condvar, and joins
    /// it. No-op for the watchdog if none was provided at construction or
    /// if already shut down. Called from the fuzz loop's finally block.
    ///
    /// Clearing the stash makes a surviving stash a reliable abrupt-death
    /// certificate for the supervisor: every input is stashed before
    /// execution, and this shutdown runs on every orderly exit (including
    /// in-band crash findings), so a stash that outlives the child process
    /// means it died mid-execution (native crash, watchdog `_exit`,
    /// SIGKILL) without reaching the fuzz loop's finally block. There is no
    /// race with the watchdog's fire path: the watchdog is disarmed
    /// whenever the loop is able to reach its finally block.
    #[napi]
    pub fn shutdown(&mut self) {
        crate::cmplog::disable();
        if let Some(ref shared) = self.watchdog_shared {
            shutdown_watchdog_shared(shared, &mut self.watchdog_thread_handle);
        }
        if let Some(ref view) = self.shmem_view {
            view.reset_generation();
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
    ///
    /// Reentrancy: the callback MUST NOT call any method on this `Fuzzer`
    /// (or any other `Fuzzer` on this thread). `runBatch` holds an exclusive
    /// (`&mut self`) borrow across the callback invocation, so re-entering
    /// through NAPI would alias that borrow - undefined behavior on the Rust
    /// side - and corrupt the thread-local CmpLog state mid-drain. The
    /// callback must confine itself to running the target and detectors.
    #[napi]
    pub fn run_batch(
        &mut self,
        env: Env,
        #[napi(ts_arg_type = "(inputBuffer: Buffer, inputLength: number) => number")]
        callback: Unknown<'_>,
        batch_size: u32,
        timeout_ms: f64,
    ) -> Result<BatchResult> {
        // Thin wrapper; implementation lives in `run_batch::run_batch_impl`.
        self.run_batch_impl(env, callback, batch_size, timeout_ms)
    }
}

/// AFL's hit-count bucket bit for feature-set corpus admission
/// (`count_class_lookup8`).
///
/// Maps a raw edge hit count (0-255) to a one-hot bit identifying its bucket:
/// - 0 -> 0, 1 -> 0x01, 2 -> 0x02, 3 -> 0x04, 4-7 -> 0x08, 8-15 -> 0x10,
///   16-31 -> 0x20, 32-127 -> 0x40, 128-255 -> 0x80
///
/// Applying it in place to the coverage map before feedback evaluation lets
/// `AflMapFeedback` (OR-reduction) admit an input exactly when it produces a
/// never-seen (edge, hit-count-bucket) feature - including a bucket *lower*
/// than any previously observed for that edge - matching AFL's virgin-bitmap
/// and libFuzzer's feature-set semantics. The feedback's history map therefore
/// holds, per edge, the bitmask of all buckets seen so far.
const CLASSIFY_BUCKET_BIT: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 1usize;
    while i < 256 {
        table[i] = match i {
            1 => 0x01,
            2 => 0x02,
            3 => 0x04,
            4..=7 => 0x08,
            8..=15 => 0x10,
            16..=31 => 0x20,
            32..=127 => 0x40,
            128..=255 => 0x80,
            _ => unreachable!(),
        };
        i += 1;
    }
    table
};

/// Classify a coverage map in place into AFL-style hit-count bucket bits.
///
/// Each raw count is replaced by its one-hot bucket bit (see
/// [`CLASSIFY_BUCKET_BIT`]). Nonzero counts stay nonzero, so `bitmap_size` and
/// covered-index computations are unaffected. Must only be applied to a map of
/// raw counts (it is not idempotent); the coverage map is zeroed after every
/// evaluation, so each classification starts from raw counts.
pub(super) fn classify_counts_in_place(map: &mut [u8]) {
    for slot in map.iter_mut() {
        *slot = CLASSIFY_BUCKET_BIT[*slot as usize];
    }
}

/// Compute coverage features from a feedback history map.
///
/// The history map holds, per edge, the bitmask of hit-count buckets seen so
/// far, so the popcount is the number of distinct (edge, bucket) features -
/// exactly libFuzzer's `ft` metric.
pub(crate) fn compute_coverage_features(history_map: &[u8]) -> u32 {
    history_map.iter().map(|&bits| bits.count_ones()).sum()
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

    /// Build an error for an empty corpus after all seeds have been evaluated.
    /// Tailors the message based on whether any seeds crashed (solution_count > 0)
    /// vs none produced coverage at all.
    fn empty_corpus_error(solution_count: u32) -> Error {
        if solution_count > 0 {
            Error::from_reason(
                "No seed produced coverage and the corpus is empty - the fuzzer \
                 cannot continue without at least one non-crashing seed that \
                 exercises instrumented code.",
            )
        } else {
            Error::from_reason(
                "All seeds evaluated but none produced coverage. Possible causes:\n\
                 - the fuzz target does not execute any instrumented code paths\n\
                 - instrumentation is not active (check that the vitiate plugin is loaded \
                   and globalThis.__vitiate_cov is initialized)",
            )
        }
    }

    /// Core input generation logic shared by `get_next_input` (allocates Buffer)
    /// and `run_batch` (writes into pre-allocated buffer).
    ///
    /// Handles auto-seeding, seed drain, corpus selection, and mutation.
    /// Returns the input bytes and parent corpus ID.
    fn generate_input(&mut self) -> Result<GeneratedInput> {
        // Seed composition: queue detector seeds, then default auto-seeds
        // (if no user seeds and auto_seed enabled), then empty fallback.
        if self.state.corpus().count() == 0 && self.unevaluated_seeds.is_empty() {
            if self.has_user_seeds || self.seeds_composed {
                // All seeds (user or auto) exhausted with empty corpus.
                return Err(Self::empty_corpus_error(self.solution_count));
            }

            self.seeds_composed = true;

            let mut auto_seed_count: usize = 0;

            // Queue detector seeds if auto-seeding is enabled.
            if self.auto_seed_enabled {
                for seed_bytes in std::mem::take(&mut self.detector_seeds) {
                    self.queue_seed(BytesInput::new(seed_bytes));
                    auto_seed_count += 1;
                }
            }

            // Queue default auto-seeds if no user seeds and auto_seed enabled.
            if !self.has_user_seeds && self.auto_seed_enabled {
                for seed in DEFAULT_SEEDS {
                    self.queue_seed(BytesInput::new(seed.to_vec()));
                    auto_seed_count += 1;
                }
            }

            self.features.set_auto_seed_count(auto_seed_count);

            // Empty fallback: if queue is still empty, add a single empty seed.
            if self.unevaluated_seeds.is_empty() {
                self.queue_seed(BytesInput::new(Vec::new()));
            }
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
