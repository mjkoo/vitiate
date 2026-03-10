use hashbrown::HashMap;

use libafl::HasMetadata;
use libafl::corpus::{Corpus, CorpusId, SchedulerTestcaseMetadata};
use libafl::observers::cmp::{AflppCmpLogHeader, AflppCmpValuesMetadata, CmpValues};
use libafl::schedulers::powersched::N_FUZZ_SIZE;
use libafl::state::HasCorpus;
use libafl_bolts::AsSlice;
use napi::bindgen_prelude::*;

use super::FuzzerState;

/// Set n_fuzz_entry on a corpus entry's SchedulerTestcaseMetadata.
/// Uses the corpus ID as a per-entry index into the n_fuzz frequency array.
/// ProbabilitySamplingScheduler does not implement AflScheduler, so n_fuzz
/// tracking is not automatic. Per-entry indexing (vs. path-hashing) is
/// appropriate for probabilistic selection.
pub(super) fn set_n_fuzz_entry_for_corpus_id(state: &FuzzerState, id: CorpusId) -> Result<()> {
    let mut tc = state
        .corpus()
        .get(id)
        .map_err(|e| Error::from_reason(format!("Failed to get corpus entry: {e}")))?
        .borrow_mut();
    if let Ok(meta) = tc.metadata_mut::<SchedulerTestcaseMetadata>() {
        meta.set_n_fuzz_entry(usize::from(id) % N_FUZZ_SIZE);
    }
    Ok(())
}

/// Extract byte tokens from enriched CmpLog entries for dictionary-based mutations.
///
/// Iterates `CmpValues::Bytes` entries (extracting the `CmpValues` component
/// from enriched tuples) and collects both operands, filtering out empty
/// sequences, all-null byte sequences, and all-0xFF byte sequences.
/// Non-Bytes entries (U8, U16, U32, U64) are skipped — integer comparisons
/// already produce a companion `CmpValues::Bytes` entry with decimal string
/// representations.
pub(super) fn extract_tokens_from_cmplog(entries: &[crate::cmplog::CmpLogEntry]) -> Vec<Vec<u8>> {
    let mut tokens = Vec::new();

    for (cmp_values, _site_id, _operator) in entries {
        if let CmpValues::Bytes((left, right)) = cmp_values {
            for operand in [left, right] {
                let bytes = operand.as_slice();
                // CmplogBytes has a natural 32-byte capacity bound, so no
                // upper-length filter is needed.
                if bytes.is_empty() {
                    continue;
                }
                if bytes.iter().all(|&b| b == 0x00) || bytes.iter().all(|&b| b == 0xFF) {
                    continue;
                }
                tokens.push(bytes.to_vec());
            }
        }
    }

    tokens
}

/// Derive the operand byte size from a `CmpValues` variant.
///
/// Returns the shape value for `AflppCmpLogHeader` (byte size minus 1).
fn cmp_values_shape(cmp_values: &CmpValues) -> u8 {
    match cmp_values {
        CmpValues::U8(_) => 0,  // 1 byte, shape = 0
        CmpValues::U16(_) => 1, // 2 bytes, shape = 1
        CmpValues::U32(_) => 3, // 4 bytes, shape = 3
        CmpValues::U64(_) => 7, // 8 bytes, shape = 7
        CmpValues::Bytes((left, _)) => {
            let len = left.as_slice().len();
            if len == 0 {
                0
            } else {
                u8::try_from(len - 1).unwrap_or(u8::MAX)
            }
        }
    }
}

/// AFL++ CmpLog attribute bitflags (mirrored from
/// `libafl/src/mutators/token_mutations.rs`; not publicly exported by libafl).
const CMP_ATTRIBUTE_IS_EQUAL: u8 = 1;
const CMP_ATTRIBUTE_IS_GREATER: u8 = 2;
const CMP_ATTRIBUTE_IS_LESSER: u8 = 4;

/// Convert a `CmpLogOperator` to the AFL++ CMP_ATTRIBUTE bitflags.
fn operator_to_attribute(op: crate::cmplog::CmpLogOperator) -> u8 {
    use crate::cmplog::CmpLogOperator;
    match op {
        CmpLogOperator::Equal => CMP_ATTRIBUTE_IS_EQUAL,
        CmpLogOperator::NotEqual => 0,
        CmpLogOperator::Greater => CMP_ATTRIBUTE_IS_GREATER,
        CmpLogOperator::Less => CMP_ATTRIBUTE_IS_LESSER,
    }
}

/// Build an `AflppCmpLogHeader` from shape and attribute values.
///
/// Encodes the values into the bitfield format:
/// bits 0-5: hits (0), bits 6-10: shape, bit 11: type_ (0 = cmp),
/// bits 12-15: attribute.
fn build_cmplog_header(shape: u8, attribute: u8) -> AflppCmpLogHeader {
    let raw: u16 = (u16::from(attribute & 0x0F) << 12) | (u16::from(shape & 0x1F) << 6);
    AflppCmpLogHeader::new_with_raw_value(raw)
}

/// Build `AflppCmpValuesMetadata` from enriched CmpLog drain entries.
///
/// Groups entries by site ID into `orig_cmpvals`, derives headers from
/// operator/size, and initializes `new_cmpvals` as empty.
pub(super) fn build_aflpp_cmp_metadata(
    entries: &[crate::cmplog::CmpLogEntry],
) -> AflppCmpValuesMetadata {
    let mut metadata = AflppCmpValuesMetadata::new();
    let mut headers_map: HashMap<usize, AflppCmpLogHeader> = HashMap::new();

    for (cmp_values, site_id, operator) in entries {
        let site = *site_id as usize;
        metadata
            .orig_cmpvals
            .entry(site)
            .or_default()
            .push(cmp_values.clone());

        // Only insert the header once per site (first entry determines it).
        headers_map.entry(site).or_insert_with(|| {
            let shape = cmp_values_shape(cmp_values);
            let attribute = operator_to_attribute(*operator);
            build_cmplog_header(shape, attribute)
        });
    }

    metadata.headers = headers_map.into_iter().collect();
    metadata
}

/// Flatten `AflppCmpValuesMetadata.orig_cmpvals` into a flat `Vec<CmpValues>`
/// for I2S backward compatibility.
pub(super) fn flatten_orig_cmpvals(metadata: &AflppCmpValuesMetadata) -> Vec<CmpValues> {
    metadata
        .orig_cmpvals
        .values()
        .flat_map(|v| v.iter().cloned())
        .collect()
}
