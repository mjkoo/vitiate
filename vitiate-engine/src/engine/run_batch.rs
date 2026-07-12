//! The `run_batch` hot loop, extracted from `engine/mod.rs`.
//!
//! This is the raw-napi batch executor: it generates inputs, invokes the JS
//! target callback directly via `napi_call_function`, and evaluates coverage
//! entirely on the Rust side to avoid per-iteration napi round-trips. The
//! public `#[napi] fn run_batch` wrapper stays in `mod.rs`; this module holds
//! the implementation (`run_batch_impl`), mirroring the `*_impl` split used by
//! the stage and calibration submodules.

use std::time::{Duration, Instant};

use libafl::corpus::{Corpus, Testcase};
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::inputs::BytesInput;
use libafl::state::{HasExecutions, HasSolutions};
use napi::bindgen_prelude::*;

use super::Fuzzer;
use crate::types::{
    BATCH_EXIT_COMPLETED, BATCH_EXIT_ERROR, BATCH_EXIT_INTERESTING, BATCH_EXIT_SOLUTION,
    BatchResult,
};
use crate::watchdog::{arm_watchdog_shared, disarm_watchdog_shared};

impl Fuzzer {
    /// Implementation of `run_batch` - runs `batch_size` target executions in a
    /// tight Rust-side loop, returning early on the first interesting input,
    /// solution, or infrastructure error.
    ///
    /// Holding `&mut self` across the JS callback (`napi_call_function`) is
    /// sound only because of the no-reentrancy invariant documented on the
    /// `unsafe impl Send for Fuzzer` block in `mod.rs`: the callback confines
    /// itself to the target + detectors and never re-enters any `Fuzzer`.
    pub(super) fn run_batch_impl(
        &mut self,
        env: Env,
        callback: Unknown<'_>,
        batch_size: u32,
        timeout_ms: f64,
    ) -> Result<BatchResult> {
        if batch_size == 0 {
            return Ok(BatchResult {
                executions_completed: 0,
                exit_reason: BATCH_EXIT_COMPLETED.to_owned(),
                triggering_input: None,
                solution_exit_kind: None,
            });
        }

        let raw_env = env.raw();
        // SAFETY: raw_env is valid for the duration of this NAPI call.
        let callback_value = unsafe { Unknown::to_napi_value(raw_env, callback)? };

        let mut global: napi::sys::napi_value = std::ptr::null_mut();
        let status = unsafe { napi::sys::napi_get_global(raw_env, &mut global) };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_get_global failed in run_batch",
            ));
        }

        // Create a JS Buffer backed by the pre-allocated input buffer's memory.
        //
        // Created once per run_batch call, not per iteration. The napi_value
        // handle is scoped to the current HandleScope and becomes invalid after
        // this NAPI call returns - this is fine because run_batch is synchronous
        // and the handle is only used within this function.
        //
        // No finalizer is attached (None): the memory is externally owned by
        // self.input_buffer, so the GC must not free it. Multiple JS Buffers
        // over the same pointer are safe because we never create overlapping
        // live handles (one per run_batch invocation). The per-call creation
        // cost is negligible relative to the callback overhead.
        //
        // SAFETY: self.input_buffer_ptr is valid for self.max_input_len bytes,
        // backed by self.input_buffer which is alive for the duration of this call.
        let mut input_buffer_napi: napi::sys::napi_value = std::ptr::null_mut();
        let buf_status = unsafe {
            napi::sys::napi_create_external_buffer(
                raw_env,
                self.max_input_len as usize,
                self.input_buffer_ptr as *mut std::ffi::c_void,
                None,
                std::ptr::null_mut(),
                &mut input_buffer_napi,
            )
        };
        if buf_status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_create_external_buffer failed in run_batch",
            ));
        }

        let has_watchdog = self.watchdog_shared.is_some();
        let has_shmem = self.shmem_view.is_some();

        for iteration in 0..batch_size {
            // Invariant: any path below that returns or continues without calling
            // process_cmplog_and_tokens() must drain-and-discard CmpLog first, or
            // the next iteration mixes this iteration's stale comparison slots into
            // its own (the failed callback's slots remain, and the next callback's
            // JS writes append after them).
            //
            // Generate next input (seed or mutation).
            let generated = match self.generate_input() {
                Ok(g) => g,
                Err(_) => {
                    // Infrastructure error (e.g., empty corpus with no seeds).
                    // Zero coverage map and discard CmpLog, then return error.
                    unsafe {
                        std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
                    }
                    let _ = crate::cmplog::drain();
                    return Ok(BatchResult {
                        executions_completed: iteration,
                        exit_reason: BATCH_EXIT_ERROR.to_owned(),
                        triggering_input: None,
                        solution_exit_kind: None,
                    });
                }
            };

            let input_len = generated.bytes.len();
            let parent_corpus_id = generated.parent_corpus_id;

            // Write mutated bytes into the pre-allocated buffer.
            // SAFETY: input_len <= max_input_len (generate_input truncates).
            // input_buffer_ptr points into self.input_buffer which is alive.
            if input_len > 0 {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        generated.bytes.as_ptr(),
                        self.input_buffer_ptr,
                        input_len,
                    );
                }
            }

            // Stash input to shmem before callback (if handle present).
            if has_shmem {
                // SAFETY: shmem_view is Some when has_shmem is true.
                self.shmem_view
                    .as_ref()
                    .unwrap()
                    .stash_input(&generated.bytes);
            }

            // Arm watchdog before callback (if present).
            if has_watchdog {
                arm_watchdog_shared(self.watchdog_shared.as_ref().unwrap(), timeout_ms);
            }

            // Measure execution time around callback.
            let start = Instant::now();

            // Call JS callback: callback(inputBuffer, inputLength)
            // SAFETY: raw_env, callback_value, global, input_buffer_napi are valid.
            let mut input_len_value: napi::sys::napi_value = std::ptr::null_mut();
            let len_status = unsafe {
                napi::sys::napi_create_double(raw_env, input_len as f64, &mut input_len_value)
            };
            if len_status != napi::sys::Status::napi_ok {
                if has_watchdog {
                    let shared = self.watchdog_shared.as_ref().unwrap();
                    if shared.fired.load(std::sync::atomic::Ordering::Acquire) {
                        crate::v8_shim::v8_cancel_terminate();
                    }
                    disarm_watchdog_shared(shared);
                }
                let _ = crate::cmplog::drain();
                return Err(Error::new(
                    Status::GenericFailure,
                    "napi_create_double failed in run_batch",
                ));
            }

            let args = [input_buffer_napi, input_len_value];
            let mut return_value: napi::sys::napi_value = std::ptr::null_mut();
            let call_status = unsafe {
                napi::sys::napi_call_function(
                    raw_env,
                    global,
                    callback_value,
                    2,
                    args.as_ptr(),
                    &mut return_value,
                )
            };

            let elapsed = start.elapsed();
            let exec_time_ns = elapsed.as_nanos() as f64;

            // Read `fired` BEFORE disarming: disarm_watchdog_shared resets
            // `fired` to false via swap(false, AcqRel), so any read after
            // disarm would always see false, preventing timeout detection.
            let timed_out = has_watchdog
                && self
                    .watchdog_shared
                    .as_ref()
                    .unwrap()
                    .fired
                    .load(std::sync::atomic::Ordering::Acquire);
            if timed_out {
                crate::v8_shim::v8_cancel_terminate();
            }

            // Disarm watchdog after callback returns (if present).
            if has_watchdog {
                disarm_watchdog_shared(self.watchdog_shared.as_ref().unwrap());
            }

            // Determine ExitKind from callback result.
            let exit_kind = if call_status == napi::sys::Status::napi_ok {
                // Read the return value as a number.
                let mut result_f64: f64 = 0.0;
                let get_status = unsafe {
                    napi::sys::napi_get_value_double(raw_env, return_value, &mut result_f64)
                };
                if get_status == napi::sys::Status::napi_ok {
                    match result_f64 as u32 {
                        1 => LibaflExitKind::Crash,
                        _ => LibaflExitKind::Ok, // 0 or any invalid value treated as Ok
                    }
                } else {
                    LibaflExitKind::Ok // non-numeric return treated as Ok
                }
            } else if call_status == napi::sys::Status::napi_pending_exception {
                // Callback threw or V8 terminated execution.
                // Clear the pending exception.
                let mut exception: napi::sys::napi_value = std::ptr::null_mut();
                let _ = unsafe {
                    napi::sys::napi_get_and_clear_last_exception(raw_env, &mut exception)
                };

                if timed_out {
                    LibaflExitKind::Timeout
                } else {
                    // Infrastructure-level error (not a normal callback return).
                    // The callback ran and may have written CmpLog slots before
                    // failing. Zero coverage map and discard CmpLog (otherwise the
                    // next iteration drains these stale slots), then return error.
                    unsafe {
                        std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
                    }
                    let _ = crate::cmplog::drain();
                    return Ok(BatchResult {
                        executions_completed: iteration + 1,
                        exit_reason: BATCH_EXIT_ERROR.to_owned(),
                        triggering_input: Some(Buffer::from(generated.bytes)),
                        solution_exit_kind: None,
                    });
                }
            } else {
                // NAPI failure (not an exception). Unrecoverable. The callback ran
                // and may have written CmpLog slots; discard them alongside the map.
                unsafe {
                    std::ptr::write_bytes(self.map_ptr, 0, self.map_len);
                }
                let _ = crate::cmplog::drain();
                return Ok(BatchResult {
                    executions_completed: iteration + 1,
                    exit_reason: BATCH_EXIT_ERROR.to_owned(),
                    triggering_input: Some(Buffer::from(generated.bytes)),
                    solution_exit_kind: None,
                });
            };

            // Evaluate coverage. The callback already ran and may have written
            // CmpLog slots, so on error drain-and-discard before propagating
            // (honors the per-iteration invariant above).
            let eval = match self.evaluate_coverage(
                &generated.bytes,
                exec_time_ns,
                exit_kind,
                parent_corpus_id,
            ) {
                Ok(eval) => eval,
                Err(e) => {
                    let _ = crate::cmplog::drain();
                    return Err(e);
                }
            };

            // Process CmpLog entries.
            self.process_cmplog_and_tokens();

            // Increment execution counters.
            self.total_execs += 1;
            *self.state.executions_mut() += 1;

            // Handle results.
            if eval.is_solution {
                // Add to solutions corpus.
                let testcase = Testcase::new(BytesInput::new(generated.bytes.clone()));
                self.state
                    .solutions_mut()
                    .add(testcase)
                    .map_err(|e| Error::from_reason(format!("Failed to add solution: {e}")))?;
                self.solution_count += 1;

                let solution_exit_kind = match exit_kind {
                    LibaflExitKind::Crash => 1u32,
                    LibaflExitKind::Timeout => 2u32,
                    _ => 1u32, // shouldn't happen, but default to crash
                };

                return Ok(BatchResult {
                    executions_completed: iteration + 1,
                    exit_reason: BATCH_EXIT_SOLUTION.to_owned(),
                    triggering_input: Some(Buffer::from(generated.bytes)),
                    solution_exit_kind: Some(solution_exit_kind),
                });
            }

            if eval.is_interesting {
                // Panic justification: evaluate_coverage guarantees corpus_id is Some
                // when is_interesting is true.
                let corpus_id = eval.corpus_id.unwrap();
                let exec_time = Duration::from_nanos(exec_time_ns as u64);

                // Prepare calibration state for upcoming calibrate_run() calls.
                self.calibration.begin(corpus_id, exec_time);

                // Store for beginStage() - consumed after calibration completes.
                self.last_interesting_corpus_id = Some(corpus_id);

                // Record for feature auto-detection.
                self.features.record_interesting(&self.state);

                return Ok(BatchResult {
                    executions_completed: iteration + 1,
                    exit_reason: BATCH_EXIT_INTERESTING.to_owned(),
                    triggering_input: Some(Buffer::from(generated.bytes)),
                    solution_exit_kind: None,
                });
            }
        }

        // Full batch completed without interesting inputs or solutions.
        Ok(BatchResult {
            executions_completed: batch_size,
            exit_reason: BATCH_EXIT_COMPLETED.to_owned(),
            triggering_input: None,
            solution_exit_kind: None,
        })
    }
}
