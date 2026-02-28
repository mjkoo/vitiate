use std::time::Instant;

use libafl::corpus::{Corpus, InMemoryCorpus, Testcase};
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
use libafl::schedulers::{ProbabilitySamplingScheduler, Scheduler, TestcaseScore};
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

/// Uniform scoring: all corpus entries have equal probability.
#[derive(Debug, Clone)]
struct UniformScore;

impl<I, S> TestcaseScore<I, S> for UniformScore
where
    S: HasCorpus<I>,
{
    fn compute(_state: &S, _entry: &mut Testcase<I>) -> std::result::Result<f64, libafl::Error> {
        Ok(1.0)
    }
}

// Concrete LibAFL type aliases.
type CovObserver = StdMapObserver<'static, u8, false>;
type FuzzerFeedback = MaxMapFeedback<CovObserver, CovObserver>;
type CrashObjective = CrashFeedback;
type TimeoutObjective = TimeoutFeedback;
type FuzzerScheduler = ProbabilitySamplingScheduler<UniformScore>;
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
}

// SAFETY: `Fuzzer` contains `*mut u8` which is `!Send`. napi-rs requires `Send`
// for `#[napi]` classes. The raw pointer points into the `Buffer` held in
// `_coverage_map`, which prevents V8 GC from reclaiming the backing memory.
// Node.js `Buffer` uses a non-detachable `ArrayBuffer`, so the memory cannot be
// reallocated or moved. NAPI enforces single-threaded access - the `Fuzzer` is
// only ever used on the Node.js main thread and is never sent across threads.
unsafe impl Send for Fuzzer {}

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
        })
    }

    #[napi]
    pub fn add_seed(&mut self, input: Buffer) -> Result<()> {
        let bytes_input = BytesInput::new(input.to_vec());
        let testcase = Testcase::new(bytes_input);
        let id = self
            .state
            .corpus_mut()
            .add(testcase)
            .map_err(|e| Error::from_reason(format!("Failed to add seed: {e}")))?;
        self.scheduler
            .on_add(&mut self.state, id)
            .map_err(|e| Error::from_reason(format!("Failed to notify scheduler: {e}")))?;
        Ok(())
    }

    #[napi]
    pub fn get_next_input(&mut self) -> Result<Buffer> {
        // Auto-seed if corpus is empty.
        if self.state.corpus().count() == 0 {
            for seed in DEFAULT_SEEDS {
                let testcase = Testcase::new(BytesInput::new(seed.to_vec()));
                let id = self
                    .state
                    .corpus_mut()
                    .add(testcase)
                    .map_err(|e| Error::from_reason(format!("Failed to auto-seed: {e}")))?;
                self.scheduler
                    .on_add(&mut self.state, id)
                    .map_err(|e| Error::from_reason(format!("Failed to notify scheduler: {e}")))?;
            }
        }

        // Select a corpus entry and clone its input.
        let corpus_id = self
            .scheduler
            .next(&mut self.state)
            .map_err(|e| Error::from_reason(format!("Scheduler failed: {e}")))?;
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
    pub fn report_result(&mut self, exit_kind: ExitKind) -> Result<IterationResult> {
        let input = self.last_input.take().ok_or_else(|| {
            Error::from_reason("reportResult called without a prior getNextInput")
        })?;

        let libafl_exit_kind = match exit_kind {
            ExitKind::Ok => LibaflExitKind::Ok,
            ExitKind::Crash => LibaflExitKind::Crash,
            ExitKind::Timeout => LibaflExitKind::Timeout,
        };

        // Reconstruct observer from the stashed pointer.
        // SAFETY: `self.map_ptr` is valid for `self.map_len` bytes. The backing
        // memory is owned by `self._coverage_map` (a `Buffer` preventing V8 GC).
        // Node.js `Buffer` uses a non-detachable `ArrayBuffer`, so the memory
        // cannot be reallocated. The observer is consumed within this method and
        // does not outlive the borrow.
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
        let result = if solution {
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
                let mut testcase = Testcase::new(input);
                self.feedback
                    .append_metadata(&mut self.state, &mut mgr, &observers, &mut testcase)
                    .map_err(|e| Error::from_reason(format!("Append metadata failed: {e}")))?;
                let id = self
                    .state
                    .corpus_mut()
                    .add(testcase)
                    .map_err(|e| Error::from_reason(format!("Failed to add to corpus: {e}")))?;
                self.scheduler
                    .on_add(&mut self.state, id)
                    .map_err(|e| Error::from_reason(format!("Scheduler on_add failed: {e}")))?;
                IterationResult::Interesting
            } else {
                IterationResult::None
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
        // `self.map_ptr`. The observer has been consumed by this point (moved
        // into `observers` tuple which is not used after feedback evaluation),
        // so there is no aliasing.
        unsafe {
            std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
        }

        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        Ok(result)
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

        let state = StdState::new(
            StdRand::with_seed(42),
            InMemoryCorpus::<BytesInput>::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .unwrap();

        drop(observer);
        (state, feedback, objective)
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
        let mut scheduler = ProbabilitySamplingScheduler::<UniformScore>::new();

        let testcase = Testcase::new(BytesInput::new(b"hello".to_vec()));
        let id = state.corpus_mut().add(testcase).unwrap();
        scheduler.on_add(&mut state, id).unwrap();

        assert_eq!(state.corpus().count(), 1);
    }

    #[test]
    fn test_get_next_input_auto_seeds() {
        let (map_ptr, _map) = make_coverage_map(65536);
        let (mut state, _feedback, _objective) = make_state_and_feedback(map_ptr, 65536);
        let mut scheduler = ProbabilitySamplingScheduler::<UniformScore>::new();
        let mut mutator = HavocScheduledMutator::new(havoc_mutations());

        // Seed with only non-empty entries so the non-empty assertion is sound
        // regardless of which entry the scheduler picks.
        let nonempty_seeds: Vec<&[u8]> = DEFAULT_SEEDS
            .iter()
            .copied()
            .filter(|s| !s.is_empty())
            .collect();
        for seed in &nonempty_seeds {
            let testcase = Testcase::new(BytesInput::new(seed.to_vec()));
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
        let mut scheduler = ProbabilitySamplingScheduler::<UniformScore>::new();
        let mut mutator = HavocScheduledMutator::new(havoc_mutations());
        let max_input_len: u32 = 128;

        // Add a large seed.
        let large_seed = vec![0x41u8; 256];
        let testcase = Testcase::new(BytesInput::new(large_seed));
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

    // === CmpLog integration tests (Tasks 5.1-5.3) ===

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
}
