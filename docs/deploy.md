# Deploying the persistence layer

The engine keeps everything in one Postgres database: clinical records, expectations, cases, the audit trail, the job queue and the transactional outbox ([ADR 0003](adr/0003-postgres-job-runner-and-outbox.md)). `@follow-up-engine/adapter-postgres` implements every storage port of the core on it and runs unchanged on:

- **vanilla Postgres 15 or newer** (CI and `docker compose` use 16), and
- **Supabase** (managed Postgres 15/17; verified against the Supabase CLI's local stack, Postgres 15.8).

It needs no extensions and no superuser: `gen_random_uuid()` is built in since Postgres 13.

## Schema

All tables live in their own schema, `follow_up`, so the engine can share a database with a host application (for example a Supabase project that already has its own `public` tables) without name clashes.

| Table                       | Holds                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinics`                   | Tenants: name, `active`, `settings` (jsonb, partial `ClinicSettings`, `locale` included), `api_key_hash` (sha256 hex of the original integration key; never the key) |
| `api_keys`                  | Scoped API keys of each clinic: sha256 hex, `label`, `scopes` (`fhir:write`, `inbox:read`, `inbox:act`, `demo:clock`, `demo:ingest`, `admin:rules`), `revoked_at`    |
| `clinical_resources`        | Latest version of every FHIR resource pushed by the host (jsonb), unique per clinic + type + id. `version` increments only when the content changes                  |
| `clinical_events`           | Append-only log of normalized clinical events, unique per clinic + `idempotency_key`                                                                                 |
| `patient_conditions`        | Conditions per patient, unique per clinic + patient + code                                                                                                           |
| `expectations`              | "This should happen by this date", unique per clinic + `idempotency_key`; partial index on `due_at` where `status = 'open'`                                          |
| `follow_up_cases`           | Cases; a partial unique index allows one active case (`open`, `notified`, `snoozed`, `escalated`) per clinic + `dedup_key`                                           |
| `case_events`               | Append-only audit trail of cases                                                                                                                                     |
| `case_feedback`             | Clinician feedback on cases (a dismissal records its reason here too)                                                                                                |
| `contact_requests`          | Contact attempts (FHIR `CommunicationRequest`): case, channel, purpose, trigger, attempt number, answer deadline, the patient's `language` (0012)                    |
| `contact_communications`    | What came of each attempt (FHIR `Communication`), latest version per clinic + id: status, outcome, sender                                                            |
| `patient_contact_flags`     | Contact data flagged per patient (a wrong number), one per clinic + patient + issue, cleared when the patient is reached again                                       |
| `patient_rule_suppressions` | Rules stopped for one patient (who, when, why, source case); a partial unique index allows one active suppression per clinic + patient + rule                        |
| `quality_findings`          | Documentation-quality findings                                                                                                                                       |
| `llm_calls`                 | Tokens, cost (`numeric`, no float drift) and latency of every LLM call, per clinic                                                                                   |
| `outbox`                    | Domain events waiting for delivery to the host                                                                                                                       |
| `jobs`                      | Background jobs, claimed with `FOR UPDATE SKIP LOCKED`; a `dedup_key` is unique among unfinished (`pending`, `running`) jobs                                         |
| `backfill_progress`         | Resumable cursor and counters of the initial backfill; one unfinished (running or budget-paused) backfill per clinic                                                 |
| `rule_overrides`            | Per-clinic rule overrides in force (`due_in_days`, `enabled`), with their version, who, when and why                                                                 |
| `rule_override_history`     | Append-only history of every override change (old → new as jsonb, actor, reason, time); its row count per clinic is the revision caches check                        |
| `reconciliation_runs`       | Resumable nightly reconciliation runs: scope, event watermark, cursor, counters and repairs by kind; one running run per clinic                                      |
| `reconciliation_repairs`    | Append-only audit of every repair a run made (patient, entity, rule, status before and after; actor `system`, reason `reconciliation`)                               |

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

   - enables RLS on **every** `follow_up` table, found in the catalog (not a hand-kept list), and revokes table privileges and default privileges from `anon` and `authenticated`; tables without a policy (`jobs`, `outbox`, `backfill_progress`, `schema_migrations`, `api_keys`, the rule override and reconciliation tables) are invisible to API roles;
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
pnpm --filter @follow-up-engine/api clinic:create --id clinica-ejemplo --locale es-VE   # Spanish labels and findings
```

Scopes: `fhir:write` (the host integration: `/fhir`, `/jobs`), `inbox:read`, `inbox:act` (the inbox API), `admin:rules` (the clinic's rule configuration, `/api/admin/rules`: an operator's key, never the integration's or the inbox's), `demo:clock` and `demo:ingest` (the demo controls, fake clock only; refused for any clinic but `clinic-demo` unless `--allow-demo`). Key values are unique across clinics: issuing or registering a value another clinic holds (even revoked) fails and changes nothing. Give the host server one `fhir:write` key and the inbox its own key without `fhir:write`; rotate a key by issuing a new one under another label, switching, then `--revoke` the old label. New clinics start with patient contact disabled (`--allow-patient-contact` turns it on once the clinical team has validated it) and with the `en-US` locale: `--locale <bcp47>` (new or existing clinic) sets the language of the inbox labels when the user's `Accept-Language` names none the engine has (`en`, `es`), and of the clinical reviewer's findings. Patients and notes carry their own languages ([ADR 0007](adr/0007-language-model.md)).

## Rule overrides

A clinic's rules run with other deadlines, or switched off, without a new rule version ([integration.md](integration.md#per-clinic-rule-overrides)): through `PUT /api/admin/rules` with an `admin:rules` key, or from a terminal:

```sh
pnpm --filter @follow-up-engine/api clinic:rules --clinic clinica-ejemplo --list
pnpm --filter @follow-up-engine/api clinic:rules --clinic clinica-ejemplo \
  --set lab_order_result_pending.dueInDays=10 --reason "Our lab answers in a week"
pnpm --filter @follow-up-engine/api clinic:rules --clinic clinica-ejemplo \
  --disable imaging_order_result_pending --reason "No imaging in this clinic"
pnpm --filter @follow-up-engine/api clinic:rules --clinic clinica-ejemplo \
  --reset lab_order_result_pending --reason "Back to the protocol"
pnpm --filter @follow-up-engine/api clinic:rules --clinic clinica-ejemplo --history
```

Every change is validated (known rules and fields only, whole days from 1 to 3650, a reason), versioned per rule and kept in `rule_override_history` with who (`--actor`, default the operating system user), when, old → new and why. It applies to expectations created afterwards, which carry the rule version with the override (`1.1.0+clinic.2`); existing ones keep theirs. API and worker processes see a change at once (each catalog read checks the clinic's override revision).

## Nightly reconciliation

The worker queues one `reconciliation.run` job per clinic and night, at `settings.reconciliation.hour` (default 3) in the clinic's time zone, and runs it with the other jobs ([integration.md](integration.md#nightly-reconciliation)): patients with events stored since the previous run, and every patient on `fullSweepWeekday` (default Sunday; `null` turns the weekly sweep off; `enabled: false` turns the nightly run off). Each patient is planned in a rolled-back transaction and repaired in its own transaction, which also moves the run's cursor: a crash or a deploy resumes after the last patient done, and a retry of the job continues the same run. The initial backfill records a completed full run, so the first night does not replay the clinic again.

- **Alerting.** A run that repaired anything logs `alert: "reconciliation_repairs"` (counts only, no patient data) and emits `reconciliation.repairs_found`; a clean run logs `reconciliation` at info. Repairs mean something stored events without their effect: look at the repair log.
- **By hand.** `clinic:reconcile --clinic <id>` runs (or resumes) a run now, `--all` sweeps every patient, `--runs` lists the latest runs and `--repairs <runId>` what a run repaired.
- **Cost.** No LLM call: notes are not read again (a note whose plan was never read is retried by its own `note.extract_plan` job). Each patient's stored events are replayed once, in the rolled-back plan; only a patient with differences gets a writing transaction, and a clean patient writes nothing but the run's cursor, and a night with no event stored since the previous run records nothing at all. The demo's 168 patients take a few seconds in memory.
- **Edge.** "Since the previous run" follows the event log's sequence: an event inserted by a transaction still open when a run starts and committed after it can be missed by the next nightly run; the weekly full sweep covers it.

## Security checklist (production)

- **Real clock, no demo clinic.** `CLOCK=system` (the default). The demo clinic is not registered then, even if `DEMO_API_KEY` is set (the compose `app` profile sets it for convenience; it is logged and ignored), and the demo clinic refuses every key, even if a database once seeded by the demo still holds them (the published `demo-clinic-key`, `demo-inbox-key` or any short custom one). `DEMO_CLINIC=true` forces the demo clinic on a real clock and then requires private keys of 24+ characters, at startup and whenever a stored demo key authenticates.
- **Inbox behind the host's login.** The inbox key is scoped (`inbox:read`, `inbox:act`), but whoever holds it acts for the whole clinic: serve the inbox behind the host's authentication and call `/api/inbox` from the host's server or a proxy that adds the key and `X-FollowUp-User` (the logged-in user) server-side, dropping any `X-FollowUp-User` the browser sent. `VITE_API_KEY` compiled into a browser bundle is for the demo only.
- **Webhooks.** A long random `WEBHOOK_SECRET` shared with the host only. Never deploy the development default `dev-only-webhook-secret` (the engine logs a warning when it runs on a real clock with it). Hosts verify the HMAC over `timestamp.deliveryId.body` and a 5-minute window ([integration.md](integration.md#verifying-the-signature-node)).
- **Edge limits.** The API caps bodies at 5 MB and rate-limits per key (600/min) and per client for wrong keys (60/min), in process memory: with several API replicas, add a shared limit at the gateway. It sends `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, a deny-all `Content-Security-Policy` (the `/docs` page allows only its pinned, SRI-checked Scalar bundle) and HSTS over HTTPS. Terminate TLS in front of it.
- **Database role.** The engine must connect as the role that owns its tables (the one that runs the migrations at boot): RLS is on for every table and does not restrict the owner.

## Hosted demo

The demo can run on a public URL for people to try from their own computers: one container serves the API, the embedded worker and the built inbox on the same origin (no CORS, one URL), on a fake clock over the synthetic clinic, with the seed replaying the recorded Muse Spark readings and every live call (a consultation saved from the Demo page) going to Muse Spark. It is the `pnpm demo` process with three extras, all off unless set:

| Variable                      | What it does                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOX_DIST_DIR`              | Serves this inbox build at `/` (client routes get `index.html`, `/assets` are cached for good, the page gets its own CSP); `/api`, `/fhir`, `/jobs`, `/docs` stay the API. The image sets it.                                                                                                                             |
| `DEMO_ACCESS_CODE`            | A shared code (16+ characters) in front of everything but `/healthz` and `/readyz`: a page load goes to `/_access`, an API call without it gets 401. The right code sets an HttpOnly cookie for 30 days (an HMAC of the code: changing the code signs everyone out). Wrong codes are limited to 10 per minute per client. |
| `DEFAULT_UI_LOCALE`           | `en` (default) or `es`: the inbox's language until a viewer picks one with the EN / ES switch. The code page does not use it: it follows its own EN / ES switch, else the browser's `Accept-Language`, else English.                                                                                                      |
| `DEMO_LLM_MONTHLY_BUDGET_USD` | The demo clinic's monthly LLM budget (default 50). The replayed seed readings count at what they cost when recorded (about USD 4.8), so a cap of 15 leaves about USD 10 for live calls; past it the model is not called.                                                                                                  |
| `DEMO_SESSION_SECRET`         | Signs the evaluator identity cookie (below). Optional: without it, derived from `DEMO_ACCESS_CODE`, so a deployment that only ever set the access code keeps working with no new variable.                                                                                                                                |

The image is `apps/api/Dockerfile.demo` (the inbox is built inside it with `VITE_API_URL=/`, and the `DEMO_INBOX_API_KEY` build argument compiled in as `VITE_API_KEY`: whoever passes the code holds the inbox key, which is why the code covers the whole site). `railway.json` points Railway at it, with `/healthz` as the health check (the first boot seeds for about a minute before it listens).

**Railway.** The project is `follow-up-engine-demo` (one service of the same name and a Postgres database). Its service variables: `DATABASE_URL` (a reference to the Postgres service), `LLM_PROVIDER=meta`, `META_API_KEY`, `DEMO_API_KEY`, `DEMO_INBOX_API_KEY` (private random keys), `DEMO_ACCESS_CODE`, `DEFAULT_UI_LOCALE=es`, `DEMO_LLM_MONTHLY_BUDGET_USD=15`, `WEBHOOK_SECRET` (random; the webhooks land in the in-process sink). `CLOCK=fake`, `EMBEDDED_WORKER=true` and `INBOX_DIST_DIR` come from the image.

The service settings also carry the build (Dockerfile path `apps/api/Dockerfile.demo`, health check `/healthz` with a 600 s window): a CLI upload built with Railpack until they were set on the service, `railway.json` alone was not enough. Both services run in `us-east4` (closest to the clinics in Latin America).

**Live Muse Spark calls from Railway.** The Meta Model API answers Railway's egress addresses (EU and US alike) with an empty model list and 404 on `muse-spark-1.3`, while the same key works from a developer's machine. The seed is unaffected (it replays the recorded readings, labeled Muse Spark), but a consultation saved from the Demo page is read by the fake provider, labeled "simulated reading (no model)", until Meta allows those addresses (or the demo runs where Meta answers). `META_BASE_URL` routes Meta calls through a relay instead of `api.meta.ai` (must end before `/chat/completions`, e.g. `https://relay.example/v1`): set it on the Railway service once a relay is available from an address Meta does serve, with no other change to `LLM_PROVIDER=meta`.

**The relay in use.** The hosted demo reaches Meta through a small relay in São Paulo (a Vercel function), because Meta's API does not serve US IPs. It keeps only the SHA-256 of the key, accepts a request only when its key matches that hash, and forwards only a whitelist of paths.

**Redeploy** after changes, from a checkout of the branch to ship:

```sh
pnpm deploy:demo
```

(`sh scripts/deploy-demo.sh` does the same with any pnpm.) It uploads the working tree (git-ignored files, `.env` included, stay out) to that project only: it looks the project up by name, passes the project, service and environment explicitly, and refuses to run in a directory the Railway CLI links to any other project. The new deployment takes traffic once `/healthz` answers; until then the previous one serves.

- **Seeded once.** The seed is a no-op on a database that holds the seeded clinic, so a restart or a redeploy keeps every case, verdict and action people took.
- **One shared clock.** The simulated date lives in the process: "+1 day" moves it for everyone, and a restart or a redeploy starts it again on 2026-01-05 (cases already released stay released). To start the demo over, delete and re-add the Postgres database, then redeploy. The one exception is each evaluator's own lab clinic (below): its clock is separate and the shared "+1 day" never touches it.
- **One replica.** The fake clock and the in-process webhook sink assume a single instance.

### Evaluator identity and tracking

The access gate (`DEMO_ACCESS_CODE`) also asks for an email (the code is still required; no password, nothing is emailed). The email, validated and lowercased, is kept in a second signed, httpOnly cookie (`fue_evaluator`, HMAC'd with `DEMO_SESSION_SECRET`, falling back to a value derived from `DEMO_ACCESS_CODE` so an existing deployment needs no new variable), and pre-fills the code page on "Change" (`POST /api/evaluator/logout` clears both cookies). The inbox shows "Evaluating as `<email>`" (`GET /api/evaluator/me`) with that "Change" action. Every request that goes through the gate carries the identity server-side (`c.var.evaluatorEmail`, `actorId()` in `apps/api/src/http/security.ts`): it becomes the actor of case feedback, case actions, plan-item reviews, suppressions and clinical-review findings instead of the generic `inbox-user`, and every mutating action, lab document upload, lab record, lab date change and two lightweight views (a case detail, a patient's documents) are appended to `evaluator_events` (migration 0016, adapter-postgres; `MemoryEvaluatorEventStore`/`PostgresEvaluatorEventStore` in `@follow-up-engine/runtime`). The inbox's "Evaluators" page (`GET /api/demo/evaluators` for the per-evaluator summary, `GET /api/demo/evaluator-events?format=json|csv` for the chronological log and its export) reads it back: last seen, counts by action, a "Download CSV" link.

**What is tracked.** Besides the server-side actions above, the inbox reports what only the browser sees through `POST /api/evaluator/events` (a closed list, only with an evaluator identity): one `page_viewed` per page opened (Inbox, Lab, Agent, Value, Engine tests, Clinical review, a patient's page, Metrics, Demo, Evaluators, To recover), and the agent page's model and language selects. Every other agent control is logged by the API under its own action: `agent_story_started` (with `restart`), `agent_reply_suggested`, `agent_message_typed`, `agent_media_uploaded`, `agent_sample_sent`, `agent_clock_jumped`, `agent_delivery_status_set`, `agent_phone_fixed`. `EVALUATOR_ACTIONS` (`packages/runtime/src/evaluator-events.ts`) is the list; a test fails when one lacks its English or Spanish label.

**Test and QA accounts.** `config/demo/test-evaluators.json` names the evaluators that are not physicians: any address at `example.com` (and `.org`, `.net`) plus explicit addresses. Nothing of theirs is deleted, but every reported number leaves them out: the clinic metrics (their verdicts, plan-item reviews and case actions; a case they closed counts as still open), the inbox's usefulness tile, the rule calibration, the reviewer's precision, and the Evaluators summary (they are listed apart). The activity log badges their rows and the CSV carries an `is_test_evaluator` column.

**Rotating the demo keys.** Set new `DEMO_API_KEY` and `DEMO_INBOX_API_KEY` values on the service (`railway variable set KEY --stdin --skip-deploys`) and redeploy: the boot replaces the demo clinic's host key and revokes the previous inbox key, so both old keys stop working. The inbox key is compiled into the bundle from the same variable. Neither key is printed: the boot banner names the variable instead, and the image build reads the key inside the shell so BuildKit does not print it in the step name.

### The Lab page and its per-evaluator sandbox clock

The inbox's "Lab" page is every evaluator's own sandbox: a patient picker (their own fictitious lab patients, or "New patient": name, sex, age, specialty) and "Add to the record", a type selector over either a document (upload a PDF/DOCX/TXT or paste text, with its own date and type, ingested through the normal FHIR path — note extraction via `llm_gateway`, labeled "Simulated reading" when the fake provider answers, `POST /api/demo/lab/documents`) or a structured entry with no LLM call at all (`buildRecordBundle`, `@follow-up-engine/fhir`): a lab/imaging order, a result, a prescription, a visit, a diagnosis, or an appointment booked/cancelled, each with its own date (`POST /api/demo/lab/records`). After each save the page shows what was read (quotes highlighted in the text), the patient's timeline and an expectations table (`GET /api/demo/lab/patients/:id/expectations`) with what changed since the previous action highlighted. "See the impact on a date" (`POST /api/demo/lab/date`, forward only) moves the lab's own clock and shows the watcher/escalation impact plus the lab's own cases (`GET /api/demo/lab/cases`).

**Import history (V1-A).** The Lab page's "Import history" card (`POST /api/demo/lab/history`, JSON with base64 files or multipart `files` + a `documents` JSON field; `GET /api/demo/lab/history/samples` serves the committed synthetic set from `scripts/generate-history-samples.py`) takes several documents of one patient at once — PDF, DOCX, TXT, photos of results — each with the date it was written. Notes are staged as FHIR DocumentReferences for the note extractor; lab reports (a `lab_result` document, every photo) go through the order agent's lab-result reading (`PatientMediaReader`: Muse Spark vision for a photo — only for a clinic whose `allowUnmaskedImagesToProvider` setting is on, which is the demo clinic and the lab sandboxes; it is off by default, and the `llm_gateway` then refuses every image before any provider call, so the photo is held as "needs review" with reason "photos can't be read automatically for this clinic" and the order agent hands it to the team with a task — the PDF's extracted text — masked like a note, the patient's names and identifiers replaced before Muse Spark reads it; a photo cannot be masked — for a document) and are staged as FHIR Observations coded like the agent codes them. A report whose printed name is another person's (compared by code, as the agent does) is held as "needs review" and never staged, so it closes nothing: it is stored per clinic (`held_lab_reports`, migration 0025; `GET /api/demo/lab/held-reports`) and listed on the Lab page ("Needs review", and a card on the selected patient) until someone decides. "It's this patient" (`POST …/held-reports/{id}/confirm`) records who and when, then stages its Observations and replays the patient exactly like an accepted report, so the engine may close an order; "Not this patient" (`…/discard`) keeps who and when and records nothing. Both are evaluator events. A held report is keyed by the document's content key: importing it again never reads it again. A result is dated by the collection/report date printed on it when the reader finds one (the entered date otherwise, or when the printed one is after the lab's date); a gap of more than 3 days between the two is flagged. Then `engine.backfill.replayPatients` replays that one patient on the lab's own clock, as its own run (it never starts, resumes or completes the clinic's backfill run): chronologically, so a result collected after an order closes it and one collected before does not; everything it creates is `origin: backfill`, and what history left unmet becomes held backfill cases released by `planBackfillRelease` (the lab clinic's cap is 1 case per owner per day, so two sample patients already show it; a plan counts what earlier plans released on the same calendar day in the clinic's time zone, and a later day's batch comes out at that day's local midnight). The lab's "To recover" (`GET /api/demo/lab/recovery`) lists the held ones; "What happens on a date?" releases the next batch. Re-importing the same documents (same patient, date, type and bytes) stages nothing and reads nothing. The order agent also accepts a lab report as a PDF on the simulated phone (`kind: document`, migration 0021): its text goes through the same lab-result reading, then `match_result_to_order` and `submit_fhir_result`.

**Per-evaluator clock.** Every evaluator gets their own empty sandbox clinic (`lab-<sha256 prefix of their email>`, `ensureLabClinic` in `packages/runtime/src/runtime.ts`), so "see the impact on a date" for one evaluator can never change what another evaluator — or the shared seeded clinic — sees. `activeClinicIds()` excludes every `lab-*` clinic by id prefix, so neither the worker's periodic sweep nor the shared `POST /api/demo/clock/advance` ever touches one. What was still missing was the lab clinic's own _movable_ date: `LabClockRegistry` (`packages/runtime/src/lab.ts`) gives each lab clinic its own in-process `FakeClock` (core's `Clock` port stays untouched and pure — nothing here makes it clinic-aware). `setLabClinicDate` moves that one clock forward, one simulated day at a time, calling `FollowUpEngine.runWatcher`/`.runEscalation` directly for that one clinic with the clock's own `now()` (the same two calls `Worker`'s ambient sweep makes, just scoped to one clinic and one clock instead of the shared one, and accumulating their reports into the impact totals the Lab page shows); `labIngestion` binds a fresh `IngestionService` to the same clock so a lab document's `receivedAt` agrees with the lab's own "today". In-memory, one process — consistent with the shared fake clock already assuming a single replica, so a restart resetting every lab clinic back to "today" is harmless for a disposable sandbox. The Demo page's global "Advance time" control only moves the shared clinic's clock; any identified evaluator sees a link to the Lab there instead, so an evaluator can never accidentally change what everyone else sees.
