use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::inputs::GeneralizedInputMetadata;
use libafl::mutators::Mutator;
use libafl::state::{HasCorpus, HasExecutions, HasRand};
use libafl_bolts::rands::Rand;
use napi::bindgen_prelude::*;

use super::{Fuzzer, STAGE_MAX_ITERATIONS, StageState};

impl Fuzzer {
    /// Begin the Grimoire mutational stage for a corpus entry that has
    /// `GeneralizedInputMetadata`. Returns the first mutated input, or `None`
    /// if the entry has no metadata.
    pub(super) fn begin_grimoire(&mut self, corpus_id: CorpusId) -> Result<Option<Buffer>> {
        if !self.features.grimoire_enabled {
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
    pub(super) fn advance_grimoire(&mut self, exec_time_ns: f64) -> Result<Option<Buffer>> {
        let (corpus_id, iteration, max_iterations) = match self.stage_state {
            StageState::Grimoire {
                corpus_id,
                iteration,
                max_iterations,
            } => (corpus_id, iteration, max_iterations),
            _ => return Ok(None),
        };

        // Drain CmpLog (discard - Grimoire doesn't use CmpLog data).
        let _ = crate::cmplog::drain();

        // Reset stage state before the fallible evaluate_coverage call. On error,
        // the stage is cleanly abandoned (no zombie state). On success, stage_state
        // is overwritten below with the next iteration or StageState::None.
        self.stage_state = StageState::None;
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advanceGrimoire: no stashed stage input"))?;

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
            // Grimoire complete - try unicode, then JSON.
            // stage_state is already StageState::None (reset before evaluate_coverage above).
            if let Some(buf) = self.begin_unicode(corpus_id)? {
                return Ok(Some(buf));
            }
            if let Some(buf) = self.begin_json(corpus_id)? {
                return Ok(Some(buf));
            }
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
    pub(super) fn grimoire_mutate_one(&mut self, corpus_id: CorpusId) -> Result<Vec<u8>> {
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
