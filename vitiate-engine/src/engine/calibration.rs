use std::time::Duration;

use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, SchedulerTestcaseMetadata};
use libafl::schedulers::RemovableScheduler;
use libafl::schedulers::powersched::SchedulerMetadata;
use libafl::state::HasCorpus;
use napi::bindgen_prelude::*;

use super::Fuzzer;

/// Calibration run count: minimum total runs (including original iteration).
pub(super) const CALIBRATION_STAGE_START: usize = 4;
/// Calibration run count: maximum total runs (extended when unstable edges detected).
pub(super) const CALIBRATION_STAGE_MAX: usize = 8;

/// Tracks the calibration lifecycle for a single corpus entry.
/// Populated by `report_result()` when an input is interesting,
/// updated by `calibrate_run()`, consumed by `calibrate_finish()`.
pub(super) struct CalibrationState {
    /// Entry being calibrated.
    pub(super) corpus_id: Option<CorpusId>,
    /// First calibration run's coverage snapshot (baseline).
    pub(super) first_map: Option<Vec<u8>>,
    /// Unstable edge tracker (u8::MAX = unstable).
    pub(super) history_map: Option<Vec<u8>>,
    /// Accumulated execution time across calibration runs.
    pub(super) total_time: Duration,
    /// Number of calibration runs completed (including the original fuzz iteration).
    pub(super) iterations: usize,
    /// Whether unstable edges were detected during calibration.
    pub(super) has_unstable: bool,
}

impl CalibrationState {
    pub(super) fn new() -> Self {
        Self {
            corpus_id: None,
            first_map: None,
            history_map: None,
            total_time: Duration::ZERO,
            iterations: 0,
            has_unstable: false,
        }
    }

    /// Initialize for a new calibration cycle.
    pub(super) fn begin(&mut self, corpus_id: CorpusId, initial_exec_time: Duration) {
        self.reset();
        self.corpus_id = Some(corpus_id);
        self.total_time = initial_exec_time;
        self.iterations = 1;
    }

    /// Reset calibration state after calibration completes.
    pub(super) fn reset(&mut self) {
        *self = Self::new();
    }
}

impl Fuzzer {
    /// Perform one calibration iteration for the most recently added corpus entry.
    /// Returns `true` if more calibration runs are needed.
    pub(super) fn calibrate_run_impl(&mut self, exec_time_ns: f64) -> Result<bool> {
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
    ///
    /// Safe to call after incomplete calibration (e.g., target crashed during
    /// calibration runs). In that case: `first_map` may be `None` (falls back
    /// to the preliminary `bitmap_size` from `report_result`), and the coverage
    /// map is zeroed regardless to prevent stale data.
    pub(super) fn calibrate_finish_impl(&mut self) -> Result<()> {
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
}
