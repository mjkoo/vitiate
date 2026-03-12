---
title: Structure-Aware Fuzzing
description: Using FuzzedDataProvider to generate structured inputs for fuzz targets.
---

Many fuzz targets need more than raw bytes. If your function expects a string, a number, or a complex object, you need to transform the fuzzer's byte output into the right shape. The `FuzzedDataProvider` class makes this straightforward.

## Installation

```bash
npm install --save-dev @vitiate/fuzzed-data-provider
```

## Basic Usage

Wrap the raw `Buffer` in a `FuzzedDataProvider` and consume typed values:

```ts
import { fuzz } from "@vitiate/core";
import { FuzzedDataProvider } from "@vitiate/fuzzed-data-provider";

fuzz("createUser with structured input", (data: Buffer) => {
  const fdp = new FuzzedDataProvider(data);

  const user = {
    name: fdp.consumeString(100),
    age: fdp.consumeIntegralInRange(0, 150),
    isAdmin: fdp.consumeBoolean(),
    role: fdp.pickValue(["viewer", "editor", "admin"]),
  };

  createUser(user);
});
```

The fuzzer's mutation engine still operates on raw bytes, but `FuzzedDataProvider` deterministically maps those bytes to typed values. When the fuzzer mutates the underlying bytes, the consumed values change in meaningful ways.

## How It Works

`FuzzedDataProvider` consumes bytes from the end of the buffer, leaving the beginning intact for the first values you request. This means:

- The first few `consume*()` calls get the most "stable" bytes - small mutations to the input tend to change later values while keeping earlier ones similar
- The fuzzer can learn which byte positions affect which consumed values and mutate them independently

This is the same design as [LLVM's FuzzedDataProvider](https://llvm.org/docs/LibFuzzer.html#fuzzed-data-provider).

## Common Patterns

### Generating Strings with Constraints

```ts
// ASCII-only printable strings
const username = fdp.consumeString(50, { printable: true });

// Remaining bytes as a string (useful for "the rest is freeform text")
const body = fdp.consumeRemainingAsString();
```

### Generating Arrays

```ts
// Array of integers
const values = fdp.consumeIntegrals(20, 4); // up to 20 ints, 4 bytes each

// Array of strings
const tags = fdp.consumeStringArray(10, 50); // up to 10 strings, 50 chars each
```

### Choosing from Enums or Fixed Sets

```ts
const method = fdp.pickValue(["GET", "POST", "PUT", "DELETE"]);
const statusCode = fdp.pickValue([200, 301, 400, 404, 500]);
```

### Building Nested Objects

```ts
fuzz("process request", (data: Buffer) => {
  const fdp = new FuzzedDataProvider(data);

  const request = {
    method: fdp.pickValue(["GET", "POST"]),
    path: "/" + fdp.consumeString(200),
    headers: {
      "content-type": fdp.pickValue(["text/plain", "application/json", "text/html"]),
      "x-custom": fdp.consumeString(100),
    },
    body: fdp.consumeRemainingAsString(),
  };

  handleRequest(request);
});
```

### Numeric Ranges

```ts
const port = fdp.consumeIntegralInRange(0, 65535);
const probability = fdp.consumeProbabilityFloat(); // 0.0 to 1.0
const temperature = fdp.consumeNumberInRange(-273.15, 1000.0);
```

## When to Use FuzzedDataProvider vs. Raw Bytes

**Use raw bytes** when your target already accepts bytes or strings:

```ts
// Parser that takes a string - just convert the buffer directly
fuzz("parse JSON", (data: Buffer) => {
  JSON.parse(data.toString("utf-8"));
});
```

**Use FuzzedDataProvider** when your target needs structured input:

```ts
// Function that takes multiple typed arguments
fuzz("query database", (data: Buffer) => {
  const fdp = new FuzzedDataProvider(data);
  queryDb(fdp.consumeString(100), fdp.consumeIntegralInRange(1, 1000));
});
```

For text-based targets using raw bytes, Vitiate's Grimoire mutation strategy automatically detects that the input is UTF-8 text and applies structure-aware mutations that preserve textual patterns. This happens transparently - you do not need to configure anything.

## Checking Remaining Bytes

Use `remainingBytes` to guard against consuming more data than available:

```ts
const fdp = new FuzzedDataProvider(data);

while (fdp.remainingBytes > 0) {
  const key = fdp.consumeString(50);
  const value = fdp.consumeString(200);
  map.set(key, value);
}
```

When there are no bytes left, consume methods return zero-values (0, false, empty string, empty array) rather than throwing.
