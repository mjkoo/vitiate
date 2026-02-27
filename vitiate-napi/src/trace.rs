use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Perform a JS comparison and return the boolean result.
///
/// When a Fuzzer is active (CmpLog enabled), the comparison operands are
/// recorded for use by the I2S replacement mutator. When no Fuzzer is active,
/// this is a pure passthrough with no side effects beyond the comparison.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn trace_cmp(
    env: Env,
    left: Unknown,
    right: Unknown,
    #[napi(ts_arg_type = "number")] _cmp_id: u32,
    op: String,
) -> Result<bool> {
    if crate::cmplog::is_enabled()
        && let Some(entries) =
            crate::cmplog::serialize_to_cmp_values(env.raw(), left.raw(), right.raw())
    {
        for entry in entries {
            crate::cmplog::push(entry);
        }
    }

    match op.as_str() {
        "===" => env.strict_equals(left, right),
        "!==" => env.strict_equals(left, right).map(|v| !v),
        "==" => eval_comparison(&env, left, right, "=="),
        "!=" => eval_comparison(&env, left, right, "!="),
        "<" => eval_comparison(&env, left, right, "<"),
        ">" => eval_comparison(&env, left, right, ">"),
        "<=" => eval_comparison(&env, left, right, "<="),
        ">=" => eval_comparison(&env, left, right, ">="),
        _ => Err(Error::from_reason(format!(
            "trace_cmp: unknown operator: {op}"
        ))),
    }
}

const KNOWN_OPS: &[&str] = &["==", "!=", "<", ">", "<=", ">="];

/// Evaluate a comparison by creating a JS function and calling it with the operands.
///
/// Comparison functions are cached on `globalThis.__vitiate_cmp_cache` so that
/// the JS source is only parsed and compiled once per operator.
#[cfg_attr(test, allow(dead_code))]
fn eval_comparison(env: &Env, left: Unknown, right: Unknown, op: &str) -> Result<bool> {
    debug_assert!(
        KNOWN_OPS.contains(&op),
        "eval_comparison: unexpected operator: {op}"
    );

    // Retrieve (or create) the per-operator cache on globalThis.__vitiate_cmp_cache
    let cache_script = format!(
        concat!(
            "(function() {{",
            "  var c = globalThis.__vitiate_cmp_cache;",
            "  if (!c) {{ c = {{}}; globalThis.__vitiate_cmp_cache = c; }}",
            "  if (!c['{op}']) {{ c['{op}'] = function(a, b) {{ return a {op} b; }}; }}",
            "  return c['{op}'];",
            "}})()"
        ),
        op = op
    );
    let cmp_fn: Unknown = env.run_script(&cache_script)?;

    // Call the cached function with our operands
    unsafe {
        let mut result = std::ptr::null_mut();
        let mut undefined = std::ptr::null_mut();
        let status = napi::sys::napi_get_undefined(env.raw(), &mut undefined);
        if status != napi::sys::Status::napi_ok {
            return Err(Error::from_reason("trace_cmp: failed to get undefined"));
        }

        let args = [left.raw(), right.raw()];
        let status = napi::sys::napi_call_function(
            env.raw(),
            undefined,
            cmp_fn.raw(),
            2,
            args.as_ptr(),
            &mut result,
        );
        if status != napi::sys::Status::napi_ok {
            return Err(Error::from_reason(
                "trace_cmp: failed to call comparison function",
            ));
        }

        let mut bool_result = false;
        let status = napi::sys::napi_get_value_bool(env.raw(), result, &mut bool_result);
        if status != napi::sys::Status::napi_ok {
            return Err(Error::from_reason(
                "trace_cmp: comparison did not return boolean",
            ));
        }

        Ok(bool_result)
    }
}
