fn main() {
    napi_build::setup();

    #[cfg(unix)]
    {
        cc::Build::new()
            .cpp(true)
            .flag_if_supported("-std=c++14")
            .file("src/v8_shim.cc")
            .compile("v8_shim");
    }
}
