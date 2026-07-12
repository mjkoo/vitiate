use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, Testcase};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::inputs::BytesInput;
use libafl::mutators::Mutator;
use libafl::observers::cmp::CmpValuesMetadata;
use libafl::stages::UnicodeIdentificationMetadata;
use libafl::state::{HasCorpus, HasExecutions, HasRand, HasSolutions};
use libafl_bolts::rands::Rand;
use napi::bindgen_prelude::*;

use super::colorization;
use super::generalization::GeneralizationPhase;
use super::{Fuzzer, STAGE_MAX_ITERATIONS};
use crate::types::ExitKind;

/// Number of initial interesting entries that always receive the full expensive
/// stage pipeline before sampling begins (C2 warmup: explore thoroughly early,
/// then bound stage amplification for the long tail of the campaign).
pub(super) const EXPENSIVE_STAGE_WARMUP: u64 = 64;
/// After warmup, expensive stages run when `rand_below(DENOM) < NUMER`, i.e. on
/// this fraction of interesting entries (here 1/2), mirroring AFL++ running
/// cmplog/REDQUEEN on a fraction of the queue rather than every entry.
const EXPENSIVE_STAGE_NUMER: usize = 1;
const EXPENSIVE_STAGE_DENOM: usize = 2;

/// Tracks the lifecycle of a multi-execution stage (I2S, Grimoire, etc.).
/// Designed for extensibility - future stages add new variants.
pub(crate) enum StageState {
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
        /// Ranges still to test, processed largest-first via max-heap.
        /// Elements are `(size, start, end)` so the largest range is popped first.
        pending_ranges: std::collections::BinaryHeap<(usize, usize, usize)>,
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
        /// Cached metadata identifying UTF-8 ranges, computed once at stage start.
        metadata: UnicodeIdentificationMetadata,
    },
    /// JSON mutational stage: structure-preserving JSON-aware mutations.
    Json {
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
    },
}

/// The mutational stages driven by the shared pipeline, in canonical execution
/// order. Used as the single source of truth for stage ordering by
/// [`Fuzzer::begin_stages_after`], replacing the previously duplicated per-stage
/// completion tails.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum StageKind {
    /// The I2S stage. It precedes the post-I2S chain; passing it as the `after`
    /// argument to `begin_stages_after` begins the whole chain from the top.
    I2S,
    Generalization,
    Grimoire,
    Unicode,
    Json,
}

impl StageKind {
    /// Position in the canonical stage order. `begin_stages_after` begins only
    /// the stages ranked strictly higher than a given kind.
    fn rank(self) -> u8 {
        match self {
            StageKind::I2S => 0,
            StageKind::Generalization => 1,
            StageKind::Grimoire => 2,
            StageKind::Unicode => 3,
            StageKind::Json => 4,
        }
    }

    /// Tag used in the "no stashed stage input" error raised by
    /// `advance_multi_iteration_stage`. Matches the pre-refactor per-stage
    /// messages so existing diagnostics are unchanged.
    fn advance_error_tag(self) -> &'static str {
        match self {
            StageKind::I2S => "advanceStage",
            StageKind::Generalization => "advanceGeneralization",
            StageKind::Grimoire => "advanceGrimoire",
            StageKind::Unicode => "advanceUnicode",
            StageKind::Json => "advanceJson",
        }
    }
}

impl Fuzzer {
    /// Decide whether the current interesting entry should run the expensive
    /// stages (colorization/REDQUEEN and the structure-aware post-I2S stages).
    ///
    /// Always true during the warmup window; afterward samples a fixed fraction
    /// using the seeded RNG, so the decision is deterministic under a fixed seed.
    /// This bounds the stage amplification the design review flagged in C2: the
    /// expensive stages no longer run on every interesting entry for the whole
    /// campaign.
    pub(super) fn should_run_expensive_stages(&mut self) -> bool {
        self.expensive_stage_entries = self.expensive_stage_entries.saturating_add(1);
        if self.expensive_stage_entries <= EXPENSIVE_STAGE_WARMUP {
            return true;
        }
        // SAFETY of unwrap: EXPENSIVE_STAGE_DENOM is a nonzero constant.
        let roll = self
            .state
            .rand_mut()
            .below(core::num::NonZero::new(EXPENSIVE_STAGE_DENOM).unwrap());
        roll < EXPENSIVE_STAGE_NUMER
    }

    /// Implementation of `begin_stage` - dispatches to the appropriate stage.
    pub(super) fn begin_stage_impl(&mut self) -> Result<Option<Buffer>> {
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

        // C2: gate the expensive stages. When gated out, this entry skips straight
        // to havoc (begin_stage returns None) except for the cheap, bounded I2S
        // stage, which stays available whenever CmpLog data exists.
        let run_expensive = self.should_run_expensive_stages();

        // Step 1: Attempt colorization if REDQUEEN is enabled and input fits (expensive).
        if run_expensive && self.features.redqueen_enabled {
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

        // Step 2: Attempt I2S (only if REDQUEEN didn't run). Bounded and cheap, so
        // it is not gated by the expensive-stage sampler.
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

        // Step 3: Fall through to the structure-aware stages (Grimoire/unicode/
        // json/generalization), also gated as expensive.
        if run_expensive {
            self.begin_stages_after(corpus_id, StageKind::I2S)
        } else {
            Ok(None)
        }
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

    /// Begin the first applicable mutational stage ranked after `after` in the
    /// canonical order (generalization → Grimoire → unicode → JSON), returning
    /// its first input, or `None` if none apply.
    ///
    /// This is the single source of truth for post-I2S stage ordering:
    /// `begin_stage_impl`, the colorization/REDQUEEN tail,
    /// `finalize_generalization`, and every multi-iteration stage's completion
    /// all route through it. Passing `StageKind::I2S` begins the whole chain
    /// from the top (the former `begin_post_i2s_stages`).
    pub(super) fn begin_stages_after(
        &mut self,
        corpus_id: CorpusId,
        after: StageKind,
    ) -> Result<Option<Buffer>> {
        let after_rank = after.rank();

        // Generalization and Grimoire are gated behind grimoire_enabled.
        if self.features.grimoire_enabled {
            if after_rank < StageKind::Generalization.rank()
                && let Some(buf) = self.begin_generalization(corpus_id)?
            {
                return Ok(Some(buf));
            }
            if after_rank < StageKind::Grimoire.rank()
                && let Some(buf) = self.begin_grimoire(corpus_id)?
            {
                return Ok(Some(buf));
            }
        }
        if after_rank < StageKind::Unicode.rank()
            && let Some(buf) = self.begin_unicode(corpus_id)?
        {
            return Ok(Some(buf));
        }
        if after_rank < StageKind::Json.rank()
            && let Some(buf) = self.begin_json(corpus_id)?
        {
            return Ok(Some(buf));
        }
        Ok(None)
    }

    /// Shared body of the four multi-iteration mutational stages (I2S, Grimoire,
    /// unicode, JSON). The caller destructures its own `StageState` variant
    /// (preserving each stage's mismatch handling and any extra fields, e.g.
    /// unicode's `metadata`) and passes the common fields plus a `next_step`
    /// closure that produces the next candidate bytes and the rebuilt
    /// `StageState` for the following iteration.
    ///
    /// On completion (`next_iteration >= max_iterations`), transitions to the
    /// next stage via [`Self::begin_stages_after`] keyed on `kind`.
    pub(super) fn advance_multi_iteration_stage(
        &mut self,
        kind: StageKind,
        corpus_id: CorpusId,
        iteration: usize,
        max_iterations: usize,
        exec_time_ns: f64,
        next_step: impl FnOnce(&mut Self, usize) -> Result<(Vec<u8>, StageState)>,
    ) -> Result<Option<Buffer>> {
        // Drain and discard CmpLog: these stages mutate already-interesting
        // inputs, so their comparison slots are noise (do not promote tokens or
        // update CmpValuesMetadata).
        let _ = crate::cmplog::drain();

        // Clear stage state before the fallible evaluate_coverage call so an
        // error cleanly abandons the stage (no zombie state). Idempotent for
        // callers that already cleared it via mem::replace.
        self.stage_state = StageState::None;

        let stage_input = self.last_stage_input.take().ok_or_else(|| {
            Error::from_reason(format!(
                "{}: no stashed stage input",
                kind.advance_error_tag()
            ))
        })?;

        // The target was invoked - count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        let _eval = self.evaluate_coverage(
            &stage_input,
            exec_time_ns,
            LibaflExitKind::Ok,
            Some(corpus_id),
        )?;

        let next_iteration = iteration + 1;
        if next_iteration >= max_iterations {
            // Stage complete - advance to the next stage in the pipeline.
            // stage_state is already StageState::None (reset above).
            return self.begin_stages_after(corpus_id, kind);
        }

        // Generate the next candidate and rebuild the stage state for it.
        let (bytes, next_state) = next_step(self, next_iteration)?;
        self.last_stage_input = Some(bytes.clone());
        self.stage_state = next_state;

        Ok(Some(Buffer::from(bytes)))
    }

    /// Implementation of `advance_stage` - processes stage result, returns next input.
    ///
    /// `exit_kind` is only used by the Redqueen stage (to decide whether to
    /// record a solution). All other stages evaluate coverage as `Ok` - stage
    /// crashes are handled via `abort_stage`, not `advance_stage`.
    pub(super) fn advance_stage_impl(
        &mut self,
        exit_kind: ExitKind,
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
            StageState::Json { .. } => {
                return self.advance_json(exec_time_ns);
            }
            StageState::I2S { .. } => {}
            StageState::Colorization { .. } => {
                return self.advance_colorization(exec_time_ns);
            }
            StageState::Redqueen { .. } => {
                return self.advance_redqueen(exit_kind, exec_time_ns);
            }
        }

        self.advance_i2s(exec_time_ns)
    }

    /// Advance the I2S stage: evaluate coverage, generate next candidate.
    fn advance_i2s(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        let (corpus_id, iteration, max_iterations) = match self.stage_state {
            StageState::I2S {
                corpus_id,
                iteration,
                max_iterations,
            } => (corpus_id, iteration, max_iterations),
            _ => {
                return Err(Error::from_reason(
                    "advance_i2s called with non-I2S stage state",
                ));
            }
        };

        self.advance_multi_iteration_stage(
            StageKind::I2S,
            corpus_id,
            iteration,
            max_iterations,
            exec_time_ns,
            |f, next_iteration| {
                // Generate next I2S candidate: clone original corpus entry, mutate.
                let mut input = f
                    .state
                    .corpus()
                    .cloned_input_for_id(corpus_id)
                    .map_err(|e| {
                        Error::from_reason(format!("Failed to clone corpus entry: {e}"))
                    })?;

                let _ = f
                    .i2s_mutator
                    .mutate(&mut f.state, &mut input)
                    .map_err(|e| Error::from_reason(format!("I2S mutation failed: {e}")))?;

                let mut bytes: Vec<u8> = input.into();
                bytes.truncate(f.max_input_len as usize);

                Ok((
                    bytes,
                    StageState::I2S {
                        corpus_id,
                        iteration: next_iteration,
                        max_iterations,
                    },
                ))
            },
        )
    }

    /// Implementation of `abort_stage` - cleanly terminates the current stage.
    pub(super) fn abort_stage_impl(&mut self, exit_kind: ExitKind) -> Result<()> {
        if matches!(self.stage_state, StageState::None) {
            return Ok(());
        }

        // Drain and discard CmpLog accumulator.
        let _ = crate::cmplog::drain();

        // Take the stage input into a local before cleanup - we may need it
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

        // Crash/Timeout aborts follow an execution that actually ran the
        // pending candidate; Ok aborts abandon the stage (e.g. fuzz-time
        // deadline) before the candidate executes, so nothing is counted.
        if !matches!(exit_kind, ExitKind::Ok) {
            self.total_execs += 1;
            *self.state.executions_mut() += 1;
        }

        // Record crash/timeout as a solution. This is the only fallible
        // operation - all cleanup is already done above.
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
}
