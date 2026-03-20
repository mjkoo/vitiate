use libafl::corpus::Corpus;
use libafl::state::HasCorpus;

use super::FuzzerState;
use super::json::looks_like_json;

/// Number of interesting main-loop inputs before deferred auto-detection fires.
pub(super) const DEFERRED_DETECTION_THRESHOLD: usize = 10;

/// Tracks auto-detection state for Grimoire, unicode, REDQUEEN, and JSON features.
/// Features can be explicitly configured (override) or auto-detected based on
/// corpus content after a deferred threshold.
pub(super) struct FeatureDetection {
    /// Whether Grimoire structure-aware fuzzing is enabled.
    pub(super) grimoire_enabled: bool,
    /// Whether unicode-aware mutations are enabled.
    pub(super) unicode_enabled: bool,
    /// Whether REDQUEEN is enabled.
    pub(super) redqueen_enabled: bool,
    /// Whether JSON-aware mutations are enabled.
    pub(super) json_mutations_enabled: bool,
    /// Original config override for grimoire. `None` = auto-detect.
    pub(super) grimoire_override: Option<bool>,
    /// Original config override for unicode. `None` = auto-detect.
    pub(super) unicode_override: Option<bool>,
    /// Original config override for redqueen. `None` = auto-detect.
    pub(super) redqueen_override: Option<bool>,
    /// Original config override for json_mutations. `None` = auto-detect.
    pub(super) json_mutations_override: Option<bool>,
    /// Count of interesting inputs for deferred detection. `None` = resolved.
    pub(super) deferred_detection_count: Option<usize>,
    /// Number of auto-seeded corpus entries to skip during scanning.
    /// Auto-seeds (detector seeds + default seeds) are all valid UTF-8 and
    /// would bias detection toward text-mode features if included.
    pub(super) auto_seed_count: usize,
}

impl FeatureDetection {
    /// Create feature detection state from config overrides and current corpus count.
    pub(super) fn new(
        grimoire_override: Option<bool>,
        unicode_override: Option<bool>,
        redqueen_override: Option<bool>,
        json_mutations_override: Option<bool>,
        corpus_count: usize,
    ) -> Self {
        let grimoire_needs_detection = grimoire_override.is_none();
        let unicode_needs_detection = unicode_override.is_none();
        let redqueen_needs_detection = redqueen_override.is_none();
        let json_needs_detection = json_mutations_override.is_none();
        let needs_deferred = grimoire_needs_detection
            || unicode_needs_detection
            || redqueen_needs_detection
            || json_needs_detection;

        let (corpus_is_utf8, deferred_detection_count) = if !needs_deferred {
            // All features are explicitly configured - no detection needed.
            (false, None)
        } else if corpus_count == 0 {
            // Empty corpus: defer detection until DEFERRED_DETECTION_THRESHOLD
            // interesting inputs.
            (false, Some(0))
        } else {
            // Pre-populated corpus: defer detection just like the empty case.
            // The scan needs `&FuzzerState` which isn't available yet at
            // construction, so we defer and scan once the threshold is reached.
            // Currently unreachable (state is freshly constructed with an empty
            // corpus), but correct if future changes introduce pre-populated state.
            (false, Some(0))
        };

        let grimoire_enabled = grimoire_override.unwrap_or(corpus_is_utf8);
        let unicode_enabled = unicode_override.unwrap_or(corpus_is_utf8);
        // REDQUEEN: inverted polarity - enabled for binary (non-UTF-8) corpus.
        let redqueen_enabled =
            redqueen_override.unwrap_or(!corpus_is_utf8 && deferred_detection_count.is_none());
        // JSON mutations: disabled by default until deferred detection resolves.
        let json_mutations_enabled = json_mutations_override.unwrap_or(false);

        Self {
            grimoire_enabled,
            unicode_enabled,
            redqueen_enabled,
            json_mutations_enabled,
            grimoire_override,
            unicode_override,
            redqueen_override,
            json_mutations_override,
            deferred_detection_count,
            auto_seed_count: 0,
        }
    }

    /// Set the auto-seed count after seed composition completes.
    pub(super) fn set_auto_seed_count(&mut self, count: usize) {
        self.auto_seed_count = count;
    }

    /// Record an interesting input from the main loop and run deferred detection
    /// if the threshold is reached. Returns `true` if detection resolved.
    pub(super) fn record_interesting(&mut self, state: &FuzzerState) -> bool {
        if let Some(count) = self.deferred_detection_count.as_mut() {
            *count += 1;
            if *count >= DEFERRED_DETECTION_THRESHOLD {
                let (is_utf8, json_like_count, utf8_count) =
                    Self::scan_corpus(state, self.auto_seed_count);
                // Only override features that were not explicitly configured.
                // Explicit overrides (including explicit `false`) are preserved;
                // only `None` (auto-detect) entries are resolved here.
                if self.grimoire_override.is_none() {
                    self.grimoire_enabled = is_utf8;
                }
                if self.unicode_override.is_none() {
                    self.unicode_enabled = is_utf8;
                }
                // REDQUEEN: inverted polarity - enabled for binary corpus.
                if self.redqueen_override.is_none() {
                    self.redqueen_enabled = !is_utf8;
                }
                // JSON: enabled if majority of UTF-8 entries are JSON-like.
                if self.json_mutations_override.is_none() {
                    self.json_mutations_enabled =
                        utf8_count > 0 && json_like_count > utf8_count / 2;
                }
                self.deferred_detection_count = None;
                return true;
            }
        }
        false
    }

    /// Scan corpus entries for UTF-8 content and JSON-like classification,
    /// skipping the first `skip_count` entries (auto-seeds that would bias
    /// detection toward text-mode features).
    /// Returns `(is_utf8_majority, json_like_count, utf8_count)`.
    ///
    /// Assumes `InMemoryCorpus` yields IDs in insertion order, so `.skip(skip_count)`
    /// correctly skips the first N entries (the auto-seeds).
    pub(super) fn scan_corpus(state: &FuzzerState, skip_count: usize) -> (bool, usize, usize) {
        let mut utf8_count: usize = 0;
        let mut non_utf8_count: usize = 0;
        let mut json_like_count: usize = 0;

        for id in state.corpus().ids().skip(skip_count) {
            if let Ok(entry) = state.corpus().get(id) {
                let tc = entry.borrow();
                if let Some(input) = tc.input() {
                    let bytes: &[u8] = input.as_ref();
                    if std::str::from_utf8(bytes).is_ok() {
                        utf8_count += 1;
                        if looks_like_json(bytes) {
                            json_like_count += 1;
                        }
                    } else {
                        non_utf8_count += 1;
                    }
                }
            }
        }
        (utf8_count > non_utf8_count, json_like_count, utf8_count)
    }
}
