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
use libafl_bolts::tuples::{Merge, tuple_list, tuple_list_type};
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
mod tests;
mod token_tracker;
mod unicode;
use feature_detection::FeatureDetection;
use generalization::GeneralizationPhase;
use mutator::I2SSpliceReplace;

use calibration::{CALIBRATION_STAGE_MAX, CALIBRATION_STAGE_START, CalibrationState};
use cmplog_metadata::{
    build_aflpp_cmp_metadata, extract_tokens_from_cmplog, flatten_orig_cmpvals,
    set_n_fuzz_entry_for_corpus_id,
};
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
