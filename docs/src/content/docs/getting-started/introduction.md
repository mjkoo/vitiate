---
title: Introduction
description: What is Vitiate and why you should use it.
---

Vitiate is a coverage-guided fuzzer for JavaScript and TypeScript projects. It runs as a Vitest plugin, so you can write fuzz tests in the same files and with the same patterns as your unit tests.

Under the hood, Vitiate uses an [SWC](https://swc.rs/) WASM plugin to insert coverage instrumentation during Vite's module transformation and [LibAFL](https://github.com/AFLplusplus/LibAFL) to drive mutation-based fuzzing. The coverage map is shared between JavaScript and Rust via zero-copy memory - both sides read and write the same buffer with no serialization overhead in the hot loop.

## Why Fuzz Your JavaScript?

Unit tests verify behavior you anticipate. Fuzzing finds behavior you didn't.

If your code processes untrusted input - parsers, validators, serializers, template engines, API handlers, URL routers - a fuzzer can generate millions of inputs per minute and explore code paths you would never write by hand. Common findings include:

- Uncaught exceptions on malformed input
- Prototype pollution via crafted object keys
- ReDoS from pathological regex patterns
- Command injection through unsanitized shell arguments
- Path traversal in file-serving code

## What Vitiate Provides

Vitiate consists of three packages:

| Package | Role |
|---------|------|
| `@vitiate/core` | Vitest plugin, `fuzz()` API, CLI, corpus management |
| `@vitiate/engine` | Native Node.js addon wrapping LibAFL (ships prebuilt binaries) |
| `@vitiate/swc-plugin` | SWC WASM plugin for edge coverage and comparison tracing |

An optional fourth package, `@vitiate/fuzzed-data-provider`, provides a structured input API for targets that need typed values instead of raw bytes.

## Prerequisites

- **Node.js** 18 or later
- **Vite** 6+
- **Vitest** 3.1+

Prebuilt native binaries are provided for Linux (x86_64, aarch64, armv7), macOS (Apple Silicon), and Windows (x86_64). No Rust toolchain is required to use Vitiate.
