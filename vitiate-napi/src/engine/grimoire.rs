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
            // Grimoire complete — try unicode.
            // stage_state is already StageState::None (reset before evaluate_coverage above).
            if let Some(buf) = self.begin_unicode(corpus_id)? {
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

#[cfg(test)]
mod tests {
    use libafl::HasMetadata;
    use libafl::corpus::{Corpus, Testcase};
    use libafl::inputs::BytesInput;
    use libafl::observers::cmp::CmpValues;
    use libafl::state::HasCorpus;
    use napi::bindgen_prelude::*;

    use super::*;
    use crate::cmplog;
    use crate::engine::test_helpers::{TestFuzzerBuilder, make_cmplog_bytes};
    use crate::types::{ExitKind, FuzzerConfig};

    // -----------------------------------------------------------------------
    // Grimoire mutational stage tests
    #[test]
    fn test_grimoire_stage_begins_with_metadata() {
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");

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

        let mut fuzzer = TestFuzzerBuilder::new(256).grimoire(true).build();
        fuzzer.features.deferred_detection_count = None;

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
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");
        fuzzer.features.grimoire_enabled = false;

        let result = fuzzer.begin_grimoire(corpus_id).unwrap();
        assert!(
            result.is_none(),
            "begin_grimoire should return None when Grimoire disabled"
        );

        cmplog::disable();
    }

    #[test]
    fn test_grimoire_stage_completes_after_iterations() {
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");

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
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");

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
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");

        let _first = fuzzer.begin_grimoire(corpus_id).unwrap();

        // Push CmpLog entries simulating target execution.
        cmplog::push(
            CmpValues::Bytes((
                make_cmplog_bytes(b"grimoire_test"),
                make_cmplog_bytes(b"grimoire_data"),
            )),
            0,
            cmplog::CmpLogOperator::Equal,
        );

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
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");
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
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(input);

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
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");

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
    // Grimoire override through constructor test (#5)
    // -----------------------------------------------------------------------

    #[test]
    fn test_grimoire_override_through_constructor() {
        // When FuzzerConfig.grimoire = Some(true), grimoire_enabled should be true
        // and deferred_detection_count should be None (already resolved).
        let coverage_map: Buffer = vec![0u8; 256].into();
        let fuzzer = Fuzzer::new(
            coverage_map,
            Some(FuzzerConfig {
                max_input_len: None,
                seed: None,
                grimoire: Some(true),
                unicode: None,
                redqueen: None,
            }),
        )
        .unwrap();
        assert!(
            fuzzer.features.grimoire_enabled,
            "grimoire_enabled should be true when config.grimoire = Some(true)"
        );
        // unicode needs auto-detect, so deferred count is still Some.
        assert!(
            fuzzer.features.deferred_detection_count.is_some(),
            "deferred_detection_count should be Some when unicode needs auto-detect"
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
                unicode: None,
                redqueen: None,
            }),
        )
        .unwrap();
        assert!(
            !fuzzer.features.grimoire_enabled,
            "grimoire_enabled should be false when config.grimoire = Some(false)"
        );
        // unicode needs auto-detect, so deferred count is still Some.
        assert!(
            fuzzer.features.deferred_detection_count.is_some(),
            "deferred_detection_count should be Some when unicode needs auto-detect"
        );
    }

    // -----------------------------------------------------------------------
    // Grimoire spec 5.1 tests (#8)
    // -----------------------------------------------------------------------

    #[test]
    fn test_grimoire_iteration_advances_regardless_of_mutation_result() {
        // Verify that the iteration counter advances on each advance_stage call,
        // regardless of whether the underlying Grimoire mutator returns Mutated
        // or Skipped.
        let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
            .grimoire(true)
            .build_with_grimoire_entry(b"fn foo() {}");

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
