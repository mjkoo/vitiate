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
    #[napi(ts_arg_type = "number")] cmp_id: u32,
    op: String,
) -> Result<bool> {
    if crate::cmplog::is_enabled()
        && let Some(operator) = crate::cmplog::CmpLogOperator::from_op(&op)
        && let Some(entries) =
            crate::cmplog::serialize_to_cmp_values(env.raw(), left.raw(), right.raw())
    {
        for entry in entries {
            crate::cmplog::push(entry, cmp_id, operator);
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
    if !KNOWN_OPS.contains(&op) {
        return Err(Error::from_reason(format!(
            "eval_comparison: unexpected operator: {op}"
        )));
    }

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

    // SAFETY: env.raw() is valid (napi-rs Env parameter). cmp_fn, left, right
    // are Unknown values obtained in this callback scope.
    unsafe { call_js_comparison(env.raw(), cmp_fn.raw(), left.raw(), right.raw()) }
}

/// Call a JS function with two arguments and extract the boolean result.
///
/// Uses raw NAPI C API calls to avoid `JsUnknown` allocation overhead on this
/// hot path (called for every non-strict comparison in instrumented code).
///
/// # Safety
///
/// - `env` must be a valid `napi_env` handle from the current callback scope.
/// - `func`, `left`, and `right` must be valid `napi_value` handles in the
///   current scope.
///
/// These invariants are guaranteed when called from `eval_comparison`, which
/// receives its `Env` and `Unknown` values from the `#[napi]` framework.
unsafe fn call_js_comparison(
    env: napi::sys::napi_env,
    func: napi::sys::napi_value,
    left: napi::sys::napi_value,
    right: napi::sys::napi_value,
) -> Result<bool> {
    let mut result = std::ptr::null_mut();
    let mut undefined = std::ptr::null_mut();

    let status = unsafe { napi::sys::napi_get_undefined(env, &mut undefined) };
    if status != napi::sys::Status::napi_ok {
        return Err(Error::from_reason("trace_cmp: failed to get undefined"));
    }

    let args = [left, right];
    let status = unsafe {
        napi::sys::napi_call_function(env, undefined, func, 2, args.as_ptr(), &mut result)
    };
    if status != napi::sys::Status::napi_ok {
        return Err(Error::from_reason(
            "trace_cmp: failed to call comparison function",
        ));
    }

    let mut bool_result = false;
    let status = unsafe { napi::sys::napi_get_value_bool(env, result, &mut bool_result) };
    if status != napi::sys::Status::napi_ok {
        return Err(Error::from_reason(
            "trace_cmp: comparison did not return boolean",
        ));
    }

    Ok(bool_result)
}
