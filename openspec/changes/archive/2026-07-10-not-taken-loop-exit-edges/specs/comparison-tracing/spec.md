## MODIFIED Requirements

### Requirement: Comparison IDs are deterministic

Comparison IDs SHALL be computed using the same hash scheme as edge coverage IDs (see the
`edge-coverage` capability): `finalize(hash(file_path, span.lo, span.hi, edge_kind)) %
coverage_map_size`, using the comparison-site edge kind so a comparison ID does not alias a
coverage counter at the same span. Comparison IDs SHALL be deterministic (same inputs always
produce the same output).

#### Scenario: Same comparison produces same ID across compilations

- **WHEN** the same source file containing `x === y` is compiled twice
- **THEN** the same comparison ID is produced
