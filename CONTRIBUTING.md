# Contributing

1. `pnpm verify` must pass before every commit. CI runs the same checks plus a gitleaks secret scan.
2. Respect the boundaries (`pnpm boundaries` enforces them):
   - `packages/core`: pure domain and ports. No I/O, no drivers, no vendor SDKs, no other workspace package. Only allowlisted pure libraries (zod).
   - `packages/fhir` depends on core only.
   - Adapters (`adapter-*`, `llm`) depend on core and fhir, never on each other or on apps.
   - Only `apps/*` wire adapters together. Nothing imports an app.
   - `packages/testkit` is imported from tests only.
3. Every new adapter runs the port's contract suite from `packages/testkit`.
4. Every repository method takes `clinicId` explicitly; every table has `clinic_id`.
5. Code, identifiers, comments, tests and docs in English. Only clinic- and patient-facing UI copy is in Spanish (neutral Spanish, "tú").
6. Commit messages start with the Linear issue id: `HIP-123: short summary`.
7. Synthetic data only. No credentials, no real patient data.
