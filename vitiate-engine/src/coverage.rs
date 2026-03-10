use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Validate that a coverage map size is acceptable.
pub(crate) fn validate_coverage_map_size(size: u32) -> std::result::Result<(), &'static str> {
    if size == 0 {
        return Err("Coverage map size must be greater than 0");
    }
    Ok(())
}

#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn create_coverage_map(size: u32) -> Result<Buffer> {
    validate_coverage_map_size(size).map_err(Error::from_reason)?;
    Ok(Buffer::from(vec![0u8; size as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_size_rejected() {
        assert!(validate_coverage_map_size(0).is_err());
    }

    #[test]
    fn test_nonzero_size_accepted() {
        assert!(validate_coverage_map_size(1).is_ok());
        assert!(validate_coverage_map_size(65536).is_ok());
    }
}
