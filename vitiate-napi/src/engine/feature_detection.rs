use libafl::corpus::Corpus;
use libafl::state::HasCorpus;

use super::FuzzerState;

/// Number of interesting main-loop inputs before deferred auto-detection fires.
pub(crate) const DEFERRED_DETECTION_THRESHOLD: usize = 10;

/// Tracks auto-detection state for Grimoire, unicode, and REDQUEEN features.
/// Features can be explicitly configured (override) or auto-detected based on
/// corpus UTF-8 content after a deferred threshold.
pub(crate) struct FeatureDetection {
    /// Whether Grimoire structure-aware fuzzing is enabled.
    pub(crate) grimoire_enabled: bool,
    /// Whether unicode-aware mutations are enabled.
    pub(crate) unicode_enabled: bool,
    /// Whether REDQUEEN is enabled.
    pub(crate) redqueen_enabled: bool,
    /// Original config override for grimoire. `None` = auto-detect.
    pub(crate) grimoire_override: Option<bool>,
    /// Original config override for unicode. `None` = auto-detect.
    pub(crate) unicode_override: Option<bool>,
    /// Original config override for redqueen. `None` = auto-detect.
    pub(crate) redqueen_override: Option<bool>,
    /// Count of interesting inputs for deferred detection. `None` = resolved.
    pub(crate) deferred_detection_count: Option<usize>,
    /// Number of auto-seeded corpus entries to skip during scanning.
    pub(crate) auto_seed_count: usize,
}

impl FeatureDetection {
    /// Create feature detection state from config overrides and current corpus count.
    pub(crate) fn new(
        grimoire_override: Option<bool>,
        unicode_override: Option<bool>,
        redqueen_override: Option<bool>,
        corpus_count: usize,
    ) -> Self {
        let grimoire_needs_detection = grimoire_override.is_none();
        let unicode_needs_detection = unicode_override.is_none();
        let redqueen_needs_detection = redqueen_override.is_none();
        let needs_deferred =
            grimoire_needs_detection || unicode_needs_detection || redqueen_needs_detection;

        let (corpus_is_utf8, deferred_detection_count) = if !needs_deferred {
            // All features are explicitly configured — no detection needed.
            (false, None)
        } else if corpus_count == 0 {
            // Empty corpus: defer detection until DEFERRED_DETECTION_THRESHOLD
            // interesting inputs.
            (false, Some(0))
        } else {
            // Currently unreachable: state is freshly constructed with an empty
            // corpus. Retained as a defensive fallback if future changes introduce
            // pre-populated state.
            (false, None)
        };

        let grimoire_enabled = grimoire_override.unwrap_or(corpus_is_utf8);
        let unicode_enabled = unicode_override.unwrap_or(corpus_is_utf8);
        // REDQUEEN: inverted polarity — enabled for binary (non-UTF-8) corpus.
        let redqueen_enabled =
            redqueen_override.unwrap_or(!corpus_is_utf8 && deferred_detection_count.is_none());

        Self {
            grimoire_enabled,
            unicode_enabled,
            redqueen_enabled,
            grimoire_override,
            unicode_override,
            redqueen_override,
            deferred_detection_count,
            auto_seed_count: 0,
        }
    }

    /// Record an interesting input from the main loop and run deferred detection
    /// if the threshold is reached. Returns `true` if detection resolved.
    pub(crate) fn record_interesting(&mut self, state: &FuzzerState) -> bool {
        if let Some(count) = self.deferred_detection_count.as_mut() {
            *count += 1;
            if *count >= DEFERRED_DETECTION_THRESHOLD {
                let is_utf8 = Self::scan_corpus_utf8(state, self.auto_seed_count);
                // Only override features that were not explicitly configured.
                // Explicit overrides (including explicit `false`) are preserved;
                // only `None` (auto-detect) entries are resolved here.
                if self.grimoire_override.is_none() {
                    self.grimoire_enabled = is_utf8;
                }
                if self.unicode_override.is_none() {
                    self.unicode_enabled = is_utf8;
                }
                // REDQUEEN: inverted polarity — enabled for binary corpus.
                if self.redqueen_override.is_none() {
                    self.redqueen_enabled = !is_utf8;
                }
                self.deferred_detection_count = None;
                return true;
            }
        }
        false
    }

    /// Set the auto-seed count after auto-seeding.
    pub(crate) fn set_auto_seed_count(&mut self, count: usize) {
        self.auto_seed_count = count;
    }

    /// Scan corpus entries for UTF-8 content, skipping the first `skip_count`
    /// entries (used to exclude auto-seeds from deferred detection).
    /// Returns `true` if `utf8_count > non_utf8_count` (strictly greater than).
    ///
    /// Assumes `InMemoryCorpus` yields IDs in insertion order, so `.skip(skip_count)`
    /// correctly skips the first N entries (the auto-seeds).
    pub(crate) fn scan_corpus_utf8(state: &FuzzerState, skip_count: usize) -> bool {
        let mut utf8_count: usize = 0;
        let mut non_utf8_count: usize = 0;
        for id in state.corpus().ids().skip(skip_count) {
            if let Ok(entry) = state.corpus().get(id) {
                let tc = entry.borrow();
                if let Some(input) = tc.input() {
                    let bytes: &[u8] = input.as_ref();
                    if std::str::from_utf8(bytes).is_ok() {
                        utf8_count += 1;
                    } else {
                        non_utf8_count += 1;
                    }
                }
            }
        }
        utf8_count > non_utf8_count
    }
}
