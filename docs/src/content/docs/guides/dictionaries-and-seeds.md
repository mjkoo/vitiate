---
title: Dictionaries and Seeds
description: Improving fuzzing effectiveness with domain-specific knowledge.
---

The fuzzer works without any manual input, but you can significantly improve its effectiveness by providing seed inputs and dictionaries.

## Seed Inputs

Seeds are example inputs that give the fuzzer a starting point. Place them in your test's seed directory:

```
testdata/fuzz/<sanitized-test-name>/
├── seed-valid-basic
├── seed-valid-complex
├── seed-edge-case
├── crash-abc123...    (crash artifacts, auto-generated)
└── timeout-def456...  (timeout artifacts, auto-generated)
```

The directory name is a sanitized form of the test name (hash prefix + slug, e.g., `8fcacc40-parse_url`). Run the fuzzer briefly with `-runs 1` to create the directory, then add your seeds to it.

### What Makes Good Seeds

- **Cover different code paths.** A JSON parser benefits from seeds with objects, arrays, strings, numbers, nested structures, and empty inputs.
- **Include edge cases.** Empty input, very long input, inputs with special characters.
- **Be minimal.** Small seeds are more useful than large ones — the fuzzer can build complexity through mutation.
- **Be valid *and* invalid.** Valid inputs exercise normal code paths; slightly invalid inputs exercise error handling.

### Example Seeds for a URL Parser

```bash
# Run once to create the seed directory
npx vitiate test/url-parser.fuzz.ts -runs 1

# Find the created directory
SEED_DIR=$(ls -d test/testdata/fuzz/*parseUrl*)

# Valid URLs of different shapes
echo -n 'https://example.com' > "$SEED_DIR/seed-https"
echo -n 'http://user:pass@host:8080/path?q=1#frag' > "$SEED_DIR/seed-full"
echo -n 'ftp://[::1]:21/' > "$SEED_DIR/seed-ipv6"

# Edge cases
echo -n '' > "$SEED_DIR/seed-empty"
echo -n ':///' > "$SEED_DIR/seed-minimal"
```

## Dictionaries

A dictionary is a file containing tokens — short byte sequences that are meaningful to your target. The fuzzer uses these tokens during mutation, inserting them into inputs to help reach code paths that depend on specific keywords or delimiters.

### Dictionary File Format

One token per line. Tokens can be quoted or unquoted:

```
# URL dictionary
"://"
"http"
"https"
"ftp"
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

Lines starting with `#` are comments.

### Automatic Discovery

Place the dictionary at `testdata/fuzz/<sanitized-test-name>.dict` (next to the seed directory, same name with `.dict` extension) and it will be loaded automatically. No CLI flag needed.

### CLI Flag

```bash
npx vitiate test/parser.fuzz.ts -dict path/to/custom.dict
```

### Detector Tokens

When detectors are active, they automatically contribute relevant tokens to the dictionary. For example, the command injection detector adds shell metacharacters and the prototype pollution detector adds `__proto__` and `constructor`. You do not need to include these manually.

### Tips

- **Target-specific tokens are best.** A JSON parser benefits from `{`, `}`, `[`, `]`, `:`, `"`, `true`, `false`, `null`. A CSV parser benefits from `,`, `\n`, `"`.
- **Include encoding variations.** URL-encoded versions (`%2e%2e`), Unicode escapes, null bytes.
- **Keep tokens short.** The fuzzer combines and mutates them — long tokens reduce the mutation space.
- **Do not overload the dictionary.** 10-50 tokens is typical. Hundreds of tokens slow down mutation and dilute effectiveness.
