fn main() {
    napi_build::setup();

    // Compile v8_shim.cc on all targets. The C++ code uses #ifdef _WIN32 to
    // select between GetProcAddress (Windows) and dlsym (Unix) for runtime
    // symbol resolution. Use MSVC-compatible /std:c++14 on Windows, -std=c++14
    // on Unix (flag_if_supported silently skips unsupported flags).
    cc::Build::new()
        .cpp(true)
        .flag_if_supported("-std=c++14")
        .flag_if_supported("/std:c++14")
        .file("src/v8_shim.cc")
        .compile("v8_shim");
}
