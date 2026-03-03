## REMOVED Requirements

### Requirement: Fuzz mode activation via --fuzz CLI flag
**Reason**: Vitest's `cac` CLI parser rejects unknown flags before the plugin's `config()` hook runs, making `parseFuzzFlag()` dead code. The Vitest maintainers have explicitly declined to support plugin-extensible CLI flags. `VITIATE_FUZZ=1` is the sole activation mechanism.
**Migration**: Use `VITIATE_FUZZ=1 vitest run` instead of `vitest --fuzz`. Use Vitest's `-t` flag instead of `--fuzz=<pattern>`.
