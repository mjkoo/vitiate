---
title: FuzzedDataProvider
description: Complete reference for the FuzzedDataProvider class.
---

```ts
import { FuzzedDataProvider } from "@vitiate/fuzzed-data-provider";
```

`FuzzedDataProvider` consumes bytes from a fuzzer-generated buffer and produces typed values. It follows the same design as [LLVM's FuzzedDataProvider](https://llvm.org/docs/LibFuzzer.html#fuzzed-data-provider).

## Constructor

```ts
new FuzzedDataProvider(data: Uint8Array)
```

Creates a provider that consumes bytes from `data`. A `Buffer` (which extends `Uint8Array`) can be passed directly.

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `remainingBytes` | `number` | Number of unconsumed bytes remaining |

## Boolean

| Method | Return Type | Description |
|--------|-------------|-------------|
| `consumeBoolean()` | `boolean` | Consume one byte as a boolean |

## Integers

| Method | Return Type | Description |
|--------|-------------|-------------|
| `consumeIntegral(maxNumBytes, isSigned?)` | `number` | Consume up to `maxNumBytes` (1-6) as an integer. `isSigned` defaults to `false`. |
| `consumeIntegralInRange(min, max)` | `number` | Consume an integer uniformly distributed in `[min, max]` |
| `consumeIntegrals(maxLength, numBytesPerIntegral, isSigned?)` | `number[]` | Consume an array of integers |

## BigInts

| Method | Return Type | Description |
|--------|-------------|-------------|
| `consumeBigIntegral(maxNumBytes, isSigned?)` | `bigint` | Consume up to `maxNumBytes` as a BigInt |
| `consumeBigIntegralInRange(min, max)` | `bigint` | Consume a BigInt in `[min, max]` |
| `consumeBigIntegrals(maxLength, numBytesPerIntegral, isSigned?)` | `bigint[]` | Consume an array of BigInts |

## Floating Point

| Method | Return Type | Description |
|--------|-------------|-------------|
| `consumeNumber()` | `number` | Consume 8 bytes as a `number` (double) |
| `consumeNumberInRange(min, max)` | `number` | Consume a number in `[min, max]` |
| `consumeFloat()` | `number` | Consume 4 bytes as a float |
| `consumeFloatInRange(min, max)` | `number` | Consume a float in `[min, max]` |
| `consumeDouble()` | `number` | Alias for `consumeNumber()` |
| `consumeDoubleInRange(min, max)` | `number` | Alias for `consumeNumberInRange()` |
| `consumeNumbers(maxLength)` | `number[]` | Consume an array of doubles |
| `consumeProbabilityFloat()` | `number` | Consume a float in `[0.0, 1.0]` |
| `consumeProbabilityDouble()` | `number` | Consume a double in `[0.0, 1.0]` |

## Bytes

| Method | Return Type | Description |
|--------|-------------|-------------|
| `consumeBytes(maxLength)` | `Uint8Array` | Consume up to `maxLength` bytes |
| `consumeRemainingAsBytes()` | `Uint8Array` | Consume all remaining bytes |

## Strings

| Method | Return Type | Description |
|--------|-------------|-------------|
| `consumeString(maxLength, options?)` | `string` | Consume up to `maxLength` characters |
| `consumeRemainingAsString(options?)` | `string` | Consume all remaining bytes as a string |
| `consumeStringArray(maxArrayLength, maxStringLength, options?)` | `string[]` | Consume an array of strings |

### StringOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `encoding` | `string` | `"utf-8"` | String encoding |
| `printable` | `boolean` | `false` | Restrict to printable ASCII characters |

## Element Picking

| Method | Return Type | Description |
|--------|-------------|-------------|
| `pickValue<T>(array)` | `T` | Pick a random element from the array |
| `pickValues<T>(array, numValues)` | `T[]` | Pick `numValues` elements (with replacement) |

## Behavior When Empty

When no bytes remain, consume methods return zero-values: `0` for numbers, `false` for booleans, `""` for strings, empty arrays for array methods. They do not throw.
