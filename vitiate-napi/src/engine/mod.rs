use std::collections::HashSet;
use std::time::{Duration, Instant};

use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, SchedulerTestcaseMetadata, Testcase};
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::map::MapFeedbackMetadata;
use libafl::feedbacks::{
    CrashFeedback, Feedback, MapIndexesMetadata, MapNoveltiesMetadata, MaxMapFeedback,
    StateInitializer, TimeoutFeedback,
};
use libafl::inputs::BytesInput;
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
use libafl::schedulers::{
    MinimizerScheduler, ProbabilitySamplingScheduler, RemovableScheduler, Scheduler,
};
use libafl::stages::UnicodeIdentificationMetadata;
use libafl::state::{HasCorpus, HasExecutions, HasMaxSize, HasRand, HasSolutions, StdState};
use libafl::{HasMetadata, HasNamedMetadata};
use libafl_bolts::rands::{Rand, StdRand};
use libafl_bolts::tuples::{Merge, tuple_list};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::types::{ExitKind, FuzzerConfig, FuzzerStats, IterationResult};

mod calibration;
mod cmplog_metadata;
mod colorization;
mod feature_detection;
mod generalization;
mod grimoire;
mod mutator;
#[cfg(test)]
mod test_helpers;
mod token_tracker;
mod unicode;
pub(crate) use self::generalization::GeneralizationPhase;
pub(crate) use self::mutator::I2SSpliceReplace;

use feature_detection::FeatureDetection;

use calibration::{CALIBRATION_STAGE_MAX, CALIBRATION_STAGE_START, CalibrationState};
use cmplog_metadata::{
    build_aflpp_cmp_metadata, extract_tokens_from_cmplog, flatten_orig_cmpvals,
    set_n_fuzz_entry_for_corpus_id,
};
use token_tracker::TokenTracker;

// Re-export constants for test access via `use super::*`.
#[cfg(test)]
pub(crate) use feature_detection::DEFERRED_DETECTION_THRESHOLD;
#[cfg(test)]
pub(crate) use token_tracker::{MAX_TOKEN_CANDIDATES, TOKEN_PROMOTION_THRESHOLD};

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

/// Nominal execution time assigned to seeds (not calibrated).
const SEED_EXEC_TIME: Duration = Duration::from_millis(1);

/// Maximum power-of-two stacked mutations per Grimoire iteration (2^3 = 8 max).
const GRIMOIRE_MAX_STACK_POW: usize = 3;

/// Maximum power-of-two stacked mutations per unicode iteration (2^7 = 128 max).
/// Character-level mutations are small individually, so deeper stacking is appropriate.
const UNICODE_MAX_STACK_POW: usize = 7;

/// Maximum random iteration count for I2S and Grimoire stages (selected uniformly from 1..=N).
const STAGE_MAX_ITERATIONS: usize = 128;

/// Maximum input size for generalization. Inputs exceeding this are skipped.
const MAX_GENERALIZED_LEN: usize = 8192;

/// Offset values for the offset-based gap-finding passes.
const GENERALIZATION_OFFSETS: [usize; 5] = [255, 127, 63, 31, 0];

/// Delimiter characters for delimiter-based gap-finding passes.
const GENERALIZATION_DELIMITERS: [u8; 7] = [b'.', b';', b',', b'\n', b'\r', b'#', b' '];

/// Bracket pairs for bracket-based gap-finding passes: (open, close).
const GENERALIZATION_BRACKETS: [(u8, u8); 6] = [
    (b'(', b')'),
    (b'[', b']'),
    (b'{', b'}'),
    (b'<', b'>'),
    (b'\'', b'\''),
    (b'"', b'"'),
];

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
type TokensMutationsType = (TokenInsert, (TokenReplace, ()));
type FuzzerMutationsType = <HavocMutationsType as Merge<TokensMutationsType>>::MergeResult;
type FuzzerMutator = HavocScheduledMutator<FuzzerMutationsType>;
type GrimoireMutationsType = (
    GrimoireExtensionMutator<BytesInput>,
    (
        GrimoireRecursiveReplacementMutator<BytesInput>,
        (
            GrimoireStringReplacementMutator<BytesInput>,
            (
                GrimoireRandomDeleteMutator<BytesInput>,
                (GrimoireRandomDeleteMutator<BytesInput>, ()),
            ),
        ),
    ),
);
type GrimoireMutator = HavocScheduledMutator<GrimoireMutationsType>;
/// Unicode input type: (BytesInput, UnicodeIdentificationMetadata) tuple.
type UnicodeInput = (BytesInput, UnicodeIdentificationMetadata);
/// Unicode mutator pool: 1x category + 4x subcategory for both random and token replacement.
/// Subcategory mutators are weighted 4x relative to category mutators.
type UnicodeMutationsType = (
    UnicodeCategoryRandMutator,
    (
        UnicodeSubcategoryRandMutator,
        (
            UnicodeSubcategoryRandMutator,
            (
                UnicodeSubcategoryRandMutator,
                (
                    UnicodeSubcategoryRandMutator,
                    (
                        UnicodeCategoryTokenReplaceMutator,
                        (
                            UnicodeSubcategoryTokenReplaceMutator,
                            (
                                UnicodeSubcategoryTokenReplaceMutator,
                                (
                                    UnicodeSubcategoryTokenReplaceMutator,
                                    (UnicodeSubcategoryTokenReplaceMutator, ()),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    ),
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
    solution_count: u32,
    start_time: Instant,
    last_input: Option<BytesInput>,
    /// Corpus ID selected by the most recent `get_next_input()` — parent for depth tracking.
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
}

// SAFETY: `Fuzzer` contains `*mut u8` which is `!Send`. napi-rs requires `Send`
// for `#[napi]` classes. The raw pointer points into the `Buffer` held in
// `_coverage_map`, which prevents V8 GC from reclaiming the backing memory.
// Node.js `Buffer` uses a non-detachable `ArrayBuffer`, so the memory cannot be
// reallocated or moved. NAPI enforces single-threaded access - the `Fuzzer` is
// only ever used on the Node.js main thread and is never sent across threads.
unsafe impl Send for Fuzzer {}

/// Tracks the lifecycle of a multi-execution stage (I2S, Grimoire, etc.).
/// Designed for extensibility — future stages add new variants.
enum StageState {
    /// No stage is active.
    None,
    /// Colorization stage: identifies free byte ranges via binary search.
    Colorization {
        corpus_id: CorpusId,
        /// Coverage hash of the baseline (original) execution.
        original_hash: u64,
        /// Original corpus entry bytes.
        original_input: Vec<u8>,
        /// Type-replaced copy of the input.
        changed_input: Vec<u8>,
        /// Ranges still to test, processed largest-first.
        pending_ranges: Vec<(usize, usize)>,
        /// Confirmed free ranges (bytes that don't affect coverage).
        taint_ranges: Vec<std::ops::Range<usize>>,
        /// Number of colorization executions so far.
        executions: usize,
        /// Maximum allowed executions (2 * input_len).
        max_executions: usize,
        /// True after binary search, before dual trace execution.
        awaiting_dual_trace: bool,
        /// The range `(start, end)` being tested in the current execution.
        /// `None` for the baseline execution and the dual trace.
        testing_range: Option<(usize, usize)>,
    },
    /// REDQUEEN mutation stage: transform-aware targeted replacements.
    Redqueen {
        corpus_id: CorpusId,
        /// Pre-generated candidates from `multi_mutate()`.
        candidates: Vec<BytesInput>,
        /// Current candidate index.
        index: usize,
    },
    /// I2S mutational stage in progress.
    I2S {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
    },
    /// Generalization stage: identifies structural vs gap bytes in a corpus entry.
    Generalization {
        corpus_id: CorpusId,
        /// Novel coverage map indices to verify during gap-finding.
        novelties: Vec<usize>,
        /// Working buffer: `Some(byte)` = structural/untested, `None` = gap.
        payload: Vec<Option<u8>>,
        /// Current phase within the generalization algorithm.
        phase: GeneralizationPhase,
        /// Byte range `[start, end)` removed in the current candidate.
        candidate_range: Option<(usize, usize)>,
    },
    /// Grimoire mutational stage: structure-aware mutations using GeneralizedInputMetadata.
    Grimoire {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
    },
    /// Unicode mutational stage: category-aware character replacement mutations.
    Unicode {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
    },
}

/// Result of coverage evaluation for a single execution.
struct CoverageEvalResult {
    /// Whether the input was added to the corpus (new coverage).
    is_interesting: bool,
    /// Whether the input triggered a crash/timeout objective.
    is_solution: bool,
    /// The corpus ID of the newly added entry, if `is_interesting` is true.
    corpus_id: Option<CorpusId>,
}

#[napi]
impl Fuzzer {
    #[napi(constructor)]
    pub fn new(mut coverage_map: Buffer, config: Option<FuzzerConfig>) -> Result<Self> {
        let max_input_len = config
            .as_ref()
            .and_then(|c| c.max_input_len)
            .unwrap_or(DEFAULT_MAX_INPUT_LEN);
        let seed = config.as_ref().and_then(|c| c.seed);
        let grimoire_override = config.as_ref().and_then(|c| c.grimoire);
        let unicode_override = config.as_ref().and_then(|c| c.unicode);
        let redqueen_override = config.as_ref().and_then(|c| c.redqueen);

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
            // Negative i64 seeds intentionally wrap to u64 — JS has no native u64,
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
        let scheduler = MinimizerScheduler::new(&tracking_observer, base_scheduler);
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

        // Initialize CmpLog: enable recording and add empty CmpValuesMetadata.
        crate::cmplog::enable();
        state.metadata_map_mut().insert(CmpValuesMetadata::new());

        // Initialize power scheduling metadata with FAST strategy.
        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));

        // Initialize minimizer scheduler state: TopRatedsMetadata tracks the best
        // corpus entry per coverage edge for the MinimizerScheduler.
        state.add_metadata(TopRatedsMetadata::new());

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
            solution_count: 0,
            start_time: Instant::now(),
            last_input: None,
            last_corpus_id: None,
            calibration: CalibrationState::new(),
            unstable_entries: HashSet::new(),
            token_tracker: TokenTracker::new(),
            stage_state: StageState::None,
            last_interesting_corpus_id: None,
            last_stage_input: None,
            grimoire_mutator,
            redqueen_mutator,
            redqueen_ran_for_entry: false,
            unicode_mutator,
        })
    }

    #[napi]
    pub fn add_seed(&mut self, input: Buffer) -> Result<()> {
        let bytes_input = BytesInput::new(input.to_vec());
        let mut testcase = Testcase::new(bytes_input);

        // Seeds get nominal metadata so CorpusPowerTestcaseScore can score them.
        testcase.set_exec_time(SEED_EXEC_TIME);
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
        testcase.add_metadata(sched_meta);

        // Seeds receive empty MapIndexesMetadata so MinimizerScheduler::update_score()
        // succeeds without error when scheduler.on_add() is called. Seeds cover no
        // edges, so they cannot become favored.
        testcase.add_metadata(MapIndexesMetadata::new(vec![]));

        let id = self
            .state
            .corpus_mut()
            .add(testcase)
            .map_err(|e| Error::from_reason(format!("Failed to add seed: {e}")))?;
        self.scheduler
            .on_add(&mut self.state, id)
            .map_err(|e| Error::from_reason(format!("Failed to notify scheduler: {e}")))?;
        set_n_fuzz_entry_for_corpus_id(&self.state, id)?;
        Ok(())
    }

    #[napi]
    pub fn get_next_input(&mut self) -> Result<Buffer> {
        // Auto-seed if corpus is empty.
        if self.state.corpus().count() == 0 {
            for seed in DEFAULT_SEEDS {
                let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));

                // Auto-seeds get same nominal metadata as explicit seeds.
                testcase.set_exec_time(SEED_EXEC_TIME);
                let mut sched_meta = SchedulerTestcaseMetadata::new(0);
                sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
                testcase.add_metadata(sched_meta);
                testcase.add_metadata(MapIndexesMetadata::new(vec![]));

                let id = self
                    .state
                    .corpus_mut()
                    .add(testcase)
                    .map_err(|e| Error::from_reason(format!("Failed to auto-seed: {e}")))?;
                self.scheduler
                    .on_add(&mut self.state, id)
                    .map_err(|e| Error::from_reason(format!("Failed to notify scheduler: {e}")))?;
                set_n_fuzz_entry_for_corpus_id(&self.state, id)?;
            }
            self.features.set_auto_seed_count(DEFAULT_SEEDS.len());
        }

        // Select a corpus entry and clone its input.
        let corpus_id = self
            .scheduler
            .next(&mut self.state)
            .map_err(|e| Error::from_reason(format!("Scheduler failed: {e}")))?;
        self.last_corpus_id = Some(corpus_id);

        // Increment the fuzz count for the selected entry's path.
        // This drives the FAST schedule's logarithmic decay of frequently-fuzzed entries.
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
        let input = BytesInput::new(bytes.clone());

        // Store for use in report_result.
        self.last_input = Some(input);

        Ok(Buffer::from(bytes))
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

        // last_corpus_id is always set by getNextInput before reportResult.
        let parent_corpus_id = self.last_corpus_id.unwrap_or(CorpusId::from(0usize));

        let eval = self.evaluate_coverage(
            input.as_ref(),
            exec_time_ns,
            libafl_exit_kind,
            parent_corpus_id,
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
            // when `is_interesting` is `true` — it is set in the same code path that
            // sets `is_interesting`.
            let corpus_id = eval.corpus_id.unwrap();
            let exec_time = Duration::from_nanos(exec_time_ns as u64);

            // Prepare calibration state for upcoming calibrate_run() calls.
            self.calibration.begin(corpus_id, exec_time);

            // Store for beginStage() — consumed after calibration completes.
            self.last_interesting_corpus_id = Some(corpus_id);

            // Deferred detection: count interesting inputs from the main loop
            // (not stage-found). After threshold, scan corpus for UTF-8 and
            // resolve Grimoire, unicode, and REDQUEEN enable states in one pass.
            self.features.record_interesting(&self.state);

            IterationResult::Interesting
        } else {
            IterationResult::None
        };

        // Drain enriched CmpLog accumulator and build both metadata types:
        // - AflppCmpValuesMetadata (site-keyed, for REDQUEEN)
        // - CmpValuesMetadata (flat list, for I2S backward compatibility)
        let cmp_entries = crate::cmplog::drain();

        // Extract byte tokens from CmpLog entries and promote frequent ones into
        // the mutation dictionary. Each candidate is tracked in `token_candidates`
        // and only promoted to `Tokens` after being observed
        // `TOKEN_PROMOTION_THRESHOLD` times. This filters out one-off garbled byte
        // sequences produced by havoc mutations (which each appear once) while
        // keeping real comparison constants like `"javascript"` (which appear in
        // every execution that reaches the comparison).
        let extracted = extract_tokens_from_cmplog(&cmp_entries);
        self.token_tracker.process(&extracted, &mut self.state);

        // Build site-keyed metadata for REDQUEEN.
        let aflpp_metadata = build_aflpp_cmp_metadata(&cmp_entries);
        // Flatten orig_cmpvals into a flat list for I2S backward compatibility.
        let flat_list = flatten_orig_cmpvals(&aflpp_metadata);

        self.state.metadata_map_mut().insert(aflpp_metadata);
        self.state
            .metadata_map_mut()
            .insert(CmpValuesMetadata { list: flat_list });

        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        Ok(result)
    }

    /// Perform one calibration iteration for the most recently added corpus entry.
    /// Returns `true` if more calibration runs are needed.
    #[napi]
    pub fn calibrate_run(&mut self, exec_time_ns: f64) -> Result<bool> {
        let exec_time = Duration::from_nanos(exec_time_ns as u64);
        self.calibration.total_time += exec_time;
        self.calibration.iterations += 1;

        // Read current coverage map into a snapshot.
        // SAFETY: `self.map_ptr` is valid for `self.map_len` bytes (backed by
        // `self._coverage_map` Buffer). We only read here.
        let current_map =
            unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) }.to_vec();

        if let Some(first) = &self.calibration.first_map {
            // Compare with first run to detect unstable edges.
            // Panic justification: `history_map` is always set together with
            // `first_map` in the `else` branch below, so when `first_map` is
            // `Some`, `history_map` is too.
            let history = self.calibration.history_map.as_mut().unwrap();

            for (idx, (&first_val, &cur_val)) in first.iter().zip(current_map.iter()).enumerate() {
                if first_val != cur_val && history[idx] != u8::MAX {
                    history[idx] = u8::MAX; // mark as unstable
                    self.calibration.has_unstable = true;
                }
            }
        } else {
            // First calibration run — store as baseline.
            self.calibration.first_map = Some(current_map);
            self.calibration.history_map = Some(vec![0u8; self.map_len]);
        }

        // Zero coverage map for next run.
        // SAFETY: Same pointer validity as above. No aliasing — observer is not alive.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        // Signal whether more runs are needed.
        let target_runs = if self.calibration.has_unstable {
            CALIBRATION_STAGE_MAX // 8
        } else {
            CALIBRATION_STAGE_START // 4
        };
        Ok(self.calibration.iterations < target_runs)
    }

    /// Finalize calibration for the most recently added corpus entry.
    /// Updates per-testcase and global metadata with calibrated values.
    #[napi]
    pub fn calibrate_finish(&mut self) -> Result<()> {
        let corpus_id = self.calibration.corpus_id.take().ok_or_else(|| {
            Error::from_reason("calibrateFinish called without pending calibration")
        })?;
        let iterations = self.calibration.iterations;
        if iterations == 0 {
            return Err(Error::from_reason(
                "calibrateFinish: zero calibration iterations",
            ));
        }
        let total_time = self.calibration.total_time;
        let avg_time = total_time / (iterations as u32);

        // Update per-testcase metadata with calibrated values.
        {
            let mut tc = self
                .state
                .corpus()
                .get(corpus_id)
                .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
                .borrow_mut();
            tc.set_exec_time(avg_time);
            if let Ok(sched_meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
                sched_meta.set_cycle_and_time((total_time, iterations));
            }
        }

        // Update global SchedulerMetadata with calibrated totals.
        let bitmap_size = self
            .calibration
            .first_map
            .as_ref()
            .map(|m| m.iter().filter(|&&b| b > 0).count() as u64)
            .or_else(|| {
                // No calibration runs completed — fall back to preliminary bitmap_size
                // from report_result (stored on the testcase's SchedulerTestcaseMetadata).
                self.state.corpus().get(corpus_id).ok().and_then(|entry| {
                    let tc = entry.borrow();
                    tc.metadata::<SchedulerTestcaseMetadata>()
                        .ok()
                        .map(|meta| meta.bitmap_size())
                })
            })
            .unwrap_or(0);

        if let Ok(psmeta) = self.state.metadata_mut::<SchedulerMetadata>() {
            psmeta.set_exec_time(psmeta.exec_time() + total_time);
            psmeta.set_cycles(psmeta.cycles() + (iterations as u64));
            psmeta.set_bitmap_size(psmeta.bitmap_size() + bitmap_size);
            if bitmap_size > 0 {
                psmeta.set_bitmap_size_log(psmeta.bitmap_size_log() + (bitmap_size as f64).log2());
            }
            psmeta.set_bitmap_entries(psmeta.bitmap_entries() + 1);
        }

        // Merge newly discovered unstable edges into the fuzzer's global set.
        if let Some(history) = self.calibration.history_map.take() {
            for (idx, &v) in history.iter().enumerate() {
                if v == u8::MAX {
                    self.unstable_entries.insert(idx);
                }
            }
        }

        // Re-score the entry now that metadata is calibrated.
        // on_replace re-computes the probability for this corpus entry.
        {
            let prev_tc = self
                .state
                .corpus()
                .get(corpus_id)
                .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
                .borrow()
                .clone();
            self.scheduler
                .on_replace(&mut self.state, corpus_id, &prev_tc)
                .map_err(|e| Error::from_reason(format!("Scheduler on_replace failed: {e}")))?;
        }

        // Clear calibration state.
        self.calibration.reset();

        // Zero the coverage map to prevent stale calibration data from affecting
        // the next iteration's feedback evaluation. When calibration completes
        // normally, calibrate_run() already zeroed on its last call, making this
        // idempotent. When calibration breaks (target crashed), this clears the
        // stale coverage data.
        // SAFETY: map_ptr is valid for map_len bytes (backed by _coverage_map
        // Buffer). No observer is alive at this point.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        Ok(())
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
        // Precondition: no stage currently active.
        if !matches!(self.stage_state, StageState::None) {
            return Ok(None);
        }

        // Read and clear last_interesting_corpus_id (consumed regardless of whether
        // the stage proceeds).
        let corpus_id = match self.last_interesting_corpus_id.take() {
            Some(id) => id,
            None => return Ok(None),
        };

        // Reset per-entry flag.
        self.redqueen_ran_for_entry = false;

        // Step 1: Attempt colorization if REDQUEEN is enabled and input fits.
        if self.features.redqueen_enabled {
            let input_len = self
                .state
                .corpus()
                .get(corpus_id)
                .ok()
                .map(|entry| {
                    let tc = entry.borrow();
                    if let Some(input) = tc.input() {
                        input.as_ref().len()
                    } else {
                        0
                    }
                })
                .unwrap_or(0);
            if input_len > 0 && input_len <= colorization::MAX_COLORIZATION_LEN {
                self.redqueen_ran_for_entry = true;
                return self.begin_colorization(corpus_id);
            }
        }

        // Step 2: Attempt I2S (only if REDQUEEN didn't run).
        if !self.redqueen_ran_for_entry {
            let has_cmp_data = self
                .state
                .metadata_map()
                .get::<CmpValuesMetadata>()
                .is_some_and(|m| !m.list.is_empty());
            if has_cmp_data {
                return self.begin_i2s(corpus_id);
            }
        }

        // Step 3: Fall through to Grimoire/unicode.
        self.begin_post_i2s_stages(corpus_id)
    }

    /// Begin the I2S stage for the given corpus entry.
    fn begin_i2s(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        // Select random iteration count 1..=STAGE_MAX_ITERATIONS.
        // SAFETY of unwrap: STAGE_MAX_ITERATIONS is a non-zero constant.
        let max_iterations = self
            .state
            .rand_mut()
            .below(core::num::NonZero::new(STAGE_MAX_ITERATIONS).unwrap())
            + 1;

        // Clone the corpus entry and apply I2S mutation.
        let mut input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        let _ = self
            .i2s_mutator
            .mutate(&mut self.state, &mut input)
            .map_err(|e| Error::from_reason(format!("I2S mutation failed: {e}")))?;

        // Enforce max_input_len truncation.
        let mut bytes: Vec<u8> = input.into();
        bytes.truncate(self.max_input_len as usize);

        // Store the mutated input for advanceStage() corpus addition.
        self.last_stage_input = Some(bytes.clone());

        // Transition to I2S stage state.
        self.stage_state = StageState::I2S {
            corpus_id,
            iteration: 0,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Attempt to begin the post-I2S stages: generalization → Grimoire → unicode.
    fn begin_post_i2s_stages(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if self.features.grimoire_enabled {
            if let Some(buf) = self.begin_generalization(corpus_id)? {
                return Ok(Some(buf));
            }
            if let Some(buf) = self.begin_grimoire(corpus_id)? {
                return Ok(Some(buf));
            }
        }
        if let Some(buf) = self.begin_unicode(corpus_id)? {
            return Ok(Some(buf));
        }
        Ok(None)
    }

    /// Process the result of a stage execution and return the next candidate input.
    ///
    /// Returns the next stage-mutated input as a `Buffer`, or `null` if the stage is
    /// complete (iterations exhausted) or no stage is active.
    #[napi]
    pub fn advance_stage(
        &mut self,
        _exit_kind: ExitKind,
        exec_time_ns: f64,
    ) -> Result<Option<Buffer>> {
        match &self.stage_state {
            StageState::None => return Ok(None),
            StageState::Generalization { .. } => {
                return self.advance_generalization(exec_time_ns);
            }
            StageState::Grimoire { .. } => {
                return self.advance_grimoire(exec_time_ns);
            }
            StageState::Unicode { .. } => {
                return self.advance_unicode(exec_time_ns);
            }
            StageState::I2S { .. } => {}
            StageState::Colorization { .. } => {
                return self.advance_colorization(exec_time_ns);
            }
            StageState::Redqueen { .. } => {
                return self.advance_redqueen(_exit_kind, exec_time_ns);
            }
        }

        let (corpus_id, iteration, max_iterations) = match self.stage_state {
            StageState::I2S {
                corpus_id,
                iteration,
                max_iterations,
            } => (corpus_id, iteration, max_iterations),
            _ => unreachable!(),
        };

        // Drain and discard CmpLog accumulator (do not update CmpValuesMetadata
        // or promote tokens — stage CmpLog data is noise from I2S-mutated inputs).
        let _ = crate::cmplog::drain();

        // Reset stage state before the fallible evaluate_coverage call. On error,
        // the stage is cleanly abandoned (no zombie state). On success, stage_state
        // is overwritten below with the next iteration or StageState::None.
        self.stage_state = StageState::None;
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advanceStage: no stashed stage input"))?;
        // The target was invoked — count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        let _eval =
            self.evaluate_coverage(&stage_input, exec_time_ns, LibaflExitKind::Ok, corpus_id)?;

        let next_iteration = iteration + 1;
        if next_iteration >= max_iterations {
            // I2S stage complete — try transitioning to Generalization, Grimoire, or Unicode.
            // stage_state is already StageState::None (reset before evaluate_coverage above).
            return self.begin_post_i2s_stages(corpus_id);
        }

        // Generate next I2S candidate: clone original corpus entry, mutate.
        let mut input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        let _ = self
            .i2s_mutator
            .mutate(&mut self.state, &mut input)
            .map_err(|e| Error::from_reason(format!("I2S mutation failed: {e}")))?;

        let mut bytes: Vec<u8> = input.into();
        bytes.truncate(self.max_input_len as usize);

        // Store for next advanceStage() call.
        self.last_stage_input = Some(bytes.clone());

        // Update iteration counter.
        self.stage_state = StageState::I2S {
            corpus_id,
            iteration: next_iteration,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
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
        if matches!(self.stage_state, StageState::None) {
            return Ok(());
        }

        // Drain and discard CmpLog accumulator.
        let _ = crate::cmplog::drain();

        // Take the stage input into a local before cleanup — we may need it
        // for solution recording below.
        let stage_input = self.last_stage_input.take();

        // Reset stage state before the fallible add() call. On error, the
        // stage is cleanly abandoned (no zombie state).
        self.stage_state = StageState::None;

        // Zero the coverage map (may contain partial/corrupt data from the
        // crashed execution).
        // SAFETY: map_ptr is valid for map_len bytes (backed by _coverage_map
        // Buffer). No observer is alive at this point.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        // The aborted execution counts as a target invocation.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        // Record crash/timeout as a solution. This is the only fallible
        // operation — all cleanup is already done above.
        if matches!(exit_kind, ExitKind::Crash | ExitKind::Timeout)
            && let Some(input_bytes) = stage_input
        {
            let testcase = Testcase::new(BytesInput::new(input_bytes));
            self.state
                .solutions_mut()
                .add(testcase)
                .map_err(|e| Error::from_reason(format!("Failed to add solution: {e}")))?;
            self.solution_count += 1;
        }

        Ok(())
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

        let coverage_edges = self
            .state
            .named_metadata_map()
            .get::<MapFeedbackMetadata<u8>>(EDGES_OBSERVER_NAME)
            .map(|m| m.num_covered_map_indexes)
            .unwrap_or(0);

        FuzzerStats {
            total_execs: self.total_execs as i64,
            corpus_size: self.state.corpus().count() as u32,
            solution_count: self.solution_count,
            coverage_edges: coverage_edges as u32,
            execs_per_sec,
        }
    }
}

impl Fuzzer {
    /// Compute which coverage map indices are newly maximized compared to the
    /// feedback's internal history. Called BEFORE `is_interesting()` so the
    /// history hasn't been updated yet. Returns indices where `map[i] > history[i]`.
    fn compute_novel_indices(&self) -> Vec<usize> {
        let history = self
            .state
            .named_metadata_map()
            .get::<MapFeedbackMetadata<u8>>(EDGES_OBSERVER_NAME);

        let Some(history_meta) = history else {
            // No history yet — every nonzero map entry is novel.
            // SAFETY: map_ptr is valid for map_len bytes.
            let map = unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) };
            return map
                .iter()
                .enumerate()
                .filter(|&(_, v)| *v > 0)
                .map(|(i, _)| i)
                .collect();
        };

        // SAFETY: map_ptr is valid for map_len bytes.
        let map = unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) };
        let history_map = &history_meta.history_map;

        // History map may be shorter than coverage map (e.g., before first
        // is_interesting() call initializes it). Indices beyond history length
        // have an implicit history value of 0.
        let mut novel = Vec::new();
        for (i, &map_val) in map.iter().enumerate() {
            let hist_val = history_map.get(i).copied().unwrap_or(0);
            if map_val > hist_val {
                novel.push(i);
            }
        }
        novel
    }

    /// Shared coverage evaluation logic used by both `report_result()` and
    /// `advance_stage()`. Masks unstable edges, evaluates objective and feedback,
    /// adds to corpus if interesting, and zeroes the coverage map.
    fn evaluate_coverage(
        &mut self,
        input: &[u8],
        exec_time_ns: f64,
        exit_kind: LibaflExitKind,
        parent_corpus_id: CorpusId,
    ) -> Result<CoverageEvalResult> {
        // Mask unstable edges before observer construction. This prevents
        // non-deterministic coverage edges from triggering false-positive
        // "interesting" evaluations. Must happen before the observer reads
        // the map.
        if !self.unstable_entries.is_empty() {
            // SAFETY: `self.map_ptr` is valid for `self.map_len` bytes (backed by
            // `self._coverage_map` Buffer). The map is mutable and not aliased here.
            let map = unsafe { std::slice::from_raw_parts_mut(self.map_ptr, self.map_len) };
            for &idx in &self.unstable_entries {
                if idx < self.map_len {
                    map[idx] = 0;
                }
            }
        }

        let result = {
            // Reconstruct observer from the stashed pointer.
            // SAFETY: `self.map_ptr` is valid for `self.map_len` bytes. The backing
            // memory is owned by `self._coverage_map` (a `Buffer` preventing V8 GC).
            // Node.js `Buffer` uses a non-detachable `ArrayBuffer`, so the memory
            // cannot be reallocated. The observer is dropped at scope exit (or
            // explicitly in the is_interesting branch before raw map reads).
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, self.map_ptr, self.map_len)
            };
            let observers = tuple_list!(observer);

            let mut mgr = NopEventManager::new();
            let bytes_input = BytesInput::new(input.to_vec());

            // Evaluate crash/timeout objective first (AFL convention).
            // If the input is a solution, skip feedback to avoid biasing the
            // corpus toward crash-inducing inputs.
            let is_solution = match exit_kind {
                LibaflExitKind::Crash => self
                    .crash_objective
                    .is_interesting(
                        &mut self.state,
                        &mut mgr,
                        &bytes_input,
                        &observers,
                        &exit_kind,
                    )
                    .map_err(|e| Error::from_reason(format!("Crash evaluation failed: {e}")))?,
                LibaflExitKind::Timeout => self
                    .timeout_objective
                    .is_interesting(
                        &mut self.state,
                        &mut mgr,
                        &bytes_input,
                        &observers,
                        &exit_kind,
                    )
                    .map_err(|e| Error::from_reason(format!("Timeout evaluation failed: {e}")))?,
                _ => false,
            };

            // Solutions and corpus entries are mutually exclusive (LibAFL convention).
            if is_solution {
                CoverageEvalResult {
                    is_interesting: false,
                    is_solution: true,
                    corpus_id: None,
                }
            } else {
                // Compute novel indices BEFORE calling is_interesting(), which
                // updates the feedback's internal history. Novel = map[i] > history[i].
                let novel_indices = self.compute_novel_indices();

                let is_interesting = self
                    .feedback
                    .is_interesting(
                        &mut self.state,
                        &mut mgr,
                        &bytes_input,
                        &observers,
                        &exit_kind,
                    )
                    .map_err(|e| Error::from_reason(format!("Feedback evaluation failed: {e}")))?;

                if is_interesting {
                    let exec_time = Duration::from_nanos(exec_time_ns as u64);

                    let mut testcase = Testcase::new(bytes_input);
                    self.feedback
                        .append_metadata(&mut self.state, &mut mgr, &observers, &mut testcase)
                        .map_err(|e| Error::from_reason(format!("Append metadata failed: {e}")))?;

                    // Store novel indices on the testcase for generalization.
                    testcase.add_metadata(MapNoveltiesMetadata::new(novel_indices));

                    // Drop observers before reading the raw map pointer to avoid aliasing.
                    drop(observers);

                    // Collect all nonzero coverage map indices for MapIndexesMetadata
                    // and count them for bitmap_size. Piggy-backs on a single map pass.
                    // SAFETY: map_ptr is valid for map_len bytes, backed by _coverage_map
                    // Buffer. The observer has been dropped, so no aliasing.
                    let map_slice =
                        unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) };
                    let covered_indices: Vec<usize> = map_slice
                        .iter()
                        .enumerate()
                        .filter(|&(_, &b)| b > 0)
                        .map(|(i, _)| i)
                        .collect();
                    let bitmap_size = covered_indices.len() as u64;

                    // Store MapIndexesMetadata for the MinimizerScheduler's update_score.
                    testcase.add_metadata(MapIndexesMetadata::new(covered_indices));

                    testcase.set_exec_time(exec_time);

                    // Compute depth from parent corpus entry.
                    let depth = match self.state.corpus().get(parent_corpus_id) {
                        Ok(entry) => {
                            let parent_tc = entry.borrow();
                            match parent_tc.metadata::<SchedulerTestcaseMetadata>() {
                                Ok(meta) => meta.depth() + 1,
                                Err(_) => 0,
                            }
                        }
                        Err(_) => 0,
                    };

                    // Create per-testcase scheduler metadata.
                    let mut sched_meta = SchedulerTestcaseMetadata::new(depth);
                    sched_meta.set_bitmap_size(bitmap_size);
                    sched_meta.set_cycle_and_time((exec_time, 1));
                    // handicap = current queue_cycles (recently-added entries get boosted)
                    if let Ok(psmeta) = self.state.metadata::<SchedulerMetadata>() {
                        sched_meta.set_handicap(psmeta.queue_cycles());
                    }
                    testcase.add_metadata(sched_meta);

                    let id =
                        self.state.corpus_mut().add(testcase).map_err(|e| {
                            Error::from_reason(format!("Failed to add to corpus: {e}"))
                        })?;
                    self.scheduler
                        .on_add(&mut self.state, id)
                        .map_err(|e| Error::from_reason(format!("Scheduler on_add failed: {e}")))?;
                    set_n_fuzz_entry_for_corpus_id(&self.state, id)?;

                    CoverageEvalResult {
                        is_interesting: true,
                        is_solution: false,
                        corpus_id: Some(id),
                    }
                } else {
                    CoverageEvalResult {
                        is_interesting: false,
                        is_solution: false,
                        corpus_id: None,
                    }
                }
            }
        };

        // Zero the coverage map in place for the next iteration.
        // SAFETY: Same pointer validity invariants as the observer construction
        // above. `write_bytes` zeroes `self.map_len` bytes starting at
        // `self.map_ptr`. The observer is guaranteed dropped — either explicitly
        // in the is_interesting branch (before bitmap_size read) or implicitly
        // at the scope-block exit (for solution/not-interesting paths).
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        Ok(result)
    }
}

/// Disables CmpLog on drop. CmpLog state is thread-local to the main thread,
/// which is correct because `Fuzzer` is only used on the Node.js main thread
/// (see `unsafe impl Send` safety comment above).
impl Drop for Fuzzer {
    fn drop(&mut self) {
        crate::cmplog::disable();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmplog;
    use crate::engine::test_helpers::{
        TestFuzzerBuilder, force_single_iteration, make_cmplog_bytes, make_coverage_map,
        make_fuzzer, make_scheduler, make_seed_testcase, make_state_and_feedback,
    };
    use libafl::inputs::GeneralizedInputMetadata;
    use libafl::mutators::Tokens;
    use libafl::observers::MapObserver;
    use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
    use libafl::schedulers::TestcaseScore;
    use libafl::schedulers::powersched::N_FUZZ_SIZE;

    mod basic_feedback {
        use super::*;

        #[test]
        fn test_new_state_is_empty() {
            let (map_ptr, _map) = make_coverage_map(65536);
            let (state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            assert_eq!(state.corpus().count(), 0);
            assert_eq!(state.solutions().count(), 0);
        }

        #[test]
        fn test_add_seed() {
            let (map_ptr, _map) = make_coverage_map(65536);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            let testcase = make_seed_testcase(b"hello");
            let id = state.corpus_mut().add(testcase).unwrap();
            scheduler.on_add(&mut state, id).unwrap();

            assert_eq!(state.corpus().count(), 1);
        }

        #[test]
        fn test_novel_coverage_is_interesting() {
            let (map_ptr, mut map) = make_coverage_map(65536);
            let (mut state, mut feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
            let mut mgr = NopEventManager::new();
            let input = BytesInput::new(b"test".to_vec());

            // Simulate novel coverage.
            map[0] = 1;
            map[42] = 3;

            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);

            let interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &input,
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(interesting);
        }

        #[test]
        fn test_duplicate_coverage_not_interesting() {
            let (map_ptr, mut map) = make_coverage_map(65536);
            let (mut state, mut feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
            let mut mgr = NopEventManager::new();
            let input = BytesInput::new(b"test".to_vec());

            // First report: novel.
            map[0] = 1;
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);
            let interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &input,
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(interesting);

            // Must call append_metadata to update history.
            let mut testcase = Testcase::new(input.clone());
            feedback
                .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
                .unwrap();

            // Zero and set same coverage again.
            map.fill(0);
            map[0] = 1;
            let observer2 = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers2 = tuple_list!(observer2);
            let interesting2 = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &input,
                    &observers2,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(!interesting2);
        }

        #[test]
        fn test_crash_detection() {
            let (map_ptr, map) = make_coverage_map(65536);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
            let mut crash_obj = CrashFeedback::new();
            crash_obj.init_state(&mut state).unwrap();
            let mut mgr = NopEventManager::new();
            let input = BytesInput::new(b"crash_input".to_vec());

            let observer = unsafe {
                StdMapObserver::from_mut_ptr(
                    EDGES_OBSERVER_NAME,
                    map.as_ptr() as *mut u8,
                    map.len(),
                )
            };
            let observers = tuple_list!(observer);

            let is_crash = crash_obj
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &input,
                    &observers,
                    &LibaflExitKind::Crash,
                )
                .unwrap();
            assert!(is_crash);

            let is_ok = crash_obj
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &input,
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(!is_ok);
        }

        #[test]
        fn test_solution_added_on_crash() {
            let (map_ptr, map) = make_coverage_map(65536);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, map.len());
            let mut crash_obj = CrashFeedback::new();
            crash_obj.init_state(&mut state).unwrap();
            let mut mgr = NopEventManager::new();
            let input = BytesInput::new(b"crash_input".to_vec());

            let observer = unsafe {
                StdMapObserver::from_mut_ptr(
                    EDGES_OBSERVER_NAME,
                    map.as_ptr() as *mut u8,
                    map.len(),
                )
            };
            let observers = tuple_list!(observer);

            // Crash objective should fire on ExitKind::Crash.
            let is_crash = crash_obj
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &input,
                    &observers,
                    &LibaflExitKind::Crash,
                )
                .unwrap();
            assert!(is_crash);

            // Add to solutions corpus.
            let testcase = Testcase::new(input);
            state.solutions_mut().add(testcase).unwrap();
            assert_eq!(state.solutions().count(), 1);
        }

        #[test]
        fn test_coverage_map_pointer_stash() {
            // Verify that an observer created from a raw pointer correctly reads
            // data written through that pointer (simulates JS writing to the buffer).
            let (map_ptr, map) = make_coverage_map(1024);

            // Write through the raw pointer (simulating JS instrumentation writing to the buffer).
            unsafe {
                *map_ptr.add(10) = 5;
                *map_ptr.add(100) = 42;
            }

            // Create observer from the same pointer - it should see the writes.
            let observer =
                unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map.len()) };

            // Verify observer reads the written values.

            assert_eq!(observer.get(10), 5);
            assert_eq!(observer.get(100), 42);
            assert_eq!(observer.get(0), 0); // untouched position

            // Also verify the underlying map was modified.
            assert_eq!(map[10], 5);
            assert_eq!(map[100], 42);
        }
    }

    mod input_handling {
        use super::*;

        #[test]
        fn test_get_next_input_auto_seeds() {
            let (map_ptr, _map) = make_coverage_map(65536);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());
            let mut mutator =
                HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));

            // Seed with only non-empty entries so the non-empty assertion is sound
            // regardless of which entry the scheduler picks.
            let nonempty_seeds: Vec<&[u8]> = DEFAULT_SEEDS
                .iter()
                .copied()
                .filter(|s| !s.is_empty())
                .collect();
            for seed in &nonempty_seeds {
                let testcase = make_seed_testcase(seed);
                let id = state.corpus_mut().add(testcase).unwrap();
                scheduler.on_add(&mut state, id).unwrap();
            }

            assert_eq!(state.corpus().count(), nonempty_seeds.len());

            // Get a mutated input and verify mutation changed it.
            let corpus_id = scheduler.next(&mut state).unwrap();
            let mut input = state.corpus().cloned_input_for_id(corpus_id).unwrap();
            let original: Vec<u8> = input.as_ref().to_vec();
            let _ = mutator.mutate(&mut state, &mut input).unwrap();
            let mutated: &[u8] = input.as_ref();
            assert_ne!(
                original.as_slice(),
                mutated,
                "Mutated input should differ from corpus entry"
            );
        }

        #[test]
        fn test_max_input_len_enforcement() {
            let max_input_len: usize = 128;

            // Construct an input that exceeds max_input_len.
            let oversized = BytesInput::new(vec![0x41u8; 256]);
            let bytes: Vec<u8> = oversized.into();
            assert!(
                bytes.len() > max_input_len,
                "precondition: input exceeds limit"
            );

            // Simulate the truncation step that the engine performs.
            let truncated = &bytes[..std::cmp::min(bytes.len(), max_input_len)];
            assert_eq!(truncated.len(), max_input_len);

            // An input already within the limit should be unchanged.
            let small = BytesInput::new(vec![0x42u8; 64]);
            let small_bytes: Vec<u8> = small.into();
            let truncated_small = &small_bytes[..std::cmp::min(small_bytes.len(), max_input_len)];
            assert_eq!(truncated_small.len(), 64);
        }
    }

    mod cmplog_lifecycle {
        use super::*;

        #[test]
        fn test_cmplog_enable_disable_on_fuzzer_lifecycle() {
            // Reset cmplog state.
            cmplog::disable();
            cmplog::drain();
            assert!(!cmplog::is_enabled());

            // Simulate Fuzzer construction (enable cmplog + init metadata).
            cmplog::enable();
            assert!(cmplog::is_enabled());

            // Push should work while enabled.
            cmplog::push(
                CmpValues::U8((1, 2, false)),
                0,
                cmplog::CmpLogOperator::Equal,
            );
            let entries = cmplog::drain();
            assert_eq!(entries.len(), 1);

            // Simulate Fuzzer drop (disable cmplog).
            cmplog::disable();
            assert!(!cmplog::is_enabled());

            // Push should be silently dropped while disabled.
            cmplog::push(
                CmpValues::U8((3, 4, false)),
                0,
                cmplog::CmpLogOperator::Equal,
            );
            let entries = cmplog::drain();
            assert!(entries.is_empty());
        }

        #[test]
        fn test_cmplog_entries_drained_into_metadata() {
            // Reset cmplog state.
            cmplog::disable();
            cmplog::drain();

            let (map_ptr, _map) = make_coverage_map(65536);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);

            // Initialize CmpValuesMetadata on state (as Fuzzer::new() does).
            state.metadata_map_mut().insert(CmpValuesMetadata::new());

            // Simulate a fuzz iteration: enable, push entries, drain to metadata.
            cmplog::enable();
            cmplog::push(
                CmpValues::U8((10, 20, false)),
                0,
                cmplog::CmpLogOperator::Equal,
            );
            cmplog::push(
                CmpValues::U16((1000, 2000, false)),
                0,
                cmplog::CmpLogOperator::Equal,
            );

            let entries = cmplog::drain();
            assert_eq!(entries.len(), 2);

            // Insert into state metadata (as reportResult does).
            let flat_entries: Vec<CmpValues> = entries.iter().map(|(v, _, _)| v.clone()).collect();
            state
                .metadata_map_mut()
                .insert(CmpValuesMetadata { list: flat_entries });

            // Verify metadata is accessible.
            let meta = state
                .metadata_map()
                .get::<CmpValuesMetadata>()
                .expect("CmpValuesMetadata should exist");
            assert_eq!(meta.list.len(), 2);
            assert_eq!(meta.list[0], CmpValues::U8((10, 20, false)));
            assert_eq!(meta.list[1], CmpValues::U16((1000, 2000, false)));

            cmplog::disable();
        }
    }

    mod token_promotion {
        use super::*;

        #[test]
        fn test_report_result_populates_tokens_from_cmplog() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add a seed so the fuzzer has something to work with.
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Push the same CmpLog entries TOKEN_PROMOTION_THRESHOLD times so
            // the tokens get promoted into the dictionary.
            for _ in 0..TOKEN_PROMOTION_THRESHOLD {
                let _input = fuzzer.get_next_input().unwrap();
                cmplog::push(
                    CmpValues::Bytes((
                        make_cmplog_bytes(b"http"),
                        make_cmplog_bytes(b"javascript"),
                    )),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                cmplog::push(
                    CmpValues::U16((1000, 2000, false)),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            }

            // Verify Tokens metadata was populated from the Bytes entry.
            let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
            let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
            assert!(
                token_list.contains(&b"http".as_slice()),
                "should contain 'http'"
            );
            assert!(
                token_list.contains(&b"javascript".as_slice()),
                "should contain 'javascript'"
            );

            cmplog::disable();
        }

        #[test]
        fn test_tokens_accumulate_across_report_result_calls() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Push two different comparisons TOKEN_PROMOTION_THRESHOLD times each
            // so both pairs get promoted.
            for _ in 0..TOKEN_PROMOTION_THRESHOLD {
                let _input = fuzzer.get_next_input().unwrap();
                cmplog::push(
                    CmpValues::Bytes((
                        make_cmplog_bytes(b"http"),
                        make_cmplog_bytes(b"javascript"),
                    )),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                cmplog::push(
                    CmpValues::Bytes((make_cmplog_bytes(b"ftp"), make_cmplog_bytes(b"ssh"))),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            }

            // All four tokens should be present (accumulated, not replaced).
            let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
            let token_list: Vec<&[u8]> = tokens.tokens().iter().map(|t| t.as_slice()).collect();
            assert!(token_list.contains(&b"http".as_slice()));
            assert!(token_list.contains(&b"javascript".as_slice()));
            assert!(token_list.contains(&b"ftp".as_slice()));
            assert!(token_list.contains(&b"ssh".as_slice()));
            assert_eq!(token_list.len(), 4);

            cmplog::disable();
        }

        #[test]
        fn test_token_candidates_capped_at_max() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Push MAX_TOKEN_CANDIDATES + 100 unique single-observation tokens.
            // Each token is observed only once, so none are promoted.
            for i in 0..(MAX_TOKEN_CANDIDATES + 100) {
                let _input = fuzzer.get_next_input().unwrap();
                let token_bytes = format!("tok_{i:06}");
                cmplog::push(
                    CmpValues::Bytes((
                        make_cmplog_bytes(token_bytes.as_bytes()),
                        make_cmplog_bytes(b"other"),
                    )),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            }

            assert!(
                fuzzer.token_tracker.candidates.len() <= MAX_TOKEN_CANDIDATES,
                "token_candidates should be capped at {MAX_TOKEN_CANDIDATES}, got {}",
                fuzzer.token_tracker.candidates.len(),
            );

            cmplog::disable();
        }

        #[test]
        fn test_promoted_tokens_not_reinserted_into_candidates() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Push a token TOKEN_PROMOTION_THRESHOLD observations to promote it.
            for _ in 0..TOKEN_PROMOTION_THRESHOLD {
                let _input = fuzzer.get_next_input().unwrap();
                cmplog::push(
                    CmpValues::Bytes((
                        make_cmplog_bytes(b"promote_me"),
                        make_cmplog_bytes(b"other_side"),
                    )),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            }

            // The promoted token should be in the dictionary.
            let tokens = fuzzer.state.metadata::<Tokens>().unwrap();
            assert!(
                tokens
                    .tokens()
                    .iter()
                    .any(|t| t.as_slice() == b"promote_me"),
                "promoted token should be in the dictionary"
            );

            // The promoted token should be removed from candidates and tracked in promoted_tokens.
            assert!(
                !fuzzer
                    .token_tracker
                    .candidates
                    .contains_key(b"promote_me".as_slice()),
                "promoted token should be removed from token_candidates"
            );
            assert!(
                fuzzer
                    .token_tracker
                    .promoted
                    .contains(b"promote_me".as_slice()),
                "promoted token should be tracked in promoted_tokens"
            );

            let dict_len_before = fuzzer.state.metadata::<Tokens>().unwrap().tokens().len();

            // Push the same CmpLog entry again — the token must NOT re-enter candidates.
            for _ in 0..TOKEN_PROMOTION_THRESHOLD {
                let _input = fuzzer.get_next_input().unwrap();
                cmplog::push(
                    CmpValues::Bytes((
                        make_cmplog_bytes(b"promote_me"),
                        make_cmplog_bytes(b"other_side"),
                    )),
                    0,
                    cmplog::CmpLogOperator::Equal,
                );
                fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            }

            // Token must not re-enter candidates.
            assert!(
                !fuzzer
                    .token_tracker
                    .candidates
                    .contains_key(b"promote_me".as_slice()),
                "promoted token should not re-enter token_candidates"
            );

            // Token must still be in the promoted set.
            assert!(
                fuzzer
                    .token_tracker
                    .promoted
                    .contains(b"promote_me".as_slice()),
                "promoted token should remain in promoted_tokens"
            );

            // Dictionary should not have grown (no duplicate promotion).
            let dict_len_after = fuzzer.state.metadata::<Tokens>().unwrap().tokens().len();
            assert_eq!(
                dict_len_before, dict_len_after,
                "dictionary should not grow from re-observed promoted tokens"
            );

            cmplog::disable();
        }
    }

    mod depth_tracking {
        use super::*;

        #[test]
        fn test_depth_root_entry_has_depth_zero() {
            let (map_ptr, mut map) = make_coverage_map(1024);
            let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // Add a seed and select it.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Simulate novel coverage from a first iteration (no parent).
            map[0] = 1;
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);
            let is_interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &BytesInput::new(b"input1".to_vec()),
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(is_interesting);

            let mut testcase = Testcase::new(BytesInput::new(b"input1".to_vec()));
            testcase.set_exec_time(Duration::from_micros(100));
            feedback
                .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
                .unwrap();

            // Compute depth with no parent (last_corpus_id = None).
            let depth = 0u64; // No parent → depth 0
            let mut sched_meta = SchedulerTestcaseMetadata::new(depth);
            sched_meta.set_bitmap_size(1);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            testcase.add_metadata(sched_meta);
            testcase.add_metadata(MapIndexesMetadata::new(vec![0]));

            let id = state.corpus_mut().add(testcase).unwrap();
            scheduler.on_add(&mut state, id).unwrap();

            // Verify depth is 0.
            let tc = state.corpus().get(id).unwrap().borrow();
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            assert_eq!(meta.depth(), 0);
        }

        #[test]
        fn test_depth_increments_from_parent() {
            let (map_ptr, mut map) = make_coverage_map(1024);
            let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // Add a seed at depth 0.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Add an interesting entry with seed as parent (depth 0 → child depth 1).
            map[0] = 1;
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);
            let is_interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &BytesInput::new(b"child".to_vec()),
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(is_interesting);

            let mut testcase = Testcase::new(BytesInput::new(b"child".to_vec()));
            testcase.set_exec_time(Duration::from_micros(100));
            feedback
                .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
                .unwrap();

            // Read parent depth, compute child depth.
            let parent_depth = state
                .corpus()
                .get(seed_id)
                .unwrap()
                .borrow()
                .metadata::<SchedulerTestcaseMetadata>()
                .unwrap()
                .depth();
            assert_eq!(parent_depth, 0);
            let child_depth = parent_depth + 1;

            let mut sched_meta = SchedulerTestcaseMetadata::new(child_depth);
            sched_meta.set_bitmap_size(1);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            testcase.add_metadata(sched_meta);
            testcase.add_metadata(MapIndexesMetadata::new(vec![0]));

            let child_id = state.corpus_mut().add(testcase).unwrap();
            scheduler.on_add(&mut state, child_id).unwrap();

            // Verify child depth is 1.
            let tc = state.corpus().get(child_id).unwrap().borrow();
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            assert_eq!(meta.depth(), 1);
        }

        #[test]
        fn test_depth_parent_without_metadata_defaults_to_zero() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);

            // Add an entry without SchedulerTestcaseMetadata.
            let tc = Testcase::new(BytesInput::new(b"bare".to_vec()));
            let bare_id = state.corpus_mut().add(tc).unwrap();

            // Attempt to read parent metadata — should fail, default to 0.
            let depth = match state.corpus().get(bare_id) {
                Ok(entry) => {
                    let parent_tc = entry.borrow();
                    match parent_tc.metadata::<SchedulerTestcaseMetadata>() {
                        Ok(meta) => meta.depth() + 1,
                        Err(_) => 0, // No metadata → depth 0
                    }
                }
                Err(_) => 0,
            };
            assert_eq!(depth, 0);
        }

        #[test]
        fn test_depth_chain_across_three_levels() {
            let mut fuzzer = TestFuzzerBuilder::new(1024).build();

            // Add a seed at depth 0.
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // --- Level 0 → 1: first interesting input ---
            let _input = fuzzer.get_next_input().unwrap();
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));
            let id_depth1 = fuzzer
                .calibration
                .corpus_id
                .expect("should have calibration corpus_id");
            fuzzer.calibrate_finish().unwrap();

            // Verify depth 1.
            {
                let tc = fuzzer.state.corpus().get(id_depth1).unwrap().borrow();
                let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
                assert_eq!(
                    meta.depth(),
                    1,
                    "first interesting entry should have depth 1"
                );
            }

            // --- Level 1 → 2: second interesting input (child of depth-1 entry) ---
            // Set up last_input and last_corpus_id directly (simulating get_next_input
            // having selected the depth-1 entry) to avoid a non-deterministic loop.
            fuzzer.last_input = Some(BytesInput::new(b"depth1_child".to_vec()));
            fuzzer.last_corpus_id = Some(id_depth1);

            // Trigger novel coverage at a new edge.
            unsafe {
                *fuzzer.map_ptr.add(20) = 1;
            }
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));
            let id_depth2 = fuzzer
                .calibration
                .corpus_id
                .expect("should have calibration corpus_id");
            fuzzer.calibrate_finish().unwrap();

            // Verify depth 2.
            {
                let tc = fuzzer.state.corpus().get(id_depth2).unwrap().borrow();
                let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
                assert_eq!(
                    meta.depth(),
                    2,
                    "second interesting entry should have depth 2"
                );
            }
        }
    }

    mod unstable_edges {
        use super::*;

        #[test]
        fn test_unstable_edge_masked_during_feedback() {
            let (map_ptr, mut map) = make_coverage_map(1024);
            let (mut state, mut feedback, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // Pre-populate the unstable set with index 42.
            let mut unstable = HashSet::new();
            unstable.insert(42usize);

            // Set coverage only at index 42 (unstable).
            map[42] = 1;

            // Manually mask (simulating what report_result does).
            for &idx in &unstable {
                if idx < map.len() {
                    map[idx] = 0;
                }
            }

            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);

            let is_interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &BytesInput::new(b"test".to_vec()),
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(
                !is_interesting,
                "Input with only unstable edge coverage should not be interesting"
            );
        }

        #[test]
        fn test_stable_edges_unaffected_by_masking() {
            let (map_ptr, mut map) = make_coverage_map(1024);
            let (mut state, mut feedback, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // Unstable set contains index 42.
            let mut unstable = HashSet::new();
            unstable.insert(42usize);

            // Set coverage at index 42 (unstable) AND index 99 (stable).
            map[42] = 1;
            map[99] = 1;

            // Mask unstable edges.
            for &idx in &unstable {
                if idx < map.len() {
                    map[idx] = 0;
                }
            }

            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);

            let is_interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &BytesInput::new(b"test".to_vec()),
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(
                is_interesting,
                "Stable edge (99) should still make the input interesting"
            );
        }

        #[test]
        fn test_no_masking_without_unstable_metadata() {
            let (map_ptr, mut map) = make_coverage_map(1024);
            let (mut state, mut feedback, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // No unstable set — all edges evaluated normally.
            map[42] = 1;

            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);

            let is_interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &BytesInput::new(b"test".to_vec()),
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(
                is_interesting,
                "Without unstable masking, edge 42 should be interesting"
            );
        }
    }

    mod metadata_population {
        use super::*;

        #[test]
        fn test_metadata_populated_on_interesting_input() {
            let (map_ptr, mut map) = make_coverage_map(1024);
            let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // Add a seed so the scheduler has something.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Simulate novel coverage.
            map[0] = 1;
            map[5] = 2;
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);

            let is_interesting = feedback
                .is_interesting(
                    &mut state,
                    &mut mgr,
                    &BytesInput::new(b"novel".to_vec()),
                    &observers,
                    &LibaflExitKind::Ok,
                )
                .unwrap();
            assert!(is_interesting);

            let exec_time = Duration::from_micros(500);

            let mut testcase = Testcase::new(BytesInput::new(b"novel".to_vec()));
            testcase.set_exec_time(exec_time);
            feedback
                .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
                .unwrap();

            // Drop observers before reading the raw map pointer to avoid aliasing.
            drop(observers);

            let bitmap_size = unsafe { std::slice::from_raw_parts(map_ptr, map.len()) }
                .iter()
                .filter(|&&b| b > 0)
                .count() as u64;

            // Compute depth from parent (seed at depth 0).
            let depth = state
                .corpus()
                .get(seed_id)
                .unwrap()
                .borrow()
                .metadata::<SchedulerTestcaseMetadata>()
                .unwrap()
                .depth()
                + 1;

            let mut sched_meta = SchedulerTestcaseMetadata::new(depth);
            sched_meta.set_bitmap_size(bitmap_size);
            sched_meta.set_cycle_and_time((exec_time, 1));
            testcase.add_metadata(sched_meta);
            testcase.add_metadata(MapIndexesMetadata::new(vec![0, 5]));

            let id = state.corpus_mut().add(testcase).unwrap();
            scheduler.on_add(&mut state, id).unwrap();

            // Verify metadata.
            let tc = state.corpus().get(id).unwrap().borrow();
            assert!(tc.exec_time().is_some());
            assert_eq!(tc.exec_time().unwrap(), Duration::from_micros(500));
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            assert_eq!(meta.depth(), 1);
            assert_eq!(meta.bitmap_size(), 2); // two nonzero bytes
            assert_eq!(meta.cycle_and_time(), (exec_time, 1));
        }

        #[test]
        fn test_explicit_seed_has_scheduler_metadata() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            let tc = make_seed_testcase(b"hello");
            let id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, id).unwrap();

            let tc = state.corpus().get(id).unwrap().borrow();
            let meta = tc
                .metadata::<SchedulerTestcaseMetadata>()
                .expect("seed should have SchedulerTestcaseMetadata");
            assert_eq!(meta.depth(), 0);
            assert_eq!(*tc.exec_time(), Some(Duration::from_millis(1)));
        }

        #[test]
        fn test_auto_seed_has_scheduler_metadata() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add auto-seeds the same way Fuzzer::get_next_input does.
            for seed in DEFAULT_SEEDS {
                let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));
                testcase.set_exec_time(SEED_EXEC_TIME);
                let mut sched_meta = SchedulerTestcaseMetadata::new(0);
                sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
                testcase.add_metadata(sched_meta);
                testcase.add_metadata(MapIndexesMetadata::new(vec![]));

                let id = state.corpus_mut().add(testcase).unwrap();
                scheduler.on_add(&mut state, id).unwrap();
            }

            assert_eq!(state.corpus().count(), DEFAULT_SEEDS.len());

            // Verify each auto-seed has metadata.
            for id in state.corpus().ids() {
                let tc = state.corpus().get(id).unwrap().borrow();
                let meta = tc
                    .metadata::<SchedulerTestcaseMetadata>()
                    .expect("auto-seed should have SchedulerTestcaseMetadata");
                assert_eq!(meta.depth(), 0);
                assert_eq!(*tc.exec_time(), Some(Duration::from_millis(1)));
            }
        }
    }

    mod calibration {
        use super::*;

        #[test]
        fn test_calibrate_run_first_call_captures_baseline() {
            let (map_ptr, mut map) = make_coverage_map(256);
            let (mut state, mut feedback, mut scheduler, ..) = make_fuzzer(map_ptr, map.len());
            let mut mgr = NopEventManager::new();

            // Add a seed.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Simulate interesting coverage to set up calibration state.
            map[10] = 1;
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_mut_ptr(), map.len())
            };
            let observers = tuple_list!(observer);
            assert!(
                feedback
                    .is_interesting(
                        &mut state,
                        &mut mgr,
                        &BytesInput::new(b"x".to_vec()),
                        &observers,
                        &LibaflExitKind::Ok,
                    )
                    .unwrap()
            );
            let mut testcase = Testcase::new(BytesInput::new(b"x".to_vec()));
            testcase.set_exec_time(Duration::from_micros(100));
            feedback
                .append_metadata(&mut state, &mut mgr, &observers, &mut testcase)
                .unwrap();
            let mut sched_meta = SchedulerTestcaseMetadata::new(0);
            sched_meta.set_bitmap_size(1);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            testcase.add_metadata(sched_meta);
            testcase.add_metadata(MapIndexesMetadata::new(vec![10]));
            let corpus_id = state.corpus_mut().add(testcase).unwrap();
            scheduler.on_add(&mut state, corpus_id).unwrap();

            // Set up calibration state manually (as report_result would).
            let calibration_corpus_id = Some(corpus_id);
            let calibration_total_time = Duration::from_micros(100);
            let calibration_iterations: usize = 1;
            let mut calibration_first_map: Option<Vec<u8>> = None;
            let mut calibration_history_map: Option<Vec<u8>> = None;
            let calibration_has_unstable = false;

            // Zero map and set calibration coverage.
            map.fill(0);
            map[10] = 1; // same stable coverage

            // Simulate first calibrate_run.
            let exec_time = Duration::from_micros(110);
            let _calibration_total_time = calibration_total_time + exec_time;
            let _calibration_iterations = calibration_iterations + 1;

            let current_map = map.to_vec();
            if calibration_first_map.is_none() {
                calibration_first_map = Some(current_map);
                calibration_history_map = Some(vec![0u8; map.len()]);
            }

            // After first call, baseline should be set.
            assert!(calibration_first_map.is_some());
            assert_eq!(calibration_first_map.as_ref().unwrap()[10], 1);

            // Should need more runs (2 < 4).
            let target_runs = if calibration_has_unstable {
                CALIBRATION_STAGE_MAX
            } else {
                CALIBRATION_STAGE_START
            };
            assert!(_calibration_iterations < target_runs);
            // Cleanup
            let _ = (
                calibration_corpus_id,
                calibration_has_unstable,
                calibration_history_map,
            );
        }

        #[test]
        fn test_calibrate_run_detects_unstable_edges() {
            let (map_ptr, mut map) = make_coverage_map(256);

            // Simulate calibration with differing maps.
            let first_map = {
                map[10] = 1;
                map[20] = 1;
                map.to_vec()
            };
            let mut history_map = vec![0u8; map.len()];
            let mut has_unstable = false;

            // Second run: edge 20 is now 0 (unstable).
            let second_map = {
                map.fill(0);
                map[10] = 1;
                // map[20] = 0 — differs from first
                map.to_vec()
            };

            for (idx, (&first_val, &cur_val)) in first_map.iter().zip(second_map.iter()).enumerate()
            {
                if first_val != cur_val && history_map[idx] != u8::MAX {
                    history_map[idx] = u8::MAX;
                    has_unstable = true;
                }
            }

            assert!(has_unstable, "Should detect unstable edge at index 20");
            assert_eq!(
                history_map[20],
                u8::MAX,
                "Index 20 should be marked unstable"
            );
            assert_eq!(history_map[10], 0, "Index 10 should remain stable");

            // With unstable detected, target should extend to 8 runs.
            let target_runs = if has_unstable {
                CALIBRATION_STAGE_MAX
            } else {
                CALIBRATION_STAGE_START
            };
            assert_eq!(target_runs, CALIBRATION_STAGE_MAX);
            let _ = map_ptr;
        }

        #[test]
        fn test_calibrate_run_returns_false_when_complete() {
            // Without instability: 4 total runs needed.
            // After original (1) + 3 calibrate_run calls (total = 4), should return false.
            let mut iterations = 1usize; // original run
            let has_unstable = false;

            for i in 0..3 {
                iterations += 1;
                let target = if has_unstable {
                    CALIBRATION_STAGE_MAX
                } else {
                    CALIBRATION_STAGE_START
                };
                let needs_more = iterations < target;
                if i < 2 {
                    assert!(needs_more, "Should need more at iteration {iterations}");
                } else {
                    assert!(!needs_more, "Should be complete at iteration {iterations}");
                }
            }
            assert_eq!(iterations, 4);
        }

        #[test]
        fn test_calibrate_run_extends_to_8_on_unstable() {
            // With instability: 8 total runs needed.
            let mut iterations = 1usize;
            let has_unstable = true;

            for _ in 0..7 {
                iterations += 1;
                let target = if has_unstable {
                    CALIBRATION_STAGE_MAX
                } else {
                    CALIBRATION_STAGE_START
                };
                let needs_more = iterations < target;
                if iterations < 8 {
                    assert!(needs_more);
                } else {
                    assert!(!needs_more);
                }
            }
            assert_eq!(iterations, 8);
        }

        #[test]
        fn test_calibrate_finish_averages_exec_time() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a corpus entry with preliminary metadata.
            let mut tc = Testcase::new(BytesInput::new(b"test".to_vec()));
            tc.set_exec_time(Duration::from_micros(100));
            let mut sched_meta = SchedulerTestcaseMetadata::new(0);
            sched_meta.set_bitmap_size(1);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            tc.add_metadata(sched_meta);
            tc.add_metadata(MapIndexesMetadata::new(vec![]));
            let id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, id).unwrap();

            // Simulate calibrate_finish with 4 runs totaling 400us.
            let total_time = Duration::from_micros(400);
            let iterations = 4usize;
            let avg_time = total_time / (iterations as u32);

            {
                let mut tc = state.corpus().get(id).unwrap().borrow_mut();
                tc.set_exec_time(avg_time);
                if let Ok(meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
                    meta.set_cycle_and_time((total_time, iterations));
                }
            }

            // Verify averaged timing.
            let tc = state.corpus().get(id).unwrap().borrow();
            assert_eq!(*tc.exec_time(), Some(Duration::from_micros(100))); // 400/4
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            assert_eq!(meta.cycle_and_time(), (Duration::from_micros(400), 4));
        }

        #[test]
        fn test_calibrate_finish_updates_global_metadata() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);

            // Initial global metadata should be zeroed.
            let psmeta = state.metadata::<SchedulerMetadata>().unwrap();
            assert_eq!(psmeta.exec_time(), Duration::ZERO);
            assert_eq!(psmeta.cycles(), 0);
            assert_eq!(psmeta.bitmap_entries(), 0);

            // Simulate calibrate_finish updating global metadata.
            let total_time = Duration::from_micros(400);
            let iterations = 4u64;
            let bitmap_size = 150u64;

            let psmeta = state.metadata_mut::<SchedulerMetadata>().unwrap();
            psmeta.set_exec_time(psmeta.exec_time() + total_time);
            psmeta.set_cycles(psmeta.cycles() + iterations);
            psmeta.set_bitmap_size(psmeta.bitmap_size() + bitmap_size);
            psmeta.set_bitmap_entries(psmeta.bitmap_entries() + 1);

            // Verify.
            let psmeta = state.metadata::<SchedulerMetadata>().unwrap();
            assert_eq!(psmeta.exec_time(), Duration::from_micros(400));
            assert_eq!(psmeta.cycles(), 4);
            assert_eq!(psmeta.bitmap_size(), 150);
            assert_eq!(psmeta.bitmap_entries(), 1);
        }

        #[test]
        fn test_calibrate_finish_merges_unstable_edges() {
            let mut unstable_entries = HashSet::new();

            // First calibration: edges 42, 100.
            let history1 = {
                let mut h = vec![0u8; 256];
                h[42] = u8::MAX;
                h[100] = u8::MAX;
                h
            };
            for (idx, &v) in history1.iter().enumerate() {
                if v == u8::MAX {
                    unstable_entries.insert(idx);
                }
            }
            assert!(unstable_entries.contains(&42));
            assert!(unstable_entries.contains(&100));

            // Second calibration: edges 100, 200.
            let history2 = {
                let mut h = vec![0u8; 256];
                h[100] = u8::MAX;
                h[200] = u8::MAX;
                h
            };
            for (idx, &v) in history2.iter().enumerate() {
                if v == u8::MAX {
                    unstable_entries.insert(idx);
                }
            }

            // Should be union: {42, 100, 200}.
            assert_eq!(unstable_entries.len(), 3);
            assert!(unstable_entries.contains(&42));
            assert!(unstable_entries.contains(&100));
            assert!(unstable_entries.contains(&200));
        }

        #[test]
        fn test_crash_during_calibration_partial_data() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a corpus entry with preliminary metadata.
            let mut tc = Testcase::new(BytesInput::new(b"crashing".to_vec()));
            tc.set_exec_time(Duration::from_micros(100));
            let mut sched_meta = SchedulerTestcaseMetadata::new(0);
            sched_meta.set_bitmap_size(1);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            tc.add_metadata(sched_meta);
            tc.add_metadata(MapIndexesMetadata::new(vec![]));
            let id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, id).unwrap();

            // Simulate partial calibration (crash after 2 total runs, out of 4 target).
            let total_time = Duration::from_micros(200);
            let iterations = 2usize;
            let avg_time = total_time / (iterations as u32);

            {
                let mut tc = state.corpus().get(id).unwrap().borrow_mut();
                tc.set_exec_time(avg_time);
                if let Ok(meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
                    meta.set_cycle_and_time((total_time, iterations));
                }
            }

            // Entry should still be in corpus with partial data.
            assert_eq!(state.corpus().count(), 1);
            let tc = state.corpus().get(id).unwrap().borrow();
            assert_eq!(*tc.exec_time(), Some(Duration::from_micros(100))); // 200/2
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            assert_eq!(meta.cycle_and_time(), (Duration::from_micros(200), 2));
        }

        #[test]
        fn test_calibrate_run_and_finish_integration() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add a seed so the scheduler has something to select.
            let seed_tc = make_seed_testcase(b"seed");
            let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
            fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

            // Set up last_input and last_corpus_id (simulating get_next_input).
            fuzzer.last_input = Some(BytesInput::new(b"test_input".to_vec()));
            fuzzer.last_corpus_id = Some(seed_id);

            // Write novel coverage to the map.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }

            // report_result should detect novel coverage and return Interesting.
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            // Map was zeroed by report_result. Run 3 calibration iterations
            // (report_result counted as iteration 1, so we need 3 more for 4 total).
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let needs_more = fuzzer.calibrate_run(110_000.0).unwrap();
            assert!(needs_more, "2 < CALIBRATION_STAGE_START");

            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let needs_more = fuzzer.calibrate_run(120_000.0).unwrap();
            assert!(needs_more, "3 < CALIBRATION_STAGE_START");

            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let needs_more = fuzzer.calibrate_run(130_000.0).unwrap();
            assert!(!needs_more, "4 >= CALIBRATION_STAGE_START");

            // Read calibration corpus_id before calibrate_finish() consumes it.
            let interesting_id = fuzzer
                .calibration
                .corpus_id
                .expect("calibration corpus_id should be set after report_result(Interesting)");

            // Finalize calibration.
            fuzzer.calibrate_finish().unwrap();

            // Verify the coverage map is zeroed after calibrate_finish
            // (prevents stale calibration data from affecting the next iteration).
            let map_after = unsafe { std::slice::from_raw_parts(fuzzer.map_ptr, fuzzer.map_len) };
            assert!(
                map_after.iter().all(|&b| b == 0),
                "coverage map should be zeroed after calibrate_finish"
            );

            // Verify per-testcase metadata: avg_time = (100+110+120+130)us / 4 = 115us.
            let tc = fuzzer.state.corpus().get(interesting_id).unwrap().borrow();
            assert_eq!(
                *tc.exec_time(),
                Some(Duration::from_nanos(115_000)),
                "exec_time should be the average of all calibration runs"
            );
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            let total_time = Duration::from_nanos(100_000 + 110_000 + 120_000 + 130_000);
            assert_eq!(meta.cycle_and_time(), (total_time, 4));
            drop(tc);

            // Verify global SchedulerMetadata was updated.
            let psmeta = fuzzer.state.metadata::<SchedulerMetadata>().unwrap();
            assert_eq!(psmeta.bitmap_entries(), 1);
            assert_eq!(
                psmeta.bitmap_size(),
                1,
                "bitmap_size should match the single covered map index"
            );
            assert_eq!(psmeta.exec_time(), total_time);
            assert_eq!(psmeta.cycles(), 4);
        }

        #[test]
        fn test_calibrate_finish_without_calibrate_run() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add a seed so the scheduler has something to select.
            let seed_tc = make_seed_testcase(b"seed");
            let seed_id = fuzzer.state.corpus_mut().add(seed_tc).unwrap();
            fuzzer.scheduler.on_add(&mut fuzzer.state, seed_id).unwrap();

            // Set up last_input and last_corpus_id (simulating get_next_input).
            fuzzer.last_input = Some(BytesInput::new(b"test_input".to_vec()));
            fuzzer.last_corpus_id = Some(seed_id);

            // Write novel coverage to the map (2 edges hit).
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
                *fuzzer.map_ptr.add(20) = 1;
            }

            // report_result should detect novel coverage and return Interesting.
            let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            // Simulate: the JS-side target re-runs during calibration and writes
            // coverage, then crashes before calibrate_run() can zero the map.
            // This leaves stale calibration data that calibrate_finish must clear.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }

            // calibrate_finish() without ever calling calibrate_run().
            // calibration_first_map is None — the fallback should use the
            // bitmap_size from the testcase's SchedulerTestcaseMetadata.
            fuzzer.calibrate_finish().unwrap();

            // Verify the coverage map is zeroed after calibrate_finish
            // (this is the broken-calibration path where calibrate_run never ran).
            let map_after = unsafe { std::slice::from_raw_parts(fuzzer.map_ptr, fuzzer.map_len) };
            assert!(
                map_after.iter().all(|&b| b == 0),
                "coverage map should be zeroed after calibrate_finish (broken calibration path)"
            );

            // Verify global metadata has correct bitmap_size (from the fallback).
            // report_result saw 2 nonzero map indices (10 and 20).
            let psmeta = fuzzer.state.metadata::<SchedulerMetadata>().unwrap();
            assert_eq!(
                psmeta.bitmap_size(),
                2,
                "bitmap_size should match the two covered map indices via fallback"
            );
            assert_eq!(psmeta.bitmap_entries(), 1);
        }

        #[test]
        fn test_calibrate_finish_errors_without_pending_calibration() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // calibrate_finish() on a fresh fuzzer with no prior Interesting result
            // should return an error because calibration_corpus_id is None.
            let err = fuzzer.calibrate_finish().unwrap_err();
            assert!(
                err.to_string().contains("without pending calibration"),
                "Expected 'without pending calibration' error, got: {err}"
            );
        }
    }

    mod scheduling {
        use super::*;

        #[test]
        fn test_power_scoring_favors_fast_high_coverage_entry() {
            let (map_ptr, _map) = make_coverage_map(1024);
            let (mut state, ..) = make_fuzzer(map_ptr, 1024);

            // Set up global metadata with averages between the two entries so
            // scoring has a meaningful baseline to compare against.
            {
                let psmeta = state.metadata_mut::<SchedulerMetadata>().unwrap();
                psmeta.set_exec_time(Duration::from_micros(1100)); // total for 2 entries
                psmeta.set_cycles(2);
                psmeta.set_bitmap_size(550); // total for 2 entries
                psmeta.set_bitmap_size_log((500f64).log2() + (50f64).log2());
                psmeta.set_bitmap_entries(2);
            }

            // Entry A: fast (100us), high coverage (bitmap 500).
            let mut tc_a = Testcase::new(BytesInput::new(b"fast_high_cov".to_vec()));
            tc_a.set_exec_time(Duration::from_micros(100));
            let mut meta_a = SchedulerTestcaseMetadata::new(0);
            meta_a.set_bitmap_size(500);
            meta_a.set_n_fuzz_entry(0);
            meta_a.set_handicap(0);
            meta_a.set_cycle_and_time((Duration::from_micros(400), 4));
            tc_a.add_metadata(meta_a);

            // Entry B: slow (1ms), low coverage (bitmap 50).
            let mut tc_b = Testcase::new(BytesInput::new(b"slow_low_cov".to_vec()));
            tc_b.set_exec_time(Duration::from_millis(1));
            let mut meta_b = SchedulerTestcaseMetadata::new(0);
            meta_b.set_bitmap_size(50);
            meta_b.set_n_fuzz_entry(1);
            meta_b.set_handicap(0);
            meta_b.set_cycle_and_time((Duration::from_millis(4), 4));
            tc_b.add_metadata(meta_b);

            let score_a = CorpusPowerTestcaseScore::compute(&state, &mut tc_a).unwrap();
            let score_b = CorpusPowerTestcaseScore::compute(&state, &mut tc_b).unwrap();

            assert!(
                score_a > score_b,
                "Fast/high-coverage entry (score={score_a}) should score higher \
                 than slow/low-coverage entry (score={score_b})"
            );
        }

        #[test]
        fn test_n_fuzz_entry_set_on_interesting_input() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add a seed so the scheduler has something to select.
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // get_next_input selects and mutates.
            let _input = fuzzer.get_next_input().unwrap();

            // Write novel coverage.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }

            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            // The interesting entry should have n_fuzz_entry = usize::from(id) % N_FUZZ_SIZE.
            let interesting_id = fuzzer
                .calibration
                .corpus_id
                .expect("calibration corpus_id should be set");
            let tc = fuzzer.state.corpus().get(interesting_id).unwrap().borrow();
            let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
            let expected = usize::from(interesting_id) % N_FUZZ_SIZE;
            assert_eq!(
                meta.n_fuzz_entry(),
                expected,
                "n_fuzz_entry should be corpus_id % N_FUZZ_SIZE, not default 0"
            );
            // For corpus ID > 0 (seed is ID 0, interesting entry is ID 1+), this should be nonzero.
            assert_ne!(
                meta.n_fuzz_entry(),
                0,
                "n_fuzz_entry for the second corpus entry should not be 0"
            );
        }

        #[test]
        fn test_seed_has_n_fuzz_entry() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add two seeds.
            fuzzer.add_seed(Buffer::from(b"seed0".to_vec())).unwrap();
            fuzzer.add_seed(Buffer::from(b"seed1".to_vec())).unwrap();

            // Verify each seed has n_fuzz_entry = usize::from(id) % N_FUZZ_SIZE.
            for id in fuzzer.state.corpus().ids() {
                let tc = fuzzer.state.corpus().get(id).unwrap().borrow();
                let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
                let expected = usize::from(id) % N_FUZZ_SIZE;
                assert_eq!(
                    meta.n_fuzz_entry(),
                    expected,
                    "seed {id:?} should have n_fuzz_entry = {expected}"
                );
            }
        }

        #[test]
        fn test_n_fuzz_incremented_on_selection() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add two seeds.
            fuzzer.add_seed(Buffer::from(b"seed0".to_vec())).unwrap();
            fuzzer.add_seed(Buffer::from(b"seed1".to_vec())).unwrap();

            // Record the initial n_fuzz values for both seeds' entries.
            let mut initial_counts: Vec<(CorpusId, usize, u32)> = Vec::new();
            for id in fuzzer.state.corpus().ids() {
                let tc = fuzzer.state.corpus().get(id).unwrap().borrow();
                let meta = tc.metadata::<SchedulerTestcaseMetadata>().unwrap();
                let idx = meta.n_fuzz_entry();
                let count = fuzzer
                    .state
                    .metadata::<SchedulerMetadata>()
                    .unwrap()
                    .n_fuzz()[idx];
                initial_counts.push((id, idx, count));
            }

            // Call get_next_input multiple times to trigger n_fuzz increments.
            for _ in 0..20 {
                let _ = fuzzer.get_next_input().unwrap();
            }

            // Verify that at least one seed's n_fuzz counter was incremented.
            let mut any_incremented = false;
            for &(_, idx, initial) in &initial_counts {
                let current = fuzzer
                    .state
                    .metadata::<SchedulerMetadata>()
                    .unwrap()
                    .n_fuzz()[idx];
                if current > initial {
                    any_incremented = true;
                }
            }
            assert!(
                any_incremented,
                "n_fuzz counters should be incremented after get_next_input selections"
            );

            // Verify total increments match total get_next_input calls.
            let total_increments: u32 = initial_counts
                .iter()
                .map(|&(_, idx, initial)| {
                    fuzzer
                        .state
                        .metadata::<SchedulerMetadata>()
                        .unwrap()
                        .n_fuzz()[idx]
                        - initial
                })
                .sum();
            assert_eq!(
                total_increments, 20,
                "total n_fuzz increments should equal the number of get_next_input calls"
            );
        }
    }

    mod stage_lifecycle {
        use super::*;

        #[test]
        fn test_begin_stage_returns_null_during_active_stage() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            // First beginStage should return Some (stage starts).
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some(), "beginStage should return Some initially");
            assert!(
                matches!(fuzzer.stage_state, StageState::I2S { .. }),
                "stage should be I2S"
            );

            // Second beginStage during active stage should return None.
            let second = fuzzer.begin_stage().unwrap();
            assert!(
                second.is_none(),
                "beginStage should return None during active stage"
            );

            // Active stage should not be disrupted.
            assert!(
                matches!(fuzzer.stage_state, StageState::I2S { .. }),
                "stage should still be I2S"
            );

            cmplog::disable();
        }

        #[test]
        fn test_advance_stage_returns_null_with_no_active_stage() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // advanceStage with no active stage should return None.
            let total_before = fuzzer.total_execs;
            let result = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                result.is_none(),
                "advanceStage should return None without active stage"
            );
            // Verify no side effects (total_execs unchanged).
            assert_eq!(fuzzer.total_execs, total_before);

            cmplog::disable();
        }

        #[test]
        fn test_single_iteration_stage_completes_immediately() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            // Add a seed.
            fuzzer
                .add_seed(Buffer::from(b"seed_data".to_vec()))
                .unwrap();

            // Simulate getNextInput.
            let _ = fuzzer.get_next_input().unwrap();

            // Write novel coverage.
            unsafe {
                *fuzzer.map_ptr.add(42) = 1;
            }

            // Push CmpLog data.
            cmplog::push(
                CmpValues::Bytes((make_cmplog_bytes(b"test"), make_cmplog_bytes(b"data"))),
                0,
                cmplog::CmpLogOperator::Equal,
            );

            let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            assert_eq!(result, IterationResult::Interesting);

            // Calibrate.
            for _ in 0..3 {
                unsafe {
                    *fuzzer.map_ptr.add(42) = 1;
                }
                let needs_more = fuzzer.calibrate_run(50_000.0).unwrap();
                if !needs_more {
                    break;
                }
            }
            fuzzer.calibrate_finish().unwrap();

            // Force max_iterations = 1 by setting a specific seed on the RNG.
            // We can't easily control the RNG to get exactly 1, so instead we'll
            // manually set the stage state after beginStage.
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());

            // Override max_iterations to 1 to test single-iteration behavior.
            force_single_iteration(&mut fuzzer);

            // First advanceStage should return None (stage complete after one iteration).
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                next.is_none(),
                "advanceStage should return None for single-iteration stage"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::None),
                "stage should be None after completion"
            );

            cmplog::disable();
        }

        #[test]
        fn test_cmplog_drained_and_discarded_during_stage() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            // Record original CmpValuesMetadata.
            let original_cmp_count = fuzzer
                .state
                .metadata_map()
                .get::<CmpValuesMetadata>()
                .map(|m| m.list.len())
                .unwrap_or(0);
            assert!(
                original_cmp_count > 0,
                "should have CmpLog data from report_result"
            );

            // Begin stage.
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());

            // Simulate a stage execution that produces CmpLog entries.
            cmplog::push(
                CmpValues::Bytes((
                    make_cmplog_bytes(b"stage_operand_1"),
                    make_cmplog_bytes(b"stage_operand_2"),
                )),
                0,
                cmplog::CmpLogOperator::Equal,
            );

            // advanceStage should drain and discard these CmpLog entries.
            let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

            // Verify CmpValuesMetadata was NOT overwritten by stage CmpLog data.
            let cmp_meta = fuzzer
                .state
                .metadata_map()
                .get::<CmpValuesMetadata>()
                .expect("CmpValuesMetadata should exist");
            assert_eq!(
                cmp_meta.list.len(),
                original_cmp_count,
                "CmpValuesMetadata should not be overwritten by stage CmpLog data"
            );

            // Verify token promotion did not occur for stage CmpLog entries.
            assert!(
                !fuzzer
                    .token_tracker
                    .candidates
                    .contains_key(b"stage_operand_1".as_slice()),
                "stage CmpLog operands should not enter token_candidates"
            );

            cmplog::disable();
        }

        #[test]
        fn test_non_cumulative_mutations() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            // Get the original corpus entry bytes for comparison.
            let stage_corpus_id = fuzzer.last_interesting_corpus_id.unwrap();
            let original_bytes: Vec<u8> = fuzzer
                .state
                .corpus()
                .cloned_input_for_id(stage_corpus_id)
                .unwrap()
                .into();

            // Begin stage.
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());

            // Get the corpus_id from the stage state.
            let i2s_corpus_id = match fuzzer.stage_state {
                StageState::I2S { corpus_id, .. } => corpus_id,
                _ => panic!("expected I2S stage"),
            };

            // Advance through multiple iterations and verify each starts from the
            // original corpus entry (not the previous mutation).
            for _ in 0..3 {
                // The next mutation should be based on the original entry.
                // We can verify this indirectly: the corpus entry bytes should
                // remain unchanged throughout the stage.
                let current_bytes: Vec<u8> = fuzzer
                    .state
                    .corpus()
                    .cloned_input_for_id(i2s_corpus_id)
                    .unwrap()
                    .into();
                assert_eq!(
                    current_bytes, original_bytes,
                    "corpus entry should not be modified by stage mutations"
                );

                let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                if next.is_none() {
                    break;
                }
            }

            cmplog::disable();
        }

        #[test]
        fn test_abort_stage_noop_with_no_active_stage() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            let total_execs_before = fuzzer.total_execs;
            let state_execs_before = *fuzzer.state.executions();

            // abortStage with no active stage should be a no-op.
            fuzzer.abort_stage(ExitKind::Crash).unwrap();

            assert_eq!(
                fuzzer.total_execs, total_execs_before,
                "total_execs should not change on no-op abort"
            );
            assert_eq!(
                *fuzzer.state.executions(),
                state_execs_before,
                "state.executions should not change on no-op abort"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::None),
                "stage should remain None"
            );

            cmplog::disable();
        }
    }

    mod abort_stage {
        use super::*;

        #[test]
        fn test_abort_stage_records_crash_as_solution() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some(), "stage should start");

            let solutions_before = fuzzer.solution_count;
            let solutions_corpus_before = fuzzer.state.solutions().count();

            fuzzer.abort_stage(ExitKind::Crash).unwrap();

            assert_eq!(
                fuzzer.solution_count,
                solutions_before + 1,
                "solution_count should increment on crash abort"
            );
            assert_eq!(
                fuzzer.state.solutions().count(),
                solutions_corpus_before + 1,
                "solutions corpus should have the crash input"
            );

            cmplog::disable();
        }

        #[test]
        fn test_abort_stage_records_timeout_as_solution() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some(), "stage should start");

            let solutions_before = fuzzer.solution_count;
            let solutions_corpus_before = fuzzer.state.solutions().count();

            fuzzer.abort_stage(ExitKind::Timeout).unwrap();

            assert_eq!(
                fuzzer.solution_count,
                solutions_before + 1,
                "solution_count should increment on timeout abort"
            );
            assert_eq!(
                fuzzer.state.solutions().count(),
                solutions_corpus_before + 1,
                "solutions corpus should have the timeout input"
            );

            cmplog::disable();
        }

        #[test]
        fn test_abort_stage_ok_does_not_record_solution() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some(), "stage should start");

            let solutions_before = fuzzer.solution_count;

            fuzzer.abort_stage(ExitKind::Ok).unwrap();

            assert_eq!(
                fuzzer.solution_count, solutions_before,
                "solution_count should not change on Ok abort"
            );

            cmplog::disable();
        }
    }

    mod novelty {
        use super::*;

        #[test]
        fn test_novelty_indices_recorded_for_interesting_input() {
            // When an input triggers new coverage, MapNoveltiesMetadata should be
            // stored on the testcase containing exactly the newly-maximized indices.
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            let _input = fuzzer.get_next_input().unwrap();

            // Write novel coverage at indices 42 and 100.
            unsafe {
                *fuzzer.map_ptr.add(42) = 1;
                *fuzzer.map_ptr.add(100) = 3;
            }

            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            let corpus_id = fuzzer
                .calibration
                .corpus_id
                .expect("should have calibration corpus_id");
            let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
            let novelties = tc
                .metadata::<MapNoveltiesMetadata>()
                .expect("interesting input should have MapNoveltiesMetadata");
            let mut indices = novelties.list.clone();
            indices.sort();
            assert_eq!(
                indices,
                vec![42, 100],
                "novelty metadata should contain exactly the newly-maximized indices"
            );
        }

        #[test]
        fn test_novelty_only_newly_maximized_not_all_covered() {
            // When input covers indices that already have equal-or-higher history values,
            // only the truly-novel (newly maximized) indices should be in MapNoveltiesMetadata.
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // First iteration: establish coverage at indices 10 and 20.
            let _input = fuzzer.get_next_input().unwrap();
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
                *fuzzer.map_ptr.add(20) = 1;
            }
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));
            fuzzer.calibrate_finish().unwrap();

            // Second iteration: cover indices 10, 20 (same), plus new index 30.
            // Also: index 20 now has value 5 (higher than history's 1) → novel.
            let _input = fuzzer.get_next_input().unwrap();
            unsafe {
                *fuzzer.map_ptr.add(10) = 1; // same as history, NOT novel
                *fuzzer.map_ptr.add(20) = 5; // higher than history (1), IS novel
                *fuzzer.map_ptr.add(30) = 1; // new index, IS novel
            }
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            let corpus_id = fuzzer
                .calibration
                .corpus_id
                .expect("should have calibration corpus_id");
            let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
            let novelties = tc
                .metadata::<MapNoveltiesMetadata>()
                .expect("should have MapNoveltiesMetadata");
            let mut indices = novelties.list.clone();
            indices.sort();
            // Index 10 is NOT novel (same as history), indices 20 and 30 ARE novel.
            assert_eq!(
                indices,
                vec![20, 30],
                "only newly-maximized indices should be in novelties, not all covered"
            );
        }

        #[test]
        fn test_novelty_metadata_stored_during_stage_execution() {
            // When a stage execution (e.g., I2S) triggers new coverage and the input
            // is added to the corpus, it should also have MapNoveltiesMetadata.
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Trigger an interesting input so we can start a stage.
            let _input = fuzzer.get_next_input().unwrap();
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            cmplog::push(
                CmpValues::Bytes((make_cmplog_bytes(b"seed"), make_cmplog_bytes(b"test"))),
                0,
                cmplog::CmpLogOperator::Equal,
            );
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));
            fuzzer.calibrate_finish().unwrap();

            // Begin stage.
            let stage_input = fuzzer.begin_stage().unwrap();
            assert!(stage_input.is_some(), "stage should start");

            // Write novel coverage at a new index during stage execution.
            unsafe {
                *fuzzer.map_ptr.add(50) = 1;
            }

            let corpus_count_before = fuzzer.state.corpus().count();
            let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

            // The stage execution should have found new coverage and added a corpus entry.
            let corpus_count_after = fuzzer.state.corpus().count();
            assert!(
                corpus_count_after > corpus_count_before,
                "stage should have added a new corpus entry"
            );

            // Find the new entry (the last one added).
            let new_id = CorpusId::from(corpus_count_after - 1);
            let tc = fuzzer.state.corpus().get(new_id).unwrap().borrow();
            assert!(
                tc.metadata::<MapNoveltiesMetadata>().is_ok(),
                "stage-found corpus entry should have MapNoveltiesMetadata"
            );

            cmplog::disable();
        }

        #[test]
        fn test_no_novelty_metadata_for_non_interesting_input() {
            // Non-interesting inputs are not added to corpus, so no metadata stored.
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            let _input = fuzzer.get_next_input().unwrap();
            // No novel coverage written to the map.
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::None));
            // Corpus should still have only the seed — no entry added.
            assert_eq!(
                fuzzer.state.corpus().count(),
                1,
                "no corpus entry should be added for non-interesting input"
            );
        }
    }

    mod deferred_detection {
        use super::*;

        #[test]
        fn test_grimoire_majority_utf8_enables() {
            // Corpus with 8 UTF-8 and 2 non-UTF-8 inputs → enabled.
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, ..) = make_state_and_feedback(map_ptr, 256);

            for i in 0..8 {
                let tc = Testcase::new(BytesInput::new(format!("text_{i}").into_bytes()));
                state.corpus_mut().add(tc).unwrap();
            }
            for _ in 0..2 {
                let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80, 0x81]));
                state.corpus_mut().add(tc).unwrap();
            }

            assert!(FeatureDetection::scan_corpus_utf8(&state, 0));
        }

        #[test]
        fn test_grimoire_majority_non_utf8_disables() {
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, ..) = make_state_and_feedback(map_ptr, 256);

            for _ in 0..3 {
                let tc = Testcase::new(BytesInput::new(b"text".to_vec()));
                state.corpus_mut().add(tc).unwrap();
            }
            for _ in 0..7 {
                let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80]));
                state.corpus_mut().add(tc).unwrap();
            }

            assert!(!FeatureDetection::scan_corpus_utf8(&state, 0));
        }

        #[test]
        fn test_grimoire_equal_counts_disables() {
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, ..) = make_state_and_feedback(map_ptr, 256);

            for _ in 0..5 {
                let tc = Testcase::new(BytesInput::new(b"text".to_vec()));
                state.corpus_mut().add(tc).unwrap();
            }
            for _ in 0..5 {
                let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE]));
                state.corpus_mut().add(tc).unwrap();
            }

            assert!(
                !FeatureDetection::scan_corpus_utf8(&state, 0),
                "equal counts should disable (strictly greater-than required)"
            );
        }

        #[test]
        fn test_scan_corpus_utf8_skip_all_returns_false() {
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, ..) = make_state_and_feedback(map_ptr, 256);
            for _ in 0..3 {
                state
                    .corpus_mut()
                    .add(Testcase::new(BytesInput::new(b"text".to_vec())))
                    .unwrap();
            }
            // skip_count == count → false
            assert!(
                !FeatureDetection::scan_corpus_utf8(&state, 3),
                "skipping all entries should return false"
            );
            // skip_count > count → false
            assert!(
                !FeatureDetection::scan_corpus_utf8(&state, 100),
                "skipping beyond corpus size should return false"
            );
        }

        #[test]
        fn test_deferred_detection_respects_explicit_false_override() {
            // grimoire: explicit false, unicode: auto-detect (None).
            // After deferred detection fires with UTF-8 corpus, grimoire must stay
            // false while unicode must be auto-enabled.
            cmplog::disable();
            cmplog::drain();
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            // Simulate: grimoire explicitly disabled, unicode left for auto-detect.
            fuzzer.features.grimoire_override = Some(false);
            fuzzer.features.grimoire_enabled = false;
            fuzzer.features.unicode_override = None;
            fuzzer.features.unicode_enabled = false;
            fuzzer.features.deferred_detection_count = Some(0);

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            let seed_id = CorpusId::from(0usize);
            for i in 0..DEFERRED_DETECTION_THRESHOLD {
                fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
                fuzzer.last_corpus_id = Some(seed_id);
                unsafe {
                    *fuzzer.map_ptr.add(i + 10) = 1;
                }
                let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
                assert!(
                    matches!(result, IterationResult::Interesting),
                    "iteration {i} should be interesting"
                );
                fuzzer.calibrate_finish().unwrap();
            }

            assert!(
                !fuzzer.features.grimoire_enabled,
                "explicit grimoire: false must not be overridden by deferred detection"
            );
            assert!(
                fuzzer.features.unicode_enabled,
                "unicode (auto-detect) should be enabled after UTF-8 corpus detected"
            );
            assert!(
                fuzzer.features.deferred_detection_count.is_none(),
                "deferred count should be consumed"
            );
            cmplog::disable();
        }

        #[test]
        fn test_deferred_detection_respects_explicit_false_unicode_override() {
            // unicode: explicit false, grimoire: auto-detect (None).
            // After deferred detection fires with UTF-8 corpus, unicode must stay
            // false while grimoire must be auto-enabled.
            cmplog::disable();
            cmplog::drain();
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            // Simulate: unicode explicitly disabled, grimoire left for auto-detect.
            fuzzer.features.unicode_override = Some(false);
            fuzzer.features.unicode_enabled = false;
            fuzzer.features.grimoire_override = None;
            fuzzer.features.grimoire_enabled = false;
            fuzzer.features.deferred_detection_count = Some(0);

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            let seed_id = CorpusId::from(0usize);
            for i in 0..DEFERRED_DETECTION_THRESHOLD {
                fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
                fuzzer.last_corpus_id = Some(seed_id);
                unsafe {
                    *fuzzer.map_ptr.add(i + 10) = 1;
                }
                let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
                assert!(
                    matches!(result, IterationResult::Interesting),
                    "iteration {i} should be interesting"
                );
                fuzzer.calibrate_finish().unwrap();
            }

            assert!(
                !fuzzer.features.unicode_enabled,
                "explicit unicode: false must not be overridden by deferred detection"
            );
            assert!(
                fuzzer.features.grimoire_enabled,
                "grimoire (auto-detect) should be enabled after UTF-8 corpus detected"
            );
            assert!(
                fuzzer.features.deferred_detection_count.is_none(),
                "deferred count should be consumed"
            );
            cmplog::disable();
        }

        #[test]
        fn test_grimoire_empty_corpus_defers_detection() {
            let fuzzer = TestFuzzerBuilder::new(256).build();

            // Empty corpus with no override → deferred.
            assert!(!fuzzer.features.grimoire_enabled);
            assert_eq!(fuzzer.features.deferred_detection_count, Some(0));
        }

        #[test]
        fn test_grimoire_deferred_triggers_after_10_interesting() {
            cmplog::disable();
            cmplog::drain();
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Generate DEFERRED_DETECTION_THRESHOLD interesting inputs with controlled UTF-8 content.
            // We bypass get_next_input to avoid havoc producing non-UTF-8 bytes.
            let seed_id = CorpusId::from(0usize);
            for i in 0..DEFERRED_DETECTION_THRESHOLD {
                fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
                fuzzer.last_corpus_id = Some(seed_id);
                unsafe {
                    *fuzzer.map_ptr.add(i + 10) = 1;
                }
                let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
                assert!(
                    matches!(result, IterationResult::Interesting),
                    "iteration {i} should be interesting"
                );
                fuzzer.calibrate_finish().unwrap();
            }

            // After DEFERRED_DETECTION_THRESHOLD interesting UTF-8 inputs, Grimoire should be enabled.
            assert!(
                fuzzer.features.grimoire_enabled,
                "should be enabled after DEFERRED_DETECTION_THRESHOLD UTF-8 inputs"
            );
            assert!(
                fuzzer.features.deferred_detection_count.is_none(),
                "deferred count should be consumed"
            );
            cmplog::disable();
        }

        #[test]
        fn test_grimoire_deferred_ignores_stage_found_entries() {
            cmplog::disable();
            cmplog::drain();
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // One interesting input via main loop → deferred count = 1.
            // Push CmpLog data so begin_stage has I2S entries to work with.
            let seed_id = CorpusId::from(0usize);
            fuzzer.last_input = Some(BytesInput::new(b"utf8_main".to_vec()));
            fuzzer.last_corpus_id = Some(seed_id);
            unsafe {
                *fuzzer.map_ptr.add(50) = 1;
            }
            cmplog::push(
                CmpValues::Bytes((make_cmplog_bytes(b"hello"), make_cmplog_bytes(b"world"))),
                0,
                cmplog::CmpLogOperator::Equal,
            );
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));
            assert_eq!(fuzzer.features.deferred_detection_count, Some(1));

            // Calibrate to completion.
            loop {
                unsafe {
                    *fuzzer.map_ptr.add(50) = 1;
                }
                if !fuzzer.calibrate_run(50_000.0).unwrap() {
                    break;
                }
            }
            fuzzer.calibrate_finish().unwrap();

            // Begin I2S stage (CmpLog data was drained into state by report_result).
            let stage_buf = fuzzer.begin_stage().unwrap();
            assert!(stage_buf.is_some(), "stage should start");

            // Novel coverage during stage advance.
            unsafe {
                *fuzzer.map_ptr.add(80) = 1;
            }
            let _advance = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

            // Deferred count must still be 1 — stage-found entries don't count.
            assert_eq!(
                fuzzer.features.deferred_detection_count,
                Some(1),
                "stage-found entries should not increment deferred count"
            );
            cmplog::disable();
        }

        #[test]
        fn test_grimoire_deferred_excludes_default_seeds() {
            // When deferred detection fires, scan_corpus_utf8 should skip the
            // auto-seeds (all valid UTF-8) so only user-found inputs influence the vote.
            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            for seed in DEFAULT_SEEDS {
                let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));
                testcase.set_exec_time(SEED_EXEC_TIME);
                let mut sched_meta = SchedulerTestcaseMetadata::new(0);
                sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
                testcase.add_metadata(sched_meta);
                testcase.add_metadata(MapIndexesMetadata::new(vec![]));
                let id = fuzzer.state.corpus_mut().add(testcase).unwrap();
                fuzzer.scheduler.on_add(&mut fuzzer.state, id).unwrap();
                set_n_fuzz_entry_for_corpus_id(&fuzzer.state, id).unwrap();
            }
            fuzzer.features.auto_seed_count = DEFAULT_SEEDS.len();

            // Add only non-UTF-8 interesting inputs.
            for i in 0u8..4 {
                let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80, i]));
                fuzzer.state.corpus_mut().add(tc).unwrap();
            }

            // Without skipping: 6 UTF-8 seeds + 0 UTF-8 user vs 4 non-UTF-8 → enabled (wrong).
            assert!(
                FeatureDetection::scan_corpus_utf8(&fuzzer.state, 0),
                "without skipping, default seeds cause false positive"
            );

            // With skipping: 0 UTF-8 user vs 4 non-UTF-8 → disabled (correct).
            assert!(
                !FeatureDetection::scan_corpus_utf8(&fuzzer.state, fuzzer.features.auto_seed_count),
                "with skipping, only user inputs are counted"
            );
        }
    }

    mod pipeline {
        use super::*;

        #[test]
        fn test_pipeline_i2s_to_generalization_to_grimoire_to_none() {
            // Full pipeline: I2S (1 iteration) → Generalization → Grimoire → None.
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
            fuzzer.features.grimoire_enabled = true;
            fuzzer.features.deferred_detection_count = None;

            // begin_stage starts I2S (CmpLog data exists from build_ready_for_stage).
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());
            assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

            // Force max_iterations = 1 so I2S completes on next advance.
            force_single_iteration(&mut fuzzer);

            // Advance I2S → should transition to Generalization (Grimoire enabled, input qualifies).
            // Set coverage for the novelty index so evaluate_coverage works.
            unsafe {
                *fuzzer.map_ptr.add(42) = 1;
            }
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                next.is_some(),
                "should transition from I2S to Generalization"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Generalization { .. }),
                "stage state should be Generalization after I2S completes"
            );

            // Drive through generalization: verification + gap-finding.
            // Verification: set novelty index so it passes.
            unsafe {
                *fuzzer.map_ptr.add(42) = 1;
            }
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                next.is_some(),
                "should produce gap-finding candidate after verification"
            );

            // Drive through remaining generalization phases until Grimoire starts.
            let mut count = 0;
            loop {
                unsafe {
                    *fuzzer.map_ptr.add(42) = 1;
                }
                let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                count += 1;
                if matches!(fuzzer.stage_state, StageState::Grimoire { .. }) {
                    assert!(
                        candidate.is_some(),
                        "Grimoire transition should return a candidate"
                    );
                    break;
                }
                if candidate.is_none() {
                    panic!("generalization should transition to Grimoire, not None");
                }
                assert!(
                    count <= 200,
                    "should complete generalization within 200 iterations"
                );
            }

            // Drive through Grimoire until completion.
            // Force max_iterations = 1 so Grimoire completes on next advance.
            force_single_iteration(&mut fuzzer);
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(next.is_none(), "Grimoire should complete and return None");
            assert!(matches!(fuzzer.stage_state, StageState::None));

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_i2s_to_grimoire_preexisting_metadata() {
            // I2S → Grimoire (generalization skipped because entry already has GeneralizedInputMetadata).
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_grimoire_entry(b"fn foo() {}");

            // Set up CmpLog data so I2S starts.
            let cmp_entries = vec![CmpValues::Bytes((
                make_cmplog_bytes(b"hello"),
                make_cmplog_bytes(b"world"),
            ))];
            fuzzer
                .state
                .metadata_map_mut()
                .insert(CmpValuesMetadata { list: cmp_entries });
            fuzzer.last_interesting_corpus_id = Some(corpus_id);

            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());
            assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

            // Force I2S to complete in one iteration.
            force_single_iteration(&mut fuzzer);

            // Advance → should skip generalization (already has metadata) and go to Grimoire.
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(next.is_some(), "should transition to Grimoire");
            assert!(
                matches!(fuzzer.stage_state, StageState::Grimoire { .. }),
                "should be in Grimoire stage (generalization skipped)"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_i2s_to_none_grimoire_disabled() {
            // I2S → None (Grimoire disabled).
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
            fuzzer.features.grimoire_enabled = false;

            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());
            assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

            // Force I2S to complete.
            force_single_iteration(&mut fuzzer);

            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(next.is_none(), "should return None when Grimoire disabled");
            assert!(matches!(fuzzer.stage_state, StageState::None));

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_none_to_generalization_no_cmplog() {
            // No CmpLog → Generalization (Grimoire enabled, input qualifies).
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_corpus_entry(b"hello", &[10]);

            // Ensure CmpValuesMetadata is empty (no CmpLog data).
            fuzzer
                .state
                .metadata_map_mut()
                .insert(CmpValuesMetadata { list: vec![] });
            fuzzer.last_interesting_corpus_id = Some(corpus_id);

            let first = fuzzer.begin_stage().unwrap();
            assert!(
                first.is_some(),
                "should start Generalization when no CmpLog data"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Generalization { .. }),
                "should be in Generalization stage"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_none_to_grimoire_no_cmplog_preexisting_metadata() {
            // No CmpLog → Grimoire (Grimoire enabled, pre-existing GeneralizedInputMetadata).
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_grimoire_entry(b"fn foo() {}");

            // Ensure CmpValuesMetadata is empty.
            fuzzer
                .state
                .metadata_map_mut()
                .insert(CmpValuesMetadata { list: vec![] });
            fuzzer.last_interesting_corpus_id = Some(corpus_id);

            let first = fuzzer.begin_stage().unwrap();
            assert!(
                first.is_some(),
                "should start Grimoire when no CmpLog data and metadata exists"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Grimoire { .. }),
                "should be in Grimoire stage"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_generalization_fail_to_none() {
            // Generalization verification fails → None.
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_corpus_entry(b"hello", &[10]);

            let first = fuzzer.begin_generalization(corpus_id).unwrap();
            assert!(first.is_some());

            // Disable Grimoire so if verification fails, we go to None (not Grimoire).
            fuzzer.features.grimoire_enabled = false;

            // Verification: DON'T set novelty index → verification fails.
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(next.is_none(), "verification failure should return None");
            assert!(matches!(fuzzer.stage_state, StageState::None));

            // Verify no GeneralizedInputMetadata was stored.
            let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
            assert!(
                !tc.has_metadata::<GeneralizedInputMetadata>(),
                "should not store metadata when verification fails"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_abort_from_generalization() {
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_corpus_entry(b"hello", &[10]);

            let _first = fuzzer.begin_generalization(corpus_id).unwrap();
            assert!(matches!(
                fuzzer.stage_state,
                StageState::Generalization { .. }
            ));

            let total_before = fuzzer.total_execs;
            fuzzer.abort_stage(ExitKind::Crash).unwrap();

            assert!(matches!(fuzzer.stage_state, StageState::None));
            assert_eq!(fuzzer.total_execs, total_before + 1);

            // Verify no GeneralizedInputMetadata was stored.
            let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
            assert!(!tc.has_metadata::<GeneralizedInputMetadata>());

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_abort_from_grimoire() {
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_grimoire_entry(b"fn foo() {}");

            let _first = fuzzer.begin_grimoire(corpus_id).unwrap();
            assert!(matches!(fuzzer.stage_state, StageState::Grimoire { .. }));

            let total_before = fuzzer.total_execs;
            fuzzer.abort_stage(ExitKind::Timeout).unwrap();

            assert!(matches!(fuzzer.stage_state, StageState::None));
            assert_eq!(fuzzer.total_execs, total_before + 1);

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_abort_from_i2s() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            let _first = fuzzer.begin_stage().unwrap();
            assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

            let total_before = fuzzer.total_execs;
            fuzzer.abort_stage(ExitKind::Crash).unwrap();

            assert!(matches!(fuzzer.stage_state, StageState::None));
            assert_eq!(fuzzer.total_execs, total_before + 1);

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_i2s_to_unicode_grimoire_disabled() {
            // I2S → Unicode → None (grimoire disabled, unicode enabled).
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.features.unicode_enabled = true;
            fuzzer.features.deferred_detection_count = None;

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            let _ = fuzzer.get_next_input().unwrap();
            unsafe {
                *fuzzer.map_ptr.add(42) = 1;
            }
            cmplog::push(
                CmpValues::Bytes((make_cmplog_bytes(b"hello"), make_cmplog_bytes(b"world"))),
                0,
                cmplog::CmpLogOperator::Equal,
            );
            let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
            assert_eq!(result, IterationResult::Interesting);

            // Calibrate.
            for _ in 0..3 {
                unsafe {
                    *fuzzer.map_ptr.add(42) = 1;
                }
                let needs_more = fuzzer.calibrate_run(50_000.0).unwrap();
                if !needs_more {
                    break;
                }
            }
            fuzzer.calibrate_finish().unwrap();

            // beginStage should start I2S.
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());
            assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

            // Force I2S to single iteration.
            force_single_iteration(&mut fuzzer);

            // Advance I2S — should transition to Unicode (grimoire disabled).
            let after_i2s = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                after_i2s.is_some(),
                "should transition to unicode after I2S"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                "stage should be Unicode after I2S completion"
            );

            // Force unicode to single iteration and advance — should complete.
            force_single_iteration(&mut fuzzer);

            let after_unicode = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                after_unicode.is_none(),
                "unicode should complete and return None"
            );
            assert!(matches!(fuzzer.stage_state, StageState::None));

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_grimoire_to_unicode() {
            // Grimoire → Unicode → None (both enabled).
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_grimoire_entry(b"fn foo() {}");
            fuzzer.features.unicode_enabled = true;

            let first = fuzzer.begin_grimoire(corpus_id).unwrap();
            assert!(first.is_some());

            // Force Grimoire to single iteration.
            force_single_iteration(&mut fuzzer);

            // Advance Grimoire — should transition to Unicode.
            let after_grimoire = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                after_grimoire.is_some(),
                "should transition to unicode after Grimoire"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                "stage should be Unicode after Grimoire completion"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_unicode_disabled_existing_transitions_unchanged() {
            // With unicode disabled, Grimoire → None (no unicode fallthrough).
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_grimoire_entry(b"fn foo() {}");
            assert!(!fuzzer.features.unicode_enabled);

            let first = fuzzer.begin_grimoire(corpus_id).unwrap();
            assert!(first.is_some());

            // Force Grimoire to single iteration.
            force_single_iteration(&mut fuzzer);

            let after_grimoire = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                after_grimoire.is_none(),
                "should return None when unicode disabled"
            );
            assert!(matches!(fuzzer.stage_state, StageState::None));

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_unicode_only_begin_no_cmplog() {
            // No CmpLog, Grimoire not applicable, unicode enabled → direct to Unicode.
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .unicode(true)
                .build_with_corpus_entry(b"hello world", &[10]);

            // Set up for beginStage: set last_interesting_corpus_id directly.
            fuzzer.last_interesting_corpus_id = Some(corpus_id);
            fuzzer.stage_state = StageState::None;

            // Ensure no CmpLog data.
            fuzzer
                .state
                .metadata_map_mut()
                .insert(CmpValuesMetadata::new());

            let result = fuzzer.begin_stage().unwrap();
            assert!(result.is_some(), "should begin unicode stage directly");
            assert!(
                matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                "stage should be Unicode"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_grimoire_enabled_but_not_applicable_transitions_to_unicode() {
            // Grimoire enabled, but entry doesn't qualify for generalization and has no
            // GeneralizedInputMetadata → should fall through to Unicode.
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.features.grimoire_enabled = true;
            fuzzer.features.unicode_enabled = true;
            fuzzer.features.deferred_detection_count = None;

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // Add a corpus entry that does NOT have GeneralizedInputMetadata
            // and does NOT qualify for generalization (no MapNoveltiesMetadata).
            let mut testcase = Testcase::new(BytesInput::new(b"hello utf8 test".to_vec()));
            let mut sched_meta = SchedulerTestcaseMetadata::new(0);
            sched_meta.set_n_fuzz_entry(0);
            testcase.add_metadata(sched_meta);
            testcase.add_metadata(MapIndexesMetadata::new(vec![]));
            *testcase.exec_time_mut() = Some(Duration::from_micros(100));

            let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
            fuzzer
                .scheduler
                .on_add(&mut fuzzer.state, corpus_id)
                .unwrap();

            // Set up for beginStage.
            fuzzer.last_interesting_corpus_id = Some(corpus_id);

            // Ensure no CmpLog data.
            fuzzer
                .state
                .metadata_map_mut()
                .insert(CmpValuesMetadata::new());

            let result = fuzzer.begin_stage().unwrap();
            assert!(
                result.is_some(),
                "should fall through to unicode when grimoire not applicable"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                "stage should be Unicode"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_generalization_failure_transitions_to_none_not_unicode() {
            // Generalization failure → None (not Unicode).
            // Unstable inputs produce unreliable coverage.
            let input = b"ab";
            let novelty_indices = vec![10];
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_corpus_entry(input, &novelty_indices);
            fuzzer.features.unicode_enabled = true;

            // Begin generalization.
            let first = fuzzer.begin_generalization(corpus_id).unwrap();
            assert!(first.is_some());
            assert!(matches!(
                fuzzer.stage_state,
                StageState::Generalization { .. }
            ));

            // Simulate verification failure by NOT writing the expected coverage.
            // advance_generalization will see missing novel coverage → fail.
            let result = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

            // The generalization verification failed, so it should transition to None.
            assert!(
                result.is_none(),
                "generalization failure should transition to None, not Unicode"
            );
            assert!(matches!(fuzzer.stage_state, StageState::None));

            cmplog::disable();
        }

        #[test]
        fn test_finalize_generalization_falls_through_to_unicode() {
            // When grimoire is disabled mid-flight, finalize_generalization must
            // fall through to Unicode instead of returning None.
            let input = b"fn foo() { return 42; }";
            let novelty_indices = vec![10, 20];
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_corpus_entry(input, &novelty_indices);
            fuzzer.features.unicode_enabled = true;

            // Begin generalization.
            let first = fuzzer.begin_generalization(corpus_id).unwrap();
            assert!(first.is_some());
            assert!(matches!(
                fuzzer.stage_state,
                StageState::Generalization { .. }
            ));

            // Disable grimoire mid-flight so finalize_generalization can't start Grimoire.
            fuzzer.features.grimoire_enabled = false;

            // Drive generalization to completion.
            let mut count = 0;
            loop {
                unsafe {
                    for &idx in &novelty_indices {
                        *fuzzer.map_ptr.add(idx) = 1;
                    }
                }
                let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                match &fuzzer.stage_state {
                    StageState::Unicode { .. } => {
                        assert!(
                            next.is_some(),
                            "Unicode transition should return a candidate"
                        );
                        break;
                    }
                    StageState::None if next.is_none() => {
                        panic!(
                            "finalize_generalization returned None — should have fallen through to Unicode"
                        );
                    }
                    _ => {}
                }
                count += 1;
                assert!(
                    count <= 200,
                    "should complete generalization within 200 iterations"
                );
            }

            assert!(
                matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                "stage should have transitioned to Unicode after generalization"
            );

            cmplog::disable();
        }

        #[test]
        fn test_pipeline_full_four_stage_lifecycle() {
            // I2S → Generalization → Grimoire → Unicode → None.
            // This is the most comprehensive pipeline test.
            let input = b"fn foo() { return 42; }";
            let novelty_indices = vec![10, 20];
            let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
                .grimoire(true)
                .build_with_corpus_entry(input, &novelty_indices);
            fuzzer.features.unicode_enabled = true;

            // Manually add CmpValuesMetadata with data to trigger I2S.
            fuzzer.state.metadata_map_mut().insert(CmpValuesMetadata {
                list: vec![CmpValues::Bytes((
                    make_cmplog_bytes(b"foo"),
                    make_cmplog_bytes(b"bar"),
                ))],
            });

            fuzzer.last_interesting_corpus_id = Some(corpus_id);

            // beginStage should start I2S (CmpLog data present).
            let first = fuzzer.begin_stage().unwrap();
            assert!(first.is_some());
            assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

            // Force I2S to single iteration.
            force_single_iteration(&mut fuzzer);

            // Advance I2S — should transition to Generalization.
            // Write expected coverage for generalization verification.
            unsafe {
                for &idx in &novelty_indices {
                    *fuzzer.map_ptr.add(idx) = 1;
                }
            }
            let after_i2s = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            assert!(
                after_i2s.is_some(),
                "should transition from I2S to Generalization"
            );
            assert!(
                matches!(fuzzer.stage_state, StageState::Generalization { .. }),
                "stage should be Generalization"
            );

            // Run through generalization to completion.
            loop {
                // Write expected coverage for each generalization candidate.
                unsafe {
                    for &idx in &novelty_indices {
                        *fuzzer.map_ptr.add(idx) = 1;
                    }
                }
                let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                if next.is_none() {
                    // Generalization complete or Grimoire started.
                    break;
                }
                // If we transitioned to Grimoire or Unicode, we're done with generalization.
                match &fuzzer.stage_state {
                    StageState::Grimoire { .. } | StageState::Unicode { .. } => break,
                    _ => continue,
                }
            }

            // After generalization, we should be in Grimoire or Unicode.
            // (Depends on whether generalization produced metadata.)
            match &fuzzer.stage_state {
                StageState::Grimoire { .. } => {
                    // Force Grimoire to single iteration.
                    force_single_iteration(&mut fuzzer);

                    let after_grimoire = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                    // Should transition to Unicode.
                    if after_grimoire.is_some() {
                        assert!(
                            matches!(fuzzer.stage_state, StageState::Unicode { .. }),
                            "should transition from Grimoire to Unicode"
                        );

                        // Force unicode to single iteration.
                        force_single_iteration(&mut fuzzer);

                        let after_unicode = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                        assert!(after_unicode.is_none(), "pipeline should complete");
                    }
                }
                StageState::Unicode { .. } => {
                    // Generalization skipped to Unicode directly.
                    force_single_iteration(&mut fuzzer);
                    let after_unicode = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
                    assert!(after_unicode.is_none(), "pipeline should complete");
                }
                StageState::None => {
                    // Generalization may have failed (input unstable) — that's ok
                    // for this test; the key is that the pipeline didn't crash.
                }
                _ => panic!("unexpected stage state after generalization"),
            }

            assert!(
                matches!(fuzzer.stage_state, StageState::None),
                "pipeline should end in None"
            );

            cmplog::disable();
        }
    }

    mod minimizer {
        use super::*;

        #[test]
        fn test_map_indexes_metadata_contains_all_covered_edges() {
            // Task 1.3: MapIndexesMetadata contains all nonzero indices (not just novel).
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // First iteration: set edges {10, 20, 30} as covered. All are novel.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
                *fuzzer.map_ptr.add(20) = 2;
                *fuzzer.map_ptr.add(30) = 3;
            }
            fuzzer.last_input = Some(BytesInput::new(b"input1".to_vec()));
            fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            // The corpus entry should have MapIndexesMetadata with all 3 edges.
            // MapIndexesMetadata has refcnt > 0 after update_score, so it must be present.
            let id = CorpusId::from(1usize); // second entry (after seed)
            let tc = fuzzer.state.corpus().get(id).unwrap().borrow();
            let meta = tc
                .metadata::<MapIndexesMetadata>()
                .expect("MapIndexesMetadata should be present (refcnt > 0 after update_score)");
            assert!(meta.list.contains(&10));
            assert!(meta.list.contains(&20));
            assert!(meta.list.contains(&30));
            assert_eq!(meta.list.len(), 3);
            drop(tc);

            // Second iteration: edges {10, 20, 30, 40, 50} covered, only {40, 50} novel.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
                *fuzzer.map_ptr.add(20) = 2;
                *fuzzer.map_ptr.add(30) = 3;
                *fuzzer.map_ptr.add(40) = 1;
                *fuzzer.map_ptr.add(50) = 1;
            }
            fuzzer.last_input = Some(BytesInput::new(b"input2".to_vec()));
            fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            // The entry should have MapIndexesMetadata with ALL 5 edges.
            let id2 = CorpusId::from(2usize);
            let tc2 = fuzzer.state.corpus().get(id2).unwrap().borrow();
            let meta = tc2
                .metadata::<MapIndexesMetadata>()
                .expect("MapIndexesMetadata should be present (refcnt > 0 after update_score)");
            assert!(meta.list.contains(&10), "should contain non-novel edge 10");
            assert!(meta.list.contains(&20), "should contain non-novel edge 20");
            assert!(meta.list.contains(&30), "should contain non-novel edge 30");
            assert!(meta.list.contains(&40), "should contain novel edge 40");
            assert!(meta.list.contains(&50), "should contain novel edge 50");
            assert_eq!(meta.list.len(), 5);

            cmplog::disable();
        }

        #[test]
        fn test_map_indexes_metadata_absent_for_non_interesting() {
            // Task 1.3: MapIndexesMetadata not stored for non-interesting inputs.
            let mut fuzzer = TestFuzzerBuilder::new(256).build();

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

            // First: establish coverage at edge 10.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            fuzzer.last_input = Some(BytesInput::new(b"novel".to_vec()));
            fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));

            let corpus_before = fuzzer.state.corpus().count();

            // Second: same coverage (edge 10 only) — not interesting.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            fuzzer.last_input = Some(BytesInput::new(b"duplicate".to_vec()));
            fuzzer.last_corpus_id = Some(CorpusId::from(0usize));
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::None));

            // Corpus should not have grown — no entry was added.
            assert_eq!(fuzzer.state.corpus().count(), corpus_before);

            cmplog::disable();
        }

        #[test]
        fn test_top_rateds_populated_on_corpus_addition() {
            // Task 3.1: TopRatedsMetadata populated when corpus entries are added.
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a seed (no edges).
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // TopRatedsMetadata should be empty (seed has no edges).
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert!(
                    top_rated.map().is_empty(),
                    "TopRatedsMetadata should be empty after adding seed"
                );
            }

            // Add an interesting entry covering edges {10, 20}.
            let mut tc = Testcase::new(BytesInput::new(b"entry1".to_vec()));
            tc.set_exec_time(Duration::from_micros(100));
            let mut sched_meta = SchedulerTestcaseMetadata::new(1);
            sched_meta.set_bitmap_size(2);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            tc.add_metadata(sched_meta);
            tc.add_metadata(MapIndexesMetadata::new(vec![10, 20]));
            let id1 = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, id1).unwrap();

            // TopRatedsMetadata should now track edges 10 and 20 → id1.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&10),
                    Some(&id1),
                    "edge 10 should be tracked to entry 1"
                );
                assert_eq!(
                    top_rated.map().get(&20),
                    Some(&id1),
                    "edge 20 should be tracked to entry 1"
                );
            }
        }

        #[test]
        fn test_is_favored_set_on_best_representative() {
            // Task 3.2: IsFavoredMetadata set on entries that are best for at least one edge.
            use libafl::schedulers::minimizer::IsFavoredMetadata;

            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a seed.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Add entry covering edge 10.
            let mut tc = Testcase::new(BytesInput::new(b"entry1".to_vec()));
            tc.set_exec_time(Duration::from_micros(100));
            let mut sched_meta = SchedulerTestcaseMetadata::new(1);
            sched_meta.set_bitmap_size(1);
            sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
            tc.add_metadata(sched_meta);
            tc.add_metadata(MapIndexesMetadata::new(vec![10]));
            let id1 = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, id1).unwrap();

            // Trigger cull by calling next(). MinimizerScheduler::next calls cull
            // which refreshes IsFavoredMetadata.
            let _ = scheduler.next(&mut state).unwrap();

            // Entry 1 should be favored (best for edge 10).
            {
                let tc = state.corpus().get(id1).unwrap().borrow();
                assert!(
                    tc.metadata::<IsFavoredMetadata>().is_ok(),
                    "entry covering edge 10 should be favored"
                );
            }

            // Seed should NOT be favored (no edges).
            {
                let tc = state.corpus().get(seed_id).unwrap().borrow();
                assert!(
                    tc.metadata::<IsFavoredMetadata>().is_err(),
                    "seed with no edges should not be favored"
                );
            }
        }

        #[test]
        fn test_non_favored_entries_skipped_with_high_probability() {
            // Task 3.3: Non-favored entries skipped with high probability.
            // With only seeds (non-favored), the scheduler should still terminate
            // but each attempt has a 95% skip probability.
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add seeds only (all non-favored).
            for seed in DEFAULT_SEEDS {
                let tc = make_seed_testcase(seed);
                let id = state.corpus_mut().add(tc).unwrap();
                scheduler.on_add(&mut state, id).unwrap();
            }

            // With a known seed, call next() multiple times — it should always return
            // a valid corpus ID even though all entries are non-favored.
            for _ in 0..20 {
                let id = scheduler.next(&mut state).unwrap();
                assert!(
                    state.corpus().get(id).is_ok(),
                    "scheduler should return valid corpus entry even when all non-favored"
                );
            }
        }

        #[test]
        fn test_entry_displacement_smaller_faster_wins() {
            // Task 3.4: Smaller/faster entry replaces larger/slower for shared edge.
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a seed.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Entry A: large, slow. Covers edge 42.
            // penalty = as_millis(1ms) * 100 bytes = 100
            let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 100]));
            tc_a.set_exec_time(Duration::from_millis(1));
            let mut meta_a = SchedulerTestcaseMetadata::new(1);
            meta_a.set_bitmap_size(1);
            meta_a.set_cycle_and_time((Duration::from_millis(1), 1));
            tc_a.add_metadata(meta_a);
            tc_a.add_metadata(MapIndexesMetadata::new(vec![42]));
            let id_a = state.corpus_mut().add(tc_a).unwrap();
            scheduler.on_add(&mut state, id_a).unwrap();

            // Entry A should own edge 42.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(top_rated.map().get(&42), Some(&id_a));
            }

            // Entry B: small, fast. Also covers edge 42.
            // penalty = as_millis(500us) * 50 bytes = 0 (sub-ms truncates to 0; lower → wins)
            let mut tc_b = Testcase::new(BytesInput::new(vec![0u8; 50]));
            tc_b.set_exec_time(Duration::from_micros(500));
            let mut meta_b = SchedulerTestcaseMetadata::new(1);
            meta_b.set_bitmap_size(1);
            meta_b.set_cycle_and_time((Duration::from_micros(500), 1));
            tc_b.add_metadata(meta_b);
            tc_b.add_metadata(MapIndexesMetadata::new(vec![42]));
            let id_b = state.corpus_mut().add(tc_b).unwrap();
            scheduler.on_add(&mut state, id_b).unwrap();

            // Entry B should now own edge 42 (lower penalty).
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&42),
                    Some(&id_b),
                    "smaller/faster entry B should displace entry A for edge 42"
                );
            }
        }

        #[test]
        fn test_seeds_have_empty_map_indexes_metadata() {
            // Task 3.5: Seeds have empty MapIndexesMetadata, on_add succeeds,
            // and TopRatedsMetadata is not modified.
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // TopRatedsMetadata should be empty initially.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert!(top_rated.map().is_empty());
            }

            // Add 3 seeds.
            for seed_data in [b"hello" as &[u8], b"world", b"test"] {
                let tc = make_seed_testcase(seed_data);
                let id = state.corpus_mut().add(tc).unwrap();
                // on_add should succeed without error.
                scheduler.on_add(&mut state, id).unwrap();
            }

            // TopRatedsMetadata should STILL be empty — seeds have no edges.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert!(
                    top_rated.map().is_empty(),
                    "TopRatedsMetadata should not be modified by seeds with empty MapIndexesMetadata"
                );
            }
        }

        #[test]
        fn test_calibration_on_replace_retains_edges() {
            // Spec coverage: corpus-minimizer/spec.md lines 74-105.
            // Scenarios: "Calibrated entry retains existing edges" and
            // "Future entries compare using calibrated penalties".
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a seed (required by the scheduler).
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Add entry A covering edges {10, 20}.
            // LenTimeMulTestcasePenalty: exec_time.as_millis() * input_len = 1 * 10 = 10
            let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 10]));
            tc_a.set_exec_time(Duration::from_millis(1));
            let mut sched_meta_a = SchedulerTestcaseMetadata::new(1);
            sched_meta_a.set_bitmap_size(2);
            sched_meta_a.set_cycle_and_time((Duration::from_millis(1), 1));
            tc_a.add_metadata(sched_meta_a);
            tc_a.add_metadata(MapIndexesMetadata::new(vec![10, 20]));
            let id_a = state.corpus_mut().add(tc_a).unwrap();
            scheduler.on_add(&mut state, id_a).unwrap();

            // Verify A owns edges {10, 20}.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(top_rated.map().get(&10), Some(&id_a));
                assert_eq!(top_rated.map().get(&20), Some(&id_a));
            }

            // --- Scenario 1: self-comparison shortcut in on_replace ---
            // Worsen A's exec_time to 5ms → penalty becomes 5 * 10 = 50.
            // on_replace should retain A's edges unconditionally (self-check shortcut).
            let prev_tc = {
                let tc = state.corpus().get(id_a).unwrap().borrow();
                tc.clone()
            };
            {
                let mut tc = state.corpus().get(id_a).unwrap().borrow_mut();
                tc.set_exec_time(Duration::from_millis(5));
                tc.metadata_mut::<SchedulerTestcaseMetadata>()
                    .expect("SchedulerTestcaseMetadata should be present")
                    .set_cycle_and_time((Duration::from_millis(5), 1));
            }
            scheduler.on_replace(&mut state, id_a, &prev_tc).unwrap();

            // A should still own edges {10, 20} after on_replace (self-comparison retains).
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&10),
                    Some(&id_a),
                    "A should retain edge 10 after on_replace (self-comparison shortcut)"
                );
                assert_eq!(
                    top_rated.map().get(&20),
                    Some(&id_a),
                    "A should retain edge 20 after on_replace (self-comparison shortcut)"
                );
            }

            // --- Scenario 2: displacement uses calibrated penalty ---
            // Add entry C covering edge {10} only.
            // penalty = 2ms * 10 bytes = 20 (lower than A's calibrated 50).
            let mut tc_c = Testcase::new(BytesInput::new(vec![0u8; 10]));
            tc_c.set_exec_time(Duration::from_millis(2));
            let mut sched_meta_c = SchedulerTestcaseMetadata::new(1);
            sched_meta_c.set_bitmap_size(1);
            sched_meta_c.set_cycle_and_time((Duration::from_millis(2), 1));
            tc_c.add_metadata(sched_meta_c);
            tc_c.add_metadata(MapIndexesMetadata::new(vec![10]));
            let id_c = state.corpus_mut().add(tc_c).unwrap();
            scheduler.on_add(&mut state, id_c).unwrap();

            // C (penalty 20) should displace A (calibrated penalty 50) for edge 10.
            // A should retain edge 20 (C doesn't cover it).
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&10),
                    Some(&id_c),
                    "C (penalty 20) should displace A (penalty 50) for edge 10"
                );
                assert_eq!(
                    top_rated.map().get(&20),
                    Some(&id_a),
                    "A should retain edge 20 (C doesn't cover it)"
                );
            }
        }

        #[test]
        fn test_entry_loses_favored_status_when_displaced() {
            // Spec coverage: corpus-minimizer/spec.md
            // Scenario: "Displaced entry loses edge ownership but retains favored marker"
            // Entry A is best for edge 10 (its only edge). Entry B displaces A.
            // Verifies TopRatedsMetadata ownership transfers and B gets IsFavoredMetadata.
            // Per spec, A's stale IsFavoredMetadata is not removed (inherited LibAFL behavior).
            use libafl::schedulers::minimizer::IsFavoredMetadata;

            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a seed.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Add entry A covering edge {10} only.
            // penalty = 1ms * 10 bytes = 10
            let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 10]));
            tc_a.set_exec_time(Duration::from_millis(1));
            let mut sched_meta_a = SchedulerTestcaseMetadata::new(1);
            sched_meta_a.set_bitmap_size(1);
            sched_meta_a.set_cycle_and_time((Duration::from_millis(1), 1));
            tc_a.add_metadata(sched_meta_a);
            tc_a.add_metadata(MapIndexesMetadata::new(vec![10]));
            let id_a = state.corpus_mut().add(tc_a).unwrap();
            scheduler.on_add(&mut state, id_a).unwrap();

            // Trigger cull via next() — A should be favored (best for edge 10).
            let _ = scheduler.next(&mut state).unwrap();
            {
                let tc = state.corpus().get(id_a).unwrap().borrow();
                assert!(
                    tc.metadata::<IsFavoredMetadata>().is_ok(),
                    "A should be favored before displacement (best for edge 10)"
                );
            }

            // Add entry B covering edge {10} with lower penalty.
            // penalty = 1ms * 5 bytes = 5 (lower than A's 10)
            let mut tc_b = Testcase::new(BytesInput::new(vec![0u8; 5]));
            tc_b.set_exec_time(Duration::from_millis(1));
            let mut sched_meta_b = SchedulerTestcaseMetadata::new(1);
            sched_meta_b.set_bitmap_size(1);
            sched_meta_b.set_cycle_and_time((Duration::from_millis(1), 1));
            tc_b.add_metadata(sched_meta_b);
            tc_b.add_metadata(MapIndexesMetadata::new(vec![10]));
            let id_b = state.corpus_mut().add(tc_b).unwrap();
            scheduler.on_add(&mut state, id_b).unwrap();

            // B should now own edge 10 in TopRatedsMetadata (displacement happened in on_add).
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&10),
                    Some(&id_b),
                    "B (penalty 5) should displace A (penalty 10) for edge 10"
                );
            }

            // A should not own ANY edge in TopRatedsMetadata (edge 10 was its only edge).
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert!(
                    !top_rated.map().values().any(|id| *id == id_a),
                    "A should not own any edge after displacement"
                );
            }

            // Trigger cull via next() to refresh IsFavoredMetadata.
            let _ = scheduler.next(&mut state).unwrap();

            // B should be favored (cull marks entries in TopRatedsMetadata).
            {
                let tc = state.corpus().get(id_b).unwrap().borrow();
                assert!(
                    tc.metadata::<IsFavoredMetadata>().is_ok(),
                    "B should be favored (now best for edge 10)"
                );
            }
        }

        #[test]
        fn test_calibration_on_replace_gains_new_edges() {
            // Spec coverage: corpus-minimizer/spec.md lines 92-98.
            // Scenario: "Calibrated entry gains new edges with improved penalty"
            // A covers {10, 20, 30} but only owns {20, 30} (B owns 10 with lower penalty).
            // After calibration improves A's exec_time, on_replace makes A displace B for edge 10.
            let (map_ptr, _map) = make_coverage_map(256);
            let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, _map.len());
            let mut scheduler = make_scheduler(map_ptr, _map.len());

            // Add a seed.
            let tc = make_seed_testcase(b"seed");
            let seed_id = state.corpus_mut().add(tc).unwrap();
            scheduler.on_add(&mut state, seed_id).unwrap();

            // Add entry B covering edge {10} only.
            // penalty = 2ms * 10 bytes = 20
            let mut tc_b = Testcase::new(BytesInput::new(vec![0u8; 10]));
            tc_b.set_exec_time(Duration::from_millis(2));
            let mut sched_meta_b = SchedulerTestcaseMetadata::new(1);
            sched_meta_b.set_bitmap_size(1);
            sched_meta_b.set_cycle_and_time((Duration::from_millis(2), 1));
            tc_b.add_metadata(sched_meta_b);
            tc_b.add_metadata(MapIndexesMetadata::new(vec![10]));
            let id_b = state.corpus_mut().add(tc_b).unwrap();
            scheduler.on_add(&mut state, id_b).unwrap();

            // Add entry A covering edges {10, 20, 30}.
            // penalty = 3ms * 10 bytes = 30 (higher than B's 20 for edge 10)
            let mut tc_a = Testcase::new(BytesInput::new(vec![0u8; 10]));
            tc_a.set_exec_time(Duration::from_millis(3));
            let mut sched_meta_a = SchedulerTestcaseMetadata::new(1);
            sched_meta_a.set_bitmap_size(3);
            sched_meta_a.set_cycle_and_time((Duration::from_millis(3), 1));
            tc_a.add_metadata(sched_meta_a);
            tc_a.add_metadata(MapIndexesMetadata::new(vec![10, 20, 30]));
            let id_a = state.corpus_mut().add(tc_a).unwrap();
            scheduler.on_add(&mut state, id_a).unwrap();

            // Verify initial ownership: B owns edge 10, A owns edges 20 and 30.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&10),
                    Some(&id_b),
                    "B should own edge 10 initially (penalty 20 < A's 30)"
                );
                assert_eq!(
                    top_rated.map().get(&20),
                    Some(&id_a),
                    "A should own edge 20 (first and only entry for it)"
                );
                assert_eq!(
                    top_rated.map().get(&30),
                    Some(&id_a),
                    "A should own edge 30 (first and only entry for it)"
                );
            }

            // Simulate calibration: clone A as prev_tc, then improve A's exec_time.
            let prev_tc = {
                let tc = state.corpus().get(id_a).unwrap().borrow();
                tc.clone()
            };

            // Improve A's exec_time from 3ms to 1ms → new penalty = 1ms * 10 bytes = 10.
            {
                let mut tc = state.corpus().get(id_a).unwrap().borrow_mut();
                tc.set_exec_time(Duration::from_millis(1));
                tc.metadata_mut::<SchedulerTestcaseMetadata>()
                    .expect("SchedulerTestcaseMetadata should be present")
                    .set_cycle_and_time((Duration::from_millis(1), 1));
            }

            // Call on_replace to re-evaluate A's edges with the calibrated penalty.
            scheduler.on_replace(&mut state, id_a, &prev_tc).unwrap();

            // A (penalty 10) should now displace B (penalty 20) for edge 10.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_eq!(
                    top_rated.map().get(&10),
                    Some(&id_a),
                    "A should now own edge 10 after calibration (penalty 10 < B's 20)"
                );
                assert_eq!(
                    top_rated.map().get(&20),
                    Some(&id_a),
                    "A should still own edge 20"
                );
                assert_eq!(
                    top_rated.map().get(&30),
                    Some(&id_a),
                    "A should still own edge 30"
                );
            }

            // Verify B no longer owns edge 10.
            {
                let top_rated = state.metadata::<TopRatedsMetadata>().unwrap();
                assert_ne!(
                    top_rated.map().get(&10),
                    Some(&id_b),
                    "B should no longer own edge 10 after A's calibration"
                );
            }
        }
    }

    mod redqueen {
        use super::*;

        #[test]
        fn test_begin_stage_starts_colorization_when_redqueen_enabled() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
            fuzzer.features.redqueen_enabled = true;

            let result = fuzzer.begin_stage().unwrap();
            assert!(result.is_some(), "should start colorization");
            assert!(
                matches!(fuzzer.stage_state, StageState::Colorization { .. }),
                "stage should be Colorization, got {:?}",
                std::mem::discriminant(&fuzzer.stage_state)
            );
            assert!(
                fuzzer.redqueen_ran_for_entry,
                "redqueen_ran_for_entry should be true"
            );

            cmplog::disable();
        }

        #[test]
        fn test_begin_stage_falls_to_i2s_when_redqueen_disabled() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
            fuzzer.features.redqueen_enabled = false;

            let result = fuzzer.begin_stage().unwrap();
            assert!(result.is_some(), "should start I2S");
            assert!(
                matches!(fuzzer.stage_state, StageState::I2S { .. }),
                "stage should be I2S"
            );
            assert!(
                !fuzzer.redqueen_ran_for_entry,
                "redqueen_ran_for_entry should be false"
            );

            cmplog::disable();
        }

        #[test]
        fn test_begin_stage_falls_to_i2s_when_input_too_large() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();
            fuzzer.features.redqueen_enabled = true;

            // Replace the corpus entry with one larger than MAX_COLORIZATION_LEN.
            let large_input = BytesInput::new(vec![0x42; colorization::MAX_COLORIZATION_LEN + 1]);
            let mut testcase = Testcase::new(large_input);
            testcase.set_exec_time(std::time::Duration::from_millis(1));
            let new_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
            fuzzer.last_interesting_corpus_id = Some(new_id);

            // Add CmpValuesMetadata so I2S can start.
            let mut cmp_meta = CmpValuesMetadata::new();
            cmp_meta.list.push(CmpValues::Bytes((
                make_cmplog_bytes(b"test"),
                make_cmplog_bytes(b"best"),
            )));
            fuzzer.state.metadata_map_mut().insert(cmp_meta);

            let result = fuzzer.begin_stage().unwrap();
            assert!(result.is_some(), "should start I2S");
            assert!(
                matches!(fuzzer.stage_state, StageState::I2S { .. }),
                "stage should be I2S, not Colorization"
            );
            assert!(
                !fuzzer.redqueen_ran_for_entry,
                "redqueen_ran_for_entry should be false for oversized input"
            );

            cmplog::disable();
        }

        #[test]
        fn test_redqueen_ran_for_entry_reset_on_begin_stage() {
            let mut fuzzer = TestFuzzerBuilder::new(256).build_ready_for_stage();

            // Manually set the flag to true.
            fuzzer.redqueen_ran_for_entry = true;

            let _result = fuzzer.begin_stage().unwrap();
            // Flag should be reset to false at the start of begin_stage.
            // (It would only be re-set to true if REDQUEEN is enabled and
            // colorization starts, but we left redqueen_enabled = false.)
            assert!(
                !fuzzer.redqueen_ran_for_entry,
                "redqueen_ran_for_entry should be reset"
            );

            cmplog::disable();
        }

        #[test]
        fn test_redqueen_explicit_enable() {
            let coverage_map: Buffer = vec![0u8; 256].into();
            let fuzzer = Fuzzer::new(
                coverage_map,
                Some(FuzzerConfig {
                    max_input_len: None,
                    seed: None,
                    grimoire: None,
                    unicode: None,
                    redqueen: Some(true),
                }),
            )
            .unwrap();
            assert!(
                fuzzer.features.redqueen_enabled,
                "explicit true should enable"
            );
        }

        #[test]
        fn test_redqueen_explicit_disable() {
            let coverage_map: Buffer = vec![0u8; 256].into();
            let fuzzer = Fuzzer::new(
                coverage_map,
                Some(FuzzerConfig {
                    max_input_len: None,
                    seed: None,
                    grimoire: None,
                    unicode: None,
                    redqueen: Some(false),
                }),
            )
            .unwrap();
            assert!(
                !fuzzer.features.redqueen_enabled,
                "explicit false should disable"
            );
        }

        #[test]
        fn test_redqueen_auto_detect_empty_corpus_defaults_false() {
            let coverage_map: Buffer = vec![0u8; 256].into();
            let fuzzer = Fuzzer::new(
                coverage_map,
                Some(FuzzerConfig {
                    max_input_len: None,
                    seed: None,
                    grimoire: None,
                    unicode: None,
                    redqueen: None,
                }),
            )
            .unwrap();
            assert!(
                !fuzzer.features.redqueen_enabled,
                "auto-detect with empty corpus should default to false"
            );
            assert!(
                fuzzer.features.deferred_detection_count.is_some(),
                "should have deferred detection"
            );
        }

        #[test]
        fn test_redqueen_deferred_detection_binary_corpus_enables() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.features.redqueen_override = None;
            fuzzer.features.redqueen_enabled = false;
            fuzzer.features.deferred_detection_count = Some(0);

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
            let seed_id = CorpusId::from(0usize);

            for i in 0..DEFERRED_DETECTION_THRESHOLD {
                fuzzer.last_input = Some(BytesInput::new(vec![0x80, 0x90, 0xA0, i as u8]));
                fuzzer.last_corpus_id = Some(seed_id);
                unsafe {
                    *fuzzer.map_ptr.add(i + 10) = 1;
                }
                let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
                assert!(matches!(result, IterationResult::Interesting));
                fuzzer.calibrate_finish().unwrap();
            }

            assert!(
                fuzzer.features.redqueen_enabled,
                "REDQUEEN should be enabled for binary corpus"
            );
            assert!(
                fuzzer.features.deferred_detection_count.is_none(),
                "detection should be resolved"
            );

            cmplog::disable();
        }

        #[test]
        fn test_redqueen_deferred_detection_utf8_corpus_disables() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.features.redqueen_override = None;
            fuzzer.features.redqueen_enabled = false;
            fuzzer.features.deferred_detection_count = Some(0);

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
            let seed_id = CorpusId::from(0usize);

            for i in 0..DEFERRED_DETECTION_THRESHOLD {
                fuzzer.last_input = Some(BytesInput::new(format!("hello{i}").into_bytes()));
                fuzzer.last_corpus_id = Some(seed_id);
                unsafe {
                    *fuzzer.map_ptr.add(i + 10) = 1;
                }
                let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
                assert!(matches!(result, IterationResult::Interesting));
                fuzzer.calibrate_finish().unwrap();
            }

            assert!(
                !fuzzer.features.redqueen_enabled,
                "REDQUEEN should be disabled for UTF-8 corpus"
            );
            assert!(
                fuzzer.features.deferred_detection_count.is_none(),
                "detection should be resolved"
            );

            cmplog::disable();
        }

        #[test]
        fn test_redqueen_complementary_to_grimoire_unicode() {
            cmplog::disable();
            cmplog::drain();

            let mut fuzzer = TestFuzzerBuilder::new(256).build();
            fuzzer.features.grimoire_override = None;
            fuzzer.features.unicode_override = None;
            fuzzer.features.redqueen_override = None;
            fuzzer.features.grimoire_enabled = false;
            fuzzer.features.unicode_enabled = false;
            fuzzer.features.redqueen_enabled = false;
            fuzzer.features.deferred_detection_count = Some(0);

            fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
            let seed_id = CorpusId::from(0usize);

            for i in 0..DEFERRED_DETECTION_THRESHOLD {
                fuzzer.last_input = Some(BytesInput::new(vec![0xFF, 0xFE, 0xFD, i as u8]));
                fuzzer.last_corpus_id = Some(seed_id);
                unsafe {
                    *fuzzer.map_ptr.add(i + 10) = 1;
                }
                let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
                assert!(matches!(result, IterationResult::Interesting));
                fuzzer.calibrate_finish().unwrap();
            }

            // Binary corpus: REDQUEEN on, Grimoire/Unicode off.
            assert!(
                fuzzer.features.redqueen_enabled,
                "binary corpus → REDQUEEN enabled"
            );
            assert!(
                !fuzzer.features.grimoire_enabled,
                "binary corpus → Grimoire disabled"
            );
            assert!(
                !fuzzer.features.unicode_enabled,
                "binary corpus → Unicode disabled"
            );

            cmplog::disable();
        }
    }
}
