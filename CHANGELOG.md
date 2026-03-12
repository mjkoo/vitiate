# Changelog

## 0.1.0 (2026-03-12)


### Features

* add VITIATE_FUZZ_TIME env var configuration support ([f7e4bf6](https://github.com/mjkoo/vitiate/commit/f7e4bf6fe2f497d283c4ce1a7a63dd299ef18b2d))
* allow opt-in instrumentation of modules from node_modules ([0740cec](https://github.com/mjkoo/vitiate/commit/0740cecccf44fce7f159c105bf4f5d32d28b27ab))
* better CLI handling, configuration options ([16e6893](https://github.com/mjkoo/vitiate/commit/16e689388467ceb2e2f47e405239247d62bfd7ec))
* better debug output and help text ([4e1f4ab](https://github.com/mjkoo/vitiate/commit/4e1f4ab8a87c5b9b10708a46149c1481a86f0412))
* cli subcommands ([d7672fa](https://github.com/mjkoo/vitiate/commit/d7672fabfa4f032e702bc0b7fb64009ead453a53))
* configurable coverage map size ([593949b](https://github.com/mjkoo/vitiate/commit/593949b751b59cc9814e3196c3cbb553db45158f))
* corpus minimization ([f64873f](https://github.com/mjkoo/vitiate/commit/f64873f81b7085f61ccdbd7f0bbe39fc562c482e))
* crash handling supervisor process ([92e1fc4](https://github.com/mjkoo/vitiate/commit/92e1fc4fd97b12daca3aff776f79fd2f96d11a3f))
* defect dedupe ([985403a](https://github.com/mjkoo/vitiate/commit/985403a866dfe85d3d860c501d7903f9cc9a522c))
* detectors now trigger even when exception is caught ([33036c1](https://github.com/mjkoo/vitiate/commit/33036c142d21ef2176b11bbbc12289e984fc4a8b))
* full redqueen ([abf8e70](https://github.com/mjkoo/vitiate/commit/abf8e7016f20fa42e5b76dea9e4d59325600b39d))
* fuzzed data provider ([d4c7c6f](https://github.com/mjkoo/vitiate/commit/d4c7c6f66e5d48eee65d7d23febed918f1d7c10c))
* grimoire support ([e4f2b36](https://github.com/mjkoo/vitiate/commit/e4f2b36766be742d9c259ffc65be6e4826743384))
* i2s splice mutation ([29ca2b5](https://github.com/mjkoo/vitiate/commit/29ca2b553e07d79b8ea140fb50942e2ef2592791))
* initial napi fuzzing engine implementation ([ea9eefe](https://github.com/mjkoo/vitiate/commit/ea9eefe5e8dad9ea34e973b8f52529e776b7b154))
* initial vitest plugin implementation ([cb74b29](https://github.com/mjkoo/vitiate/commit/cb74b296d4436af8c0d0580b8ac16ab90ffd2937))
* libfuzzer cli arguments, minimization ([493193c](https://github.com/mjkoo/vitiate/commit/493193c4f6b0c7d35ccb05f3593764246c804912))
* musl support and CLI tweaks ([cb01f1d](https://github.com/mjkoo/vitiate/commit/cb01f1dc6168258b5545faac5b0c2749a930fb46))
* plugin configuration ([c17b535](https://github.com/mjkoo/vitiate/commit/c17b5350cc17815778bebf12b92e2976ec178f05))
* power schedule ([f28dc51](https://github.com/mjkoo/vitiate/commit/f28dc51f0f6491cf1cd7f5b874cc611913ea555e))
* robust timeout handling ([0ba34fd](https://github.com/mjkoo/vitiate/commit/0ba34fda5fa6e2f67de385f74801162ee0cc4ee3))
* staged execution ([de8d8b5](https://github.com/mjkoo/vitiate/commit/de8d8b5030a3ff91f5800a957ec03c6c04fa1fa8))
* stop on crash ([c573f00](https://github.com/mjkoo/vitiate/commit/c573f0026145ecb01dbdf88f974ba3aa9f2088f1))
* tier 2 bug detectors ([c3dcde5](https://github.com/mjkoo/vitiate/commit/c3dcde5c2d4ac2b0ae6830bddbb84c1088114923))
* unicode mutators ([8f7d0ad](https://github.com/mjkoo/vitiate/commit/8f7d0ad97da70eb7f315d27eb67eed29a45ae198))
* user-provided dictionaries ([3c85859](https://github.com/mjkoo/vitiate/commit/3c85859ed564a126d332aa45084b676595c09cb1))
* validate config with valibot ([5020a23](https://github.com/mjkoo/vitiate/commit/5020a23095eea76e56ff33edbde4965d1e54275c))
* vitest plugin CLI and configuration ([572bc9e](https://github.com/mjkoo/vitiate/commit/572bc9ee100af7e69fb44e5b2786d3d49e4a3c2e))
* vitest supervisor ([956ae4e](https://github.com/mjkoo/vitiate/commit/956ae4eaec99acdbc259f6385c0750b75e71c8f2))
* vitiate standalone CLI ([b0f839f](https://github.com/mjkoo/vitiate/commit/b0f839ffc8b90ecbe8522d3661b64075635ea4d8))
* vulnerability detectors ([6ebb868](https://github.com/mjkoo/vitiate/commit/6ebb868b6b59a60f2d8f5f2fca799031f535fc90))


### Bug Fixes

* address items from project review ([5ea1b4f](https://github.com/mjkoo/vitiate/commit/5ea1b4f24d018c68b346e9c535bed40b2303d453))
* address items from review ([589419e](https://github.com/mjkoo/vitiate/commit/589419ebc71451554b3e8a5c42bea54bfaab3257))
* address more review findings ([c995c34](https://github.com/mjkoo/vitiate/commit/c995c34c9384b2c00ab6e0860bf40bc2d9c0d223))
* correct behavior of path traversal detector ([91cd4dd](https://github.com/mjkoo/vitiate/commit/91cd4dd9270fdaf65d906f03686c18dca6ec392c))
* env var consolidation ([8f206bc](https://github.com/mjkoo/vitiate/commit/8f206bc1159249edfaf26bc54f02bc9b8e1598d5))
* fix cmplog token insertion ([8c94294](https://github.com/mjkoo/vitiate/commit/8c94294670e9b18bd9c23719fec769902c4eb58c))
* fix detector lifecycle ([2268ff3](https://github.com/mjkoo/vitiate/commit/2268ff33bd8ceb15b32505d7ee1b08cbf2db8afe))
* fix libfuzzer argument compatibility ([8270479](https://github.com/mjkoo/vitiate/commit/8270479e13cfc5a617fc066f452197050a91ef98))
* fix poor validate-scheme performance ([411d020](https://github.com/mjkoo/vitiate/commit/411d020e7d609a26601e8cb663027c12fe89f664))
* fix SEH handler logic on windows ([8b938ba](https://github.com/mjkoo/vitiate/commit/8b938baefc3ba6e5a20ca025d7be94f1581ce3ff))
* fix windows tests ([432fe45](https://github.com/mjkoo/vitiate/commit/432fe456d8dfde579254c245dc7a2258c879917a))
* rename runs to fuzzExecs ([af1d066](https://github.com/mjkoo/vitiate/commit/af1d066483d3bcdda3e142b09385cc328c3c5c2a))
