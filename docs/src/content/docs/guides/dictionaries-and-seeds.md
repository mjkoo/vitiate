---
title: Dictionaries and Seeds
description: Improving fuzzing effectiveness with domain-specific knowledge.
---

The fuzzer works without any manual input, but you can significantly improve its effectiveness by providing seed inputs and dictionaries.

## Seed Inputs

Seeds are example inputs that give the fuzzer a starting point. Place them in your test's seed directory:

```
.vitiate/testdata/<hashdir>/
├── seeds/
│   ├── seed-valid-basic
│   ├── seed-valid-complex
│   └── seed-edge-case
├── crashes/
│   └── crash-abc123...    (crash artifacts, auto-generated)
└── timeouts/
    └── timeout-def456...  (timeout artifacts, auto-generated)
```

The directory name is a base32 encoded hash followed by the test name (e.g., `vxr4kpqyb12fza1gv81bjj8k3i64mlqn-parse_url`). Run `npx vitiate init` to create the directories, then add your seeds to the `seeds/` subdirectory.

### What Makes Good Seeds

- **Cover different code paths.** A JSON parser benefits from seeds with objects, arrays, strings, numbers, nested structures, and empty inputs.
- **Include edge cases.** Empty input, very long input, inputs with special characters.
- **Be valid *and* invalid.** Valid inputs exercise normal code paths; slightly invalid inputs exercise error handling.
- **Don't worry about quantity.** It's fine to add many seeds - after fuzzing, run `npx vitiate optimize` to [minimize the corpus](/concepts/corpus/#corpus-minimization) down to the smallest set that maintains coverage.

### Example Seeds for a URL Parser

```bash
# Initialize test data directories (creates seed directories for all fuzz tests)
npx vitiate init

# Find the created directory
SEED_DIR=$(ls -d .vitiate/testdata/*parseUrl*/seeds)

# Valid URLs of different shapes
echo -n 'https://example.com' > "$SEED_DIR/seed-https"
echo -n 'http://user:pass@host:8080/path?q=1#frag' > "$SEED_DIR/seed-full"
echo -n 'ftp://[::1]:21/' > "$SEED_DIR/seed-ipv6"

# Edge cases
echo -n '' > "$SEED_DIR/seed-empty"
echo -n ':///' > "$SEED_DIR/seed-minimal"
```

## Dictionaries

A dictionary is a file containing tokens - short byte sequences that are meaningful to your target. The fuzzer uses these tokens during mutation, inserting them into inputs to help reach code paths that depend on specific keywords or delimiters.

### Dictionary File Format

Vitiate uses the standard AFL/libFuzzer dictionary format. One token per line, enclosed in double quotes. Lines starting with `#` are comments. Empty lines are ignored.

```
# URL dictionary
protocol_http="http"
protocol_https="https"
"ftp"
"://"
"@"
":"
"/"
"?"
"&"
"="
"#"
"%20"
"%00"
"localhost"
"127.0.0.1"
"[::1]"
```

Tokens can have an optional `name=` prefix (e.g., `protocol_http="http"`) which serves as a human-readable label and is ignored by the parser. Use `\xHH` hex escapes for binary bytes:

```
# Binary magic bytes
jpeg_magic="\xff\xd8\xff\xe0"
null="\x00"
```

### Premade Dictionaries

The [AFLplusplus dictionaries collection](https://github.com/AFLplusplus/AFLplusplus/tree/stable/dictionaries) contains ready-to-use dictionaries for many common formats (JSON, XML, HTML, HTTP, SQL, and more). These are directly compatible with Vitiate's `-dict` flag.

### Automatic Discovery

Place the dictionary file directly in the test's data directory at `.vitiate/testdata/<hashdir>/` and it will be discovered automatically by convention. No CLI flag needed.

### CLI Flag

When using the [standalone CLI](/guides/cli/), you can also specify a dictionary explicitly:

```bash
npx vitiate libfuzzer test/parser.fuzz.ts -dict path/to/custom.dict
```

### Detector Tokens

When detectors are active, they automatically contribute relevant tokens to the dictionary. For example, the command injection detector adds shell metacharacters and the prototype pollution detector adds `__proto__` and `constructor`. You do not need to include these manually.

### Tips

- **Target-specific tokens are best.** A JSON parser benefits from `{`, `}`, `[`, `]`, `:`, `"`, `true`, `false`, `null`. A CSV parser benefits from `,`, `\n`, `"`.
- **Include encoding variations.** URL-encoded versions (`%2e%2e`), Unicode escapes, null bytes.
- **Keep tokens short.** The fuzzer combines and mutates them - long tokens reduce the mutation space.
- **Do not overload the dictionary.** 10-50 tokens is typical. Hundreds of tokens slow down mutation and dilute effectiveness.
