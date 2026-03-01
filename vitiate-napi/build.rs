fn main() {
    napi_build::setup();

    // Use CARGO_CFG_UNIX instead of #[cfg(unix)] because build.rs runs on the
    // *host* platform. When cross-checking with --target x86_64-pc-windows-msvc,
    // the host is still Linux, so #[cfg(unix)] would incorrectly try to compile
    // v8_shim.cc with MSVC tools. CARGO_CFG_UNIX is set by Cargo when the
    // *target* is Unix.
    if std::env::var_os("CARGO_CFG_UNIX").is_some() {
        cc::Build::new()
            .cpp(true)
            .flag_if_supported("-std=c++14")
            .file("src/v8_shim.cc")
            .compile("v8_shim");
    }
}
