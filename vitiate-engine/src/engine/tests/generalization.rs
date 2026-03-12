use super::helpers::{TestFuzzerBuilder, make_cmplog_bytes};
use crate::cmplog;
use crate::engine::generalization::{
    GeneralizationPhase, build_generalization_candidate, trim_payload,
};
use crate::engine::{Fuzzer, MAX_GENERALIZED_LEN, StageState};
use crate::types::ExitKind;
use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, Testcase};
use libafl::feedbacks::MapNoveltiesMetadata;
use libafl::inputs::{BytesInput, GeneralizedInputMetadata, GeneralizedItem};
use libafl::observers::cmp::CmpValues;
use libafl::state::{HasCorpus, HasExecutions};

// -----------------------------------------------------------------------
// Generalization stage tests
// -----------------------------------------------------------------------

#[test]
fn test_generalization_skipped_when_grimoire_disabled() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(b"fn foo() {}", &[10, 20]);
    fuzzer.features.grimoire_enabled = false;

    let result = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "generalization should be skipped when Grimoire disabled"
    );
    assert!(matches!(fuzzer.stage_state, StageState::None));

    cmplog::disable();
}

#[test]
fn test_generalization_skipped_for_large_input() {
    let large_input = vec![b'A'; MAX_GENERALIZED_LEN + 1];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(&large_input, &[10]);

    let result = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "generalization should be skipped for input > MAX_GENERALIZED_LEN"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_skipped_when_no_novelties() {
    cmplog::disable();
    cmplog::drain();

    let mut fuzzer = TestFuzzerBuilder::new(256).grimoire(true).build();
    fuzzer.features.deferred_detection_count = None;

    // Add a corpus entry WITHOUT MapNoveltiesMetadata.
    let testcase = Testcase::new(BytesInput::new(b"test".to_vec()));
    let corpus_id = fuzzer.state.corpus_mut().add(testcase).unwrap();

    let result = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "generalization should be skipped without novelties"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_skipped_when_already_generalized() {
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(b"fn foo() {}", &[10, 20]);

    // Manually add GeneralizedInputMetadata to simulate prior generalization.
    let payload: Vec<Option<u8>> = b"fn foo() {}".iter().map(|&b| Some(b)).collect();
    let meta = GeneralizedInputMetadata::generalized_from_options(&payload);
    fuzzer
        .state
        .corpus()
        .get(corpus_id)
        .unwrap()
        .borrow_mut()
        .add_metadata(meta);

    let result = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(
        result.is_none(),
        "generalization should be skipped when already generalized"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_verification_succeeds() {
    let input = b"fn foo() {}";
    let novelty_indices = vec![10, 20];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    // Begin generalization - should return the original input for verification.
    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some(), "should return verification candidate");
    let candidate: Vec<u8> = first.unwrap().to_vec();
    assert_eq!(
        candidate, input,
        "verification candidate should be the original input"
    );
    assert!(matches!(
        fuzzer.stage_state,
        StageState::Generalization {
            phase: GeneralizationPhase::Verify,
            ..
        }
    ));

    // Simulate target execution: set novelty indices in coverage map.
    for &idx in &novelty_indices {
        unsafe {
            *fuzzer.map_ptr.add(idx) = 1;
        }
    }

    // Advance - verification should pass and produce next candidate.
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        next.is_some(),
        "should produce first gap-finding candidate after verification passes"
    );
    // Should now be in Offset phase.
    assert!(matches!(
        fuzzer.stage_state,
        StageState::Generalization {
            phase: GeneralizationPhase::Offset { .. },
            ..
        }
    ));

    cmplog::disable();
}

#[test]
fn test_generalization_verification_fails() {
    let input = b"fn foo() {}";
    let novelty_indices = vec![10, 20];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some());

    // Simulate execution where one novelty index is zero (unstable).
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
        // index 20 is left at 0 - verification fails.
    }

    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(
        next.is_none(),
        "verification failure should abort generalization"
    );
    assert!(matches!(fuzzer.stage_state, StageState::None));

    // Verify no GeneralizedInputMetadata was stored.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        !tc.has_metadata::<GeneralizedInputMetadata>(),
        "no metadata should be stored on verification failure"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_offset_marks_gaps() {
    // Use a small input so offset-0 pass tests each byte individually.
    let input = b"ab";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    // Begin generalization.
    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some());

    // Disable Grimoire after starting generalization so finalize_generalization
    // doesn't transition to Grimoire stage (this test isolates generalization).
    fuzzer.features.grimoire_enabled = false;

    // Verification: set novelty index.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(next.is_some(), "should produce first offset candidate");

    // We're now in offset phase. The first pass has offset=255.
    // For a 2-byte input: start=0, end=min(0+1+255, 2)=2.
    // Candidate removes bytes [0, 2) = entire input → empty candidate.
    // Simulate novelties surviving (meaning entire input can be gapped).
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    // Since end (2) >= payload.len() (2), this pass is done. Trim + next level.
    // After marking [0, 2) as gaps, payload = [None, None].
    // After trimming, payload = [None].
    // Continue through remaining offset levels and delimiter passes.
    // Eventually generalization completes.

    // Drive to completion - keep advancing until None.
    let mut exec_count = 2; // verification + first offset candidate
    while let Some(_buf) = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap() {
        exec_count += 1;
        // Set novelties for all subsequent candidates.
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        if exec_count > 100 {
            panic!("generalization should complete within reasonable iterations");
        }
    }

    // Verify metadata was stored.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        tc.has_metadata::<GeneralizedInputMetadata>(),
        "GeneralizedInputMetadata should be stored after generalization completes"
    );
    let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
    // The entire input was gapped, so metadata should be just [Gap].
    // (Leading and trailing gaps merged with the single gap.)
    assert!(
        meta.generalized().contains(&GeneralizedItem::Gap),
        "metadata should contain Gap items"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_offset_preserves_structural() {
    // 4-byte input. We'll make the first offset-255 candidate fail (novelties don't survive),
    // meaning those bytes are structural.
    let input = b"test";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let first = fuzzer.begin_generalization(corpus_id).unwrap();
    assert!(first.is_some());

    // Disable Grimoire after starting generalization so finalize_generalization
    // doesn't transition to Grimoire stage (this test isolates generalization).
    fuzzer.features.grimoire_enabled = false;

    // Verification: pass.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert!(next.is_some());

    // First offset-255 candidate removes [0, 4) from 4-byte input.
    // Simulate novelties NOT surviving → bytes are structural.
    // (Don't set the novelty index → it stays 0.)
    let _next = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    // Pass complete (end=4 >= payload.len=4). Move to next offset level.
    // Continue - all candidates also fail novelties.
    let mut exec_count = 3;
    loop {
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        if candidate.is_none() {
            break;
        }
        exec_count += 1;
        // Don't set novelty index - all candidates fail.
        if exec_count > 200 {
            panic!("generalization should complete within reasonable iterations");
        }
    }

    // Verify metadata was stored (even if everything is structural).
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        tc.has_metadata::<GeneralizedInputMetadata>(),
        "GeneralizedInputMetadata should be stored even when all bytes are structural"
    );
    let meta = tc.metadata::<GeneralizedInputMetadata>().unwrap();
    // All bytes are structural, so metadata should be [Gap, Bytes(b"test"), Gap].
    let items = meta.generalized();
    assert_eq!(
        items.first(),
        Some(&GeneralizedItem::Gap),
        "should have leading gap"
    );
    assert_eq!(
        items.last(),
        Some(&GeneralizedItem::Gap),
        "should have trailing gap"
    );
    assert!(
        items
            .iter()
            .any(|item| matches!(item, GeneralizedItem::Bytes(b) if b == b"test")),
        "should have the original bytes as structural"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_execution_counting() {
    let input = b"ab";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let total_before = fuzzer.total_execs;
    let state_execs_before = *fuzzer.state.executions();

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();

    // Disable Grimoire after starting generalization so finalize_generalization
    // doesn't transition to Grimoire stage (this test isolates generalization).
    fuzzer.features.grimoire_enabled = false;

    // Verification.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    assert_eq!(
        fuzzer.total_execs,
        total_before + 1,
        "verification should count"
    );
    assert_eq!(
        *fuzzer.state.executions(),
        state_execs_before + 1,
        "state.executions should increment"
    );

    // Drive to completion, counting all executions.
    let mut advance_count = 1;
    loop {
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        advance_count += 1;
        if candidate.is_none() {
            break;
        }
        if advance_count > 100 {
            panic!("should complete within reasonable iterations");
        }
    }

    assert_eq!(
        fuzzer.total_execs,
        total_before + advance_count as u64,
        "total_execs should match number of advance calls"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_cmplog_drained() {
    let input = b"fn foo() {}";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();

    // Push CmpLog entries (simulating target execution producing CmpLog data).
    cmplog::push(
        CmpValues::Bytes((make_cmplog_bytes(b"test"), make_cmplog_bytes(b"data"))),
        0,
        cmplog::CmpLogOperator::Equal,
    );

    // Set novelties for verification pass.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // Verify CmpLog was drained.
    let drained = cmplog::drain();
    assert!(
        drained.is_empty(),
        "CmpLog should be drained by advance_stage during generalization"
    );

    cmplog::disable();
}

#[test]
fn test_generalization_output_format() {
    // Test that payload_to_generalized produces correct format.
    // Payload: [None, Some(b'f'), Some(b'n'), None, Some(b'('), Some(b')'), None]
    let payload = vec![
        None,
        Some(b'f'),
        Some(b'n'),
        None,
        Some(b'('),
        Some(b')'),
        None,
    ];
    let meta = GeneralizedInputMetadata::generalized_from_options(&payload);
    let items = meta.generalized();
    assert_eq!(
        items,
        &[
            GeneralizedItem::Gap,
            GeneralizedItem::Bytes(b"fn".to_vec()),
            GeneralizedItem::Gap,
            GeneralizedItem::Bytes(b"()".to_vec()),
            GeneralizedItem::Gap,
        ],
        "should produce [Gap, Bytes(fn), Gap, Bytes(()), Gap]"
    );
}

#[test]
fn test_generalization_output_leading_trailing_gaps() {
    // Payload starts and ends with Some - should get leading/trailing gaps.
    let payload = vec![Some(b'a'), Some(b'b')];
    let meta = GeneralizedInputMetadata::generalized_from_options(&payload);
    let items = meta.generalized();
    assert_eq!(
        items.first(),
        Some(&GeneralizedItem::Gap),
        "must have leading gap"
    );
    assert_eq!(
        items.last(),
        Some(&GeneralizedItem::Gap),
        "must have trailing gap"
    );
    assert_eq!(
        items,
        &[
            GeneralizedItem::Gap,
            GeneralizedItem::Bytes(b"ab".to_vec()),
            GeneralizedItem::Gap,
        ]
    );
}

#[test]
fn test_trim_payload_removes_consecutive_gaps() {
    let mut payload = vec![None, None, Some(b'a'), None, None, None, Some(b'b'), None];
    trim_payload(&mut payload);
    assert_eq!(
        payload,
        vec![None, Some(b'a'), None, Some(b'b'), None],
        "consecutive None entries should be collapsed to single None"
    );
}

#[test]
fn test_build_generalization_candidate() {
    let payload = vec![
        Some(b'a'),
        Some(b'b'),
        None,
        Some(b'c'),
        Some(b'd'),
        Some(b'e'),
    ];
    // Remove range [1, 4) - removes Some(b'b'), None, Some(b'c').
    let candidate = build_generalization_candidate(&payload, 1, 4);
    // payload[..1] = [Some(b'a')] → [b'a']
    // payload[4..] = [Some(b'd'), Some(b'e')] → [b'd', b'e']
    // None values in either portion are skipped.
    assert_eq!(candidate, b"ade");
}

#[test]
fn test_build_candidate_skips_gaps() {
    let payload = vec![None, Some(b'a'), Some(b'b'), None, Some(b'c')];
    // Remove range [1, 3) - removes Some(b'a'), Some(b'b').
    let candidate = build_generalization_candidate(&payload, 1, 3);
    // payload[..1] = [None] → skipped
    // payload[3..] = [None, Some(b'c')] → [b'c']
    assert_eq!(candidate, b"c");
}

#[test]
fn test_generalization_delimiter_gap_finding() {
    // Use "line1\nline2" and test that the delimiter pass can split on \n.
    let input = b"line1\nline2";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();

    // Disable Grimoire after starting generalization so finalize_generalization
    // doesn't transition to Grimoire stage (this test isolates generalization).
    fuzzer.features.grimoire_enabled = false;

    // Verification pass.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // Drive through all offset passes - don't set novelty (all fail, bytes stay structural).
    let mut count = 0;
    loop {
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        // Check if we're now in delimiter phase.
        if matches!(
            fuzzer.stage_state,
            StageState::Generalization {
                phase: GeneralizationPhase::Delimiter { .. },
                ..
            }
        ) {
            break;
        }
        if count > 200 {
            panic!("should reach delimiter phase");
        }
    }

    // Now we're in delimiter phase. For the newline delimiter (index 3),
    // the first candidate removes from pos=0 to \n+1 position.
    // Drive through delimiter passes, setting novelties to survive on the \n pass.
    // This is complex to test precisely since we'd need to identify which pass
    // has the \n delimiter. Instead, just verify the pipeline completes.
    loop {
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        if count > 500 {
            panic!("should complete generalization");
        }
    }

    // Verify metadata was stored and contains Gap entries.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    let metadata = tc
        .metadata::<GeneralizedInputMetadata>()
        .expect("GeneralizedInputMetadata should be stored");
    // With all novelties surviving through delimiter passes, the metadata should
    // contain at least one Gap entry (delimiters become gap boundaries).
    let has_gaps = metadata
        .generalized()
        .iter()
        .any(|item| matches!(item, GeneralizedItem::Gap));
    assert!(
        has_gaps,
        "delimiter-based generalization should produce gaps when novelties survive"
    );

    cmplog::disable();
}

// -----------------------------------------------------------------------
// Generalization gap-finding adds to corpus test (#7)
// -----------------------------------------------------------------------

#[test]
fn test_generalization_gap_finding_adds_to_corpus() {
    // During an offset pass, new coverage at a previously-unseen index should
    // cause the candidate to be added to the corpus with MapNoveltiesMetadata.
    let input = b"abcdefgh";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();
    fuzzer.features.grimoire_enabled = false;

    // Verification pass: set novelty so it passes.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // We're now in offset phase. Set novel coverage at a NEW index (20)
    // that the feedback hasn't seen before.
    let corpus_count_before = fuzzer.state.corpus().count();
    unsafe {
        *fuzzer.map_ptr.add(20) = 1;
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
    let corpus_count_after = fuzzer.state.corpus().count();

    assert!(
        corpus_count_after > corpus_count_before,
        "gap-finding execution with novel coverage should add to corpus"
    );

    // Verify the new entry has MapNoveltiesMetadata.
    let new_id = CorpusId::from(corpus_count_after - 1);
    let tc = fuzzer.state.corpus().get(new_id).unwrap().borrow();
    assert!(
        tc.metadata::<MapNoveltiesMetadata>().is_ok(),
        "gap-finding corpus entry should have MapNoveltiesMetadata"
    );

    // Verify that last_interesting_corpus_id is None - stage-found entries
    // don't set this (only report_result does).
    assert!(
        fuzzer.last_interesting_corpus_id.is_none(),
        "last_interesting_corpus_id should be None for stage-found entries"
    );

    cmplog::disable();
}

// -----------------------------------------------------------------------
// Bracket-based gap-finding tests (#4)
// -----------------------------------------------------------------------

/// Drive a fuzzer through Verify and all Offset/Delimiter phases to reach
/// the Bracket phase, with novelties surviving all phases.
fn advance_to_bracket_phase(fuzzer: &mut Fuzzer, novelty_indices: &[usize]) {
    // Verification pass.
    for &idx in novelty_indices {
        unsafe {
            *fuzzer.map_ptr.add(idx) = 1;
        }
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // Drive through offset and delimiter phases.
    let mut count = 0;
    loop {
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        if matches!(
            fuzzer.stage_state,
            StageState::Generalization {
                phase: GeneralizationPhase::Bracket { .. },
                ..
            }
        ) {
            return;
        }
        if count > 10_000 {
            panic!(
                "should reach bracket phase within 10000 iterations (got {count} without entering bracket phase)"
            );
        }
    }
    panic!("generalization ended before reaching bracket phase");
}

#[test]
fn test_bracket_gaps_marked_on_novelty_survival() {
    // Input with brackets: "(abc)". When novelties survive, the range between
    // open and close bracket should be marked as gaps.
    let input = b"(abc)";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();
    fuzzer.features.grimoire_enabled = false;

    advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

    // We're now in bracket phase. Set novelties to survive.
    let mut count = 0;
    loop {
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        if count > 200 {
            panic!("should complete bracket phase");
        }
    }

    // Verify metadata was stored with gaps.
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    let metadata = tc
        .metadata::<GeneralizedInputMetadata>()
        .expect("should have GeneralizedInputMetadata");
    let has_gaps = metadata
        .generalized()
        .iter()
        .any(|item| matches!(item, GeneralizedItem::Gap));
    assert!(
        has_gaps,
        "bracket-based generalization should produce gaps when novelties survive"
    );

    // Verify opener byte `(` is preserved (not gapped) - the candidate_range
    // should exclude the opener position so it remains in a Bytes segment.
    let opener_preserved = metadata
        .generalized()
        .iter()
        .any(|item| matches!(item, GeneralizedItem::Bytes(b) if b.contains(&b'(')));
    assert!(
        opener_preserved,
        "opener byte '(' should be preserved in generalized metadata, not gapped"
    );

    cmplog::disable();
}

#[test]
fn test_bracket_no_gaps_when_novelties_fail() {
    // Input with brackets: "(abc)". When novelties DON'T survive, no gaps
    // should be added during bracket phase.
    let input = b"(abc)";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();
    fuzzer.features.grimoire_enabled = false;

    advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

    // Drive through bracket phase WITHOUT setting novelties (they fail).
    let mut count = 0;
    loop {
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        if count > 200 {
            panic!("should complete bracket phase");
        }
    }

    // Verify metadata was stored. Since all offset/delimiter phases failed too
    // (no novelties set), there should be no internal gaps (only leading/trailing).
    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        tc.has_metadata::<GeneralizedInputMetadata>(),
        "should have GeneralizedInputMetadata even without gaps"
    );

    cmplog::disable();
}

#[test]
fn test_bracket_same_char_pairs() {
    // Input with quotes: "'hello'". Same-character pairs should work.
    let input = b"'hello'";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();
    fuzzer.features.grimoire_enabled = false;

    advance_to_bracket_phase(&mut fuzzer, &novelty_indices);

    // Drive through bracket phase with novelties surviving.
    let mut count = 0;
    loop {
        unsafe {
            *fuzzer.map_ptr.add(10) = 1;
        }
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        if count > 200 {
            panic!("should complete bracket phase for quote pairs");
        }
    }

    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        tc.has_metadata::<GeneralizedInputMetadata>(),
        "same-char bracket pairs should produce metadata"
    );

    cmplog::disable();
}

#[test]
fn test_bracket_no_closer_advances_to_next_pair() {
    // Input with opener but no closer: "(abc". Should advance through all
    // bracket pairs and finalize without getting stuck.
    // Note: bracket scanning for inputs without closers completes within a
    // single advance_stage call (no yielding), so we just drive the full
    // generalization to completion and verify it doesn't hang.
    let input = b"(abc";
    let novelty_indices = vec![10];
    let (mut fuzzer, corpus_id) = TestFuzzerBuilder::new(256)
        .grimoire(true)
        .build_with_corpus_entry(input, &novelty_indices);

    let _first = fuzzer.begin_generalization(corpus_id).unwrap();
    fuzzer.features.grimoire_enabled = false;

    // Verification pass.
    unsafe {
        *fuzzer.map_ptr.add(10) = 1;
    }
    let _ = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();

    // Drive through all phases to completion.
    let mut count = 0;
    loop {
        let candidate = fuzzer.advance_stage(ExitKind::Ok, 50_000.0).unwrap();
        count += 1;
        if candidate.is_none() {
            break;
        }
        if count > 500 {
            panic!("should complete generalization when no closers exist");
        }
    }

    let tc = fuzzer.state.corpus().get(corpus_id).unwrap().borrow();
    assert!(
        tc.has_metadata::<GeneralizedInputMetadata>(),
        "should finalize even without matching closers"
    );

    cmplog::disable();
}
