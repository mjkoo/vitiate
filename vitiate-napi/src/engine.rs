use std::collections::HashSet;
use std::time::{Duration, Instant};

use libafl::corpus::{Corpus, CorpusId, InMemoryCorpus, SchedulerTestcaseMetadata, Testcase};
use libafl::events::NopEventManager;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::feedbacks::map::MapFeedbackMetadata;
use libafl::feedbacks::{
    CrashFeedback, Feedback, MaxMapFeedback, StateInitializer, TimeoutFeedback,
};
use libafl::inputs::BytesInput;
use libafl::mutators::token_mutations::I2SRandReplace;
use libafl::mutators::{HavocMutationsType, HavocScheduledMutator, Mutator, havoc_mutations};
use libafl::observers::StdMapObserver;
use libafl::observers::cmp::CmpValuesMetadata;
use libafl::schedulers::powersched::{N_FUZZ_SIZE, PowerSchedule, SchedulerMetadata};
use libafl::schedulers::testcase_score::CorpusPowerTestcaseScore;
use libafl::schedulers::{ProbabilitySamplingScheduler, RemovableScheduler, Scheduler};
use libafl::state::{HasCorpus, HasExecutions, HasMaxSize, HasSolutions, StdState};
use libafl::{HasMetadata, HasNamedMetadata};
use libafl_bolts::rands::StdRand;
use libafl_bolts::tuples::tuple_list;
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

// Concrete LibAFL type aliases.
type CovObserver = StdMapObserver<'static, u8, false>;
type FuzzerFeedback = MaxMapFeedback<CovObserver, CovObserver>;
type CrashObjective = CrashFeedback;
type TimeoutObjective = TimeoutFeedback;
type FuzzerScheduler = ProbabilitySamplingScheduler<CorpusPowerTestcaseScore>;
type FuzzerMutator = HavocScheduledMutator<HavocMutationsType>;
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
    i2s_mutator: I2SRandReplace,
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

#[napi]
impl Fuzzer {
    #[napi(constructor)]
    pub fn new(mut coverage_map: Buffer, config: Option<FuzzerConfig>) -> Result<Self> {
        let max_input_len = config
            .as_ref()
            .and_then(|c| c.max_input_len)
            .unwrap_or(DEFAULT_MAX_INPUT_LEN);
        let seed = config.as_ref().and_then(|c| c.seed);

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
        let mutator = HavocScheduledMutator::new(havoc_mutations());
        let i2s_mutator = I2SRandReplace::new();

        // Drop the temporary observer - feedback only holds a name-based Handle.
        drop(temp_observer);

        // Set max input size on state for I2SRandReplace bounds.
        state.set_max_size(max_input_len as usize);

        // Initialize CmpLog: enable recording and add empty CmpValuesMetadata.
        crate::cmplog::enable();
        state.metadata_map_mut().insert(CmpValuesMetadata::new());

        // Initialize power scheduling metadata with FAST strategy.
        state.add_metadata(SchedulerMetadata::new(Some(PowerSchedule::fast())));

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

            // Evaluate crash/timeout objective first (AFL convention).
            // If the input is a solution, skip feedback to avoid biasing the
            // corpus toward crash-inducing inputs.
            let solution = match libafl_exit_kind {
                LibaflExitKind::Crash => self
                    .crash_objective
                    .is_interesting(
                        &mut self.state,
                        &mut mgr,
                        &input,
                        &observers,
                        &libafl_exit_kind,
                    )
                    .map_err(|e| Error::from_reason(format!("Crash evaluation failed: {e}")))?,
                LibaflExitKind::Timeout => self
                    .timeout_objective
                    .is_interesting(
                        &mut self.state,
                        &mut mgr,
                        &input,
                        &observers,
                        &libafl_exit_kind,
                    )
                    .map_err(|e| Error::from_reason(format!("Timeout evaluation failed: {e}")))?,
                _ => false,
            };

            // Evaluate objective first, then feedback only if not a solution.
            // This mirrors LibAFL's StdFuzzer::check_results() control flow:
            // solutions and corpus entries are mutually exclusive.
            if solution {
                let testcase = Testcase::new(input);
                self.state
                    .solutions_mut()
                    .add(testcase)
                    .map_err(|e| Error::from_reason(format!("Failed to add solution: {e}")))?;
                self.solution_count += 1;
                IterationResult::Solution
            } else {
                let is_interesting = self
                    .feedback
                    .is_interesting(
                        &mut self.state,
                        &mut mgr,
                        &input,
                        &observers,
                        &libafl_exit_kind,
                    )
                    .map_err(|e| Error::from_reason(format!("Feedback evaluation failed: {e}")))?;

                if is_interesting {
                    let exec_time = Duration::from_nanos(exec_time_ns as u64);

                    let mut testcase = Testcase::new(input);
                    self.feedback
                        .append_metadata(&mut self.state, &mut mgr, &observers, &mut testcase)
                        .map_err(|e| Error::from_reason(format!("Append metadata failed: {e}")))?;

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

                    // Set preliminary execution time (overwritten by calibration).
                    testcase.set_exec_time(exec_time);

                    // Compute depth from parent corpus entry.
                    let depth = match self.last_corpus_id {
                        Some(parent_id) => match self.state.corpus().get(parent_id) {
                            Ok(entry) => {
                                let parent_tc = entry.borrow();
                                match parent_tc.metadata::<SchedulerTestcaseMetadata>() {
                                    Ok(meta) => meta.depth() + 1,
                                    Err(_) => 0,
                                }
                            }
                            Err(_) => 0,
                        },
                        None => 0,
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

                    // Prepare calibration state for upcoming calibrate_run() calls.
                    self.calibration_corpus_id = Some(id);
                    self.calibration_total_time = exec_time; // include the original execution
                    self.calibration_iterations = 1;
                    self.calibration_has_unstable = false;
                    self.calibration_first_map = None;
                    self.calibration_history_map = None;

                    IterationResult::Interesting
                } else {
                    IterationResult::None
                }
            }
        };

        // Drain CmpLog accumulator into state metadata for the next I2S pass.
        let cmp_entries = crate::cmplog::drain();
        self.state
            .metadata_map_mut()
            .insert(CmpValuesMetadata { list: cmp_entries });

        // Zero the coverage map in place for the next iteration.
        // SAFETY: Same pointer validity invariants as the observer construction
        // above. `write_bytes` zeroes `self.map_len` bytes starting at
        // `self.map_ptr`. The observer is guaranteed dropped — either explicitly
        // in the is_interesting branch (before bitmap_size read) or implicitly
        // at the scope-block exit (for solution/not-interesting paths).
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

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

impl Drop for Fuzzer {
    fn drop(&mut self) {
        crate::cmplog::disable();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut mutator = HavocScheduledMutator::new(havoc_mutations());

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
        use libafl::observers::MapObserver;
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
        let mut mutator = HavocScheduledMutator::new(havoc_mutations());
        let max_input_len: u32 = 128;

        // Add a large seed with scheduler metadata.
        let large_seed = vec![0x41u8; 256];
        let testcase = make_seed_testcase(&large_seed);
        let id = state.corpus_mut().add(testcase).unwrap();
        scheduler.on_add(&mut state, id).unwrap();

        // Generate multiple inputs and verify they respect max_input_len.
        for _ in 0..100 {
            let corpus_id = scheduler.next(&mut state).unwrap();
            let mut input = state.corpus().cloned_input_for_id(corpus_id).unwrap();
            let _ = mutator.mutate(&mut state, &mut input).unwrap();
            let mut bytes: Vec<u8> = input.into();
            bytes.truncate(max_input_len as usize);
            assert!(bytes.len() <= max_input_len as usize);
        }
    }

    // === CmpLog integration tests ===

    #[test]
    fn test_cmplog_enable_disable_on_fuzzer_lifecycle() {
        use crate::cmplog;
        use libafl::observers::cmp::CmpValues;

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
        use crate::cmplog;
        use libafl::observers::cmp::{CmpValues, CmpValuesMetadata};

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
        use libafl::schedulers::TestcaseScore;

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
        let mutator = HavocScheduledMutator::new(havoc_mutations());
        let i2s_mutator = I2SRandReplace::new();

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
}
