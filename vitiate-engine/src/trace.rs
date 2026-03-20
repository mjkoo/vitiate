use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Record comparison operands for the I2S replacement mutator.
///
/// When a Fuzzer is active (CmpLog enabled), the comparison operands are
/// recorded for use by the I2S replacement mutator. When no Fuzzer is active,
/// this is a no-op. The function never throws - internal errors are silently
/// ignored because the record call precedes the comparison in the IIFE body,
/// and a throw would skip the comparison, changing program control flow.
///
/// @param operatorId - Numeric operator ID (0=`===`, 1=`!==`, 2=`==`, 3=`!=`, 4=`<`, 5=`>`, 6=`<=`, 7=`>=`)
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn trace_cmp_record(
    env: Env,
    left: Unknown,
    right: Unknown,
    #[napi(ts_arg_type = "number")] cmp_id: u32,
    #[napi(ts_arg_type = "number")] operator_id: u32,
) {
    // Errors silently ignored - a throw here would skip the comparison in the IIFE body
    let _: Result<()> = (|| {
        if crate::cmplog::is_site_at_cap(cmp_id) {
            return Ok(());
        }

        let operator = match crate::cmplog::CmpLogOperator::from_id(operator_id) {
            Some(op) => op,
            None => return Ok(()),
        };

        if let Some(entries) =
            crate::cmplog::serialize_to_cmp_values(env.raw(), left.raw(), right.raw())
        {
            for entry in entries {
                crate::cmplog::push(entry, cmp_id, operator);
            }
        }

        Ok(())
    })();
}
