use std::time::Duration;

use libafl::corpus::{Corpus, CorpusId, SchedulerTestcaseMetadata, Testcase};
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::map::MapFeedbackMetadata;
use libafl::feedbacks::{Feedback, MapIndexesMetadata, MapNoveltiesMetadata};
use libafl::inputs::BytesInput;
use libafl::observers::StdMapObserver;
use libafl::schedulers::Scheduler;
use libafl::schedulers::powersched::SchedulerMetadata;
use libafl::state::HasCorpus;
use libafl::{HasMetadata, HasNamedMetadata};
use libafl_bolts::tuples::tuple_list;
use napi::bindgen_prelude::*;

use super::cmplog_metadata::set_n_fuzz_entry_for_corpus_id;
use super::{EDGES_OBSERVER_NAME, Fuzzer};

/// Result of coverage evaluation for a single execution.
pub(super) struct CoverageEvalResult {
    /// Whether the input was added to the corpus (new coverage).
    pub(super) is_interesting: bool,
    /// Whether the input triggered a crash/timeout objective.
    pub(super) is_solution: bool,
    /// The corpus ID of the newly added entry, if `is_interesting` is true.
    pub(super) corpus_id: Option<CorpusId>,
}

impl Fuzzer {
    /// Compute which coverage map indices are newly maximized compared to the
    /// feedback's internal history. Called BEFORE `is_interesting()` so the
    /// history hasn't been updated yet. Returns indices where `map[i] > history[i]`.
    pub(super) fn compute_novel_indices(&self) -> Vec<usize> {
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
    pub(super) fn evaluate_coverage(
        &mut self,
        input: &[u8],
        exec_time_ns: f64,
        exit_kind: LibaflExitKind,
        parent_corpus_id: Option<CorpusId>,
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

        // Compute novel indices BEFORE constructing the observer. The observer
        // holds `&mut [u8]` to the coverage map, while compute_novel_indices()
        // creates a `&[u8]` to the same memory. Having both alive simultaneously
        // is UB under Rust's aliasing model. Must also precede is_interesting()
        // which updates the feedback's internal history.
        let novel_indices = self.compute_novel_indices();

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
                    // LibAFL convention: root testcases have depth 1, children have
                    // parent_depth + 1. Seeds (parent_corpus_id = None) are roots.
                    let depth = match parent_corpus_id {
                        Some(id) => match self.state.corpus().get(id) {
                            Ok(entry) => {
                                let parent_tc = entry.borrow();
                                match parent_tc.metadata::<SchedulerTestcaseMetadata>() {
                                    Ok(meta) => meta.depth() + 1,
                                    Err(_) => 1 + 1, // parent exists but has no metadata — default parent depth to 1
                                }
                            }
                            Err(_) => 1, // parent not found — treat as root
                        },
                        None => 1, // no parent (seed evaluation) — root depth
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
