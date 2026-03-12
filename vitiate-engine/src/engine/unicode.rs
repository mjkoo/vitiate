use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::mutators::Mutator;
use libafl::stages::UnicodeIdentificationMetadata;
use libafl::state::{HasCorpus, HasExecutions, HasRand};
use libafl_bolts::rands::Rand;
use napi::bindgen_prelude::*;

use super::{Fuzzer, STAGE_MAX_ITERATIONS, StageState, UnicodeInput};

impl Fuzzer {
    /// Begin the unicode mutation stage for a corpus entry.
    /// Returns `None` if unicode is disabled, or if the entry has no valid UTF-8 regions.
    pub(super) fn begin_unicode(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if !self.features.unicode_enabled {
            return Ok(None);
        }

        // Compute or retrieve cached UnicodeIdentificationMetadata.
        let metadata = self.get_or_compute_unicode_metadata(corpus_id)?;

        // Skip if no valid UTF-8 regions.
        if metadata.ranges().is_empty() {
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
        let bytes = self.unicode_mutate_one(corpus_id, &metadata)?;

        self.last_stage_input = Some(bytes.clone());
        self.stage_state = StageState::Unicode {
            corpus_id,
            iteration: 0,
            max_iterations,
            metadata,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Advance the unicode stage after a target execution.
    pub(super) fn advance_unicode(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        let (corpus_id, iteration, max_iterations, metadata) =
            match std::mem::replace(&mut self.stage_state, StageState::None) {
                StageState::Unicode {
                    corpus_id,
                    iteration,
                    max_iterations,
                    metadata,
                } => (corpus_id, iteration, max_iterations, metadata),
                _ => return Ok(None),
            };

        // Drain CmpLog (discard - unicode doesn't use CmpLog data).
        let _ = crate::cmplog::drain();

        // stage_state is already StageState::None (set by mem::replace above).
        // On error, the stage is cleanly abandoned (no zombie state). On success,
        // stage_state is overwritten below with the next iteration.
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advanceUnicode: no stashed stage input"))?;

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
            // Unicode stage complete - pipeline done.
            return Ok(None);
        }

        // Generate next unicode candidate.
        let bytes = self.unicode_mutate_one(corpus_id, &metadata)?;
        self.last_stage_input = Some(bytes.clone());

        self.stage_state = StageState::Unicode {
            corpus_id,
            iteration: next_iteration,
            max_iterations,
            metadata,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Clone a corpus entry, apply unicode mutations, and return the result bytes.
    /// Each call starts from a fresh clone (non-cumulative mutations).
    pub(super) fn unicode_mutate_one(
        &mut self,
        corpus_id: CorpusId,
        metadata: &UnicodeIdentificationMetadata,
    ) -> Result<Vec<u8>> {
        // Clone the corpus entry.
        let input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        // Create UnicodeInput tuple and apply mutation.
        let mut unicode_input: UnicodeInput = (input, metadata.clone());
        let _ = self
            .unicode_mutator
            .mutate(&mut self.state, &mut unicode_input)
            .map_err(|e| Error::from_reason(format!("Unicode mutation failed: {e}")))?;

        // Convert to bytes and truncate.
        let mut bytes: Vec<u8> = unicode_input.0.into();
        bytes.truncate(self.max_input_len as usize);

        Ok(bytes)
    }

    /// Get or compute `UnicodeIdentificationMetadata` for a corpus entry.
    /// Returns cached metadata if available, otherwise computes fresh metadata.
    pub(super) fn get_or_compute_unicode_metadata(
        &self,
        corpus_id: CorpusId,
    ) -> Result<UnicodeIdentificationMetadata> {
        let tc = self
            .state
            .corpus()
            .get(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?;
        let tc_ref = tc.borrow();
        if let Ok(meta) = tc_ref.metadata::<UnicodeIdentificationMetadata>() {
            return Ok(meta.clone());
        }
        let Some(input) = tc_ref.input() else {
            return Err(Error::from_reason("No input on corpus entry"));
        };
        let bytes: &[u8] = input.as_ref();
        Ok(UnicodeIdentificationMetadata::new(bytes))
    }
}
