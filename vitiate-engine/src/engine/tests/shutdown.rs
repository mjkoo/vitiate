use super::helpers::TestFuzzerBuilder;
use crate::shmem_stash::{ShmemView, shmem_size};

/// `shutdown()` must clear the shmem stash so an orderly child exit leaves
/// no stale "in-flight input" behind. The supervisor treats a stash that
/// survives child exit as an abrupt-death certificate (the child died
/// mid-execution before reaching the fuzz loop's finally block), so a stash
/// left over from an orderly run would misclassify the exit as a crash.
#[test]
fn shutdown_clears_shmem_stash() {
    let mut backing = vec![0u8; shmem_size(1024)];
    let view = ShmemView::new_for_test(backing.as_mut_ptr(), 1024);

    let mut fuzzer = TestFuzzerBuilder::new(64).build();
    fuzzer.shmem_view = Some(view);

    view.stash_input(b"in-flight input");
    assert_eq!(
        view.read_consistent().as_deref(),
        Some(&b"in-flight input"[..])
    );

    fuzzer.shutdown();

    assert!(
        view.read_consistent().is_none(),
        "orderly shutdown must reset the stash generation"
    );
}

/// `shutdown()` with no shmem view (no supervisor) must not panic.
#[test]
fn shutdown_without_shmem_is_noop() {
    let mut fuzzer = TestFuzzerBuilder::new(64).build();
    assert!(fuzzer.shmem_view.is_none());
    fuzzer.shutdown();
}
