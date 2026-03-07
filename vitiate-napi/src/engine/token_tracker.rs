use std::collections::{HashMap, HashSet};

use libafl::HasMetadata;
use libafl::mutators::Tokens;

use super::FuzzerState;

/// Minimum number of observations (appearances in CmpLog entries across all
/// `report_result` calls) before a token candidate is promoted into the mutation
/// dictionary. A token appearing in multiple `CmpValues::Bytes` entries within
/// a single call increments multiple times. Constants like `"javascript"` appear
/// in every execution that reaches a comparison; one-off garbled byte sequences
/// produced by havoc mutations appear only once. A threshold of 3 effectively
/// filters out noise while keeping real constants.
pub(super) const TOKEN_PROMOTION_THRESHOLD: usize = 3;

/// Maximum number of token candidates tracked before new candidates are
/// dropped. Real comparison constants are promoted quickly (they appear in
/// every execution that reaches the comparison), so this cap prevents unbounded
/// growth from the long tail of one-off garbled byte sequences.
pub(super) const MAX_TOKEN_CANDIDATES: usize = 4096;

/// Maximum number of auto-discovered tokens in the mutation dictionary.
/// Once this limit is reached, no further tokens are promoted. Real comparison
/// constants are promoted within the first few iterations (they appear in every
/// execution that reaches the comparison), so a cap prevents the long tail of
/// garbled byte sequences that happen to exceed `TOKEN_PROMOTION_THRESHOLD` from
/// diluting the dictionary. Matches AFL++'s `MAX_AUTO_EXTRAS` order of magnitude
/// but scaled down since our single-threaded loop benefits from a tighter
/// dictionary.
pub(super) const MAX_DICTIONARY_SIZE: usize = 512;

/// Tracks CmpLog-derived token candidates and promotes frequent ones into
/// the mutation dictionary.
pub(super) struct TokenTracker {
    /// Token candidates and their observation counts. Tokens are promoted
    /// into the mutation dictionary only after reaching `TOKEN_PROMOTION_THRESHOLD`
    /// observations, filtering out one-off garbled byte sequences from havoc.
    pub(super) candidates: HashMap<Vec<u8>, usize>,
    /// Tokens already promoted to the mutation dictionary. Checked before
    /// inserting into `candidates` to prevent re-promotion cycles.
    /// Implicitly bounded by `MAX_DICTIONARY_SIZE` — tokens only enter this set
    /// via the promotion loop, which stops when the dictionary is full.
    pub(super) promoted: HashSet<Vec<u8>>,
}

impl TokenTracker {
    pub(super) fn new() -> Self {
        Self {
            candidates: HashMap::new(),
            promoted: HashSet::new(),
        }
    }

    /// Process extracted tokens: track observation counts, promote tokens that
    /// reach the threshold into the state's `Tokens` metadata.
    pub(super) fn process(&mut self, extracted: &[Vec<u8>], state: &mut FuzzerState) {
        if extracted.is_empty() {
            return;
        }
        if !state.has_metadata::<Tokens>() {
            state.add_metadata(Tokens::default());
        }
        // PANIC: Tokens metadata is guaranteed to exist — inserted above if absent.
        let dict_full = state.metadata::<Tokens>().unwrap().tokens().len() >= MAX_DICTIONARY_SIZE;
        if dict_full {
            return;
        }
        let mut newly_promoted = Vec::new();
        for token in extracted {
            if self.promoted.contains(token) {
                continue;
            }
            let count = if let Some(c) = self.candidates.get_mut(token) {
                *c += 1;
                *c
            } else if self.candidates.len() < MAX_TOKEN_CANDIDATES {
                self.candidates.insert(token.clone(), 1);
                1
            } else {
                continue;
            };
            if count == TOKEN_PROMOTION_THRESHOLD {
                newly_promoted.push(token.clone());
            }
        }
        for token in &newly_promoted {
            self.candidates.remove(token);
            self.promoted.insert(token.clone());
            // PANIC: Tokens metadata is guaranteed to exist — inserted at the
            // top of process() if absent.
            let tokens = state.metadata_mut::<Tokens>().unwrap();
            tokens.add_token(token);
            if tokens.tokens().len() >= MAX_DICTIONARY_SIZE {
                break;
            }
        }
    }
}
