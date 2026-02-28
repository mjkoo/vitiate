//! Pre-allocated input stash for cross-thread input capture.
//!
//! The main thread writes the current fuzz input before each iteration.
//! The watchdog thread reads it during the `_exit` path to write the
//! timeout artifact to disk.
//!
//! # Two-layer synchronization design
//!
//! The stash uses two complementary synchronization mechanisms:
//!
//! - **Generation counter** (atomic u64): Enables lock-free torn-read detection
//!   on the reader side. The writer increments the counter to an odd value before
//!   writing and to an even value after. The reader snapshots the counter before
//!   and after its read — if the values differ or the counter is odd, the read
//!   was concurrent with a write and is discarded. This avoids blocking the
//!   watchdog thread on a mutex that the main thread might hold when `_exit`
//!   needs to fire.
//!
//! - **Mutex** (on the buffer `Vec<u8>`): Protects the actual byte copy so that
//!   the reader never observes a partially-written buffer. The mutex is held only
//!   for the `copy_from_slice` / `to_vec` duration, keeping the critical section
//!   short.
//!
//! Neither layer alone is sufficient: the generation counter cannot protect the
//! buffer bytes (non-atomic), and the mutex alone would risk deadlock if the
//! watchdog thread needed to `_exit` while the main thread held the lock.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// Thread-safe input stash with generation-based consistency checking.
///
/// The main thread calls [`stash`] before each fuzz iteration. The watchdog
/// thread calls [`read`] when it needs to capture the input before `_exit`.
///
/// Consistency is ensured by an atomic generation counter that the main thread
/// increments before and after writing. The reader checks that the generation
/// is even (no write in progress) and unchanged across its read.
pub struct InputStash {
    /// Generation counter. Odd = write in progress, even = consistent.
    generation: AtomicU64,
    /// Length of the currently stashed input.
    len: AtomicUsize,
    /// The input buffer, protected by a mutex for the actual byte copy.
    buf: Mutex<Vec<u8>>,
}

impl InputStash {
    /// Create a new stash with a pre-allocated buffer of `max_len` bytes.
    pub fn new(max_len: usize) -> Self {
        Self {
            generation: AtomicU64::new(0),
            len: AtomicUsize::new(0),
            buf: Mutex::new(vec![0u8; max_len]),
        }
    }

    /// Stash the current input bytes. Called from the main thread before
    /// each fuzz iteration. Truncates to the pre-allocated buffer size.
    pub fn stash(&self, bytes: &[u8]) {
        // Increment generation to odd (write in progress)
        self.generation.fetch_add(1, Ordering::Release);

        {
            // unwrap_or_else: if the mutex is poisoned, recover the inner guard
            // since we're fully overwriting the data anyway.
            let mut buf = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            let copy_len = bytes.len().min(buf.len());
            buf[..copy_len].copy_from_slice(&bytes[..copy_len]);
            self.len.store(copy_len, Ordering::Release);
        }

        // Increment generation to even (write complete)
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// Read the stashed input. Called from the watchdog thread.
    /// Returns `None` if a write is in progress (generation is odd) or
    /// the generation changed during the read (torn read).
    pub fn read(&self) -> Option<Vec<u8>> {
        let gen_before = self.generation.load(Ordering::Acquire);
        // If generation is odd, a write is in progress
        if !gen_before.is_multiple_of(2) {
            return None;
        }

        let len = self.len.load(Ordering::Acquire);
        let data = {
            // ok()?: on poison, return None so the _exit path still fires
            // (just without input capture).
            let buf = self.buf.lock().ok()?;
            buf[..len].to_vec()
        };

        let gen_after = self.generation.load(Ordering::Acquire);
        if gen_before != gen_after {
            return None;
        }

        Some(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_and_read_roundtrip() {
        let stash = InputStash::new(1024);
        let input = b"hello fuzzer";
        stash.stash(input);
        let read = stash.read().expect("should read successfully");
        assert_eq!(read, input);
    }

    #[test]
    fn stash_truncates_to_max_len() {
        let stash = InputStash::new(4);
        stash.stash(b"abcdefgh");
        let read = stash.read().expect("should read successfully");
        assert_eq!(read, b"abcd");
    }

    #[test]
    fn stash_overwrites_previous() {
        let stash = InputStash::new(1024);
        stash.stash(b"first");
        stash.stash(b"second");
        let read = stash.read().expect("should read successfully");
        assert_eq!(read, b"second");
    }

    #[test]
    fn empty_stash_reads_empty() {
        let stash = InputStash::new(1024);
        let read = stash.read().expect("should read successfully");
        assert!(read.is_empty());
    }

    #[test]
    fn generation_counter_increments() {
        let stash = InputStash::new(1024);
        assert_eq!(stash.generation.load(Ordering::Relaxed), 0);
        stash.stash(b"a");
        assert_eq!(stash.generation.load(Ordering::Relaxed), 2);
        stash.stash(b"b");
        assert_eq!(stash.generation.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn read_returns_none_on_poisoned_mutex() {
        use std::sync::Arc;
        use std::thread;

        let stash = Arc::new(InputStash::new(1024));
        stash.stash(b"before poison");

        // Poison the mutex by panicking while holding the lock.
        let stash2 = Arc::clone(&stash);
        let handle = thread::spawn(move || {
            let _guard = stash2.buf.lock().unwrap();
            panic!("intentional panic to poison mutex");
        });
        let _ = handle.join(); // join the panicked thread

        // read() should return None (poisoned mutex), not panic.
        assert!(stash.read().is_none());
    }

    #[test]
    fn stash_recovers_from_poisoned_mutex() {
        use std::sync::Arc;
        use std::thread;

        let stash = Arc::new(InputStash::new(1024));

        // Poison the mutex
        let stash2 = Arc::clone(&stash);
        let handle = thread::spawn(move || {
            let _guard = stash2.buf.lock().unwrap();
            panic!("intentional panic to poison mutex");
        });
        let _ = handle.join();

        let gen_before = stash.generation.load(Ordering::Relaxed);

        // stash() should recover from poison (unwrap_or_else), not panic.
        stash.stash(b"after poison");

        let gen_after = stash.generation.load(Ordering::Relaxed);
        assert_eq!(gen_after, gen_before + 2, "generation should advance by 2");
    }

    #[test]
    fn concurrent_read_during_write_returns_none() {
        let stash = InputStash::new(1024);

        // Manually set generation to odd (simulating mid-write) to verify
        // the reader returns None.
        stash.generation.fetch_add(1, Ordering::Release);
        assert!(
            stash.read().is_none(),
            "read during odd generation should return None"
        );

        // Complete the "write" and verify read succeeds.
        {
            let mut buf = stash.buf.lock().unwrap();
            buf[..3].copy_from_slice(b"abc");
            stash.len.store(3, Ordering::Release);
        }
        stash.generation.fetch_add(1, Ordering::Release);

        let data = stash
            .read()
            .expect("read after even generation should succeed");
        assert_eq!(data, b"abc");
    }
}
