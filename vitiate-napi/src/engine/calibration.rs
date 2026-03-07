use std::time::Duration;

use libafl::corpus::CorpusId;

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
        self.corpus_id = Some(corpus_id);
        self.total_time = initial_exec_time;
        self.iterations = 1;
        self.has_unstable = false;
        self.first_map = None;
        self.history_map = None;
    }

    /// Reset calibration state after calibration completes.
    pub(super) fn reset(&mut self) {
        self.corpus_id = None;
        self.first_map = None;
        self.history_map = None;
        self.total_time = Duration::ZERO;
        self.iterations = 0;
        self.has_unstable = false;
    }
}
