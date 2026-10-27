# Deploying the persistence layer

The engine keeps everything in one Postgres database: clinical records, expectations, cases, the audit trail, the job queue and the transactional outbox ([ADR 0003](adr/0003-postgres-job-runner-and-outbox.md)). `@follow-up-engine/adapter-postgres` implements every storage port of the core on it and runs unchanged on:

- **vanilla Postgres 15 or newer** (CI and `docker compose` use 16), and
- **Supabase** (managed Postgres 15/17; verified against the Supabase CLI's local stack, Postgres 15.8).

It needs no extensions and no superuser: `gen_random_uuid()` is built in since Postgres 13.

## Schema

All tables live in their own schema, `follow_up`, so the engine can share a database with a host application (for example a Supabase project that already has its own `public` tables) without name clashes.

| Table                | Holds                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinics`            | Tenants: name, `active`, `settings` (jsonb, partial `ClinicSettings`), `api_key_hash` (sha256 hex of the original integration key; never the key)   |
| `api_keys`           | Scoped API keys of each clinic: sha256 hex, `label`, `scopes` (`fhir:write`, `inbox:read`, `inbox:act`, `demo:clock`, `demo:ingest`), `revoked_at`  |
| `clinical_resources` | Latest version of every FHIR resource pushed by the host (jsonb), unique per clinic + type + id. `version` increments only when the content changes |
| `clinical_events`    | Append-only log of normalized clinical events, unique per clinic + `idempotency_key`                                                                |
| `patient_conditions` | Conditions per patient, unique per clinic + patient + code                                                                                          |
| `expectations`       | "This should happen by this date", unique per clinic + `idempotency_key`; partial index on `due_at` where `status = 'open'`                         |
| `follow_up_cases`    | Cases; a partial unique index allows one active case (`open`, `notified`, `snoozed`, `escalated`) per clinic + `dedup_key`                          |
| `case_events`        | Append-only audit trail of cases                                                                                                                    |
| `case_feedback`      | Clinician feedback on cases                                                                                                                         |
| `quality_findings`   | Documentation-quality findings                                                                                                                      |
| `llm_calls`          | Tokens, cost (`numeric`, no float drift) and latency of every LLM call, per clinic                                                                  |
| `outbox`             | Domain events waiting for delivery to the host                                                                                                      |
| `jobs`               | Background jobs, claimed with `FOR UPDATE SKIP LOCKED`; a `dedup_key` is unique among unfinished (`pending`, `running`) jobs                        |
| `backfill_progress`  | Resumable cursor and counters of the initial backfill; one unfinished (running or budget-paused) backfill per clinic                                |

Design rules, all enforced by tests:

- Every table has row-level security enabled from the migration that creates it (0004 enabled it on all earlier tables). The engine owns the tables and is not restricted; any other role sees nothing without a policy. `src/rls.test.ts` (CI) fails on a table without RLS.
- Every table has `clinic_id NOT NULL` (in `clinics`, the `id`) and every query filters by it. Primary keys are `(clinic_id, id)`, so ids only need to be unique within a clinic.
- Instants are `timestamptz`. Nested or FHIR-shaped values are `jsonb`, next to the relational columns queries filter and sort on.
- Clinical resource history is not duplicated: the latest version is kept, `clinical_events` is the append-only record of what each version meant, and the host EHR stays the system of record.
- No foreign keys across aggregates: a unit of work may write them in any order, and tenancy (`clinic_id` in every key) is the invariant that matters.

## Migrations

Plain SQL files in `packages/adapter-postgres/migrations/NNNN_name.sql`, applied by a small runner with no CLI dependency:

```ts
import { createPool, migrate } from '@follow-up-engine/adapter-postgres';

const pool = createPool(); // reads DATABASE_URL
await migrate(pool); // { applied: ['0001'] } the first time, [] afterwards
```

- Pending migrations run in **one transaction** under a transaction-level advisory lock keyed on the schema. Several processes (API and worker starting together) can call `migrate` at boot: the first applies, the others wait and find nothing to do. A failing migration rolls back entirely.
- Applied versions and file checksums are recorded in `follow_up.schema_migrations`. Editing an applied migration makes `migrate` throw `MigrationChecksumError`: add a new file instead.
- Files use unqualified names; the runner sets `search_path` to the target schema. `migrate(pool, { schema })` installs into another schema (the tests use a throwaway schema per file).

Run `migrate` with the same role the engine uses (it becomes the owner of the tables).

## Vanilla Postgres

Local development and integration tests:

```sh
docker compose up -d postgres     # Postgres 16 on localhost:54329
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/follow_up_engine
pnpm test --project @follow-up-engine/adapter-postgres
docker compose down
```

Without `DATABASE_URL` the Postgres suites are reported as skipped (their title says why), so `pnpm verify` still passes on a machine without Docker. CI sets `DATABASE_URL` against a `postgres:16` service, so there they always run.

Production: any Postgres 15+ (RDS, Cloud SQL, Neon, self-hosted). Create a database and a role that can create a schema in it, set `DATABASE_URL=postgres://<role>:<password>@<host>:5432/<db>?sslmode=verify-full` (add `sslrootcert=<file>` when the server certificate is not signed by a public CA), and run `migrate` at boot.

## Supabase

Hipócrates hosts the engine on Supabase. The engine is a regular Postgres client there.

1. **Connection string.** In the dashboard, _Connect_:
   - Long-lived servers (`apps/api`, `apps/worker` on a VM or container): the **direct connection** (`db.<project-ref>.supabase.co:5432`) or the **session pooler** (port 5432 on `pooler.supabase.com`).
   - Serverless or many short-lived instances: the **transaction pooler** (port 6543). The adapter is designed for it (no session state: settings are `SET LOCAL` / `set_config(..., true)`, the migration lock is transaction-level, statements are unnamed), but the local verification below covers the direct connection only.
   - TLS: node-postgres treats `sslmode=require` as `verify-full`, and Supabase certificates are signed by Supabase's own CA. Download it (_Database settings → SSL configuration_) and point `sslrootcert` at it.

   ```sh
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/certs/supabase-ca.crt
   ```

2. **Migrate** with `migrate(pool)` as the `postgres` role. The tables land in `follow_up`, owned by `postgres`, next to the host's `public` schema. The Supabase CLI migration history is not involved.

3. **Row-level security (optional).** Only needed if clinic users read the engine's tables directly through the Supabase Data API (PostgREST, `supabase-js`), for example an inbox rendered from the database:

   ```ts
   import { applySupabaseRowLevelSecurity } from '@follow-up-engine/adapter-postgres';
   await applySupabaseRowLevelSecurity(pool); // runs supabase/rls.sql, idempotent
   ```

   [`packages/adapter-postgres/supabase/rls.sql`](../packages/adapter-postgres/supabase/rls.sql):

   - enables RLS on **every** `follow_up` table, found in the catalog (not a hand-kept list), and revokes table privileges and default privileges from `anon` and `authenticated`; tables without a policy (`jobs`, `outbox`, `backfill_progress`, `schema_migrations`, `api_keys`) are invisible to API roles;
   - lets `authenticated` users `SELECT` rows whose `clinic_id` equals the `clinic_id` claim of their JWT (add the claim with a custom access token hook); their own `clinics` row is readable without `api_key_hash` (column privileges);
   - grants no writes and nothing to `anon`. Writes go through the engine API, which applies the business rules and the audit trail;
   - finally add `follow_up` to _Settings → Data API → Exposed schemas_. **Do not** run the `GRANT ALL ON ALL TABLES IN SCHEMA ... TO anon, authenticated` (and `ALTER DEFAULT PRIVILEGES ... GRANT ALL`) that Supabase's guide to custom schemas suggests: RLS would still deny rows, but the grants are the only other line of defense. Re-run `applySupabaseRowLevelSecurity` after upgrading the engine (it is idempotent); new tables already arrive with RLS on.

   `src/rls.test.ts` runs in CI on plain Postgres (it emulates the Supabase roles and `auth.jwt()`): every table has RLS right after `migrate()`, every policy after `rls.sql` is a clinic-scoped `SELECT` for `authenticated`, and `anon` and `authenticated` read nothing from internal tables even after the broad grants above.

   The engine is not affected: it connects as `postgres`, the owner of the tables, which RLS does not restrict. Every unit of work also sets `app.clinic_id` for its transaction (`set_config('app.clinic_id', <clinic>, true)`), so a host that runs the engine under a non-owner role with `FORCE ROW LEVEL SECURITY` can key policies on `current_setting('app.clinic_id', true)` as defense in depth.

### Verifying against Supabase locally

Never point tests at a remote project. Use the CLI's local stack:

```sh
mkdir /tmp/fue-supabase && cd /tmp/fue-supabase && supabase init
# optional: change the ports in supabase/config.toml if 543xx are taken
supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
cd -   # back to the repo
SUPABASE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm test --project @follow-up-engine/adapter-postgres
(cd /tmp/fue-supabase && supabase stop --no-backup)
```

With `DATABASE_URL` pointing at Supabase, the whole adapter suite (repositories, unit of work, job queue, outbox, migrations) runs on Supabase's Postgres. `SUPABASE_DATABASE_URL` additionally enables `src/supabase.test.ts`, which installs the default schema, applies `rls.sql` twice, and checks, as PostgREST would (`SET LOCAL ROLE authenticated` plus `request.jwt.claims`), that a clinic user sees only its clinic's rows, cannot read `api_key_hash` or internal tables, cannot write, and that `anon` gets nothing. It refuses any URL that is not `localhost`/`127.0.0.1`, and drops `follow_up` when done.

## Runtime API

```ts
import { createPool, createPostgresAdapters, migrate } from '@follow-up-engine/adapter-postgres';

const pool = createPool({ max: 10 });
await migrate(pool);
const pg = createPostgresAdapters(pool, { clock }); // clock: core `Clock`, SystemClock by default

await pg.unitOfWork.withTransaction(clinicId, async (stores) => {
  await stores.expectations.upsertByIdempotencyKey(clinicId, expectation);
  await stores.outbox.add(clinicId, event); // commits with the expectation, or not at all
});

const jobs = await pg.jobs.claim({
  workerId,
  limit: 10,
  leaseFor: { minutes: 5 },
  now: clock.now(),
});
await pg.drainOutbox({ publisher, now: clock.now(), limit: 50, leaseFor: { minutes: 1 } });
await pool.end();
```

- `withTransaction` runs `BEGIN ... COMMIT` on one connection; a throw rolls back every write, jobs and outbox events included. Nested calls reuse the transaction through a savepoint. Repositories taken from `pg` (not only `stores`) join the ambient transaction automatically, so code inside a unit of work cannot accidentally use a second connection.
- The job queue leases with `FOR UPDATE SKIP LOCKED`; an expired lease makes the job claimable again and the stale holder's `complete`/`fail` returns `lease_lost`. Failures retry with exponential backoff (10 s doubling, capped at 1 h) or at `retryAt`; after `maxAttempts` (default 5) the job is dead-lettered (`status = 'dead'`, kept for inspection).
- The outbox relay claims events with `SKIP LOCKED` and a lease, publishes outside any transaction, and retries failures with backoff (5 s doubling, capped at 1 h) up to 25 attempts. Delivery is at least once; the host deduplicates on the event id.

## Clinics and API keys

Register a clinic and issue its keys with the API package's CLI, against the production `DATABASE_URL` (it migrates first, like the API). Each key is printed **once**; only its sha256 is stored:

```sh
export DATABASE_URL=postgres://...
pnpm --filter @follow-up-engine/api clinic:create --name "Clínica Ejemplo" --scopes fhir:write
#   clinic clinica-ejemplo (created); key "integration" [fhir:write]: fue_Xr3...  (shown once)
pnpm --filter @follow-up-engine/api clinic:create --id clinica-ejemplo --label inbox --scopes inbox:read,inbox:act
pnpm --filter @follow-up-engine/api clinic:create --id clinica-ejemplo --revoke inbox   # revoke that key
```

Scopes: `fhir:write` (the host integration: `/fhir`, `/jobs`), `inbox:read`, `inbox:act` (the inbox API), `demo:clock` and `demo:ingest` (the demo controls, fake clock only; refused for any clinic but `clinic-demo` unless `--allow-demo`). Key values are unique across clinics: issuing or registering a value another clinic holds (even revoked) fails and changes nothing. Give the host server one `fhir:write` key and the inbox its own key without `fhir:write`; rotate a key by issuing a new one under another label, switching, then `--revoke` the old label. New clinics start with patient contact disabled (`--allow-patient-contact` turns it on once the clinical team has validated it).

## Security checklist (production)

- **Real clock, no demo clinic.** `CLOCK=system` (the default). The demo clinic is not registered then, even if `DEMO_API_KEY` is set (the compose `app` profile sets it for convenience; it is logged and ignored), and the demo clinic refuses every key, even if a database once seeded by the demo still holds them (the published `demo-clinic-key`, `demo-inbox-key` or any short custom one). `DEMO_CLINIC=true` forces the demo clinic on a real clock and then requires private keys of 24+ characters, at startup and whenever a stored demo key authenticates.
- **Inbox behind the host's login.** The inbox key is scoped (`inbox:read`, `inbox:act`), but whoever holds it acts for the whole clinic: serve the inbox behind the host's authentication and call `/api/inbox` from the host's server or a proxy that adds the key and `X-FollowUp-User` (the logged-in user) server-side, dropping any `X-FollowUp-User` the browser sent. `VITE_API_KEY` compiled into a browser bundle is for the demo only.
- **Webhooks.** A long random `WEBHOOK_SECRET` shared with the host only. Never deploy the development default `dev-only-webhook-secret` (the engine logs a warning when it runs on a real clock with it). Hosts verify the HMAC over `timestamp.deliveryId.body` and a 5-minute window ([integration.md](integration.md#verifying-the-signature-node)).
- **Edge limits.** The API caps bodies at 5 MB and rate-limits per key (600/min) and per client for wrong keys (60/min), in process memory: with several API replicas, add a shared limit at the gateway. It sends `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, a deny-all `Content-Security-Policy` (the `/docs` page allows only its pinned, SRI-checked Scalar bundle) and HSTS over HTTPS. Terminate TLS in front of it.
- **Database role.** The engine must connect as the role that owns its tables (the one that runs the migrations at boot): RLS is on for every table and does not restrict the owner.
