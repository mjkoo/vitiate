## 1. Package Scaffolding

- [x] 1.1 Create `vitiate-fuzzed-data-provider/` directory with `package.json` (`@vitiate/fuzzed-data-provider`, ESM-only, zero runtime dependencies, tsup build)
- [x] 1.2 Create `tsconfig.json` extending root config
- [x] 1.3 Create `tsup.config.ts` with single entry point (`src/index.ts`), ESM format, dts generation
- [x] 1.4 Add `vitiate-fuzzed-data-provider` to `pnpm-workspace.yaml`
- [x] 1.5 Add `vitiate-fuzzed-data-provider/src/**/*.ts` to root `tsconfig.json` include array
- [x] 1.6 Add vitest config and test setup

## 2. Core Buffer Management

- [x] 2.1 Implement `FuzzedDataProvider` class with `Uint8Array` constructor, `DataView`, front pointer, end pointer, and `remainingBytes` property
- [x] 2.2 Implement internal helper for consuming bytes from end (little-endian scalar path)
- [x] 2.3 Implement internal helper for consuming bytes from front (big-endian bulk path)
- [x] 2.4 Write tests for construction, pointer tracking, and split-buffer independence

## 3. Boolean and Integer Consumption

- [x] 3.1 Implement `consumeBoolean()` - 1 byte from end, LSB check
- [x] 3.2 Implement `consumeIntegral(maxNumBytes, isSigned)` - 1-6 bytes from end, LE, with partial consumption when fewer bytes remain
- [x] 3.3 Implement `consumeIntegralInRange(min, max)` - minimal bytes from end, modulo mapping, RangeError for ranges > 2^48
- [x] 3.4 Implement `consumeBigIntegral(maxNumBytes, isSigned)` - arbitrary byte width from end, graceful partial consumption
- [x] 3.5 Implement `consumeBigIntegralInRange(min, max)` - iterative byte-by-byte from end
- [x] 3.6 Write tests for all integer methods including edge cases (exhausted buffer, partial consumption, min==max, signed ranges, range > 2^48, validation errors)

## 4. Floating Point Consumption

- [x] 4.1 Implement `consumeProbabilityFloat()` - 4 bytes, divide by 0xFFFFFFFF
- [x] 4.2 Implement `consumeProbabilityDouble()` - 8 bytes via bigint, divide by 0xFFFFFFFFFFFFFFFF
- [x] 4.3 Implement `consumeNumber()` - 8 bytes as IEEE-754 double LE, with high-byte zero-padding for short buffers
- [x] 4.4 Implement `consumeFloat()` and `consumeFloatInRange(min, max)` - 32-bit precision, range splitting for large spans
- [x] 4.5 Implement `consumeDouble()` and `consumeDoubleInRange(min, max)` - 64-bit precision, range splitting
- [x] 4.6 Implement `consumeNumberInRange(min, max)` as alias for `consumeDoubleInRange`
- [x] 4.7 Write tests for all float methods including probability bounds, range splitting, exhausted buffer, validation errors

## 5. Array Consumption (Front/BE)

- [x] 5.1 Implement `consumeBooleans(maxLength)` - bytes from front, LSB check per byte
- [x] 5.2 Implement `consumeIntegrals(maxLength, numBytesPerIntegral, isSigned)` - from front, BE, ceil-based array length with partial final element
- [x] 5.3 Implement `consumeBigIntegrals(maxLength, numBytesPerIntegral, isSigned)` - from front, BE
- [x] 5.4 Implement `consumeNumbers(maxLength)` - 8-byte doubles from front, BE
- [x] 5.5 Implement `consumeBytes(maxLength)` - raw bytes from front, return `Uint8Array`
- [x] 5.6 Implement `consumeRemainingAsBytes()` - delegates to consumeBytes
- [x] 5.7 Write tests for all array methods including shorter-than-requested results, partial final element, empty buffer, validation errors

## 6. String Consumption

- [x] 6.1 Implement printable character lookup table (codepoints 32-126 cycling over 256 entries)
- [x] 6.2 Implement `consumeString(maxLength, options?)` - bytes from front, TextDecoder-based encoding, printable support, RangeError for invalid encoding labels
- [x] 6.3 Implement `consumeRemainingAsString(options?)` - delegates to consumeString
- [x] 6.4 Implement `consumeStringArray(maxArrayLength, maxStringLength, options?)` - loop with zero-byte-consumed termination guard
- [x] 6.5 Write tests for string methods including printable mode, encodings (ascii, utf-8, utf-16le), invalid encoding, short buffers, maxStringLength=0, validation errors

## 7. Element Picking

- [x] 7.1 Implement `pickValue<T>(array)` - consumeIntegralInRange index selection
- [x] 7.2 Implement `pickValues<T>(array, numValues)` - without-replacement selection via shrinking array
- [x] 7.3 Write tests for pick methods including empty array, numValues bounds, uniqueness of pickValues results

## 8. Integration and Finalization

- [x] 8.1 Export `FuzzedDataProvider` class from `src/index.ts`
- [x] 8.2 Verify `pnpm build` succeeds for the new package (turbo pipeline)
- [x] 8.3 Verify full test suite passes (`pnpm test` from root)
- [x] 8.4 Verify eslint, prettier, and tsc checks pass
