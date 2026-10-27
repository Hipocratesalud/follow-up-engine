# Follow-up Engine — agent rules

Source of truth for scope and specs: Linear project "Follow-up Engine AI"
(https://linear.app/hipocratesalud/project/follow-up-engine-ai-46b01fccf6bd). Read in order:
0 Hackathon context → 1 Roadmap → 2 PRD MVP → 3 Initial backfill → 4–7 PRDs V1–V4 → 8 Clinical team guide.

- Each PRD assumes the previous versions are implemented.
- Code, identifiers, enums, comments, tests and docs in English. User-facing UI copy is English by default, with Spanish (neutral Spanish, "tú") as a second locale through the i18n catalogs; every string lives in both. Clinical note text stays in its original language.
- `clinic_id` on every table and query.
- Every LLM call goes through `llm_gateway`; Meta models are the primary provider (Muse Spark via Meta Model API, or Muse Spark Open via Baseten `meta-models/muse-spark-open-1026`).
- This repo will be public: no proprietary Hipócrates code, no credentials, no real patient data. Synthetic data only.
- Never phrase output as medical advice to patients; findings are suggestions to the clinician with cited evidence.
- Nothing is enabled for a clinic without clinical team validation.

## Commands

Use pnpm 10 (`corepack enable pnpm`; a global pnpm 7 is rejected by `engines`).

- `pnpm verify`: lint + typecheck + boundaries + test. Run it before every commit.
- `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm format`.
- `pnpm test --project @follow-up-engine/core`: one package.
- `docker compose up -d postgres`: Postgres 16 on `localhost:54329`.

## Boundaries (enforced by dependency-cruiser, see docs/adr/0002)

- `packages/core`: domain + ports only. Imports itself and zod. No `pg`, no vendor SDKs, no `node:fs|net|http|child_process`, no other workspace packages.
- `packages/fhir` → core. Adapters (`adapter-postgres`, `adapter-memory`, `llm`) → core, fhir. Never adapter → adapter.
- Only `packages/runtime` (the composition root, ADR 0005) wires adapters; only apps (and acceptance tests) import it. Nothing imports an app, no exceptions. `testkit` only from tests.
- No circular dependencies. Type-only imports count.
- TypeScript runs without a build step (`erasableSyntaxOnly`): no enums, no parameter properties, relative imports end in `.ts`.

## Domain contract

Shared types live in `packages/core/src/domain` (ids, `ClinicalEvent`, `ClinicalBatch`, `Expectation`, `FollowUpCase`, `CaseEvent`, `CaseFeedback`, `PatientCondition`, `QualityFinding`, outbound `DomainEvent`), rule/protocol zod schemas in `packages/core/src/config`, ports in `packages/core/src/ports`. Build on them; change them deliberately, not ad hoc in a feature package.
