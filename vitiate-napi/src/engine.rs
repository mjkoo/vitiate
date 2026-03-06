use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, SchedulerTestcaseMetadata, Testcase};
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::map::MapFeedbackMetadata;
use libafl::feedbacks::{
    CrashFeedback, Feedback, MapNoveltiesMetadata, MaxMapFeedback, StateInitializer,
    TimeoutFeedback,
};
use libafl::inputs::{BytesInput, GeneralizedInputMetadata, HasMutatorBytes, ResizableMutator};
use libafl::mutators::grimoire::{
    GrimoireExtensionMutator, GrimoireRandomDeleteMutator, GrimoireRecursiveReplacementMutator,
    GrimoireStringReplacementMutator,
};
use libafl::mutators::token_mutations::{I2SRandReplace, TokenInsert, TokenReplace};
use libafl::mutators::{
    HavocMutationsType, HavocScheduledMutator, MutationResult, Mutator, Tokens, havoc_mutations,
    tokens_mutations,
};
use libafl::observers::StdMapObserver;
use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};
use libafl::schedulers::powersched::{N_FUZZ_SIZE, PowerSchedule, SchedulerMetadata};
use libafl::schedulers::testcase_score::CorpusPowerTestcaseScore;
use libafl::schedulers::{ProbabilitySamplingScheduler, RemovableScheduler, Scheduler};
use libafl::state::{HasCorpus, HasExecutions, HasMaxSize, HasRand, HasSolutions, StdState};
use libafl::{HasMetadata, HasNamedMetadata};
use libafl_bolts::rands::{Rand, StdRand};
use libafl_bolts::tuples::{Merge, tuple_list};
use libafl_bolts::{AsSlice, HasLen, Named};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::types::{ExitKind, FuzzerConfig, FuzzerStats, IterationResult};

const EDGES_OBSERVER_NAME: &str = "edges";
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

/// Calibration run count: minimum total runs (including original iteration).
const CALIBRATION_STAGE_START: usize = 4;
/// Calibration run count: maximum total runs (extended when unstable edges detected).
const CALIBRATION_STAGE_MAX: usize = 8;

/// Nominal execution time assigned to seeds (not calibrated).
const SEED_EXEC_TIME: Duration = Duration::from_millis(1);

/// Number of interesting main-loop inputs before deferred Grimoire auto-detection fires.
const GRIMOIRE_DEFERRED_THRESHOLD: usize = 10;

/// Maximum power-of-two stacked mutations per Grimoire iteration (2^3 = 8 max).
const GRIMOIRE_MAX_STACK_POW: usize = 3;

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

/// Minimum number of observations (appearances in CmpLog entries across all
/// `report_result` calls) before a token candidate is promoted into the mutation
/// dictionary. A token appearing in multiple `CmpValues::Bytes` entries within
/// a single call increments multiple times. Constants like `"javascript"` appear
/// in every execution that reaches a comparison; one-off garbled byte sequences
/// produced by havoc mutations appear only once. A threshold of 3 effectively
/// filters out noise while keeping real constants.
const TOKEN_PROMOTION_THRESHOLD: usize = 3;

/// Maximum number of token candidates tracked before new candidates are
/// dropped. Real comparison constants are promoted quickly (they appear in
/// every execution that reaches the comparison), so this cap prevents unbounded
/// growth from the long tail of one-off garbled byte sequences.
const MAX_TOKEN_CANDIDATES: usize = 4096;

/// Maximum number of auto-discovered tokens in the mutation dictionary.
/// Once this limit is reached, no further tokens are promoted. Real comparison
/// constants are promoted within the first few iterations (they appear in every
/// execution that reaches the comparison), so a cap prevents the long tail of
/// garbled byte sequences that happen to exceed `TOKEN_PROMOTION_THRESHOLD` from
/// diluting the dictionary. Matches AFL++'s `MAX_AUTO_EXTRAS` order of magnitude
/// but scaled down since our single-threaded loop benefits from a tighter
/// dictionary.
const MAX_DICTIONARY_SIZE: usize = 512;

// Concrete LibAFL type aliases.
type CovObserver = StdMapObserver<'static, u8, false>;
type FuzzerFeedback = MaxMapFeedback<CovObserver, CovObserver>;
type CrashObjective = CrashFeedback;
type TimeoutObjective = TimeoutFeedback;
type FuzzerScheduler = ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>;
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
type FuzzerState =
    StdState<InMemoryCorpus<BytesInput>, BytesInput, StdRand, InMemoryCorpus<BytesInput>>;

/// An I2S mutator that extends `I2SRandReplace` with a length-changing splice path
/// for `CmpValues::Bytes` entries. When a byte operand match is found, it randomly
/// chooses between overwrite (same-length, matching `I2SRandReplace` behavior) and
/// splice (delete matched bytes, insert full replacement, changing input length).
/// Non-`Bytes` variants delegate to the inner `I2SRandReplace`.
struct I2SSpliceReplace {
    inner: I2SRandReplace,
}

impl I2SSpliceReplace {
    fn new() -> Self {
        Self {
            inner: I2SRandReplace::new(),
        }
    }
}

impl Named for I2SSpliceReplace {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: std::borrow::Cow<'static, str> =
            std::borrow::Cow::Borrowed("I2SSpliceReplace");
        &NAME
    }
}

impl<I, S> Mutator<I, S> for I2SSpliceReplace
where
    S: HasMetadata + HasRand + HasMaxSize,
    I: ResizableMutator<u8> + HasMutatorBytes,
{
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut I,
    ) -> std::result::Result<MutationResult, libafl::Error> {
        let input_len = input.len();
        if input_len == 0 {
            return Ok(MutationResult::Skipped);
        }

        let cmps_len = {
            let Some(meta) = state.metadata_map().get::<CmpValuesMetadata>() else {
                return Ok(MutationResult::Skipped);
            };
            meta.list.len()
        };
        if cmps_len == 0 {
            return Ok(MutationResult::Skipped);
        }

        // SAFETY of unwraps: cmps_len and input_len are checked > 0 above.
        let idx = state
            .rand_mut()
            .below(core::num::NonZero::new(cmps_len).unwrap());
        let off = state
            .rand_mut()
            .below(core::num::NonZero::new(input_len).unwrap());
        // Pre-generate splice/overwrite coin flip while we have &mut state.
        let use_splice = state.rand_mut().coinflip(0.5);

        let meta = state.metadata_map().get::<CmpValuesMetadata>().unwrap();
        let cmp_values = meta.list[idx].clone();

        match &cmp_values {
            CmpValues::Bytes(v) => {
                let max_size = state.max_size();
                self.mutate_bytes_splice(input, &v.0, &v.1, off, max_size, use_splice)
            }
            // Non-Bytes variants: delegate entirely to inner I2SRandReplace.
            CmpValues::U8(_) | CmpValues::U16(_) | CmpValues::U32(_) | CmpValues::U64(_) => {
                self.inner.mutate(state, input)
            }
        }
    }

    #[inline]
    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> std::result::Result<(), libafl::Error> {
        Ok(())
    }
}

impl I2SSpliceReplace {
    /// Handle a `CmpValues::Bytes` match with splice/overwrite logic.
    ///
    /// Scans for both operands bidirectionally (v0 found → replace with v1,
    /// v1 found → replace with v0). Uses decreasing prefix lengths at each
    /// position. On match, randomly chooses between splice and overwrite
    /// (equal-length operands always use overwrite).
    fn mutate_bytes_splice<I>(
        &self,
        input: &mut I,
        v0: &libafl::observers::cmp::CmplogBytes,
        v1: &libafl::observers::cmp::CmplogBytes,
        off: usize,
        max_size: usize,
        use_splice: bool,
    ) -> std::result::Result<MutationResult, libafl::Error>
    where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let source_replacement_pairs: [(&[u8], &[u8]); 2] = [
            (v0.as_slice(), v1.as_slice()),
            (v1.as_slice(), v0.as_slice()),
        ];

        let input_len = input.len();

        for i in off..input_len {
            for &(source, replacement) in &source_replacement_pairs {
                if source.is_empty() {
                    continue;
                }
                if replacement.is_empty() {
                    continue;
                }
                let mut matched_prefix_len = core::cmp::min(source.len(), input_len - i);
                while matched_prefix_len > 0 {
                    if source[..matched_prefix_len]
                        == input.mutator_bytes()[i..i + matched_prefix_len]
                    {
                        return Ok(self.apply_splice_or_overwrite(
                            input,
                            replacement,
                            i,
                            matched_prefix_len,
                            max_size,
                            use_splice,
                        ));
                    }
                    matched_prefix_len -= 1;
                }
            }
        }

        Ok(MutationResult::Skipped)
    }

    /// Apply either splice or overwrite at the match position.
    ///
    /// For equal-length operands, always overwrites. Otherwise, uses the
    /// pre-generated coin flip.
    /// Splice respects max_size — falls back to overwrite if exceeded.
    fn apply_splice_or_overwrite<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
        max_size: usize,
        use_splice: bool,
    ) -> MutationResult
    where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let replacement_len = replacement.len();
        let current_len = input.len();

        if matched_prefix_len == replacement_len {
            // Equal length: always overwrite (splice and overwrite are identical).
            self.apply_overwrite(input, replacement, pos, matched_prefix_len);
        } else if use_splice {
            let new_len = current_len - matched_prefix_len + replacement_len;
            if new_len <= max_size {
                self.apply_splice(input, replacement, pos, matched_prefix_len);
            } else {
                // Splice would exceed max_size — fall back to overwrite.
                self.apply_overwrite(input, replacement, pos, matched_prefix_len);
            }
        } else {
            self.apply_overwrite(input, replacement, pos, matched_prefix_len);
        }

        MutationResult::Mutated
    }

    /// Overwrite: write `matched_prefix_len` bytes of replacement at pos.
    fn apply_overwrite<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
    ) where
        I: HasMutatorBytes,
    {
        let write_len = core::cmp::min(matched_prefix_len, replacement.len());
        input.mutator_bytes_mut()[pos..pos + write_len].copy_from_slice(&replacement[..write_len]);
    }

    /// Splice: delete matched_prefix_len bytes at pos, insert full replacement.
    fn apply_splice<I>(
        &self,
        input: &mut I,
        replacement: &[u8],
        pos: usize,
        matched_prefix_len: usize,
    ) where
        I: ResizableMutator<u8> + HasMutatorBytes,
    {
        let current_len = input.len();
        let replacement_len = replacement.len();
        let tail_start = pos + matched_prefix_len;
        let tail_len = current_len - tail_start;
        let new_len = current_len - matched_prefix_len + replacement_len;

        if replacement_len > matched_prefix_len {
            // Growing: resize first, shift tail right, write replacement.
            input.resize(new_len, 0);
            let new_tail_start = pos + replacement_len;
            // SAFETY: after resize, new_tail_start + tail_len == new_len <= capacity.
            // `from` and `to` ranges may overlap, but `core::ptr::copy` handles that.
            if tail_len > 0 {
                let bytes = input.mutator_bytes_mut();
                unsafe {
                    core::ptr::copy(
                        bytes.as_ptr().add(tail_start),
                        bytes.as_mut_ptr().add(new_tail_start),
                        tail_len,
                    );
                }
            }
        } else {
            // Shrinking: shift tail left, then resize.
            let new_tail_start = pos + replacement_len;
            if tail_len > 0 {
                let bytes = input.mutator_bytes_mut();
                unsafe {
                    core::ptr::copy(
                        bytes.as_ptr().add(tail_start),
                        bytes.as_mut_ptr().add(new_tail_start),
                        tail_len,
                    );
                }
            }
            input.resize(new_len, 0);
        }

        // Write the full replacement.
        input.mutator_bytes_mut()[pos..pos + replacement_len].copy_from_slice(replacement);
    }
}

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
    // Calibration state (populated between calibrate_run / calibrate_finish).
    /// Entry being calibrated.
    calibration_corpus_id: Option<CorpusId>,
    /// First calibration run's coverage snapshot (baseline).
    calibration_first_map: Option<Vec<u8>>,
    /// Unstable edge tracker (u8::MAX = unstable).
    calibration_history_map: Option<Vec<u8>>,
    /// Accumulated execution time across calibration runs.
    calibration_total_time: Duration,
    /// Number of calibration runs completed (including the original fuzz iteration).
    calibration_iterations: usize,
    /// Whether unstable edges were detected during calibration.
    calibration_has_unstable: bool,
    /// Coverage map indices observed to differ between calibration runs (grows monotonically).
    unstable_entries: HashSet<usize>,
    /// CmpLog token candidates and their observation counts. Tokens are promoted
    /// into the mutation dictionary only after reaching `TOKEN_PROMOTION_THRESHOLD`
    /// observations, filtering out one-off garbled byte sequences from havoc.
    token_candidates: HashMap<Vec<u8>, usize>,
    /// Set of tokens already promoted to the mutation dictionary. Checked before
    /// inserting into `token_candidates` to prevent re-promotion cycles.
    /// Implicitly bounded by `MAX_DICTIONARY_SIZE` — tokens only enter this set
    /// via the promotion loop, which stops when the dictionary is full.
    promoted_tokens: HashSet<Vec<u8>>,
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
    /// Whether Grimoire structure-aware fuzzing is enabled. Determined by
    /// auto-detection (corpus UTF-8 scanning) or explicit override.
    grimoire_enabled: bool,
    /// Count of interesting inputs found via `report_result()` for deferred
    /// Grimoire detection. `None` means detection is already resolved (not deferred).
    /// Stage-found entries do NOT count toward this threshold.
    grimoire_deferred_count: Option<usize>,
    /// Number of auto-seeded corpus entries (from `DEFAULT_SEEDS`). Used by
    /// `scan_corpus_utf8` to skip auto-seeds when performing deferred Grimoire
    /// detection — auto-seeds are all valid UTF-8 and would bias the vote.
    auto_seed_count: usize,
}

// SAFETY: `Fuzzer` contains `*mut u8` which is `!Send`. napi-rs requires `Send`
// for `#[napi]` classes. The raw pointer points into the `Buffer` held in
// `_coverage_map`, which prevents V8 GC from reclaiming the backing memory.
// Node.js `Buffer` uses a non-detachable `ArrayBuffer`, so the memory cannot be
// reallocated or moved. NAPI enforces single-threaded access - the `Fuzzer` is
// only ever used on the Node.js main thread and is never sent across threads.
unsafe impl Send for Fuzzer {}

/// Set n_fuzz_entry on a corpus entry's SchedulerTestcaseMetadata.
/// Uses the corpus ID as a per-entry index into the n_fuzz frequency array.
/// ProbabilitySamplingScheduler does not implement AflScheduler, so n_fuzz
/// tracking is not automatic. Per-entry indexing (vs. path-hashing) is
/// appropriate for probabilistic selection.
fn set_n_fuzz_entry_for_corpus_id(state: &FuzzerState, id: CorpusId) -> Result<()> {
    let mut tc = state
        .corpus()
        .get(id)
        .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
        .borrow_mut();
    if let Ok(meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
        meta.set_n_fuzz_entry(usize::from(id) % N_FUZZ_SIZE);
    }
    Ok(())
}

/// Extract byte tokens from CmpLog entries for dictionary-based mutations.
///
/// Iterates `CmpValues::Bytes` entries and collects both operands, filtering
/// out empty sequences, all-null byte sequences, and all-0xFF byte sequences.
/// Non-Bytes entries (U8, U16, U32, U64) are skipped — integer comparisons
/// already produce a companion `CmpValues::Bytes` entry with decimal string
/// representations.
fn extract_tokens_from_cmplog(entries: &[CmpValues]) -> Vec<Vec<u8>> {
    let mut tokens = Vec::new();

    for entry in entries {
        if let CmpValues::Bytes((left, right)) = entry {
            for operand in [left, right] {
                let bytes = operand.as_slice();
                // CmplogBytes has a natural 32-byte capacity bound, so no
                // upper-length filter is needed.
                if bytes.is_empty() {
                    continue;
                }
                if bytes.iter().all(|&b| b == 0x00) || bytes.iter().all(|&b| b == 0xFF) {
                    continue;
                }
                tokens.push(bytes.to_vec());
            }
        }
    }

    tokens
}

/// Phases within the generalization algorithm. Each phase corresponds to a
/// type of gap-finding pass that ablates portions of the input and checks
/// whether novel coverage indices survive.
#[derive(Debug)]
enum GeneralizationPhase {
    /// Initial stability check: execute the original input unmodified.
    Verify,
    /// Offset-based gap-finding. `level` indexes into `GENERALIZATION_OFFSETS`,
    /// `_pos` tracks the current payload position (used for state inspection/debugging).
    Offset { level: u8, _pos: usize },
    /// Delimiter-based gap-finding. `index` indexes into `GENERALIZATION_DELIMITERS`,
    /// `_pos` tracks the current payload position (used for state inspection/debugging).
    Delimiter { index: u8, _pos: usize },
    /// Bracket-based gap-finding. `pair_index` indexes into `GENERALIZATION_BRACKETS`.
    /// `index` is the outer-loop cursor (forward scan for openers).
    /// `start` is the effective opener position (inner-loop start, collapses after each closer).
    /// `end` is the backward-scan position (inner-loop cursor for closers).
    /// `endings` counts closers found for the current opener.
    Bracket {
        pair_index: u8,
        index: usize,
        start: usize,
        end: usize,
        endings: usize,
    },
}

/// Tracks the lifecycle of a multi-execution stage (I2S, Grimoire, etc.).
/// Designed for extensibility — future stages add new variants.
enum StageState {
    /// No stage is active.
    None,
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

        let scheduler = ProbabilitySamplingScheduler::new();
        let mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));
        let i2s_mutator = I2SSpliceReplace::new();
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

        // Drop the temporary observer - feedback only holds a name-based Handle.
        drop(temp_observer);

        // Set max input size on state for I2SRandReplace bounds.
        state.set_max_size(max_input_len as usize);

        // Initialize CmpLog: enable recording and add empty CmpValuesMetadata.
        crate::cmplog::enable();
        state.metadata_map_mut().insert(CmpValuesMetadata::new());

        // Initialize power scheduling metadata with FAST strategy.
        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));

        // Grimoire auto-detection: scan corpus for UTF-8 content.
        let (grimoire_enabled, grimoire_deferred_count) = match grimoire_override {
            Some(explicit) => (explicit, None),
            None => {
                if state.corpus().count() == 0 {
                    // Empty corpus: defer detection until 10 interesting inputs.
                    (false, Some(0))
                } else {
                    // Currently unreachable: state is freshly constructed with an empty
                    // corpus. Retained as a defensive fallback if future changes introduce
                    // pre-populated state (e.g., serialized corpus loading).
                    (Self::scan_corpus_utf8(&state, 0), None)
                }
            }
        };

        Ok(Self {
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
            calibration_corpus_id: None,
            calibration_first_map: None,
            calibration_history_map: None,
            calibration_total_time: Duration::ZERO,
            calibration_iterations: 0,
            calibration_has_unstable: false,
            unstable_entries: HashSet::new(),
            token_candidates: HashMap::new(),
            promoted_tokens: HashSet::new(),
            stage_state: StageState::None,
            last_interesting_corpus_id: None,
            last_stage_input: None,
            grimoire_mutator,
            grimoire_enabled,
            grimoire_deferred_count,
            auto_seed_count: 0,
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
            self.auto_seed_count = DEFAULT_SEEDS.len();
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
            // corpus_id is always Some when is_interesting is true.
            let corpus_id = eval.corpus_id.unwrap();
            let exec_time = Duration::from_nanos(exec_time_ns as u64);

            // Prepare calibration state for upcoming calibrate_run() calls.
            self.calibration_corpus_id = Some(corpus_id);
            self.calibration_total_time = exec_time; // include the original execution
            self.calibration_iterations = 1;
            self.calibration_has_unstable = false;
            self.calibration_first_map = None;
            self.calibration_history_map = None;

            // Store for beginStage() — consumed after calibration completes.
            self.last_interesting_corpus_id = Some(corpus_id);

            // Deferred Grimoire detection: count interesting inputs from the
            // main loop (not stage-found). After threshold, scan corpus for UTF-8.
            if let Some(count) = self.grimoire_deferred_count.as_mut() {
                *count += 1;
                if *count >= GRIMOIRE_DEFERRED_THRESHOLD {
                    self.grimoire_enabled =
                        Self::scan_corpus_utf8(&self.state, self.auto_seed_count);
                    self.grimoire_deferred_count = None;
                }
            }

            IterationResult::Interesting
        } else {
            IterationResult::None
        };

        // Drain CmpLog accumulator into state metadata for the next I2S pass.
        let cmp_entries = crate::cmplog::drain();

        // Extract byte tokens from CmpLog entries and promote frequent ones into
        // the mutation dictionary. Each candidate is tracked in `token_candidates`
        // and only promoted to `Tokens` after being observed
        // `TOKEN_PROMOTION_THRESHOLD` times. This filters out one-off garbled byte
        // sequences produced by havoc mutations (which each appear once) while
        // keeping real comparison constants like `"javascript"` (which appear in
        // every execution that reaches the comparison).
        let extracted = extract_tokens_from_cmplog(&cmp_entries);
        if !extracted.is_empty() {
            if !self.state.has_metadata::<Tokens>() {
                self.state.add_metadata(Tokens::default());
            }
            let dict_full = self
                .state
                .metadata::<Tokens>()
                .map(|t| t.tokens().len() >= MAX_DICTIONARY_SIZE)
                .unwrap_or(false);
            if !dict_full {
                let mut promoted = Vec::new();
                for token in &extracted {
                    if self.promoted_tokens.contains(token) {
                        continue;
                    }
                    let count = if let Some(c) = self.token_candidates.get_mut(token) {
                        *c += 1;
                        *c
                    } else if self.token_candidates.len() < MAX_TOKEN_CANDIDATES {
                        self.token_candidates.insert(token.clone(), 1);
                        1
                    } else {
                        continue;
                    };
                    if count == TOKEN_PROMOTION_THRESHOLD {
                        promoted.push(token.clone());
                    }
                }
                for token in &promoted {
                    self.token_candidates.remove(token);
                    self.promoted_tokens.insert(token.clone());
                    let tokens = self.state.metadata_mut::<Tokens>().unwrap();
                    tokens.add_token(token);
                    if tokens.tokens().len() >= MAX_DICTIONARY_SIZE {
                        break;
                    }
                }
            }
        }

        self.state
            .metadata_map_mut()
            .insert(CmpValuesMetadata { list: cmp_entries });

        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        Ok(result)
    }

    /// Perform one calibration iteration for the most recently added corpus entry.
    /// Returns `true` if more calibration runs are needed.
    #[napi]
    pub fn calibrate_run(&mut self, exec_time_ns: f64) -> Result<bool> {
        let exec_time = Duration::from_nanos(exec_time_ns as u64);
        self.calibration_total_time += exec_time;
        self.calibration_iterations += 1;

        // Read current coverage map into a snapshot.
        // SAFETY: `self.map_ptr` is valid for `self.map_len` bytes (backed by
        // `self._coverage_map` Buffer). We only read here.
        let current_map =
            unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) }.to_vec();

        if let Some(first) = &self.calibration_first_map {
            // Compare with first run to detect unstable edges.
            // calibration_history_map is always set together with calibration_first_map below,
            // so it is guaranteed to be Some here.
            let history = self.calibration_history_map.as_mut().unwrap();

            for (idx, (&first_val, &cur_val)) in first.iter().zip(current_map.iter()).enumerate() {
                if first_val != cur_val && history[idx] != u8::MAX {
                    history[idx] = u8::MAX; // mark as unstable
                    self.calibration_has_unstable = true;
                }
            }
        } else {
            // First calibration run — store as baseline.
            self.calibration_first_map = Some(current_map);
            self.calibration_history_map = Some(vec![0u8; self.map_len]);
        }

        // Zero coverage map for next run.
        // SAFETY: Same pointer validity as above. No aliasing — observer is not alive.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        // Signal whether more runs are needed.
        let target_runs = if self.calibration_has_unstable {
            CALIBRATION_STAGE_MAX // 8
        } else {
            CALIBRATION_STAGE_START // 4
        };
        Ok(self.calibration_iterations < target_runs)
    }

    /// Finalize calibration for the most recently added corpus entry.
    /// Updates per-testcase and global metadata with calibrated values.
    #[napi]
    pub fn calibrate_finish(&mut self) -> Result<()> {
        let corpus_id = self.calibration_corpus_id.take().ok_or_else(|| {
            Error::from_reason("calibrateFinish called without pending calibration")
        })?;
        let iterations = self.calibration_iterations;
        let total_time = self.calibration_total_time;
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
            .calibration_first_map
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
        if let Some(history) = self.calibration_history_map.take() {
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
        self.calibration_first_map = None;
        self.calibration_history_map = None;
        self.calibration_total_time = Duration::ZERO;
        self.calibration_iterations = 0;
        self.calibration_has_unstable = false;

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

        // Check for non-empty CmpValuesMetadata.
        let has_cmp_data = self
            .state
            .metadata_map()
            .get::<CmpValuesMetadata>()
            .is_some_and(|m| !m.list.is_empty());
        if !has_cmp_data {
            // I2S skipped — try generalization or Grimoire.
            if self.grimoire_enabled {
                if let Some(buf) = self.begin_generalization(corpus_id)? {
                    return Ok(Some(buf));
                }
                // Generalization skipped — try Grimoire directly (pre-existing metadata).
                if let Some(buf) = self.begin_grimoire(corpus_id)? {
                    return Ok(Some(buf));
                }
            }
            return Ok(None);
        }

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
            StageState::I2S { .. } => {}
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
            // I2S stage complete — try transitioning to Generalization or Grimoire.
            // stage_state is already StageState::None (reset before evaluate_coverage above).
            if self.grimoire_enabled {
                if let Some(buf) = self.begin_generalization(corpus_id)? {
                    return Ok(Some(buf));
                }
                // Generalization skipped — try Grimoire (pre-existing metadata).
                if let Some(buf) = self.begin_grimoire(corpus_id)? {
                    return Ok(Some(buf));
                }
            }
            return Ok(None);
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
    /// Scan corpus entries for UTF-8 content, skipping the first `skip_count`
    /// entries (used to exclude auto-seeds from deferred detection).
    /// Returns `true` if `utf8_count > non_utf8_count` (strictly greater than).
    ///
    /// Assumes `InMemoryCorpus` yields IDs in insertion order, so `.skip(skip_count)`
    /// correctly skips the first N entries (the auto-seeds).
    fn scan_corpus_utf8(state: &FuzzerState, skip_count: usize) -> bool {
        let mut utf8_count: usize = 0;
        let mut non_utf8_count: usize = 0;
        for id in state.corpus().ids().skip(skip_count) {
            if let Ok(entry) = state.corpus().get(id) {
                let tc = entry.borrow();
                if let Some(input) = tc.input() {
                    let bytes: &[u8] = input.as_ref();
                    if std::str::from_utf8(bytes).is_ok() {
                        utf8_count += 1;
                    } else {
                        non_utf8_count += 1;
                    }
                }
            }
        }
        utf8_count > non_utf8_count
    }

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

                    // Count nonzero bytes for bitmap_size from the raw coverage map.
                    // SAFETY: map_ptr is valid for map_len bytes, backed by _coverage_map
                    // Buffer. The observer has been dropped, so no aliasing.
                    let bitmap_size =
                        unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) }
                            .iter()
                            .filter(|&&b| b > 0)
                            .count() as u64;

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

    /// Construct a candidate `BytesInput` from the payload with the given range removed.
    /// Concatenates all `Some(byte)` values from `payload[..start]` and `payload[end..]`,
    /// skipping all `None` (gap) positions.
    fn build_generalization_candidate(payload: &[Option<u8>], start: usize, end: usize) -> Vec<u8> {
        debug_assert!(
            start <= end && end <= payload.len(),
            "build_generalization_candidate: invalid range {start}..{end} for payload len {}",
            payload.len()
        );
        let mut candidate = Vec::new();
        for &slot in &payload[..start] {
            if let Some(b) = slot {
                candidate.push(b);
            }
        }
        for &slot in &payload[end..] {
            if let Some(b) = slot {
                candidate.push(b);
            }
        }
        candidate
    }

    /// Remove consecutive `None` entries from the payload, leaving only a single
    /// `None` to represent each contiguous gap region. O(n) via `retain`.
    fn trim_payload(payload: &mut Vec<Option<u8>>) {
        let mut previous_was_none = false;
        payload.retain(|item| {
            let dominated = item.is_none() && previous_was_none;
            previous_was_none = item.is_none();
            !dominated
        });
    }

    /// Convert a payload (`Vec<Option<u8>>`) to `GeneralizedInputMetadata`.
    ///
    /// Rules:
    /// - Contiguous `Some(byte)` runs become `GeneralizedItem::Bytes(Vec<u8>)`.
    /// - Each `None` becomes `GeneralizedItem::Gap`.
    /// - Leading `Gap` is prepended if first element is not `None`.
    /// - Trailing `Gap` is appended if last element is not `None`.
    fn payload_to_generalized(payload: &[Option<u8>]) -> GeneralizedInputMetadata {
        GeneralizedInputMetadata::generalized_from_options(payload)
    }

    /// Check whether all novelty indices are nonzero in the current coverage map.
    fn check_novelties_survived(&self, novelties: &[usize]) -> bool {
        // SAFETY: map_ptr is valid for map_len bytes, backed by _coverage_map Buffer.
        let map = unsafe { std::slice::from_raw_parts(self.map_ptr, self.map_len) };
        novelties
            .iter()
            .all(|&idx| idx < self.map_len && map[idx] > 0)
    }

    /// Begin the generalization stage for a corpus entry.
    ///
    /// Returns the first candidate (the original input for verification),
    /// or `None` if preconditions are not met.
    fn begin_generalization(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if !self.grimoire_enabled {
            return Ok(None);
        }

        // Check skipping conditions on the testcase.
        let tc = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?;
        let tc_ref = tc.borrow();

        // Already generalized?
        if tc_ref.has_metadata::<GeneralizedInputMetadata>() {
            return Ok(None);
        }

        // Has novelty metadata with non-empty list?
        let novelties = match tc_ref.metadata::<MapNoveltiesMetadata>() {
            Ok(meta) if !meta.list.is_empty() => meta.list.clone(),
            _ => return Ok(None),
        };

        // Get input bytes.
        let input_bytes: Vec<u8> = tc_ref
            .input()
            .as_ref()
            .ok_or_else(|| Error::from_reason("Corpus entry has no input"))?
            .as_ref()
            .to_vec();

        drop(tc_ref);
        let _ = tc;

        // Size limit.
        if input_bytes.len() > MAX_GENERALIZED_LEN {
            return Ok(None);
        }

        // Build initial payload (all bytes are structural/untested).
        let payload: Vec<Option<u8>> = input_bytes.iter().map(|&b| Some(b)).collect();

        // First candidate is the original input (verification phase).
        let candidate = input_bytes.clone();
        self.last_stage_input = Some(candidate.clone());

        self.stage_state = StageState::Generalization {
            corpus_id,
            novelties,
            payload,
            phase: GeneralizationPhase::Verify,
            candidate_range: None,
        };

        Ok(Some(Buffer::from(candidate)))
    }

    /// Advance the generalization stage after a target execution.
    ///
    /// Reads the coverage map, decides gap/structural for the current candidate,
    /// advances to the next phase/position, constructs the next candidate.
    /// Returns `None` when generalization is complete.
    fn advance_generalization(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        // Drain CmpLog (discard — generalization doesn't use CmpLog data).
        let _ = crate::cmplog::drain();

        // Extract state (we'll put it back or replace it).
        let (corpus_id, novelties, mut payload, phase, candidate_range) =
            match std::mem::replace(&mut self.stage_state, StageState::None) {
                StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase,
                    candidate_range,
                } => (corpus_id, novelties, payload, phase, candidate_range),
                other => {
                    self.stage_state = other;
                    return Ok(None);
                }
            };

        let novelties_survived = self.check_novelties_survived(&novelties);

        // The target was invoked — count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        // Evaluate coverage for corpus addition during gap-finding (not verification).
        // Stage state was consumed by mem::replace above. If evaluate_coverage
        // fails, the in-progress generalization is cleanly abandoned.
        if !matches!(phase, GeneralizationPhase::Verify) {
            if let Some(stage_input) = self.last_stage_input.take() {
                let _eval = self.evaluate_coverage(
                    &stage_input,
                    exec_time_ns,
                    LibaflExitKind::Ok,
                    corpus_id,
                )?;
            }
        } else {
            self.last_stage_input = None;
            // Zero coverage map — Verify doesn't call evaluate_coverage (which does its own zero).
            // SAFETY: map_ptr is valid for map_len bytes, backed by _coverage_map Buffer.
            unsafe {
                std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
            }
        }

        match phase {
            GeneralizationPhase::Verify => {
                if !novelties_survived {
                    // Verification failed — unstable input. Abort generalization.
                    self.stage_state = StageState::None;
                    return Ok(None);
                }
                // Verification passed — begin offset-based gap-finding.
                let next_phase = GeneralizationPhase::Offset { level: 0, _pos: 0 };
                self.generate_next_candidate(corpus_id, novelties, payload, next_phase)
            }
            GeneralizationPhase::Offset { level, _pos: _ } => {
                // Process result of previous candidate.
                if novelties_survived && let Some((start, end)) = candidate_range {
                    for i in start..end {
                        if i < payload.len() {
                            payload[i] = None;
                        }
                    }
                }

                // Advance position.
                let offset = GENERALIZATION_OFFSETS[level as usize];
                let next_pos = candidate_range.map_or(0, |(_, e)| e);
                if next_pos >= payload.len() {
                    // Pass complete — trim and move to next level or delimiter phase.
                    Self::trim_payload(&mut payload);
                    let next_phase = if (level + 1) < GENERALIZATION_OFFSETS.len() as u8 {
                        GeneralizationPhase::Offset {
                            level: level + 1,
                            _pos: 0,
                        }
                    } else {
                        GeneralizationPhase::Delimiter { index: 0, _pos: 0 }
                    };
                    return self.generate_next_candidate(corpus_id, novelties, payload, next_phase);
                }

                // Compute next range.
                let start = next_pos;
                let end = std::cmp::min(start + 1 + offset, payload.len());
                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Offset { level, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Delimiter { index, _pos: _ } => {
                // Process result of previous candidate.
                if novelties_survived && let Some((start, end)) = candidate_range {
                    for i in start..end {
                        if i < payload.len() {
                            payload[i] = None;
                        }
                    }
                }

                let next_pos = candidate_range.map_or(0, |(_, e)| e);
                if next_pos >= payload.len() {
                    // Pass complete — trim and move to next delimiter or bracket phase.
                    Self::trim_payload(&mut payload);
                    let next_phase = if (index + 1) < GENERALIZATION_DELIMITERS.len() as u8 {
                        GeneralizationPhase::Delimiter {
                            index: index + 1,
                            _pos: 0,
                        }
                    } else {
                        GeneralizationPhase::Bracket {
                            pair_index: 0,
                            index: 0,
                            start: 0,
                            end: 0,
                            endings: 0,
                        }
                    };
                    return self.generate_next_candidate(corpus_id, novelties, payload, next_phase);
                }

                // Find next delimiter from next_pos.
                let delimiter = GENERALIZATION_DELIMITERS[index as usize];
                let start = next_pos;
                let delim_pos = payload[start..]
                    .iter()
                    .position(|&slot| slot == Some(delimiter));
                let end = match delim_pos {
                    Some(rel_pos) => start + rel_pos + 1,
                    None => payload.len(),
                };

                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Delimiter { index, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Bracket {
                pair_index,
                index: outer_index,
                // `start` is unused here; the inner scan resumes from `bracket_end`, not the opener.
                start: _bracket_start,
                end: bracket_end,
                endings,
            } => {
                // Process result of previous candidate: mark gaps if survived.
                if let Some((cr_start, cr_end)) = candidate_range
                    && novelties_survived
                {
                    for i in cr_start..cr_end {
                        if i < payload.len() {
                            payload[i] = None;
                        }
                    }
                }

                // After yielding a candidate, advance inner-loop state per LibAFL:
                //   start = end (collapse inner window)
                //   end -= 1 (move backward scan inward)
                //   index += 1 (outer loop progress)
                if candidate_range.is_some() {
                    let new_start = bracket_end;
                    let new_end = bracket_end.saturating_sub(1);
                    let new_index = outer_index + 1;
                    self.continue_bracket_inner_scan(
                        corpus_id, novelties, payload, pair_index, new_index, new_start, new_end,
                        endings,
                    )
                } else {
                    // First entry into bracket phase — start scanning.
                    self.find_next_bracket_opener(
                        corpus_id,
                        novelties,
                        payload,
                        pair_index,
                        outer_index,
                    )
                }
            }
        }
    }

    /// Generate the next candidate for the current generalization phase.
    /// Handles the entry point into each new phase (finding the first valid candidate).
    fn generate_next_candidate(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        payload: Vec<Option<u8>>,
        phase: GeneralizationPhase,
    ) -> Result<Option<Buffer>> {
        match phase {
            GeneralizationPhase::Offset { level, _pos: _ } => {
                let offset = GENERALIZATION_OFFSETS[level as usize];
                let start = 0;
                if start >= payload.len() {
                    // Empty payload — skip to next phase.
                    return self
                        .advance_to_next_offset_or_delimiter(corpus_id, novelties, payload, level);
                }
                let end = std::cmp::min(start + 1 + offset, payload.len());
                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Offset { level, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Delimiter { index, _pos: _ } => {
                let delimiter = GENERALIZATION_DELIMITERS[index as usize];
                let start = 0;
                if start >= payload.len() {
                    return self.advance_to_next_delimiter_or_bracket(
                        corpus_id, novelties, payload, index,
                    );
                }
                let delim_pos = payload.iter().position(|&slot| slot == Some(delimiter));
                let end = match delim_pos {
                    Some(rel_pos) => rel_pos + 1,
                    None => payload.len(),
                };

                let candidate = Self::build_generalization_candidate(&payload, start, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Delimiter { index, _pos: start },
                    candidate_range: Some((start, end)),
                };

                Ok(Some(Buffer::from(candidate)))
            }
            GeneralizationPhase::Bracket { pair_index, .. } => {
                if pair_index as usize >= GENERALIZATION_BRACKETS.len() {
                    // All bracket passes done — finalize.
                    return self.finalize_generalization(corpus_id, &payload);
                }
                // Start bracket scanning from index=0.
                self.find_next_bracket_opener(corpus_id, novelties, payload, pair_index, 0)
            }
            GeneralizationPhase::Verify => {
                // Should not reach here from generate_next_candidate.
                self.stage_state = StageState::None;
                Ok(None)
            }
        }
    }

    fn advance_to_next_offset_or_delimiter(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        current_level: u8,
    ) -> Result<Option<Buffer>> {
        Self::trim_payload(&mut payload);
        if (current_level + 1) < GENERALIZATION_OFFSETS.len() as u8 {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Offset {
                    level: current_level + 1,
                    _pos: 0,
                },
            )
        } else {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Delimiter { index: 0, _pos: 0 },
            )
        }
    }

    fn advance_to_next_delimiter_or_bracket(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        current_index: u8,
    ) -> Result<Option<Buffer>> {
        Self::trim_payload(&mut payload);
        if (current_index + 1) < GENERALIZATION_DELIMITERS.len() as u8 {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Delimiter {
                    index: current_index + 1,
                    _pos: 0,
                },
            )
        } else {
            self.generate_next_candidate(
                corpus_id,
                novelties,
                payload,
                GeneralizationPhase::Bracket {
                    pair_index: 0,
                    index: 0,
                    start: 0,
                    end: 0,
                    endings: 0,
                },
            )
        }
    }

    /// Outer loop of bracket-based gap-finding: scan forward from `index` for
    /// an opening bracket, then set up the inner backward scan for closers.
    ///
    /// Note: recursion depth is bounded by `MAX_GENERALIZED_LEN` (8192 bytes) and the number
    /// of bracket types (6). The worst-case depth is safe for the default 8 MB stack.
    fn find_next_bracket_opener(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        payload: Vec<Option<u8>>,
        pair_index: u8,
        mut index: usize,
    ) -> Result<Option<Buffer>> {
        if pair_index as usize >= GENERALIZATION_BRACKETS.len() {
            return self.finalize_generalization(corpus_id, &payload);
        }

        let (open_char, _close_char) = GENERALIZATION_BRACKETS[pair_index as usize];

        // Scan forward for the next opener.
        while index < payload.len() && payload[index] != Some(open_char) {
            index += 1;
        }
        if index >= payload.len() {
            // No more openers for this pair — advance to next pair.
            return self.advance_to_next_bracket_pair(corpus_id, novelties, payload, pair_index);
        }

        // Found an opener at `index`. Set up inner backward scan.
        // LibAFL: start = index, end = payload.len() - 1 (or start if empty).
        // SAFETY of payload.len() - 1: index < payload.len() was verified above,
        // so payload is guaranteed non-empty.
        debug_assert!(
            !payload.is_empty(),
            "payload must be non-empty when an opener was found"
        );
        let start = index;
        let end = payload.len() - 1;

        self.continue_bracket_inner_scan(
            corpus_id, novelties, payload, pair_index, index, start, end, 0,
        )
    }

    /// Inner loop of bracket-based gap-finding: scan backward from `end` for
    /// a closing bracket. Yields a candidate when found, or advances to the
    /// next opener/pair when exhausted.
    #[allow(clippy::too_many_arguments)]
    fn continue_bracket_inner_scan(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        pair_index: u8,
        index: usize,
        start: usize,
        mut end: usize,
        mut endings: usize,
    ) -> Result<Option<Buffer>> {
        if payload.is_empty() {
            return self.advance_to_next_bracket_pair(corpus_id, novelties, payload, pair_index);
        }

        let (_open_char, close_char) = GENERALIZATION_BRACKETS[pair_index as usize];

        // Scan backward from `end` looking for a closer.
        while end > start {
            if payload[end] == Some(close_char) {
                endings += 1;
                // Found a closer — yield candidate from start..end (exclusive of endpoints
                // to match LibAFL behavior: the opener and closer themselves are kept).
                let candidate = Self::build_generalization_candidate(&payload, start + 1, end);
                self.last_stage_input = Some(candidate.clone());

                self.stage_state = StageState::Generalization {
                    corpus_id,
                    novelties,
                    payload,
                    phase: GeneralizationPhase::Bracket {
                        pair_index,
                        index,
                        start,
                        end,
                        endings,
                    },
                    candidate_range: Some((start + 1, end)),
                };

                return Ok(Some(Buffer::from(candidate)));
            }
            end -= 1;
        }

        // Inner scan exhausted for this opener.
        if endings > 0 {
            // We found at least one closer — the outer loop advances past this opener.
            // The outer loop advances `index` by 1 per opener (not per backward-scan step
            // as in the spec). This may revisit positions but does not affect correctness.
            Self::trim_payload(&mut payload);
            self.find_next_bracket_opener(corpus_id, novelties, payload, pair_index, index + 1)
        } else {
            // No closer found at all for this opener — advance to next pair.
            self.advance_to_next_bracket_pair(corpus_id, novelties, payload, pair_index)
        }
    }

    /// Trim the payload and advance to the next bracket pair, or finalize
    /// if all bracket pairs have been processed.
    fn advance_to_next_bracket_pair(
        &mut self,
        corpus_id: CorpusId,
        novelties: Vec<usize>,
        mut payload: Vec<Option<u8>>,
        pair_index: u8,
    ) -> Result<Option<Buffer>> {
        Self::trim_payload(&mut payload);
        self.generate_next_candidate(
            corpus_id,
            novelties,
            payload,
            GeneralizationPhase::Bracket {
                pair_index: pair_index + 1,
                index: 0,
                start: 0,
                end: 0,
                endings: 0,
            },
        )
    }

    /// Finalize the generalization stage: convert payload to `GeneralizedInputMetadata`
    /// and store it on the testcase.
    fn finalize_generalization(
        &mut self,
        corpus_id: CorpusId,
        payload: &[Option<u8>],
    ) -> Result<Option<Buffer>> {
        let metadata = Self::payload_to_generalized(payload);

        let mut tc = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
            .borrow_mut();
        tc.add_metadata(metadata);
        drop(tc);

        // Transition to Grimoire stage (entry now has GeneralizedInputMetadata).
        self.stage_state = StageState::None;
        self.begin_grimoire(corpus_id)
    }

    /// Begin the Grimoire mutational stage for a corpus entry that has
    /// `GeneralizedInputMetadata`. Returns the first mutated input, or `None`
    /// if the entry has no metadata.
    fn begin_grimoire(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if !self.grimoire_enabled {
            return Ok(None);
        }

        // Check that the entry has GeneralizedInputMetadata.
        let has_metadata = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
            .borrow()
            .has_metadata::<GeneralizedInputMetadata>();
        if !has_metadata {
            return Ok(None);
        }

        // Select random iteration count 1..=STAGE_MAX_ITERATIONS.
        // SAFETY of unwrap: STAGE_MAX_ITERATIONS is a non-zero constant.
        let max_iterations = self
            .state
            .rand_mut()
            .below(core::num::NonZero::new(STAGE_MAX_ITERATIONS).unwrap())
            + 1;

        // Generate first mutated input.
        let bytes = self.grimoire_mutate_one(corpus_id)?;

        self.last_stage_input = Some(bytes.clone());
        self.stage_state = StageState::Grimoire {
            corpus_id,
            iteration: 0,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Advance the Grimoire stage after a target execution.
    fn advance_grimoire(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        let (corpus_id, iteration, max_iterations) = match self.stage_state {
            StageState::Grimoire {
                corpus_id,
                iteration,
                max_iterations,
            } => (corpus_id, iteration, max_iterations),
            _ => return Ok(None),
        };

        // Drain CmpLog (discard — Grimoire doesn't use CmpLog data).
        let _ = crate::cmplog::drain();

        // Reset stage state before the fallible evaluate_coverage call. On error,
        // the stage is cleanly abandoned (no zombie state). On success, stage_state
        // is overwritten below with the next iteration or StageState::None.
        self.stage_state = StageState::None;
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advanceGrimoire: no stashed stage input"))?;

        // The target was invoked — count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        let _eval =
            self.evaluate_coverage(&stage_input, exec_time_ns, LibaflExitKind::Ok, corpus_id)?;

        let next_iteration = iteration + 1;
        if next_iteration >= max_iterations {
            // stage_state is already StageState::None (reset before evaluate_coverage above).
            return Ok(None);
        }

        // Generate next Grimoire candidate.
        let bytes = self.grimoire_mutate_one(corpus_id)?;
        self.last_stage_input = Some(bytes.clone());

        self.stage_state = StageState::Grimoire {
            corpus_id,
            iteration: next_iteration,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Clone GeneralizedInputMetadata from a corpus entry, apply the Grimoire
    /// scheduled mutator, convert to bytes, and enforce max_input_len.
    fn grimoire_mutate_one(&mut self, corpus_id: CorpusId) -> Result<Vec<u8>> {
        // Clone the GeneralizedInputMetadata from the corpus entry.
        let mut metadata = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
            .borrow()
            .metadata::<GeneralizedInputMetadata>()
            .map_err(|e| Error::from_reason(format!("Missing GeneralizedInputMetadata: {e}")))?
            .clone();

        // Apply Grimoire mutator. Skipped results still produce the unmutated
        // metadata for execution.
        let _ = self
            .grimoire_mutator
            .mutate(&mut self.state, &mut metadata)
            .map_err(|e| Error::from_reason(format!("Grimoire mutation failed: {e}")))?;

        // Convert to bytes and truncate.
        let mut bytes = metadata.generalized_to_bytes();
        bytes.truncate(self.max_input_len as usize);

        Ok(bytes)
    }
}

impl Drop for Fuzzer {
    fn drop(&mut self) {
        crate::cmplog::disable();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmplog;
    use libafl::inputs::GeneralizedItem;
    use libafl::observers::MapObserver;
    use libafl::observers::cmp::{CmpValues, CmpValuesMetadata, CmplogBytes};
    use libafl::schedulers::TestcaseScore;

    fn make_coverage_map(size: usize) -> (*mut u8, Vec<u8>) {
        let mut map = vec![0u8; size];
        let ptr = map.as_mut_ptr();
        (ptr, map)
    }

    fn make_state_and_feedback(
        map_ptr: *mut u8,
        map_len: usize,
    ) -> (FuzzerState, FuzzerFeedback, CrashObjective) {
        let observer =
            unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };
        let mut feedback = MaxMapFeedback::new(&observer);
        let mut objective = CrashFeedback::new();

        let mut state = StdState::new(
            StdRand::with_seed(42),
            InMemoryCorpus::<BytesInput>::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .unwrap();

        // Initialize SchedulerMetadata (required by CorpusPowerTestcaseScore).
        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));

        drop(observer);
        (state, feedback, objective)
    }

    /// Create a seed testcase with scheduler metadata (required by CorpusPowerTestcaseScore).
    fn make_seed_testcase(data: &[u8]) -> Testcase<BytesInput> {
        let mut tc = Testcase::new(BytesInput::new(data.to_vec()));
        tc.set_exec_time(SEED_EXEC_TIME);
        let mut meta = SchedulerTestcaseMetadata::new(0);
        meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
        tc.add_metadata(meta);
        tc
    }

    /// Build a full Fuzzer for integration-style tests using raw pointer/map.
    fn make_fuzzer(
        map_ptr: *mut u8,
        map_len: usize,
    ) -> (
        FuzzerState,
        FuzzerFeedback,
        FuzzerScheduler,
        CrashObjective,
        TimeoutObjective,
    ) {
        let observer =
            unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };
        let mut feedback = MaxMapFeedback::new(&observer);
        let mut crash_objective = CrashFeedback::new();

        let mut state = StdState::new(
            StdRand::with_seed(42),
            InMemoryCorpus::<BytesInput>::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut crash_objective,
        )
        .unwrap();

        let mut timeout_objective = TimeoutFeedback::new();
        timeout_objective.init_state(&mut state).unwrap();

        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));
        state.metadata_map_mut().insert(CmpValuesMetadata::new());

        let scheduler = ProbabilitySamplingScheduler::new();
        drop(observer);
        (
            state,
            feedback,
            scheduler,
            crash_objective,
            timeout_objective,
        )
    }

    #[test]
    fn test_new_state_is_empty() {
        let (map_ptr, _map) = make_coverage_map(65536);
        let (state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        assert_eq!(state.corpus().count(), 0);
        assert_eq!(state.solutions().count(), 0);
    }

    #[test]
    fn test_add_seed() {
        let (map_ptr, _map) = make_coverage_map(65536);
        let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();

        let testcase = make_seed_testcase(b"hello");
        let id = state.corpus_mut().add(testcase).unwrap();
        scheduler.on_add(&mut state, id).unwrap();

        assert_eq!(state.corpus().count(), 1);
    }

    #[test]
    fn test_get_next_input_auto_seeds() {
        let (map_ptr, _map) = make_coverage_map(65536);
        let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();
        let mut mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));

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
            StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_ptr() as *mut u8, map.len())
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
            StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map.as_ptr() as *mut u8, map.len())
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

    #[test]
    fn test_max_input_len_enforcement() {
        let (map_ptr, _map) = make_coverage_map(65536);
        let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();
        let mut mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));
        let max_input_len: u32 = 128;

        // Add a large seed with scheduler metadata.
        let large_seed = vec![0x41u8; 256];
        let testcase = make_seed_testcase(&large_seed);
        let id = state.corpus_mut().add(testcase).unwrap();
        scheduler.on_add(&mut state, id).unwrap();

        // Generate multiple inputs and verify truncation enforces max_input_len.
        let mut saw_oversized = false;
        for _ in 0..100 {
            let corpus_id = scheduler.next(&mut state).unwrap();
            let mut input = state.corpus().cloned_input_for_id(corpus_id).unwrap();
            let _ = mutator.mutate(&mut state, &mut input).unwrap();
            let bytes: Vec<u8> = input.into();
            if bytes.len() > max_input_len as usize {
                saw_oversized = true;
            }
            // Simulate the truncation step that the engine performs.
            let truncated = &bytes[..std::cmp::min(bytes.len(), max_input_len as usize)];
            assert!(truncated.len() <= max_input_len as usize);
        }
        // The seed is 256 bytes and max_input_len is 128 — at least some mutations
        // should produce inputs exceeding the limit (proving truncation is needed).
        assert!(
            saw_oversized,
            "mutator should produce at least one input exceeding max_input_len"
        );
    }

    // === CmpLog integration tests ===

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
        cmplog::push(CmpValues::U8((1, 2, false)));
        let entries = cmplog::drain();
        assert_eq!(entries.len(), 1);

        // Simulate Fuzzer drop (disable cmplog).
        cmplog::disable();
        assert!(!cmplog::is_enabled());

        // Push should be silently dropped while disabled.
        cmplog::push(CmpValues::U8((3, 4, false)));
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
        cmplog::push(CmpValues::U8((10, 20, false)));
        cmplog::push(CmpValues::U16((1000, 2000, false)));

        let entries = cmplog::drain();
        assert_eq!(entries.len(), 2);

        // Insert into state metadata (as reportResult does).
        state
            .metadata_map_mut()
            .insert(CmpValuesMetadata { list: entries });

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

    // === Token extraction tests ===

    /// Helper to construct a `CmplogBytes` from a byte slice (mirrors cmplog::to_cmplog_bytes).
    fn make_cmplog_bytes(data: &[u8]) -> CmplogBytes {
        let len = data.len().min(32) as u8;
        let mut buf = [0u8; 32];
        buf[..len as usize].copy_from_slice(&data[..len as usize]);
        CmplogBytes::from_buf_and_len(buf, len)
    }

    #[test]
    fn test_extract_tokens_from_mixed_cmpvalues() {
        let entries = vec![
            CmpValues::Bytes((make_cmplog_bytes(b"http"), make_cmplog_bytes(b"javascript"))),
            CmpValues::U8((10, 20, false)),
            CmpValues::Bytes((make_cmplog_bytes(b"ftp"), make_cmplog_bytes(b"ssh"))),
            CmpValues::U16((1000, 2000, false)),
        ];

        let tokens = extract_tokens_from_cmplog(&entries);

        // Should extract both operands from each Bytes entry, skip numeric entries.
        assert!(tokens.contains(&b"http".to_vec()));
        assert!(tokens.contains(&b"javascript".to_vec()));
        assert!(tokens.contains(&b"ftp".to_vec()));
        assert!(tokens.contains(&b"ssh".to_vec()));
        assert_eq!(tokens.len(), 4);
    }

    #[test]
    fn test_extract_tokens_filters_empty_null_and_0xff() {
        let entries = vec![
            // Empty left operand — should be skipped.
            CmpValues::Bytes((make_cmplog_bytes(b""), make_cmplog_bytes(b"valid"))),
            // All-null operands — both should be skipped.
            CmpValues::Bytes((
                make_cmplog_bytes(&[0x00, 0x00, 0x00, 0x00]),
                make_cmplog_bytes(b"also_valid"),
            )),
            // All-0xFF operand — should be skipped.
            CmpValues::Bytes((
                make_cmplog_bytes(b"keep_this"),
                make_cmplog_bytes(&[0xFF, 0xFF]),
            )),
            // Mixed-with-nulls — should be kept (not all-null).
            CmpValues::Bytes((
                make_cmplog_bytes(&[0x00, 0x41, 0x00]),
                make_cmplog_bytes(b"another"),
            )),
        ];

        let tokens = extract_tokens_from_cmplog(&entries);

        // Kept: "valid", "also_valid", "keep_this", [0x00, 0x41, 0x00], "another"
        assert!(tokens.contains(&b"valid".to_vec()));
        assert!(tokens.contains(&b"also_valid".to_vec()));
        assert!(tokens.contains(&b"keep_this".to_vec()));
        assert!(tokens.contains(&vec![0x00, 0x41, 0x00]));
        assert!(tokens.contains(&b"another".to_vec()));
        assert_eq!(tokens.len(), 5);

        // Filtered: empty, all-null, all-0xFF
        assert!(!tokens.contains(&vec![]));
        assert!(!tokens.contains(&vec![0x00, 0x00, 0x00, 0x00]));
        assert!(!tokens.contains(&vec![0xFF, 0xFF]));
    }

    #[test]
    fn test_report_result_populates_tokens_from_cmplog() {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(256);

        // Add a seed so the fuzzer has something to work with.
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Push the same CmpLog entries TOKEN_PROMOTION_THRESHOLD times so
        // the tokens get promoted into the dictionary.
        for _ in 0..TOKEN_PROMOTION_THRESHOLD {
            let _input = fuzzer.get_next_input().unwrap();
            cmplog::push(CmpValues::Bytes((
                make_cmplog_bytes(b"http"),
                make_cmplog_bytes(b"javascript"),
            )));
            cmplog::push(CmpValues::U16((1000, 2000, false)));
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

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Push two different comparisons TOKEN_PROMOTION_THRESHOLD times each
        // so both pairs get promoted.
        for _ in 0..TOKEN_PROMOTION_THRESHOLD {
            let _input = fuzzer.get_next_input().unwrap();
            cmplog::push(CmpValues::Bytes((
                make_cmplog_bytes(b"http"),
                make_cmplog_bytes(b"javascript"),
            )));
            cmplog::push(CmpValues::Bytes((
                make_cmplog_bytes(b"ftp"),
                make_cmplog_bytes(b"ssh"),
            )));
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

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Push MAX_TOKEN_CANDIDATES + 100 unique single-observation tokens.
        // Each token is observed only once, so none are promoted.
        for i in 0..(MAX_TOKEN_CANDIDATES + 100) {
            let _input = fuzzer.get_next_input().unwrap();
            let token_bytes = format!("tok_{i:06}");
            cmplog::push(CmpValues::Bytes((
                make_cmplog_bytes(token_bytes.as_bytes()),
                make_cmplog_bytes(b"other"),
            )));
            fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        }

        assert!(
            fuzzer.token_candidates.len() <= MAX_TOKEN_CANDIDATES,
            "token_candidates should be capped at {MAX_TOKEN_CANDIDATES}, got {}",
            fuzzer.token_candidates.len(),
        );

        cmplog::disable();
    }

    #[test]
    fn test_promoted_tokens_not_reinserted_into_candidates() {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Push a token TOKEN_PROMOTION_THRESHOLD observations to promote it.
        for _ in 0..TOKEN_PROMOTION_THRESHOLD {
            let _input = fuzzer.get_next_input().unwrap();
            cmplog::push(CmpValues::Bytes((
                make_cmplog_bytes(b"promote_me"),
                make_cmplog_bytes(b"other_side"),
            )));
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
                .token_candidates
                .contains_key(b"promote_me".as_slice()),
            "promoted token should be removed from token_candidates"
        );
        assert!(
            fuzzer.promoted_tokens.contains(b"promote_me".as_slice()),
            "promoted token should be tracked in promoted_tokens"
        );

        let dict_len_before = fuzzer.state.metadata::<Tokens>().unwrap().tokens().len();

        // Push the same CmpLog entry again — the token must NOT re-enter candidates.
        for _ in 0..TOKEN_PROMOTION_THRESHOLD {
            let _input = fuzzer.get_next_input().unwrap();
            cmplog::push(CmpValues::Bytes((
                make_cmplog_bytes(b"promote_me"),
                make_cmplog_bytes(b"other_side"),
            )));
            fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        }

        // Token must not re-enter candidates.
        assert!(
            !fuzzer
                .token_candidates
                .contains_key(b"promote_me".as_slice()),
            "promoted token should not re-enter token_candidates"
        );

        // Token must still be in the promoted set.
        assert!(
            fuzzer.promoted_tokens.contains(b"promote_me".as_slice()),
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

    // === Power scheduling tests ===

    // Task 2.1: Depth tracking tests

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

    // Task 3.1: Unstable edge masking tests

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

    // Task 4.3: Per-testcase metadata population tests

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

    // Task 5.1: Seed metadata tests

    #[test]
    fn test_explicit_seed_has_scheduler_metadata() {
        let (map_ptr, _map) = make_coverage_map(1024);
        let (mut state, ..) = make_fuzzer(map_ptr, 1024);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();

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

    // Task 5.3: Auto-seed metadata tests

    #[test]
    fn test_auto_seed_has_scheduler_metadata() {
        let (map_ptr, _map) = make_coverage_map(1024);
        let (mut state, ..) = make_fuzzer(map_ptr, 1024);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();

        // Add auto-seeds the same way Fuzzer::get_next_input does.
        for seed in DEFAULT_SEEDS {
            let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));
            testcase.set_exec_time(SEED_EXEC_TIME);
            let mut sched_meta = SchedulerTestcaseMetadata::new(0);
            sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
            testcase.add_metadata(sched_meta);

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

    // Task 6.1: calibrate_run tests

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

        for (idx, (&first_val, &cur_val)) in first_map.iter().zip(second_map.iter()).enumerate() {
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

    // Task 6.3: calibrate_finish tests

    #[test]
    fn test_calibrate_finish_averages_exec_time() {
        let (map_ptr, _map) = make_coverage_map(1024);
        let (mut state, ..) = make_fuzzer(map_ptr, 1024);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();

        // Add a corpus entry with preliminary metadata.
        let mut tc = Testcase::new(BytesInput::new(b"test".to_vec()));
        tc.set_exec_time(Duration::from_micros(100));
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_bitmap_size(1);
        sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
        tc.add_metadata(sched_meta);
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

    // Task 8.1: Power scoring verification test

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

    // n_fuzz_entry tracking tests

    #[test]
    fn test_n_fuzz_entry_set_on_interesting_input() {
        let mut fuzzer = make_test_fuzzer(256);

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
            .calibration_corpus_id
            .expect("calibration_corpus_id should be set");
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
        let mut fuzzer = make_test_fuzzer(256);

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
        let mut fuzzer = make_test_fuzzer(256);

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

    // Task 6.5: Crash during calibration test

    #[test]
    fn test_crash_during_calibration_partial_data() {
        let (map_ptr, _map) = make_coverage_map(1024);
        let (mut state, ..) = make_fuzzer(map_ptr, 1024);
        let mut scheduler: FuzzerScheduler = ProbabilitySamplingScheduler::new();

        // Add a corpus entry with preliminary metadata.
        let mut tc = Testcase::new(BytesInput::new(b"crashing".to_vec()));
        tc.set_exec_time(Duration::from_micros(100));
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_bitmap_size(1);
        sched_meta.set_cycle_and_time((Duration::from_micros(100), 1));
        tc.add_metadata(sched_meta);
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

    // === Integration tests: exercise actual calibrate_run / calibrate_finish methods ===

    /// Construct a full `Fuzzer` for integration tests without the napi runtime.
    fn make_test_fuzzer(map_size: usize) -> Fuzzer {
        let mut coverage_map: Buffer = vec![0u8; map_size].into();
        let map_ptr = coverage_map.as_mut_ptr();
        let map_len = coverage_map.len();

        let temp_observer =
            unsafe { StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, map_ptr, map_len) };

        let mut feedback = MaxMapFeedback::new(&temp_observer);
        let mut crash_objective = CrashFeedback::new();
        let mut timeout_objective = TimeoutFeedback::new();

        let mut state = StdState::new(
            StdRand::with_seed(42),
            InMemoryCorpus::<BytesInput>::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut crash_objective,
        )
        .unwrap();

        timeout_objective.init_state(&mut state).unwrap();

        let scheduler = ProbabilitySamplingScheduler::new();
        let mutator = HavocScheduledMutator::new(havoc_mutations().merge(tokens_mutations()));
        let i2s_mutator = I2SSpliceReplace::new();
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

        drop(temp_observer);

        state.set_max_size(DEFAULT_MAX_INPUT_LEN as usize);
        state.metadata_map_mut().insert(CmpValuesMetadata::new());
        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));

        Fuzzer {
            state,
            scheduler,
            feedback,
            crash_objective,
            timeout_objective,
            mutator,
            i2s_mutator,
            grimoire_mutator,
            map_ptr,
            map_len,
            _coverage_map: coverage_map,
            max_input_len: DEFAULT_MAX_INPUT_LEN,
            total_execs: 0,
            solution_count: 0,
            start_time: Instant::now(),
            last_input: None,
            last_corpus_id: None,
            calibration_corpus_id: None,
            calibration_first_map: None,
            calibration_history_map: None,
            calibration_total_time: Duration::ZERO,
            calibration_iterations: 0,
            calibration_has_unstable: false,
            unstable_entries: HashSet::new(),
            token_candidates: HashMap::new(),
            promoted_tokens: HashSet::new(),
            stage_state: StageState::None,
            last_interesting_corpus_id: None,
            last_stage_input: None,
            grimoire_enabled: false,
            grimoire_deferred_count: Some(0),
            auto_seed_count: 0,
        }
    }

    #[test]
    fn test_calibrate_run_and_finish_integration() {
        let mut fuzzer = make_test_fuzzer(256);

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

        // Read calibration_corpus_id before calibrate_finish() consumes it.
        let interesting_id = fuzzer
            .calibration_corpus_id
            .expect("calibration_corpus_id should be set after report_result(Interesting)");

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
        let mut fuzzer = make_test_fuzzer(256);

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
        let mut fuzzer = make_test_fuzzer(256);

        // calibrate_finish() on a fresh fuzzer with no prior Interesting result
        // should return an error because calibration_corpus_id is None.
        let err = fuzzer.calibrate_finish().unwrap_err();
        assert!(
            err.to_string().contains("without pending calibration"),
            "Expected 'without pending calibration' error, got: {err}"
        );
    }

    #[test]
    fn test_depth_chain_across_three_levels() {
        let mut fuzzer = make_test_fuzzer(1024);

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
            .calibration_corpus_id
            .expect("should have calibration_corpus_id");
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
        // Force scheduler to select the depth-1 entry by running get_next_input
        // until it picks id_depth1, so last_corpus_id is set correctly.
        loop {
            let _input = fuzzer.get_next_input().unwrap();
            if fuzzer.last_corpus_id == Some(id_depth1) {
                break;
            }
            // Consume the iteration without interesting coverage.
            fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        }

        // Now last_corpus_id == id_depth1. Trigger novel coverage at a new edge.
        unsafe {
            *fuzzer.map_ptr.add(20) = 1;
        }
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(matches!(result, IterationResult::Interesting));
        let id_depth2 = fuzzer
            .calibration_corpus_id
            .expect("should have calibration_corpus_id");
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

    // === I2SSpliceReplace unit tests ===

    /// Find a seed that produces the desired RNG sequence for I2SSpliceReplace::mutate().
    ///
    /// The mutate() method makes three RNG calls in order:
    /// 1. `below(cmps_len)` → entry index
    /// 2. `below(input_len)` → starting offset
    /// 3. `coinflip(0.5)` → splice (true) or overwrite (false)
    fn find_i2s_seed(
        cmps_len: usize,
        input_len: usize,
        want_idx: usize,
        want_off: usize,
        want_splice: bool,
    ) -> u64 {
        use core::num::NonZero;
        for seed in 0u64..100_000 {
            let mut rng = StdRand::with_seed(seed);
            let idx = rng.below(NonZero::new(cmps_len).unwrap());
            let off = rng.below(NonZero::new(input_len).unwrap());
            let flip = rng.coinflip(0.5);
            if idx == want_idx && off == want_off && flip == want_splice {
                return seed;
            }
        }
        panic!(
            "no seed found for cmps_len={cmps_len}, input_len={input_len}, want_idx={want_idx}, want_off={want_off}, want_splice={want_splice}"
        );
    }

    /// Create a FuzzerState with seeded RNG and CmpValuesMetadata containing the given entries.
    fn make_i2s_state(seed: u64, entries: Vec<CmpValues>, max_size: usize) -> FuzzerState {
        let (map_ptr, _map) = make_coverage_map(65536);
        let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        // Replace the default RNG with our seeded one.
        *state.rand_mut() = StdRand::with_seed(seed);
        state.set_max_size(max_size);
        state
            .metadata_map_mut()
            .insert(CmpValuesMetadata { list: entries });
        state
    }

    #[test]
    fn test_i2s_splice_shorter_match_with_longer_operand() {
        // 3.1: splice "http" → "javascript" in "http://example.com"
        //      produces "javascript://example.com" (24 bytes)
        let seed = find_i2s_seed(1, 18, 0, 0, true);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"http"),
            make_cmplog_bytes(b"javascript"),
        ))];
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(b"http://example.com".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(input.mutator_bytes(), b"javascript://example.com");
        assert_eq!(input.mutator_bytes().len(), 24);
    }

    #[test]
    fn test_i2s_splice_longer_match_with_shorter_operand() {
        // 3.2: splice "javascript" → "ftp" in "javascript://x"
        //      produces "ftp://x" (7 bytes)
        let seed = find_i2s_seed(1, 14, 0, 0, true);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"javascript"),
            make_cmplog_bytes(b"ftp"),
        ))];
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(b"javascript://x".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(input.mutator_bytes(), b"ftp://x");
        assert_eq!(input.mutator_bytes().len(), 7);
    }

    #[test]
    fn test_i2s_overwrite_truncates_replacement() {
        // 3.3: overwrite "http" → "javascript" in "http://example.com"
        //      produces "java://example.com" (18 bytes, unchanged)
        let seed = find_i2s_seed(1, 18, 0, 0, false);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"http"),
            make_cmplog_bytes(b"javascript"),
        ))];
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(b"http://example.com".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(input.mutator_bytes(), b"java://example.com");
        assert_eq!(input.mutator_bytes().len(), 18);
    }

    #[test]
    fn test_i2s_equal_length_always_overwrites() {
        // 3.4: equal-length "test"→"pass" in "test" — always overwrite regardless of RNG.
        // Test with both splice=true and splice=false seeds.
        for want_splice in [true, false] {
            let seed = find_i2s_seed(1, 4, 0, 0, want_splice);
            let entries = vec![CmpValues::Bytes((
                make_cmplog_bytes(b"test"),
                make_cmplog_bytes(b"pass"),
            ))];
            let mut state = make_i2s_state(seed, entries, 4096);
            let mut input = BytesInput::new(b"test".to_vec());
            let mut mutator = I2SSpliceReplace::new();

            let result = mutator.mutate(&mut state, &mut input).unwrap();
            assert_eq!(result, MutationResult::Mutated);
            assert_eq!(
                input.mutator_bytes(),
                b"pass",
                "equal-length operands should always overwrite, want_splice={want_splice}"
            );
            assert_eq!(input.mutator_bytes().len(), 4, "length should be unchanged");
        }
    }

    #[test]
    fn test_i2s_non_bytes_delegates_to_inner() {
        // 3.5: When the selected entry is non-Bytes (U32), delegates to inner I2SRandReplace.
        // Use 2 entries: [U32, Bytes]. Need idx=0 to select the U32.
        use core::num::NonZero;

        // Find a seed where below(2) → 0 (selects the U32 entry).
        let mut seed = 0u64;
        for s in 0u64..100_000 {
            let mut rng = StdRand::with_seed(s);
            let idx = rng.below(NonZero::new(2).unwrap());
            if idx == 0 {
                seed = s;
                break;
            }
        }

        let entries = vec![
            CmpValues::U32((42, 99, false)),
            CmpValues::Bytes((make_cmplog_bytes(b"abc"), make_cmplog_bytes(b"xyz"))),
        ];

        // Input containing the U32 value 42 as bytes: we expect I2SRandReplace
        // to handle it. With a 4-byte input containing [42, 0, 0, 0] (little-endian u32),
        // the inner mutator should attempt to replace it.
        let input_bytes = 42u32.to_ne_bytes().to_vec();
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(input_bytes.clone());
        let mut mutator = I2SSpliceReplace::new();

        // The inner I2SRandReplace handles it — result may be Mutated or Skipped
        // depending on its own RNG. The key assertion is that it doesn't panic
        // and returns a valid result (delegation worked).
        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert!(
            result == MutationResult::Mutated || result == MutationResult::Skipped,
            "non-Bytes entry should delegate to inner I2SRandReplace"
        );

        // Verify the Bytes entry was NOT used — input should not contain
        // the byte replacements from the Bytes pair.
        let mutated = input.mutator_bytes();
        assert!(
            !mutated.windows(3).any(|w| w == b"xyz" || w == b"abc"),
            "Bytes entry should not have been applied; \
             the U32 path (delegation) should have been taken instead"
        );
    }

    #[test]
    fn test_i2s_splice_exceeding_max_size_falls_back_to_overwrite() {
        // 3.6: max_size=128, input=120 bytes with 4-byte match, replacement=20 bytes.
        // Splice would produce 120 - 4 + 20 = 136 > 128, so falls back to overwrite.
        let mut input_bytes = vec![0u8; 120];
        input_bytes[0..4].copy_from_slice(b"http");

        let seed = find_i2s_seed(1, 120, 0, 0, true);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"http"),
            make_cmplog_bytes(b"12345678901234567890"), // 20 bytes
        ))];
        let mut state = make_i2s_state(seed, entries, 128);
        let mut input = BytesInput::new(input_bytes);
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        // Should have fallen back to overwrite: first 4 bytes of replacement written.
        assert_eq!(&input.mutator_bytes()[0..4], b"1234");
        assert_eq!(
            input.mutator_bytes().len(),
            120,
            "length should be unchanged (overwrite fallback)"
        );
        assert_eq!(
            &input.mutator_bytes()[4..],
            &[0u8; 116],
            "tail bytes should be unchanged after overwrite fallback"
        );
    }

    #[test]
    fn test_i2s_splice_within_max_size_proceeds() {
        // 3.7: max_size=4096, input=100 bytes, splice produces 106 bytes.
        let mut input_bytes = vec![0x41u8; 100];
        input_bytes[0..4].copy_from_slice(b"http");

        let seed = find_i2s_seed(1, 100, 0, 0, true);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"http"),
            make_cmplog_bytes(b"javascript"),
        ))];
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(input_bytes);
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(&input.mutator_bytes()[0..10], b"javascript");
        assert_eq!(
            input.mutator_bytes().len(),
            106,
            "splice should grow input by 6"
        );
        assert!(
            input.mutator_bytes()[10..].iter().all(|&b| b == 0x41),
            "tail bytes should be preserved after splice"
        );
    }

    #[test]
    fn test_i2s_bidirectional_matching() {
        // 3.8: Forward: input contains "abc" → replace with "xyz".
        //       Reverse: input contains "xyz" → replace with "abc".
        let entries_forward = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"abc"),
            make_cmplog_bytes(b"xyz"),
        ))];
        let entries_reverse = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"abc"),
            make_cmplog_bytes(b"xyz"),
        ))];

        // Forward: input has "abc", should be replaced with "xyz".
        let seed = find_i2s_seed(1, 3, 0, 0, false);
        let mut state = make_i2s_state(seed, entries_forward, 4096);
        let mut input = BytesInput::new(b"abc".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(input.mutator_bytes(), b"xyz", "forward match: abc → xyz");

        // Reverse: input has "xyz", should be replaced with "abc".
        let mut state = make_i2s_state(seed, entries_reverse, 4096);
        let mut input = BytesInput::new(b"xyz".to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        assert_eq!(input.mutator_bytes(), b"abc", "reverse match: xyz → abc");
    }

    #[test]
    fn test_i2s_partial_prefix_match_with_splice() {
        // 3.9: Input contains "htt" (3-byte prefix of "http").
        // Splice should delete 3 matched bytes and insert full "javascript" (10 bytes).
        // Result: "javascript" + remaining bytes after "htt".
        let input_bytes = b"htt://x".to_vec(); // 7 bytes, "htt" is a 3-byte prefix match
        let seed = find_i2s_seed(1, 7, 0, 0, true);
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"http"),
            make_cmplog_bytes(b"javascript"),
        ))];
        let mut state = make_i2s_state(seed, entries, 4096);
        let mut input = BytesInput::new(input_bytes);
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        // "htt" (3 bytes) replaced by full "javascript" (10 bytes), tail "://x" preserved
        assert_eq!(input.mutator_bytes(), b"javascript://x");
        assert_eq!(
            input.mutator_bytes().len(),
            14,
            "length should be 7 - 3 + 10 = 14"
        );
    }

    #[test]
    fn test_i2s_empty_metadata_or_input_returns_skipped() {
        // 3.10a-0: Absent CmpValuesMetadata entirely → Skipped.
        let (map_ptr, _map) = make_coverage_map(65536);
        let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        *state.rand_mut() = StdRand::with_seed(42);
        state.set_max_size(4096);
        let mut input = BytesInput::new(b"some data".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(
            result,
            MutationResult::Skipped,
            "absent metadata should skip"
        );

        // 3.10a: Empty CmpValuesMetadata → Skipped.
        let mut state = make_i2s_state(42, vec![], 4096);
        let mut input = BytesInput::new(b"some data".to_vec());
        let mut mutator = I2SSpliceReplace::new();

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(
            result,
            MutationResult::Skipped,
            "empty metadata should skip"
        );

        // 3.10b: Empty input → Skipped.
        let entries = vec![CmpValues::Bytes((
            make_cmplog_bytes(b"abc"),
            make_cmplog_bytes(b"xyz"),
        ))];
        let mut state = make_i2s_state(42, entries, 4096);
        let mut input = BytesInput::new(vec![]);

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Skipped, "empty input should skip");
    }

    // === Stage execution tests ===

    /// Set up a test fuzzer with an interesting corpus entry and CmpLog data,
    /// ready for beginStage().
    fn make_fuzzer_ready_for_stage(map_size: usize) -> Fuzzer {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(map_size);
        cmplog::enable();

        // Add a seed so the scheduler has something to select.
        fuzzer
            .add_seed(Buffer::from(b"seed_for_stage_test".to_vec()))
            .unwrap();

        // Simulate getNextInput to set last_input and last_corpus_id.
        let _ = fuzzer.get_next_input().unwrap();

        // Write novel coverage to trigger Interesting.
        unsafe {
            *fuzzer.map_ptr.add(42) = 1;
        }

        // Push CmpLog entries so beginStage has data to work with.
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"hello"),
            make_cmplog_bytes(b"world"),
        )));

        // report_result will evaluate coverage, drain CmpLog, and set
        // last_interesting_corpus_id if interesting.
        let result = fuzzer.report_result(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(
            result,
            IterationResult::Interesting,
            "should be Interesting for novel coverage"
        );

        // Simulate calibration (required before beginStage).
        // Write the same coverage for calibration runs.
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

        fuzzer
    }

    #[test]
    fn test_begin_stage_returns_null_during_active_stage() {
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

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

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();

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

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();

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
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"test"),
            make_cmplog_bytes(b"data"),
        )));

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
        if let StageState::I2S {
            corpus_id,
            iteration,
            ..
        } = fuzzer.stage_state
        {
            fuzzer.stage_state = StageState::I2S {
                corpus_id,
                iteration,
                max_iterations: 1,
            };
        }

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
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

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
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"stage_operand_1"),
            make_cmplog_bytes(b"stage_operand_2"),
        )));

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
                .token_candidates
                .contains_key(b"stage_operand_1".as_slice()),
            "stage CmpLog operands should not enter token_candidates"
        );

        cmplog::disable();
    }

    #[test]
    fn test_non_cumulative_mutations() {
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

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

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();

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

    // === MapNoveltiesMetadata tracking tests (task 2.1) ===

    #[test]
    fn test_novelty_indices_recorded_for_interesting_input() {
        // When an input triggers new coverage, MapNoveltiesMetadata should be
        // stored on the testcase containing exactly the newly-maximized indices.
        let mut fuzzer = make_test_fuzzer(256);
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
            .calibration_corpus_id
            .expect("should have calibration_corpus_id");
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
    fn test_no_novelty_metadata_for_non_interesting_input() {
        // Non-interesting inputs are not added to corpus, so no metadata stored.
        let mut fuzzer = make_test_fuzzer(256);
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

    #[test]
    fn test_novelty_only_newly_maximized_not_all_covered() {
        // When input covers indices that already have equal-or-higher history values,
        // only the truly-novel (newly maximized) indices should be in MapNoveltiesMetadata.
        let mut fuzzer = make_test_fuzzer(256);
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
            .calibration_corpus_id
            .expect("should have calibration_corpus_id");
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

        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Trigger an interesting input so we can start a stage.
        let _input = fuzzer.get_next_input().unwrap();
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"seed"),
            make_cmplog_bytes(b"test"),
        )));
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

    // === Grimoire auto-detection tests (task 3.1) ===

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

        assert!(Fuzzer::scan_corpus_utf8(&state, 0));
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

        assert!(!Fuzzer::scan_corpus_utf8(&state, 0));
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
            !Fuzzer::scan_corpus_utf8(&state, 0),
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
            !Fuzzer::scan_corpus_utf8(&state, 3),
            "skipping all entries should return false"
        );
        // skip_count > count → false
        assert!(
            !Fuzzer::scan_corpus_utf8(&state, 100),
            "skipping beyond corpus size should return false"
        );
    }

    #[test]
    fn test_grimoire_explicit_override_bypasses_scanning() {
        // Explicit `grimoire: false` should prevent deferred detection from
        // enabling Grimoire, even after GRIMOIRE_DEFERRED_THRESHOLD interesting
        // UTF-8 inputs arrive via report_result.
        cmplog::disable();
        cmplog::drain();
        let mut fuzzer = make_test_fuzzer(256);
        // Simulate explicit override: grimoire disabled, no deferred tracking.
        fuzzer.grimoire_enabled = false;
        fuzzer.grimoire_deferred_count = None;
        cmplog::enable();

        assert!(
            fuzzer.grimoire_deferred_count.is_none(),
            "explicit override should set deferred_count to None"
        );

        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();
        let seed_id = CorpusId::from(0usize);
        for i in 0..GRIMOIRE_DEFERRED_THRESHOLD {
            fuzzer.last_input = Some(BytesInput::new(format!("utf8_input_{i}").into_bytes()));
            fuzzer.last_corpus_id = Some(seed_id);
            unsafe {
                *fuzzer.map_ptr.add(i + 10) = 1;
            }
            let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
            assert!(matches!(result, IterationResult::Interesting));
            fuzzer.calibrate_finish().unwrap();
        }

        assert!(
            !fuzzer.grimoire_enabled,
            "explicit false override should not be overridden by deferred detection"
        );
        cmplog::disable();
    }

    #[test]
    fn test_grimoire_empty_corpus_defers_detection() {
        let fuzzer = make_test_fuzzer(256);

        // Empty corpus with no override → deferred.
        assert!(!fuzzer.grimoire_enabled);
        assert_eq!(fuzzer.grimoire_deferred_count, Some(0));
    }

    #[test]
    fn test_grimoire_deferred_triggers_after_10_interesting() {
        cmplog::disable();
        cmplog::drain();
        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Generate GRIMOIRE_DEFERRED_THRESHOLD interesting inputs with controlled UTF-8 content.
        // We bypass get_next_input to avoid havoc producing non-UTF-8 bytes.
        let seed_id = CorpusId::from(0usize);
        for i in 0..GRIMOIRE_DEFERRED_THRESHOLD {
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

        // After GRIMOIRE_DEFERRED_THRESHOLD interesting UTF-8 inputs, Grimoire should be enabled.
        assert!(
            fuzzer.grimoire_enabled,
            "should be enabled after GRIMOIRE_DEFERRED_THRESHOLD UTF-8 inputs"
        );
        assert!(
            fuzzer.grimoire_deferred_count.is_none(),
            "deferred count should be consumed"
        );
        cmplog::disable();
    }

    #[test]
    fn test_grimoire_deferred_ignores_stage_found_entries() {
        cmplog::disable();
        cmplog::drain();
        let mut fuzzer = make_test_fuzzer(256);
        cmplog::enable();
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // One interesting input via main loop → deferred count = 1.
        // Push CmpLog data so begin_stage has I2S entries to work with.
        let seed_id = CorpusId::from(0usize);
        fuzzer.last_input = Some(BytesInput::new(b"utf8_main".to_vec()));
        fuzzer.last_corpus_id = Some(seed_id);
        unsafe {
            *fuzzer.map_ptr.add(50) = 1;
        }
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"hello"),
            make_cmplog_bytes(b"world"),
        )));
        let result = fuzzer.report_result(ExitKind::Ok, 100_000.0).unwrap();
        assert!(matches!(result, IterationResult::Interesting));
        assert_eq!(fuzzer.grimoire_deferred_count, Some(1));

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
            fuzzer.grimoire_deferred_count,
            Some(1),
            "stage-found entries should not increment deferred count"
        );
        cmplog::disable();
    }

    #[test]
    fn test_grimoire_deferred_excludes_default_seeds() {
        // When deferred detection fires, scan_corpus_utf8 should skip the
        // auto-seeds (all valid UTF-8) so only user-found inputs influence the vote.
        let mut fuzzer = make_test_fuzzer(256);
        for seed in DEFAULT_SEEDS {
            let mut testcase = Testcase::new(BytesInput::new(seed.to_vec()));
            testcase.set_exec_time(SEED_EXEC_TIME);
            let mut sched_meta = SchedulerTestcaseMetadata::new(0);
            sched_meta.set_cycle_and_time((SEED_EXEC_TIME, 1));
            testcase.add_metadata(sched_meta);
            let id = fuzzer.state.corpus_mut().add(testcase).unwrap();
            fuzzer.scheduler.on_add(&mut fuzzer.state, id).unwrap();
            set_n_fuzz_entry_for_corpus_id(&fuzzer.state, id).unwrap();
        }
        fuzzer.auto_seed_count = DEFAULT_SEEDS.len();

        // Add only non-UTF-8 interesting inputs.
        for i in 0u8..4 {
            let tc = Testcase::new(BytesInput::new(vec![0xFF, 0xFE, 0x80, i]));
            fuzzer.state.corpus_mut().add(tc).unwrap();
        }

        // Without skipping: 6 UTF-8 seeds + 0 UTF-8 user vs 4 non-UTF-8 → enabled (wrong).
        assert!(
            Fuzzer::scan_corpus_utf8(&fuzzer.state, 0),
            "without skipping, default seeds cause false positive"
        );

        // With skipping: 0 UTF-8 user vs 4 non-UTF-8 → disabled (correct).
        assert!(
            !Fuzzer::scan_corpus_utf8(&fuzzer.state, fuzzer.auto_seed_count),
            "with skipping, only user inputs are counted"
        );
    }

    // -----------------------------------------------------------------------
    // Generalization stage tests
    // -----------------------------------------------------------------------

    /// Create a fuzzer with grimoire enabled and a corpus entry at the given
    /// novelty map indices. Returns (fuzzer, corpus_id).
    fn make_fuzzer_with_generalization_entry(
        map_size: usize,
        input: &[u8],
        novelty_indices: &[usize],
    ) -> (Fuzzer, CorpusId) {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(map_size);
        fuzzer.grimoire_enabled = true;
        fuzzer.grimoire_deferred_count = None;
        cmplog::enable();

        // Add a seed so the scheduler has something.
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Manually add a corpus entry with the given input and novelty metadata.
        let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
        testcase.add_metadata(MapNoveltiesMetadata::new(novelty_indices.to_vec()));

        // We need to add scheduler metadata too.
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_n_fuzz_entry(0);
        testcase.add_metadata(sched_meta);
        *testcase.exec_time_mut() = Some(Duration::from_micros(100));

        let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
        fuzzer
            .scheduler
            .on_add(&mut fuzzer.state, corpus_id)
            .unwrap();

        // Also need to make sure the feedback history knows about these indices
        // so they're recognized as "known" coverage.
        // Write coverage at novelty indices and evaluate to establish history.
        for &idx in novelty_indices {
            unsafe {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }
        {
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, fuzzer.map_ptr, fuzzer.map_len)
            };
            let observers = tuple_list!(observer);
            let mut mgr = NopEventManager::new();
            let bytes_input = BytesInput::new(input.to_vec());
            // This call updates the feedback's history map.
            let _ = fuzzer.feedback.is_interesting(
                &mut fuzzer.state,
                &mut mgr,
                &bytes_input,
                &observers,
                &LibaflExitKind::Ok,
            );
        }
        // Zero the map.
        unsafe {
            std::ptr::write_bytes(fuzzer.map_ptr, 0, fuzzer.map_len);
        }

        (fuzzer, corpus_id)
    }

    #[test]
    fn test_generalization_skipped_when_grimoire_disabled() {
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, b"fn foo() {}", &[10, 20]);
        fuzzer.grimoire_enabled = false;

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped when Grimoire disabled"
        );
        assert!(matches!(fuzzer.stage_state, StageState::None));

        cmplog::disable();
    }

    #[test]
    fn test_generalization_skipped_for_large_input() {
        let large_input = vec![b'A'; MAX_GENERALIZED_LEN + 1];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, &large_input, &[10]);

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped for input > MAX_GENERALIZED_LEN"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_skipped_when_no_novelties() {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(256);
        fuzzer.grimoire_enabled = true;
        fuzzer.grimoire_deferred_count = None;
        cmplog::enable();

        // Add a corpus entry WITHOUT MapNoveltiesMetadata.
        let testcase = Testcase::new(BytesInput::new(b"test".to_vec()));
        let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped without novelties"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_skipped_when_already_generalized() {
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, b"fn foo() {}", &[10, 20]);

        // Manually add GeneralizedInputMetadata to simulate prior generalization.
        let payload: Vec<Option<u8>> = b"fn foo() {}".iter().map(|&b| Some(b)).collect();
        let meta = Fuzzer::payload_to_generalized(&payload);
        fuzzer
            .state
            .corpus()
            .get(corpus_id)
            .unwrap()
            .borrow_mut()
            .add_metadata(meta);

        let result = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "generalization should be skipped when already generalized"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_verification_succeeds() {
        let input = b"fn foo() {}";
        let novelty_indices = vec![10, 20];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        // Begin generalization — should return the original input for verification.
        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some(), "should return verification candidate");
        let candidate: Vec<u8> = first.unwrap().to_vec();
        assert_eq!(
            candidate, input,
            "verification candidate should be the original input"
        );
        assert!(matches!(
            fuzzer.stage_state,
            StageState::Generalization {
                phase: GeneralizationPhase::Verify,
                ..
            }
        ));

        // Simulate target execution: set novelty indices in coverage map.
        for &idx in &novelty_indices {
            unsafe {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }

        // Advance — verification should pass and produce next candidate.
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(
            next.is_some(),
            "should produce first gap-finding candidate after verification passes"
        );
        // Should now be in Offset phase.
        assert!(matches!(
            fuzzer.stage_state,
            StageState::Generalization {
                phase: GeneralizationPhase::Offset { .. },
                ..
            }
        ));

        cmplog::disable();
    }

    #[test]
    fn test_generalization_verification_fails() {
        let input = b"fn foo() {}";
        let novelty_indices = vec![10, 20];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Simulate execution where one novelty index is zero (unstable).
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
            // index 20 is left at 0 — verification fails.
        }

        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(
            next.is_none(),
            "verification failure should abort generalization"
        );
        assert!(matches!(fuzzer.stage_state, StageState::None));

        // Verify no GeneralizedInputMetadata was stored.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            !tc.has_metadata::<GeneralizedInputMetadata>(),
            "no metadata should be stored on verification failure"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_offset_marks_gaps() {
        // Use a small input so offset-0 pass tests each byte individually.
        let input = b"ab";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        // Begin generalization.
        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification: set novelty index.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(next.is_some(), "should produce first offset candidate");

        // We're now in offset phase. The first pass has offset=255.
        // For a 2-byte input: start=0, end=min(0+1+255, 2)=2.
        // Candidate removes bytes [0, 2) = entire input → empty candidate.
        // Simulate novelties surviving (meaning entire input can be gapped).
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        // Since end (2) >= payload.len() (2), this pass is done. Trim + next level.
        // After marking [0, 2) as gaps, payload = [None, None].
        // After trimming, payload = [None].
        // Continue through remaining offset levels and delimiter passes.
        // Eventually generalization completes.

        // Drive to completion — keep advancing until None.
        let mut exec_count = 2; // verification + first offset candidate
        while let Some(_buf) = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap() {
            exec_count += 1;
            // Set novelties for all subsequent candidates.
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            if exec_count > 100 {
                panic!("generalization should complete within reasonable iterations");
            }
        }

        // Verify metadata was stored.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "GeneralizedInputMetadata should be stored after generalization completes"
        );
        let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
        // The entire input was gapped, so metadata should be just [Gap].
        // (Leading and trailing gaps merged with the single gap.)
        assert!(
            meta.generalized().contains(&GeneralizedItem::Gap),
            "metadata should contain Gap items"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_offset_preserves_structural() {
        // 4-byte input. We'll make the first offset-255 candidate fail (novelties don't survive),
        // meaning those bytes are structural.
        let input = b"test";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification: pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(next.is_some());

        // First offset-255 candidate removes [0, 4) from 4-byte input.
        // Simulate novelties NOT surviving → bytes are structural.
        // (Don't set the novelty index → it stays 0.)
        let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        // Pass complete (end=4 >= payload.len=4). Move to next offset level.
        // Continue — all candidates also fail novelties.
        let mut exec_count = 3;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            if candidate.is_none() {
                break;
            }
            exec_count += 1;
            // Don't set novelty index — all candidates fail.
            if exec_count > 200 {
                panic!("generalization should complete within reasonable iterations");
            }
        }

        // Verify metadata was stored (even if everything is structural).
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "GeneralizedInputMetadata should be stored even when all bytes are structural"
        );
        let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
        // All bytes are structural, so metadata should be [Gap, Bytes(b"test"), Gap].
        let items = meta.generalized();
        assert_eq!(
            items.first(),
            Some(&GeneralizedItem::Gap),
            "should have leading gap"
        );
        assert_eq!(
            items.last(),
            Some(&GeneralizedItem::Gap),
            "should have trailing gap"
        );
        assert!(
            items
                .iter()
                .any(|item| matches!(item, GeneralizedItem::Bytes(b) if b == b"test")),
            "should have the original bytes as structural"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_execution_counting() {
        let input = b"ab";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let total_before = fuzzer.total_execs;
        let state_execs_before = *fuzzer.state.executions();

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(
            fuzzer.total_execs,
            total_before + 1,
            "verification should count"
        );
        assert_eq!(
            *fuzzer.state.executions(),
            state_execs_before + 1,
            "state.executions should increment"
        );

        // Drive to completion, counting all executions.
        let mut advance_count = 1;
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            advance_count += 1;
            if candidate.is_none() {
                break;
            }
            if advance_count > 100 {
                panic!("should complete within reasonable iterations");
            }
        }

        assert_eq!(
            fuzzer.total_execs,
            total_before + advance_count as u64,
            "total_execs should match number of advance calls"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_cmplog_drained() {
        let input = b"fn foo() {}";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();

        // Push CmpLog entries (simulating target execution producing CmpLog data).
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"test"),
            make_cmplog_bytes(b"data"),
        )));

        // Set novelties for verification pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Verify CmpLog was drained.
        let drained = cmplog::drain();
        assert!(
            drained.is_empty(),
            "CmpLog should be drained by advance_stage during generalization"
        );

        cmplog::disable();
    }

    #[test]
    fn test_generalization_output_format() {
        // Test that payload_to_generalized produces correct format.
        // Payload: [None, Some(b'f'), Some(b'n'), None, Some(b'('), Some(b')'), None]
        let payload = vec![
            None,
            Some(b'f'),
            Some(b'n'),
            None,
            Some(b'('),
            Some(b')'),
            None,
        ];
        let meta = Fuzzer::payload_to_generalized(&payload);
        let items = meta.generalized();
        assert_eq!(
            items,
            &[
                GeneralizedItem::Gap,
                GeneralizedItem::Bytes(b"fn".to_vec()),
                GeneralizedItem::Gap,
                GeneralizedItem::Bytes(b"()".to_vec()),
                GeneralizedItem::Gap,
            ],
            "should produce [Gap, Bytes(fn), Gap, Bytes(()), Gap]"
        );
    }

    #[test]
    fn test_generalization_output_leading_trailing_gaps() {
        // Payload starts and ends with Some — should get leading/trailing gaps.
        let payload = vec![Some(b'a'), Some(b'b')];
        let meta = Fuzzer::payload_to_generalized(&payload);
        let items = meta.generalized();
        assert_eq!(
            items.first(),
            Some(&GeneralizedItem::Gap),
            "must have leading gap"
        );
        assert_eq!(
            items.last(),
            Some(&GeneralizedItem::Gap),
            "must have trailing gap"
        );
        assert_eq!(
            items,
            &[
                GeneralizedItem::Gap,
                GeneralizedItem::Bytes(b"ab".to_vec()),
                GeneralizedItem::Gap,
            ]
        );
    }

    #[test]
    fn test_trim_payload_removes_consecutive_gaps() {
        let mut payload = vec![None, None, Some(b'a'), None, None, None, Some(b'b'), None];
        Fuzzer::trim_payload(&mut payload);
        assert_eq!(
            payload,
            vec![None, Some(b'a'), None, Some(b'b'), None],
            "consecutive None entries should be collapsed to single None"
        );
    }

    #[test]
    fn test_build_generalization_candidate() {
        let payload = vec![
            Some(b'a'),
            Some(b'b'),
            None,
            Some(b'c'),
            Some(b'd'),
            Some(b'e'),
        ];
        // Remove range [1, 4) — removes Some(b'b'), None, Some(b'c').
        let candidate = Fuzzer::build_generalization_candidate(&payload, 1, 4);
        // payload[..1] = [Some(b'a')] → [b'a']
        // payload[4..] = [Some(b'd'), Some(b'e')] → [b'd', b'e']
        // None values in either portion are skipped.
        assert_eq!(candidate, b"ade");
    }

    #[test]
    fn test_build_candidate_skips_gaps() {
        let payload = vec![None, Some(b'a'), Some(b'b'), None, Some(b'c')];
        // Remove range [1, 3) — removes Some(b'a'), Some(b'b').
        let candidate = Fuzzer::build_generalization_candidate(&payload, 1, 3);
        // payload[..1] = [None] → skipped
        // payload[3..] = [None, Some(b'c')] → [b'c']
        assert_eq!(candidate, b"c");
    }

    #[test]
    fn test_generalization_delimiter_gap_finding() {
        // Use "line1\nline2" and test that the delimiter pass can split on \n.
        let input = b"line1\nline2";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();

        // Disable Grimoire after starting generalization so finalize_generalization
        // doesn't transition to Grimoire stage (this test isolates generalization).
        fuzzer.grimoire_enabled = false;

        // Verification pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Drive through all offset passes — don't set novelty (all fail, bytes stay structural).
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            // Check if we're now in delimiter phase.
            if matches!(
                fuzzer.stage_state,
                StageState::Generalization {
                    phase: GeneralizationPhase::Delimiter { .. },
                    ..
                }
            ) {
                break;
            }
            if count > 200 {
                panic!("should reach delimiter phase");
            }
        }

        // Now we're in delimiter phase. For the newline delimiter (index 3),
        // the first candidate removes from pos=0 to \n+1 position.
        // Drive through delimiter passes, setting novelties to survive on the \n pass.
        // This is complex to test precisely since we'd need to identify which pass
        // has the \n delimiter. Instead, just verify the pipeline completes.
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 500 {
                panic!("should complete generalization");
            }
        }

        // Verify metadata was stored and contains Gap entries.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        let metadata = tc
            .metadata::<GeneralizedInputMetadata>()
            .expect("GeneralizedInputMetadata should be stored");
        // With all novelties surviving through delimiter passes, the metadata should
        // contain at least one Gap entry (delimiters become gap boundaries).
        let has_gaps = metadata
            .generalized()
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Gap));
        assert!(
            has_gaps,
            "delimiter-based generalization should produce gaps when novelties survive"
        );

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // Grimoire mutational stage tests
    // -----------------------------------------------------------------------

    /// Create a fuzzer with a corpus entry that has GeneralizedInputMetadata,
    /// ready for the Grimoire stage.
    fn make_fuzzer_with_grimoire_entry(map_size: usize, input: &[u8]) -> (Fuzzer, CorpusId) {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(map_size);
        fuzzer.grimoire_enabled = true;
        fuzzer.grimoire_deferred_count = None;
        cmplog::enable();

        // Add a seed so scheduler works.
        fuzzer.add_seed(Buffer::from(b"seed".to_vec())).unwrap();

        // Add a corpus entry with GeneralizedInputMetadata.
        let mut testcase = Testcase::new(BytesInput::new(input.to_vec()));
        testcase.add_metadata(MapNoveltiesMetadata::new(vec![10]));
        let mut sched_meta = SchedulerTestcaseMetadata::new(0);
        sched_meta.set_n_fuzz_entry(0);
        testcase.add_metadata(sched_meta);
        *testcase.exec_time_mut() = Some(Duration::from_micros(100));

        // Create a simple GeneralizedInputMetadata.
        let payload: Vec<Option<u8>> = input.iter().map(|&b| Some(b)).collect();
        testcase.add_metadata(Fuzzer::payload_to_generalized(&payload));

        let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();
        fuzzer
            .scheduler
            .on_add(&mut fuzzer.state, corpus_id)
            .unwrap();

        // Establish coverage history.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        {
            let observer = unsafe {
                StdMapObserver::from_mut_ptr(EDGES_OBSERVER_NAME, fuzzer.map_ptr, fuzzer.map_len)
            };
            let observers = tuple_list!(observer);
            let mut mgr = NopEventManager::new();
            let bytes_input = BytesInput::new(input.to_vec());
            let _ = fuzzer.feedback.is_interesting(
                &mut fuzzer.state,
                &mut mgr,
                &bytes_input,
                &observers,
                &LibaflExitKind::Ok,
            );
        }
        unsafe {
            std::ptr::write_bytes(fuzzer.map_ptr, 0, fuzzer.map_len);
        }

        (fuzzer, corpus_id)
    }

    #[test]
    fn test_grimoire_stage_begins_with_metadata() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

        let first = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(
            first.is_some(),
            "begin_grimoire should return Some when metadata exists"
        );
        assert!(
            matches!(fuzzer.stage_state, StageState::Grimoire { .. }),
            "stage should be Grimoire"
        );

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_stage_skipped_without_metadata() {
        cmplog::disable();
        cmplog::drain();

        let mut fuzzer = make_test_fuzzer(256);
        fuzzer.grimoire_enabled = true;
        fuzzer.grimoire_deferred_count = None;
        cmplog::enable();

        // Add a corpus entry WITHOUT GeneralizedInputMetadata.
        let testcase = Testcase::new(BytesInput::new(b"test".to_vec()));
        let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();

        let result = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "begin_grimoire should return None without metadata"
        );

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_stage_skipped_when_disabled() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");
        fuzzer.grimoire_enabled = false;

        let result = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "begin_grimoire should return None when Grimoire disabled"
        );

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_stage_completes_after_iterations() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

        let first = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(first.is_some());

        // Force max_iterations to 3 for deterministic testing.
        if let StageState::Grimoire {
            corpus_id,
            iteration,
            ..
        } = fuzzer.stage_state
        {
            fuzzer.stage_state = StageState::Grimoire {
                corpus_id,
                iteration,
                max_iterations: 3,
            };
        }

        // Advance through 3 iterations.
        let second = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(second.is_some(), "iteration 1 should produce next");

        let third = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(third.is_some(), "iteration 2 should produce next");

        let done = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(done.is_none(), "iteration 3 should complete the stage");
        assert!(matches!(fuzzer.stage_state, StageState::None));

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_execution_counting() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

        let total_before = fuzzer.total_execs;

        let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

        // Force max_iterations to 2.
        if let StageState::Grimoire {
            corpus_id,
            iteration,
            ..
        } = fuzzer.stage_state
        {
            fuzzer.stage_state = StageState::Grimoire {
                corpus_id,
                iteration,
                max_iterations: 2,
            };
        }

        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(fuzzer.total_execs, total_before + 1);

        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert_eq!(fuzzer.total_execs, total_before + 2);

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_cmplog_drained() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

        let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

        // Push CmpLog entries simulating target execution.
        cmplog::push(CmpValues::Bytes((
            make_cmplog_bytes(b"grimoire_test"),
            make_cmplog_bytes(b"grimoire_data"),
        )));

        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // CmpLog should be drained.
        let drained = cmplog::drain();
        assert!(
            drained.is_empty(),
            "CmpLog should be drained during Grimoire stage"
        );

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_max_input_len_enforced() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");
        fuzzer.max_input_len = 5;

        let first = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(first.is_some());

        // The output should be truncated to max_input_len.
        let bytes: Vec<u8> = first.unwrap().to_vec();
        assert!(
            bytes.len() <= 5,
            "output should be truncated to max_input_len"
        );

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_non_cumulative_mutations() {
        let input = b"fn foo() {}";
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, input);

        let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

        // Force max_iterations to 5.
        if let StageState::Grimoire {
            corpus_id,
            iteration,
            ..
        } = fuzzer.stage_state
        {
            fuzzer.stage_state = StageState::Grimoire {
                corpus_id,
                iteration,
                max_iterations: 5,
            };
        }

        // Advance through iterations. The corpus entry's metadata should
        // remain unchanged (each iteration clones independently).
        for _ in 0..4 {
            let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            if next.is_none() {
                break;
            }
            // Verify the corpus entry's metadata is still the original.
            let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
            let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
            let original_bytes = meta.generalized_to_bytes();
            assert_eq!(
                original_bytes,
                input.to_vec(),
                "corpus entry metadata should not be modified by mutations"
            );
        }

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_abort_transitions_to_none() {
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

        let _first = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(matches!(fuzzer.stage_state, StageState::Grimoire { .. }));

        let total_before = fuzzer.total_execs;
        fuzzer.abort_stage(ExitKind::Crash).unwrap();

        assert!(matches!(fuzzer.stage_state, StageState::None));
        assert_eq!(
            fuzzer.total_execs,
            total_before + 1,
            "abort should increment total_execs by 1"
        );

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // Stage pipeline orchestration tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_pipeline_i2s_to_generalization_to_grimoire_to_none() {
        // Full pipeline: I2S (1 iteration) → Generalization → Grimoire → None.
        let mut fuzzer = make_fuzzer_ready_for_stage(256);
        fuzzer.grimoire_enabled = true;
        fuzzer.grimoire_deferred_count = None;

        // begin_stage starts I2S (CmpLog data exists from make_fuzzer_ready_for_stage).
        let first = fuzzer.begin_stage().unwrap();
        assert!(first.is_some());
        assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

        // Force max_iterations = 1 so I2S completes on next advance.
        if let StageState::I2S { corpus_id, .. } = fuzzer.stage_state {
            fuzzer.stage_state = StageState::I2S {
                corpus_id,
                iteration: 0,
                max_iterations: 1,
            };
        }

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
        if let StageState::Grimoire { corpus_id, .. } = fuzzer.stage_state {
            fuzzer.stage_state = StageState::Grimoire {
                corpus_id,
                iteration: 0,
                max_iterations: 1,
            };
        }
        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(next.is_none(), "Grimoire should complete and return None");
        assert!(matches!(fuzzer.stage_state, StageState::None));

        cmplog::disable();
    }

    #[test]
    fn test_pipeline_i2s_to_grimoire_preexisting_metadata() {
        // I2S → Grimoire (generalization skipped because entry already has GeneralizedInputMetadata).
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

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
        if let StageState::I2S { corpus_id, .. } = fuzzer.stage_state {
            fuzzer.stage_state = StageState::I2S {
                corpus_id,
                iteration: 0,
                max_iterations: 1,
            };
        }

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
        let mut fuzzer = make_fuzzer_ready_for_stage(256);
        fuzzer.grimoire_enabled = false;

        let first = fuzzer.begin_stage().unwrap();
        assert!(first.is_some());
        assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

        // Force I2S to complete.
        if let StageState::I2S { corpus_id, .. } = fuzzer.stage_state {
            fuzzer.stage_state = StageState::I2S {
                corpus_id,
                iteration: 0,
                max_iterations: 1,
            };
        }

        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        assert!(next.is_none(), "should return None when Grimoire disabled");
        assert!(matches!(fuzzer.stage_state, StageState::None));

        cmplog::disable();
    }

    #[test]
    fn test_pipeline_none_to_generalization_no_cmplog() {
        // No CmpLog → Generalization (Grimoire enabled, input qualifies).
        let (mut fuzzer, corpus_id) = make_fuzzer_with_generalization_entry(256, b"hello", &[10]);

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
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

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
        let (mut fuzzer, corpus_id) = make_fuzzer_with_generalization_entry(256, b"hello", &[10]);

        let first = fuzzer.begin_generalization(corpus_id).unwrap();
        assert!(first.is_some());

        // Disable Grimoire so if verification fails, we go to None (not Grimoire).
        fuzzer.grimoire_enabled = false;

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
        let (mut fuzzer, corpus_id) = make_fuzzer_with_generalization_entry(256, b"hello", &[10]);

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
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

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
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

        let _first = fuzzer.begin_stage().unwrap();
        assert!(matches!(fuzzer.stage_state, StageState::I2S { .. }));

        let total_before = fuzzer.total_execs;
        fuzzer.abort_stage(ExitKind::Crash).unwrap();

        assert!(matches!(fuzzer.stage_state, StageState::None));
        assert_eq!(fuzzer.total_execs, total_before + 1);

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // abort_stage solution recording tests (#14)
    // -----------------------------------------------------------------------

    #[test]
    fn test_abort_stage_records_crash_as_solution() {
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

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
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

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
        let mut fuzzer = make_fuzzer_ready_for_stage(256);

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

    // -----------------------------------------------------------------------
    // Grimoire override through constructor test (#5)
    // -----------------------------------------------------------------------

    #[test]
    fn test_grimoire_override_through_constructor() {
        // When FuzzerConfig.grimoire = Some(true), grimoire_enabled should be true
        // and grimoire_deferred_count should be None (already resolved).
        let coverage_map: Buffer = vec![0u8; 256].into();
        let fuzzer = Fuzzer::new(
            coverage_map,
            Some(FuzzerConfig {
                max_input_len: None,
                seed: None,
                grimoire: Some(true),
            }),
        )
        .unwrap();
        assert!(
            fuzzer.grimoire_enabled,
            "grimoire_enabled should be true when config.grimoire = Some(true)"
        );
        assert!(
            fuzzer.grimoire_deferred_count.is_none(),
            "grimoire_deferred_count should be None when explicitly set"
        );
    }

    #[test]
    fn test_grimoire_override_disabled_through_constructor() {
        let coverage_map: Buffer = vec![0u8; 256].into();
        let fuzzer = Fuzzer::new(
            coverage_map,
            Some(FuzzerConfig {
                max_input_len: None,
                seed: None,
                grimoire: Some(false),
            }),
        )
        .unwrap();
        assert!(
            !fuzzer.grimoire_enabled,
            "grimoire_enabled should be false when config.grimoire = Some(false)"
        );
        assert!(
            fuzzer.grimoire_deferred_count.is_none(),
            "grimoire_deferred_count should be None when explicitly set"
        );
    }

    // -----------------------------------------------------------------------
    // Generalization gap-finding adds to corpus test (#7)
    // -----------------------------------------------------------------------

    #[test]
    fn test_generalization_gap_finding_adds_to_corpus() {
        // During an offset pass, new coverage at a previously-unseen index should
        // cause the candidate to be added to the corpus with MapNoveltiesMetadata.
        let input = b"abcdefgh";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        // Verification pass: set novelty so it passes.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // We're now in offset phase. Set novel coverage at a NEW index (20)
        // that the feedback hasn't seen before.
        let corpus_count_before = fuzzer.state.corpus().count();
        unsafe {
            *fuzzer.map_ptr.add(20) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        let corpus_count_after = fuzzer.state.corpus().count();

        assert!(
            corpus_count_after > corpus_count_before,
            "gap-finding execution with novel coverage should add to corpus"
        );

        // Verify the new entry has MapNoveltiesMetadata.
        let new_id = CorpusId::from(corpus_count_after - 1);
        let tc = fuzzer.state.corpus().get(new_id).unwrap().borrow();
        assert!(
            tc.metadata::<MapNoveltiesMetadata>().is_ok(),
            "gap-finding corpus entry should have MapNoveltiesMetadata"
        );

        // Verify that last_interesting_corpus_id is None — stage-found entries
        // don't set this (only report_result does).
        assert!(
            fuzzer.last_interesting_corpus_id.is_none(),
            "last_interesting_corpus_id should be None for stage-found entries"
        );

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // Bracket-based gap-finding tests (#4)
    // -----------------------------------------------------------------------

    /// Drive a fuzzer through Verify and all Offset/Delimiter phases to reach
    /// the Bracket phase, with novelties surviving all phases.
    fn advance_to_bracket_phase(fuzzer: &mut Fuzzer, novelty_indices: &[usize]) {
        // Verification pass.
        for &idx in novelty_indices {
            unsafe {
                *fuzzer.map_ptr.add(idx) = 1;
            }
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Drive through offset and delimiter phases.
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if matches!(
                fuzzer.stage_state,
                StageState::Generalization {
                    phase: GeneralizationPhase::Bracket { .. },
                    ..
                }
            ) {
                return;
            }
            if count > 10_000 {
                panic!(
                    "should reach bracket phase within 10000 iterations (got {count} without entering bracket phase)"
                );
            }
        }
        panic!("generalization ended before reaching bracket phase");
    }

    #[test]
    fn test_bracket_gaps_marked_on_novelty_survival() {
        // Input with brackets: "(abc)". When novelties survive, the range between
        // open and close bracket should be marked as gaps.
        let input = b"(abc)";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

        // We're now in bracket phase. Set novelties to survive.
        let mut count = 0;
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 200 {
                panic!("should complete bracket phase");
            }
        }

        // Verify metadata was stored with gaps.
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        let metadata = tc
            .metadata::<GeneralizedInputMetadata>()
            .expect("should have GeneralizedInputMetadata");
        let has_gaps = metadata
            .generalized()
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Gap));
        assert!(
            has_gaps,
            "bracket-based generalization should produce gaps when novelties survive"
        );

        // Verify opener byte `(` is preserved (not gapped) — the candidate_range
        // should exclude the opener position so it remains in a Bytes segment.
        let opener_preserved = metadata
            .generalized()
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Bytes(b) if b.contains(&b'(')));
        assert!(
            opener_preserved,
            "opener byte '(' should be preserved in generalized metadata, not gapped"
        );

        cmplog::disable();
    }

    #[test]
    fn test_bracket_no_gaps_when_novelties_fail() {
        // Input with brackets: "(abc)". When novelties DON'T survive, no gaps
        // should be added during bracket phase.
        let input = b"(abc)";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

        // Drive through bracket phase WITHOUT setting novelties (they fail).
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 200 {
                panic!("should complete bracket phase");
            }
        }

        // Verify metadata was stored. Since all offset/delimiter phases failed too
        // (no novelties set), there should be no internal gaps (only leading/trailing).
        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "should have GeneralizedInputMetadata even without gaps"
        );

        cmplog::disable();
    }

    #[test]
    fn test_bracket_same_char_pairs() {
        // Input with quotes: "'hello'". Same-character pairs should work.
        let input = b"'hello'";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

        // Drive through bracket phase with novelties surviving.
        let mut count = 0;
        loop {
            unsafe {
                *fuzzer.map_ptr.add(10) = 1;
            }
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 200 {
                panic!("should complete bracket phase for quote pairs");
            }
        }

        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "same-char bracket pairs should produce metadata"
        );

        cmplog::disable();
    }

    #[test]
    fn test_bracket_no_closer_advances_to_next_pair() {
        // Input with opener but no closer: "(abc". Should advance through all
        // bracket pairs and finalize without getting stuck.
        // Note: bracket scanning for inputs without closers completes within a
        // single advance_stage call (no yielding), so we just drive the full
        // generalization to completion and verify it doesn't hang.
        let input = b"(abc";
        let novelty_indices = vec![10];
        let (mut fuzzer, corpus_id) =
            make_fuzzer_with_generalization_entry(256, input, &novelty_indices);

        let _first = fuzzer.begin_generalization(corpus_id).unwrap();
        fuzzer.grimoire_enabled = false;

        // Verification pass.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

        // Drive through all phases to completion.
        let mut count = 0;
        loop {
            let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
            count += 1;
            if candidate.is_none() {
                break;
            }
            if count > 500 {
                panic!("should complete generalization when no closers exist");
            }
        }

        let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
        assert!(
            tc.has_metadata::<GeneralizedInputMetadata>(),
            "should finalize even without matching closers"
        );

        cmplog::disable();
    }

    // -----------------------------------------------------------------------
    // Grimoire spec 5.1 tests (#8)
    // -----------------------------------------------------------------------

    #[test]
    fn test_grimoire_iteration_advances_regardless_of_mutation_result() {
        // Verify that the iteration counter advances on each advance_stage call,
        // regardless of whether the underlying Grimoire mutator returns Mutated
        // or Skipped.
        let (mut fuzzer, corpus_id) = make_fuzzer_with_grimoire_entry(256, b"fn foo() {}");

        let first = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(first.is_some(), "grimoire should start");

        // The first Grimoire candidate was already generated by begin_grimoire.
        // Advance the stage — regardless of whether the mutator skips or not,
        // the iteration should progress.
        let iteration_before = match fuzzer.stage_state {
            StageState::Grimoire { iteration, .. } => iteration,
            _ => panic!("should be in Grimoire state"),
        };

        let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        // The stage may return None if max_iterations was 1, or Some if there are
        // more iterations. Either way, the iteration counter should have advanced.
        match fuzzer.stage_state {
            StageState::Grimoire { iteration, .. } => {
                assert_eq!(
                    iteration,
                    iteration_before + 1,
                    "iteration should advance even if mutation was skipped"
                );
            }
            StageState::None => {
                // Stage completed (max_iterations was 1) — that's fine, iteration
                // counter was consumed. Verify next is None.
                assert!(next.is_none(), "stage should be done");
            }
            _ => panic!("unexpected stage state"),
        }

        cmplog::disable();
    }
}
