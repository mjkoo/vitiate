//! Cross-process shared memory stash for input exchange between
//! the supervisor parent and the fuzzing child.
//!
//! The fuzz loop writes the current input to this region before each
//! iteration. Two readers exist:
//! - The parent process reads after the child dies (crash artifact capture)
//! - The watchdog thread reads before `_exit` (timeout artifact capture)
//!
//! # Layout
//!
//! The shmem region uses a fixed-size layout with atomic fields for
//! lock-free cross-process coordination:
//!
//! ```text
//! offset  field        type            writer              reader
//! 0       magic        u32             parent (once)       child (validates)
//! 4       (padding)    [u8; 4]         -                   -
//! 8       generation   u64 (atomic)    child (per iter)    parent, watchdog
//! 16      input_len    u32 (atomic)    child (per iter)    parent, watchdog
//! 20      (padding)    [u8; 4]         -                   -
//! 24      input_buf    [u8; N]         child (per iter)    parent, watchdog
//! ```
//!
//! Total size: 24 + MAX_INPUT_LEN bytes (HEADER_SIZE + MAX_INPUT_LEN).
//!
//! The padding after `magic` ensures `generation` is 8-byte aligned for
//! correct atomic u64 access on all platforms. The trailing padding after
//! `input_len` is inserted by `repr(C)` to maintain the struct's 8-byte
//! alignment.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use libafl_bolts::shmem::{ShMem, ShMemProvider, StdShMem, StdShMemProvider};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Magic constant for shmem validation ("VITI" in ASCII).
pub const MAGIC: u32 = 0x56495449;

/// Environment variable name for the shmem identifier.
const SHMEM_ENV_NAME: &str = "VITIATE_SHMEM";

/// Header layout for computing offsets. Not instantiated directly —
/// the shmem region is raw bytes accessed via pointer arithmetic.
#[repr(C)]
struct ShmemHeader {
    magic: u32,
    _pad: [u8; 4],
    generation: u64,
    input_len: u32,
}

const MAGIC_OFFSET: usize = std::mem::offset_of!(ShmemHeader, magic);
const GENERATION_OFFSET: usize = std::mem::offset_of!(ShmemHeader, generation);
const INPUT_LEN_OFFSET: usize = std::mem::offset_of!(ShmemHeader, input_len);
const HEADER_SIZE: usize = std::mem::size_of::<ShmemHeader>();
const INPUT_BUF_OFFSET: usize = HEADER_SIZE;

/// Calculate total shmem size for a given max input length.
pub(crate) fn shmem_size(max_input_len: usize) -> usize {
    HEADER_SIZE + max_input_len
}

/// Lightweight, thread-safe view into a shmem region.
///
/// Provides atomic read/write access to the layout fields.
/// Does not own the underlying mapping — the caller must ensure
/// the mapping outlives all views.
#[derive(Clone, Copy)]
pub(crate) struct ShmemView {
    base: *mut u8,
    max_input_len: usize,
}

// SAFETY: Access to the shmem region is synchronized via atomic operations
// on the generation counter (odd/even seqlock protocol). The underlying memory
// is process-global shared memory allocated by the OS. The raw pointer remains
// valid for the lifetime of the StdShMem handle that produced it.
//
// Lifetime invariant: The `ShmemStash` (which owns the `StdShMem` mapping)
// must outlive all `ShmemView` instances. In practice, both are held within
// `runFuzzLoop`'s scope — the `ShmemHandle` (NAPI wrapper around `ShmemStash`)
// is created first and dropped last.
unsafe impl Send for ShmemView {}
unsafe impl Sync for ShmemView {}

impl ShmemView {
    /// Create a ShmemView from a raw pointer (for testing).
    #[cfg(test)]
    pub(crate) fn new_for_test(base: *mut u8, max_input_len: usize) -> Self {
        Self {
            base,
            max_input_len,
        }
    }

    /// Get a reference to the generation counter (atomic u64 at offset 8).
    fn generation(&self) -> &AtomicU64 {
        // SAFETY: GENERATION_OFFSET (8) is 8-byte aligned relative to a
        // page-aligned shmem base. The region is at least HEADER_SIZE bytes.
        unsafe { &*(self.base.add(GENERATION_OFFSET) as *const AtomicU64) }
    }

    /// Get a reference to the input_len field (atomic u32 at offset 16).
    fn input_len_atomic(&self) -> &AtomicU32 {
        // SAFETY: INPUT_LEN_OFFSET (16) is 4-byte aligned relative to a
        // page-aligned shmem base. The region is at least HEADER_SIZE bytes.
        unsafe { &*(self.base.add(INPUT_LEN_OFFSET) as *const AtomicU32) }
    }

    /// Reset the generation counter to zero.
    ///
    /// Called by the parent supervisor after reading a crash artifact and
    /// before respawning the child. This prevents the new child's first
    /// `read_stashed_input()` from returning stale data from the dead child.
    pub fn reset_generation(&self) {
        self.generation().store(0, Ordering::Release);
    }

    /// Get a pointer to the input buffer (starts at INPUT_BUF_OFFSET).
    fn input_buf_ptr(&self) -> *mut u8 {
        // SAFETY: INPUT_BUF_OFFSET is within the allocated region.
        unsafe { self.base.add(INPUT_BUF_OFFSET) }
    }

    /// Write the current input to the shmem region.
    ///
    /// Uses an odd/even seqlock protocol: increments `generation` to an odd
    /// value (write-in-progress) BEFORE writing data, then increments again
    /// to an even value AFTER writing. Readers reject odd generations as torn.
    /// Truncates inputs exceeding `max_input_len`.
    pub fn stash_input(&self, buf: &[u8]) {
        let copy_len = buf.len().min(self.max_input_len);

        // Mark write-in-progress: generation becomes odd.
        // Release semantics ensure prior iteration's reads are ordered before
        // this store becomes visible to readers.
        self.generation().fetch_add(1, Ordering::Release);

        // Write input_len
        self.input_len_atomic()
            .store(copy_len as u32, Ordering::Relaxed);

        // Copy input_buf
        if copy_len > 0 {
            // SAFETY: copy_len <= max_input_len, and the shmem region has
            // HEADER_SIZE + max_input_len bytes allocated.
            unsafe {
                std::ptr::copy_nonoverlapping(buf.as_ptr(), self.input_buf_ptr(), copy_len);
            }
        }

        // Mark write-complete: generation becomes even.
        // Release semantics ensure the data writes are visible before readers
        // observe this generation value.
        self.generation().fetch_add(1, Ordering::Release);
    }

    /// Read the stashed input. Used by the parent after child death.
    ///
    /// No concurrent writer exists when the parent reads (the child is dead),
    /// so no consistency check is needed beyond the acquire fence.
    ///
    /// Returns an empty vec when:
    /// - `generation == 0` (no input was ever stashed — after allocation or
    ///   `reset_generation()`)
    /// - `generation` is odd (child died mid-write — torn data, not safe to read)
    pub fn read_stashed_input(&self) -> Vec<u8> {
        // Acquire fence pairs with the child's release on generation increment.
        let generation = self.generation().load(Ordering::Acquire);
        if generation == 0 || !generation.is_multiple_of(2) {
            return Vec::new();
        }

        let len = self.input_len_atomic().load(Ordering::Relaxed) as usize;
        let len = len.min(self.max_input_len);

        let mut buf = vec![0u8; len];
        if len > 0 {
            // SAFETY: len <= max_input_len, shmem region is large enough.
            unsafe {
                std::ptr::copy_nonoverlapping(self.input_buf_ptr(), buf.as_mut_ptr(), len);
            }
        }
        buf
    }

    /// Read the stashed input with generation-counter consistency check.
    ///
    /// Used by the watchdog thread before `_exit`. Returns `None` if:
    /// - The generation is zero (no input ever stashed)
    /// - The generation is odd (write in progress — seqlock protocol)
    /// - The generation changed between the two reads (torn read)
    pub fn read_consistent(&self) -> Option<Vec<u8>> {
        let gen_before = self.generation().load(Ordering::Acquire);

        // Generation 0 means no input was ever stashed — avoid returning
        // Some(empty) which would produce a phantom timeout artifact.
        if gen_before == 0 {
            return None;
        }

        // Odd generation means a write is in progress — bail immediately.
        if !gen_before.is_multiple_of(2) {
            return None;
        }

        let len = self.input_len_atomic().load(Ordering::Relaxed) as usize;
        let len = len.min(self.max_input_len);

        let mut buf = vec![0u8; len];
        if len > 0 {
            // SAFETY: len <= max_input_len, shmem region is large enough.
            unsafe {
                std::ptr::copy_nonoverlapping(self.input_buf_ptr(), buf.as_mut_ptr(), len);
            }
        }

        let gen_after = self.generation().load(Ordering::Acquire);
        if gen_before != gen_after {
            return None;
        }

        Some(buf)
    }
}

/// Owns the shared memory mapping and provides access via [`ShmemView`].
pub(crate) struct ShmemStash {
    _shmem: StdShMem,
    view: ShmemView,
}

impl ShmemStash {
    /// Allocate a new shmem region (parent side).
    ///
    /// Writes the magic field and exports the shmem ID to the
    /// `VITIATE_SHMEM` environment variable.
    pub fn allocate(max_input_len: usize) -> napi::Result<Self> {
        let mut provider = StdShMemProvider::new().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("shmem provider init failed: {e}"),
            )
        })?;

        let mut shmem = provider.new_shmem(shmem_size(max_input_len)).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("shmem allocation failed: {e}"),
            )
        })?;

        let base = shmem.as_mut_ptr();

        // Write magic field
        // SAFETY: MAGIC_OFFSET (0) is within the allocated region. u32 at
        // offset 0 from a page-aligned base is always properly aligned.
        unsafe {
            (base.add(MAGIC_OFFSET) as *mut u32).write(MAGIC);
        }

        // Zero the padding and header fields
        // SAFETY: All offsets are within the allocated region and properly aligned.
        unsafe {
            // Zero padding bytes
            std::ptr::write_bytes(base.add(4), 0, 4);
            // Zero generation
            (base.add(GENERATION_OFFSET) as *mut u64).write(0);
            // Zero input_len
            (base.add(INPUT_LEN_OFFSET) as *mut u32).write(0);
        }

        // Export shmem ID to environment for child process.
        // SAFETY: Called from the parent's main thread before spawning children.
        // No other threads are reading VITIATE_SHMEM at this point.
        unsafe {
            shmem.write_to_env(SHMEM_ENV_NAME).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("shmem write_to_env failed: {e}"),
                )
            })?;
        }

        let view = ShmemView {
            base,
            max_input_len,
        };
        Ok(Self {
            _shmem: shmem,
            view,
        })
    }

    /// Attach to an existing shmem region (child side).
    ///
    /// Reads the `VITIATE_SHMEM` environment variable, attaches to the
    /// region, and validates the magic field.
    pub fn attach() -> napi::Result<Self> {
        let mut provider = StdShMemProvider::new().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("shmem provider init failed: {e}"),
            )
        })?;

        let mut shmem = provider
            .existing_from_env(SHMEM_ENV_NAME)
            .map_err(|e| Error::new(Status::GenericFailure, format!("shmem attach failed: {e}")))?;

        // Derive max_input_len from the shmem size
        let total_size = shmem.len();
        if total_size < HEADER_SIZE {
            return Err(Error::new(
                Status::GenericFailure,
                format!("shmem region too small: {total_size} bytes (minimum {HEADER_SIZE})"),
            ));
        }
        let max_input_len = total_size - HEADER_SIZE;

        let base = shmem.as_mut_ptr();

        // Validate magic field
        // SAFETY: MAGIC_OFFSET (0) is within the region and properly aligned.
        let magic = unsafe { (base.add(MAGIC_OFFSET) as *const u32).read() };
        if magic != MAGIC {
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "shmem magic mismatch: expected {MAGIC:#010x}, got {magic:#010x} \
                     (stale or wrong shmem region)"
                ),
            ));
        }

        let view = ShmemView {
            base,
            max_input_len,
        };
        Ok(Self {
            _shmem: shmem,
            view,
        })
    }

    /// Get a lightweight view into this shmem region.
    pub fn view(&self) -> ShmemView {
        self.view
    }
}

// --- NAPI exports ---

/// NAPI-exposed handle to a shared memory stash.
///
/// Wraps a cross-process shared memory region used to exchange the
/// current fuzz input between the supervisor parent and the fuzzing child.
#[napi]
pub struct ShmemHandle {
    stash: ShmemStash,
}

#[napi]
impl ShmemHandle {
    /// Allocate a new shmem region (parent side).
    ///
    /// Writes the magic field and exports the shmem identifier to the
    /// `VITIATE_SHMEM` environment variable for the child to attach.
    #[napi(factory)]
    pub fn allocate(max_input_len: u32) -> napi::Result<Self> {
        let stash = ShmemStash::allocate(max_input_len as usize)?;
        Ok(Self { stash })
    }

    /// Attach to an existing shmem region (child side).
    ///
    /// Reads the `VITIATE_SHMEM` environment variable, attaches to the
    /// region, and validates the magic field.
    #[napi(factory)]
    pub fn attach() -> napi::Result<Self> {
        let stash = ShmemStash::attach()?;
        Ok(Self { stash })
    }

    /// Stash the current input to the shmem region.
    ///
    /// Call this before each fuzz iteration so the parent (or watchdog)
    /// can recover the crashing/timing-out input.
    #[napi]
    pub fn stash_input(&self, input: &[u8]) {
        self.stash.view().stash_input(input);
    }

    /// Read the stashed input from the shmem region.
    ///
    /// Used by the parent after the child dies to recover the crashing input.
    #[napi]
    pub fn read_stashed_input(&self) -> Buffer {
        Buffer::from(self.stash.view().read_stashed_input())
    }

    /// Reset the generation counter to zero.
    ///
    /// Called by the parent supervisor after reading a crash artifact and
    /// before respawning the child. Prevents the new child from seeing
    /// stale data from the dead child.
    #[napi]
    pub fn reset_generation(&self) {
        self.stash.view().reset_generation();
    }
}

impl ShmemHandle {
    /// Get a lightweight view for internal use (e.g., passing to Watchdog).
    pub(crate) fn view(&self) -> ShmemView {
        self.stash.view()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a ShmemView backed by a heap-allocated buffer (for testing
    /// without OS shared memory).
    fn make_test_view(max_input_len: usize) -> (Vec<u8>, ShmemView) {
        let mut buf = vec![0u8; shmem_size(max_input_len)];
        // Write magic
        let base = buf.as_mut_ptr();
        unsafe {
            (base.add(MAGIC_OFFSET) as *mut u32).write(MAGIC);
        }
        let view = ShmemView {
            base,
            max_input_len,
        };
        (buf, view)
    }

    #[test]
    fn layout_offsets_are_correct() {
        assert_eq!(MAGIC_OFFSET, 0);
        assert_eq!(GENERATION_OFFSET, 8, "generation must be 8-byte aligned");
        assert_eq!(INPUT_LEN_OFFSET, 16);
        assert_eq!(
            HEADER_SIZE, 24,
            "header has trailing padding for 8-byte alignment"
        );
        assert_eq!(INPUT_BUF_OFFSET, HEADER_SIZE);
    }

    #[test]
    fn layout_alignment() {
        // generation (u64) must be 8-byte aligned
        assert_eq!(GENERATION_OFFSET % 8, 0);
        // input_len (u32) must be 4-byte aligned
        assert_eq!(INPUT_LEN_OFFSET % 4, 0);
        // header size must be 8-byte aligned (for struct alignment)
        assert_eq!(HEADER_SIZE % 8, 0);
    }

    #[test]
    fn shmem_size_calculation() {
        assert_eq!(shmem_size(4096), HEADER_SIZE + 4096);
        assert_eq!(shmem_size(0), HEADER_SIZE);
        assert_eq!(shmem_size(1), HEADER_SIZE + 1);
    }

    #[test]
    fn stash_and_read_roundtrip() {
        let (_buf, view) = make_test_view(1024);
        let input = b"hello fuzzer";
        view.stash_input(input);
        let read = view.read_stashed_input();
        assert_eq!(read, input);
    }

    #[test]
    fn stash_truncates_to_max_len() {
        let (_buf, view) = make_test_view(4);
        view.stash_input(b"abcdefgh");
        let read = view.read_stashed_input();
        assert_eq!(read, b"abcd");
    }

    #[test]
    fn stash_overwrites_previous() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"first");
        view.stash_input(b"second");
        let read = view.read_stashed_input();
        assert_eq!(read, b"second");
    }

    #[test]
    fn empty_stash_reads_empty() {
        let (_buf, view) = make_test_view(1024);
        let read = view.read_stashed_input();
        assert!(read.is_empty());
    }

    #[test]
    fn generation_counter_increments_by_two() {
        let (_buf, view) = make_test_view(1024);
        assert_eq!(view.generation().load(Ordering::Relaxed), 0);
        view.stash_input(b"a");
        assert_eq!(view.generation().load(Ordering::Relaxed), 2);
        view.stash_input(b"b");
        assert_eq!(view.generation().load(Ordering::Relaxed), 4);
    }

    #[test]
    fn read_consistent_succeeds_when_no_concurrent_write() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"test input");
        let data = view.read_consistent().expect("should succeed");
        assert_eq!(data, b"test input");
    }

    #[test]
    fn read_consistent_returns_none_on_odd_generation() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"data");

        // Manually set generation to an odd value to simulate a write in progress.
        // The seqlock protocol rejects odd generations immediately.
        view.generation().store(3, Ordering::Release);
        assert!(view.read_consistent().is_none());
    }

    #[test]
    fn read_consistent_succeeds_on_even_generation() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"data");

        // After stash_input, generation is 2 (even) — read should succeed.
        assert_eq!(view.generation().load(Ordering::Relaxed), 2);
        let data = view.read_consistent().expect("should succeed on even gen");
        assert_eq!(data, b"data");
    }

    #[test]
    fn magic_validation_accepts_correct_value() {
        let mut buf = vec![0u8; shmem_size(4096)];
        let base = buf.as_mut_ptr();
        unsafe {
            (base.add(MAGIC_OFFSET) as *mut u32).write(MAGIC);
        }
        let magic = unsafe { (base.add(MAGIC_OFFSET) as *const u32).read() };
        assert_eq!(magic, MAGIC);
    }

    #[test]
    fn magic_validation_rejects_wrong_value() {
        let mut buf = vec![0u8; shmem_size(4096)];
        let base = buf.as_mut_ptr();
        unsafe {
            (base.add(MAGIC_OFFSET) as *mut u32).write(0xDEADBEEF);
        }
        let magic = unsafe { (base.add(MAGIC_OFFSET) as *const u32).read() };
        assert_ne!(magic, MAGIC);
    }

    #[test]
    fn large_input_stash_and_read() {
        let max_len = 8192;
        let (_buf, view) = make_test_view(max_len);
        let input: Vec<u8> = (0..max_len).map(|i| (i % 256) as u8).collect();
        view.stash_input(&input);
        let read = view.read_stashed_input();
        assert_eq!(read, input);
    }

    #[test]
    fn read_stashed_input_returns_empty_on_zero_generation() {
        let (_buf, view) = make_test_view(1024);
        // Generation starts at 0 — no input ever stashed
        assert!(view.read_stashed_input().is_empty());
    }

    #[test]
    fn reset_generation_prevents_stale_read() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"stale data");
        assert_eq!(view.read_stashed_input(), b"stale data");

        view.reset_generation();
        assert_eq!(view.generation().load(Ordering::Relaxed), 0);
        // After reset, read_stashed_input returns empty (gen==0 guard)
        assert!(view.read_stashed_input().is_empty());
    }

    #[test]
    fn read_consistent_returns_none_on_zero_generation() {
        let (_buf, view) = make_test_view(1024);
        // Generation starts at 0 — read_consistent should return None,
        // not Some(empty), to avoid phantom timeout artifacts.
        assert!(view.read_consistent().is_none());
    }

    #[test]
    fn read_stashed_input_returns_empty_on_odd_generation() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"data");

        // Manually set generation to an odd value to simulate a child
        // that died mid-write (between the two fetch_add calls).
        view.generation().store(3, Ordering::Release);
        assert!(view.read_stashed_input().is_empty());
    }

    #[test]
    fn zero_length_input() {
        let (_buf, view) = make_test_view(1024);
        view.stash_input(b"");
        let read = view.read_stashed_input();
        assert!(read.is_empty());
        // Generation still incremented (by 2 per stash via seqlock protocol)
        assert_eq!(view.generation().load(Ordering::Relaxed), 2);
    }
}
