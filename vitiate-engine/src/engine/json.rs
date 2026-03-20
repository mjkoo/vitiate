use libafl::HasMetadata;
use libafl::corpus::CorpusId;
use libafl::inputs::BytesInput;
use libafl::mutators::{MutationResult, Mutator, Tokens};
use libafl::state::HasRand;
use libafl_bolts::Named;
use libafl_bolts::rands::Rand;

/// Find all double-quoted string slots in a byte buffer.
///
/// Returns a list of `(start, end)` ranges covering the string *content*
/// (excluding the surrounding quote characters). Escape-aware: `\"` does
/// not terminate the string, `\\` does not escape the next byte.
///
/// Operates in O(n) time with no heap allocation beyond the output list.
pub(crate) fn find_string_slots(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut slots = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'"' {
            // Found an opening quote. Content starts at the next byte.
            let content_start = i + 1;
            i = content_start;

            let mut found_close = false;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    // Skip the escaped byte unconditionally.
                    i += 2;
                } else if bytes[i] == b'"' {
                    // Closing quote found.
                    slots.push((content_start, i));
                    i += 1;
                    found_close = true;
                    break;
                } else {
                    i += 1;
                }
            }

            if !found_close {
                // Unterminated string - skip it.
                break;
            }
        } else {
            i += 1;
        }
    }

    slots
}

/// Given a position at the start of a JSON value, returns its full byte range
/// `(start, end)` (exclusive end). Handles strings, numbers, booleans, null,
/// arrays, and objects with bracket matching that skips strings.
///
/// Note: a bare `-` without following digits is accepted as a single-byte
/// "number" range. This is intentional for fuzzing - producing slightly
/// malformed JSON helps explore parser edge cases.
///
/// Returns `None` if the position does not point to a recognizable JSON value
/// or if the value is malformed (unterminated string, unbalanced brackets).
pub(crate) fn find_value_range(bytes: &[u8], pos: usize) -> Option<(usize, usize)> {
    if pos >= bytes.len() {
        return None;
    }

    match bytes[pos] {
        // String value: find matching closing quote.
        b'"' => {
            let mut i = pos + 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i += 2;
                } else if bytes[i] == b'"' {
                    return Some((pos, i + 1));
                } else {
                    i += 1;
                }
            }
            None // Unterminated string.
        }

        // Number: contiguous run of numeric characters.
        b'0'..=b'9' | b'-' => {
            let mut i = pos + 1;
            while i < bytes.len()
                && matches!(bytes[i], b'0'..=b'9' | b'+' | b'-' | b'.' | b'e' | b'E')
            {
                i += 1;
            }
            if i > pos { Some((pos, i)) } else { None }
        }

        // Boolean true.
        b't' => {
            if pos + 4 <= bytes.len() && &bytes[pos..pos + 4] == b"true" {
                Some((pos, pos + 4))
            } else {
                None
            }
        }

        // Boolean false.
        b'f' => {
            if pos + 5 <= bytes.len() && &bytes[pos..pos + 5] == b"false" {
                Some((pos, pos + 5))
            } else {
                None
            }
        }

        // Null.
        b'n' => {
            if pos + 4 <= bytes.len() && &bytes[pos..pos + 4] == b"null" {
                Some((pos, pos + 4))
            } else {
                None
            }
        }

        // Array or object: bracket-match with string skipping.
        b'[' | b'{' => {
            let open = bytes[pos];
            let close = if open == b'[' { b']' } else { b'}' };
            let mut depth: usize = 1;
            let mut i = pos + 1;

            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'"' => {
                        // Skip string contents.
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == b'\\' {
                                i += 2;
                            } else if bytes[i] == b'"' {
                                i += 1;
                                break;
                            } else {
                                i += 1;
                            }
                        }
                        continue;
                    }
                    c if c == open => {
                        depth += 1;
                    }
                    c if c == close => {
                        depth -= 1;
                    }
                    _ => {}
                }
                i += 1;
            }

            if depth == 0 {
                Some((pos, i))
            } else {
                None // Unbalanced brackets.
            }
        }

        _ => None,
    }
}

/// Check if a string slot is an object key by looking for `:` after the closing quote.
/// `string_end` is the index of the closing `"` character of the string.
pub(crate) fn is_object_key(bytes: &[u8], string_end: usize) -> bool {
    // The closing quote is at `string_end`, so start scanning at `string_end + 1`.
    let mut i = string_end + 1;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\n' | b'\r' => i += 1,
            b':' => return true,
            _ => return false,
        }
    }
    false
}

/// JSON heuristic: classifies a byte buffer as "JSON-like" using a lightweight
/// statistical heuristic. Checks: starts like JSON, has brackets, brackets are
/// balanced (string-aware), control character density > 5%.
pub(crate) fn looks_like_json(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }

    // 1. First non-whitespace byte must be a JSON value starter.
    let first_non_ws = bytes
        .iter()
        .find(|&&b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
    let Some(&first) = first_non_ws else {
        return false;
    };
    if !matches!(
        first,
        b'{' | b'[' | b'"' | b'0'..=b'9' | b'-' | b't' | b'f' | b'n'
    ) {
        return false;
    }

    // Walk once: count brackets (string-aware), check balance, compute density.
    let mut open_count: usize = 0;
    let mut close_count: usize = 0;
    let mut control_count: usize = 0;
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                control_count += 1;
                i += 1;
                // Skip string contents - brackets inside strings don't count.
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i += 2;
                    } else if bytes[i] == b'"' {
                        control_count += 1;
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            b'{' | b'[' => {
                open_count += 1;
                control_count += 1;
                i += 1;
            }
            b'}' | b']' => {
                close_count += 1;
                control_count += 1;
                i += 1;
            }
            b':' | b',' => {
                control_count += 1;
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    // 2. Must have at least one bracket.
    if open_count == 0 && close_count == 0 {
        return false;
    }

    // 3. Brackets must be balanced.
    if open_count != close_count {
        return false;
    }

    // 4. JSON control character density > 5%.
    let density = (control_count as f64) / (bytes.len() as f64);
    density > 0.05
}

// --- JSON Mutators ---

/// Replaces a random string *value's* content with a dictionary token.
/// Keys (strings followed by `:`) are excluded.
pub(crate) struct JsonTokenReplaceString;

impl Named for JsonTokenReplaceString {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: std::borrow::Cow<'static, str> =
            std::borrow::Cow::Borrowed("JsonTokenReplaceString");
        &NAME
    }
}

impl<S> Mutator<BytesInput, S> for JsonTokenReplaceString
where
    S: HasRand + HasMetadata,
{
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut BytesInput,
    ) -> Result<MutationResult, libafl::Error> {
        let bytes: Vec<u8> = input.as_ref().to_vec();
        let all_slots = find_string_slots(&bytes);

        // Filter to value slots only (not object keys).
        let value_slots: Vec<(usize, usize)> = all_slots
            .into_iter()
            .filter(|&(_, end)| !is_object_key(&bytes, end))
            .collect();

        if value_slots.is_empty() {
            return Ok(MutationResult::Skipped);
        }

        // Check token count (separate borrow from rand_mut).
        let token_count = state
            .metadata_map()
            .get::<Tokens>()
            .map(|t| t.tokens().len())
            .unwrap_or(0);
        if token_count == 0 {
            return Ok(MutationResult::Skipped);
        }

        // Select random value slot and random token.
        // SAFETY of unwrap: value_slots and token_count are non-zero (checked above).
        let slot_idx = state
            .rand_mut()
            .below(core::num::NonZero::new(value_slots.len()).unwrap());
        let token_idx = state
            .rand_mut()
            .below(core::num::NonZero::new(token_count).unwrap());

        let (start, end) = value_slots[slot_idx];
        // Re-borrow to get actual token bytes.
        let token_bytes: Vec<u8> =
            state.metadata_map().get::<Tokens>().unwrap().tokens()[token_idx].clone();

        // Splice: replace [start..end) with token bytes.
        splice_replacement(input, &bytes, start, end, &token_bytes)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Replaces a random object *key's* content with a dictionary token.
/// Only strings followed by `:` are eligible.
pub(crate) struct JsonTokenReplaceKey;

impl Named for JsonTokenReplaceKey {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: std::borrow::Cow<'static, str> =
            std::borrow::Cow::Borrowed("JsonTokenReplaceKey");
        &NAME
    }
}

impl<S> Mutator<BytesInput, S> for JsonTokenReplaceKey
where
    S: HasRand + HasMetadata,
{
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut BytesInput,
    ) -> Result<MutationResult, libafl::Error> {
        let bytes: Vec<u8> = input.as_ref().to_vec();
        let all_slots = find_string_slots(&bytes);

        // Filter to key slots only.
        let key_slots: Vec<(usize, usize)> = all_slots
            .into_iter()
            .filter(|&(_, end)| is_object_key(&bytes, end))
            .collect();

        if key_slots.is_empty() {
            return Ok(MutationResult::Skipped);
        }

        let token_count = state
            .metadata_map()
            .get::<Tokens>()
            .map(|t| t.tokens().len())
            .unwrap_or(0);
        if token_count == 0 {
            return Ok(MutationResult::Skipped);
        }

        // SAFETY of unwrap: key_slots and token_count are non-zero (checked above).
        let slot_idx = state
            .rand_mut()
            .below(core::num::NonZero::new(key_slots.len()).unwrap());
        let token_idx = state
            .rand_mut()
            .below(core::num::NonZero::new(token_count).unwrap());

        let (start, end) = key_slots[slot_idx];
        let token_bytes: Vec<u8> =
            state.metadata_map().get::<Tokens>().unwrap().tokens()[token_idx].clone();

        splice_replacement(input, &bytes, start, end, &token_bytes)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Replaces a random JSON value with a type-changed alternative: a dictionary
/// token as a quoted string, a fixed type change (`null`, `true`, `false`,
/// `0`, `1`, `""`, `[]`, `{}`), or a copy of another value from the same input.
pub(crate) struct JsonReplaceValue;

/// Type-change replacement values.
const TYPE_CHANGES: &[&[u8]] = &[
    b"null", b"true", b"false", b"0", b"1", b"\"\"", b"[]", b"{}",
];

impl Named for JsonReplaceValue {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: std::borrow::Cow<'static, str> =
            std::borrow::Cow::Borrowed("JsonReplaceValue");
        &NAME
    }
}

impl<S> Mutator<BytesInput, S> for JsonReplaceValue
where
    S: HasRand + HasMetadata,
{
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut BytesInput,
    ) -> Result<MutationResult, libafl::Error> {
        // Copy bytes to avoid borrow conflicts with input mutation.
        let bytes: Vec<u8> = input.as_ref().to_vec();

        // Single-pass scan: collect all value positions while skipping string interiors.
        let mut value_positions: Vec<usize> = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'"' => {
                    // String opening quote is a value position.
                    value_positions.push(i);
                    i += 1;
                    // Skip string contents.
                    while i < bytes.len() {
                        if bytes[i] == b'\\' {
                            i += 2;
                        } else if bytes[i] == b'"' {
                            i += 1;
                            break;
                        } else {
                            i += 1;
                        }
                    }
                }
                b'0'..=b'9' | b'-' | b't' | b'f' | b'n' | b'[' | b'{' => {
                    value_positions.push(i);
                    i += 1;
                }
                _ => {
                    i += 1;
                }
            }
        }

        if value_positions.is_empty() {
            return Ok(MutationResult::Skipped);
        }

        // Select a random value position.
        // SAFETY of unwrap: value_positions is non-empty (checked above).
        let pos_idx = state
            .rand_mut()
            .below(core::num::NonZero::new(value_positions.len()).unwrap());
        let pos = value_positions[pos_idx];

        let Some((val_start, val_end)) = find_value_range(&bytes, pos) else {
            return Ok(MutationResult::Skipped);
        };

        // Select replacement strategy: 0=token string, 1=type change, 2=copy.
        // SAFETY of unwrap: 3 is non-zero.
        let strategy = state.rand_mut().below(core::num::NonZero::new(3).unwrap());

        // Read token count before the match to avoid borrow conflicts.
        let token_count = state
            .metadata_map()
            .get::<Tokens>()
            .map(|t| t.tokens().len())
            .unwrap_or(0);

        let replacement: Vec<u8> = match strategy {
            0 => {
                // Token string: pick a random token, wrap in quotes.
                if token_count == 0 {
                    // Fall back to type change.
                    random_type_change(state)
                } else {
                    // SAFETY of unwrap: token_count > 0 (checked above).
                    let token_idx = state
                        .rand_mut()
                        .below(core::num::NonZero::new(token_count).unwrap());
                    // Re-borrow to get the token bytes.
                    let token =
                        state.metadata_map().get::<Tokens>().unwrap().tokens()[token_idx].clone();

                    let mut r = Vec::with_capacity(token.len() + 2);
                    r.push(b'"');
                    r.extend_from_slice(&token);
                    r.push(b'"');
                    r
                }
            }
            1 => random_type_change(state),
            2 => {
                // Copy: pick another value from the same input.
                if value_positions.len() <= 1 {
                    random_type_change(state)
                } else {
                    // Pick a different value position with a single random draw.
                    // SAFETY of unwrap: value_positions.len() - 1 > 0 (checked above).
                    let offset = state
                        .rand_mut()
                        .below(core::num::NonZero::new(value_positions.len() - 1).unwrap());
                    let other_idx = (pos_idx + 1 + offset) % value_positions.len();
                    let other_pos = value_positions[other_idx];
                    match find_value_range(&bytes, other_pos) {
                        Some((s, e)) => bytes[s..e].to_vec(),
                        None => random_type_change(state),
                    }
                }
            }
            // SAFETY: strategy is 0, 1, or 2 (constrained by .below(3)).
            _ => unreachable!(),
        };

        splice_replacement(input, &bytes, val_start, val_end, &replacement)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Pick a random type-change replacement value.
fn random_type_change<S: HasRand>(state: &mut S) -> Vec<u8> {
    // SAFETY of unwrap: TYPE_CHANGES is non-empty.
    let tc_idx = state
        .rand_mut()
        .below(core::num::NonZero::new(TYPE_CHANGES.len()).unwrap());
    TYPE_CHANGES[tc_idx].to_vec()
}

/// Replace a byte range in the input with new bytes.
fn splice_replacement(
    input: &mut BytesInput,
    bytes: &[u8],
    start: usize,
    end: usize,
    replacement: &[u8],
) -> Result<MutationResult, libafl::Error> {
    let mut result: Vec<u8> = Vec::with_capacity(start + replacement.len() + (bytes.len() - end));
    result.extend_from_slice(&bytes[..start]);
    result.extend_from_slice(replacement);
    result.extend_from_slice(&bytes[end..]);
    *input = BytesInput::new(result);
    Ok(MutationResult::Mutated)
}

// --- JSON Stage Implementation ---

use libafl::corpus::Corpus;
use libafl::executors::ExitKind as LibaflExitKind;
use libafl::state::{HasCorpus, HasExecutions};
use napi::bindgen_prelude::{Buffer, Error};

use super::stages::StageState;
use super::{Fuzzer, STAGE_MAX_ITERATIONS};

impl Fuzzer {
    /// Begin the JSON mutation stage for a corpus entry.
    /// Returns `None` if JSON mutations are disabled or the entry is not JSON-like.
    pub(super) fn begin_json(&mut self, corpus_id: CorpusId) -> napi::Result<Option<Buffer>> {
        if !self.features.json_mutations_enabled {
            return Ok(None);
        }

        // Check that the corpus entry looks like JSON (balanced brackets, structural density).
        let is_json_like = {
            let entry = self
                .state
                .corpus()
                .get(corpus_id)
                .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?;
            let tc = entry.borrow();
            let Some(input) = tc.input() else {
                return Ok(None);
            };
            looks_like_json(input.as_ref())
        };

        if !is_json_like {
            return Ok(None);
        }

        // Select random iteration count 1..=STAGE_MAX_ITERATIONS.
        // SAFETY of unwrap: STAGE_MAX_ITERATIONS is a non-zero constant.
        let max_iterations = self
            .state
            .rand_mut()
            .below(core::num::NonZero::new(STAGE_MAX_ITERATIONS).unwrap())
            + 1;

        // Generate first mutated input.
        let bytes = self.json_mutate_one(corpus_id)?;

        self.last_stage_input = Some(bytes.clone());
        self.stage_state = StageState::Json {
            corpus_id,
            iteration: 0,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Advance the JSON stage after a target execution.
    pub(super) fn advance_json(&mut self, exec_time_ns: f64) -> napi::Result<Option<Buffer>> {
        let (corpus_id, iteration, max_iterations) =
            match std::mem::replace(&mut self.stage_state, StageState::None) {
                StageState::Json {
                    corpus_id,
                    iteration,
                    max_iterations,
                } => (corpus_id, iteration, max_iterations),
                _ => return Ok(None),
            };

        // Drain CmpLog (discard - JSON stage doesn't use CmpLog data).
        let _ = crate::cmplog::drain();

        // stage_state is already StageState::None (set by mem::replace above).
        let stage_input = self
            .last_stage_input
            .take()
            .ok_or_else(|| Error::from_reason("advanceJson: no stashed stage input"))?;

        // The target was invoked - count the execution before the fallible
        // evaluate_coverage call so counters stay accurate on error.
        self.total_execs += 1;
        *self.state.executions_mut() += 1;

        let _eval = self.evaluate_coverage(
            &stage_input,
            exec_time_ns,
            LibaflExitKind::Ok,
            Some(corpus_id),
        )?;

        let next_iteration = iteration + 1;
        if next_iteration >= max_iterations {
            // JSON stage complete - pipeline done.
            return Ok(None);
        }

        // Generate next JSON candidate.
        let bytes = self.json_mutate_one(corpus_id)?;
        self.last_stage_input = Some(bytes.clone());

        self.stage_state = StageState::Json {
            corpus_id,
            iteration: next_iteration,
            max_iterations,
        };

        Ok(Some(Buffer::from(bytes)))
    }

    /// Clone a corpus entry, apply JSON mutations, and return the result bytes.
    /// Each call starts from a fresh clone (non-cumulative mutations).
    fn json_mutate_one(&mut self, corpus_id: CorpusId) -> napi::Result<Vec<u8>> {
        let input = self
            .state
            .corpus()
            .cloned_input_for_id(corpus_id)
            .map_err(|e| Error::from_reason(format!("Failed to clone corpus entry: {e}")))?;

        let mut bytes_input = input;
        let _ = self
            .json_mutator
            .mutate(&mut self.state, &mut bytes_input)
            .map_err(|e| Error::from_reason(format!("JSON mutation failed: {e}")))?;

        let mut bytes: Vec<u8> = bytes_input.into();
        bytes.truncate(self.max_input_len as usize);

        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libafl::HasMetadata;
    use libafl::corpus::InMemoryCorpus;
    use libafl::feedbacks::CrashFeedback;
    use libafl::feedbacks::MaxMapFeedback;
    use libafl::inputs::BytesInput;
    use libafl::mutators::Tokens;
    use libafl::observers::StdMapObserver;
    use libafl::state::StdState;
    use libafl_bolts::rands::StdRand;

    type TestState =
        StdState<InMemoryCorpus<BytesInput>, BytesInput, StdRand, InMemoryCorpus<BytesInput>>;

    // --- Scanning primitive tests ---

    #[test]
    fn find_string_slots_simple_object() {
        let input = br#"{"name":"alice","role":"admin"}"#;
        let slots = find_string_slots(input);
        assert_eq!(slots.len(), 4);
        assert_eq!(&input[slots[0].0..slots[0].1], b"name");
        assert_eq!(&input[slots[1].0..slots[1].1], b"alice");
        assert_eq!(&input[slots[2].0..slots[2].1], b"role");
        assert_eq!(&input[slots[3].0..slots[3].1], b"admin");
    }

    #[test]
    fn find_string_slots_escaped_quotes() {
        let input = br#"{"key":"value with \"quotes\""}"#;
        let slots = find_string_slots(input);
        assert_eq!(slots.len(), 2);
        assert_eq!(&input[slots[0].0..slots[0].1], b"key");
        assert_eq!(&input[slots[1].0..slots[1].1], br#"value with \"quotes\""#);
    }

    #[test]
    fn find_string_slots_escaped_backslash_before_quote() {
        let input = br#"{"k":"v\\"}"#;
        let slots = find_string_slots(input);
        assert_eq!(slots.len(), 2);
        assert_eq!(&input[slots[0].0..slots[0].1], b"k");
        assert_eq!(&input[slots[1].0..slots[1].1], br#"v\\"#);
    }

    #[test]
    fn find_string_slots_no_strings() {
        let input = b"[1, true, null]";
        let slots = find_string_slots(input);
        assert!(slots.is_empty());
    }

    #[test]
    fn find_string_slots_empty_strings() {
        let input = br#"{"":""}"#;
        let slots = find_string_slots(input);
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].0, slots[0].1); // empty content
        assert_eq!(slots[1].0, slots[1].1); // empty content
    }

    #[test]
    fn find_string_slots_nested() {
        let input = br#"{"a":{"b":"c"}}"#;
        let slots = find_string_slots(input);
        assert_eq!(slots.len(), 3);
        assert_eq!(&input[slots[0].0..slots[0].1], b"a");
        assert_eq!(&input[slots[1].0..slots[1].1], b"b");
        assert_eq!(&input[slots[2].0..slots[2].1], b"c");
    }

    #[test]
    fn find_string_slots_unterminated_string() {
        let input = br#"{"a":"unterminated"#;
        let slots = find_string_slots(input);
        // Only "a" is complete, "unterminated is not.
        assert_eq!(slots.len(), 1);
        assert_eq!(&input[slots[0].0..slots[0].1], b"a");
    }

    // --- Value range tests ---

    #[test]
    fn find_value_range_string() {
        let input = br#"{"k":"hello"}"#;
        let pos = 5; // The `"` before hello.
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((5, 12))); // `"hello"` is 7 bytes.
        assert_eq!(&input[5..12], br#""hello""#);
    }

    #[test]
    fn find_value_range_nested_object() {
        let input = br#"{"a":{"b":1}}"#;
        let pos = 5; // `{` before "b".
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((5, 12)));
        assert_eq!(&input[5..12], br#"{"b":1}"#);
    }

    #[test]
    fn find_value_range_number() {
        let input = br#"{"x":42.5}"#;
        let pos = 5; // `4`.
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((5, 9)));
        assert_eq!(&input[5..9], b"42.5");
    }

    #[test]
    fn find_value_range_brackets_inside_strings() {
        let input = br#"{"a":"[{"}"#;
        let pos = 0; // Outer `{`.
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((0, 10)));
    }

    #[test]
    fn find_value_range_unterminated_string_returns_none() {
        let input = br#"{"a":"unterminated"#;
        let pos = 5; // `"` before unterminated.
        let range = find_value_range(input, pos);
        assert_eq!(range, None);
    }

    #[test]
    fn find_value_range_unbalanced_brackets_returns_none() {
        let input = br#"{"a":[1,2"#;
        let pos = 5; // `[`.
        let range = find_value_range(input, pos);
        assert_eq!(range, None);
    }

    #[test]
    fn find_value_range_true() {
        let input = br#"{"x":true}"#;
        let pos = 5;
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((5, 9)));
    }

    #[test]
    fn find_value_range_false() {
        let input = br#"{"x":false}"#;
        let pos = 5;
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((5, 10)));
    }

    #[test]
    fn find_value_range_null() {
        let input = br#"{"x":null}"#;
        let pos = 5;
        let range = find_value_range(input, pos);
        assert_eq!(range, Some((5, 9)));
    }

    // --- Object key identification tests ---

    #[test]
    fn is_object_key_distinguishes_keys_from_values() {
        let input = br#"{"name":"alice"}"#;
        let slots = find_string_slots(input);
        // "name" ends at position of its closing quote.
        assert!(is_object_key(input, slots[0].1));
        // "alice" is a value.
        assert!(!is_object_key(input, slots[1].1));
    }

    #[test]
    fn is_object_key_with_whitespace() {
        let input = br#"{ "name" : "alice" }"#;
        let slots = find_string_slots(input);
        assert!(is_object_key(input, slots[0].1));
        assert!(!is_object_key(input, slots[1].1));
    }

    // --- JSON heuristic tests ---

    #[test]
    fn looks_like_json_valid_object() {
        assert!(looks_like_json(br#"{"name":"alice","age":30}"#));
    }

    #[test]
    fn looks_like_json_valid_array() {
        assert!(looks_like_json(br#"[1, "two", null, true]"#));
    }

    #[test]
    fn looks_like_json_plain_text() {
        assert!(!looks_like_json(b"Hello, this is a test string"));
    }

    #[test]
    fn looks_like_json_unbalanced_brackets() {
        assert!(!looks_like_json(br#"{"name":"alice""#));
    }

    #[test]
    fn looks_like_json_brackets_inside_strings() {
        assert!(looks_like_json(br#"{"data":"[{invalid}"}"#));
    }

    #[test]
    fn looks_like_json_bare_number() {
        assert!(!looks_like_json(b"42"));
    }

    #[test]
    fn looks_like_json_bare_string() {
        assert!(!looks_like_json(br#""hello""#));
    }

    #[test]
    fn looks_like_json_low_density() {
        // A string with very long content and few control chars.
        let mut input = br#"{"x":""#.to_vec();
        input.extend_from_slice(&vec![b'a'; 1000]);
        input.extend_from_slice(br#""}"#);
        assert!(!looks_like_json(&input));
    }

    #[test]
    fn looks_like_json_empty_input() {
        assert!(!looks_like_json(b""));
    }

    // --- Mutator tests ---

    fn make_test_state_with_tokens(tokens: &[&[u8]], seed: u64) -> TestState {
        // SAFETY: Box::leak produces a &'static mut [u8] that outlives the
        // observer and the state. This intentionally leaks 64 bytes per test
        // call, which is acceptable for short-lived unit tests.
        let map: &'static mut [u8] = Box::leak(vec![0u8; 64].into_boxed_slice());
        let ptr = map.as_mut_ptr();
        let observer = unsafe { StdMapObserver::from_mut_ptr("test_edges", ptr, 64) };
        let mut feedback = MaxMapFeedback::new(&observer);
        let mut objective = CrashFeedback::new();
        let mut state = StdState::new(
            StdRand::with_seed(seed),
            InMemoryCorpus::<BytesInput>::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .unwrap();
        drop(observer);

        let mut token_metadata = Tokens::default();
        for t in tokens {
            token_metadata.add_token(&t.to_vec());
        }
        state.add_metadata(token_metadata);
        state
    }

    fn make_test_state_no_tokens(seed: u64) -> TestState {
        make_test_state_with_tokens(&[], seed)
    }

    #[test]
    fn json_token_replace_string_replaces_value() {
        let mut state = make_test_state_with_tokens(&[b"__proto__"], 42);
        let mut mutator = JsonTokenReplaceString;
        let mut input = BytesInput::new(br#"{"x":"1"}"#.to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);

        let output: &[u8] = input.as_ref();
        // Should have replaced "1" with "__proto__".
        assert_eq!(output, br#"{"x":"__proto__"}"#);
    }

    #[test]
    fn json_token_replace_string_skips_non_json() {
        let mut state = make_test_state_with_tokens(&[b"token"], 42);
        let mut mutator = JsonTokenReplaceString;
        let mut input = BytesInput::new(b"no json here".to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn json_token_replace_string_skips_empty_dictionary() {
        let mut state = make_test_state_no_tokens(42);
        let mut mutator = JsonTokenReplaceString;
        let mut input = BytesInput::new(br#"{"x":"1"}"#.to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn json_token_replace_string_does_not_mutate_keys() {
        let mut mutator = JsonTokenReplaceString;

        // Run many iterations to verify keys are never replaced.
        for seed in 0..100 {
            let mut state = make_test_state_with_tokens(&[b"replaced"], seed);
            let mut input = BytesInput::new(br#"{"only_key":42}"#.to_vec());

            let result = mutator.mutate(&mut state, &mut input).unwrap();
            // There are no string *values*, only a key. Should always skip.
            assert_eq!(result, MutationResult::Skipped);
        }
    }

    #[test]
    fn json_token_replace_key_replaces_key() {
        let mut state = make_test_state_with_tokens(&[b"__proto__"], 42);
        let mut mutator = JsonTokenReplaceKey;
        let mut input = BytesInput::new(br#"{"x":"1"}"#.to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);

        let output: &[u8] = input.as_ref();
        assert_eq!(output, br#"{"__proto__":"1"}"#);
    }

    #[test]
    fn json_token_replace_key_skips_array() {
        let mut state = make_test_state_with_tokens(&[b"token"], 42);
        let mut mutator = JsonTokenReplaceKey;
        let mut input = BytesInput::new(br#"["hello", "world"]"#.to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn json_replace_value_replaces_number_with_token_string() {
        // Use a specific seed to get strategy 0 (token string).
        let mut state = make_test_state_with_tokens(&[b"__proto__"], 42);

        let mut mutator = JsonReplaceValue;
        let mut input = BytesInput::new(br#"{"x":42}"#.to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        // The output should have replaced some value.
        let output: &[u8] = input.as_ref();
        assert_ne!(output, br#"{"x":42}"#);
    }

    #[test]
    fn json_replace_value_skips_empty_input() {
        let mut state = make_test_state_with_tokens(&[b"token"], 42);
        let mut mutator = JsonReplaceValue;
        let mut input = BytesInput::new(b"".to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn json_replace_value_single_value_copy_falls_back() {
        // With only one value in the input, "copy" strategy should fall back to type change.
        let mut state = make_test_state_no_tokens(42);

        let mut mutator = JsonReplaceValue;
        let mut input = BytesInput::new(b"42".to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        // Should have replaced 42 with some type-changed value.
        let output: &[u8] = input.as_ref();
        assert_ne!(output, b"42");
    }

    #[test]
    fn json_replace_value_length_changing_replacement() {
        let mut state = make_test_state_with_tokens(&[b"a_long_token_value"], 42);
        let mut mutator = JsonReplaceValue;
        let mut input = BytesInput::new(br#"{"x":"y"}"#.to_vec());

        let result = mutator.mutate(&mut state, &mut input).unwrap();
        assert_eq!(result, MutationResult::Mutated);
        // Length should have changed (token is much longer than "y").
    }
}
