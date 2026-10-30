import {
  CLINICAL_REVIEW_PROMPT_VERSION,
  emptySnapshot,
  NOTE_EXTRACTION_PROMPT_VERSION,
  parseSnapshot,
} from '@follow-up-engine/llm';
import {
  createRuntime,
  DEFAULT_DEMO_API_KEY,
  DEFAULT_DEMO_INBOX_API_KEY,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { LLM_SNAPSHOTS, readLlmSnapshot } from '@follow-up-engine/testkit';
import { loadApiConfig } from '../config.ts';
import { createApiServer } from '../server.ts';
import { seedAdjudicatorPilot } from './seed-adjudicator.ts';
import { seedReviewerPilot } from './seed-reviewer.ts';
import { seedSyntheticClinic } from './seed.ts';

/**
 * `pnpm --filter @follow-up-engine/api demo`: the whole product in one
 * process with no infrastructure. Fake clock, embedded worker, in-process
 * signed webhook sink, memory storage unless `DATABASE_URL` is set, and the
 * synthetic clinic loaded at startup through the initial backfill (all 148
 * patients; `SEED_PATIENTS=N` loads fewer, `SEED=false` skips it). Seeding an
 * already seeded database is a no-op.
 *
 * Notes are read by Muse Spark when `META_API_KEY` is set (the default
 * `LLM_PROVIDER`), by the fake provider otherwise. With Muse Spark the seed
 * never calls the model: it replays the readings recorded once from it
 * (`packages/testkit/fixtures/llm-snapshots/demo-clinic.meta.json`,
 * `demo:record`), so the backfill takes seconds, costs nothing and is the
 * same on every boot. A seed request the snapshot does not hold (a newer
 * prompt version) is answered by the fake provider and labeled as such.
 * Once the seed is done, every request (a consultation from the Demo page,
 * `POST /fhir`) calls Muse Spark.
 */
const apiKey = process.env['DEMO_API_KEY'] ?? DEFAULT_DEMO_API_KEY;
const inboxApiKey = process.env['DEMO_INBOX_API_KEY'] ?? DEFAULT_DEMO_INBOX_API_KEY;
const config = loadRuntimeConfig({
  ...process.env,
  CLOCK: 'fake',
  DEMO_API_KEY: apiKey,
  DEMO_INBOX_API_KEY: inboxApiKey,
});
const snapshotText = readLlmSnapshot(LLM_SNAPSHOTS.demoClinic);
const snapshot = snapshotText === undefined ? emptySnapshot('meta') : parseSnapshot(snapshotText);
/** The seed replays only; live calls start once it is done. */
let seeding = true;
const runtime = await createRuntime(config, {
  service: 'api',
  llmSnapshot: { snapshot, allowLive: () => !seeding },
});
if (runtime.llmReplay !== undefined) {
  const stale = [NOTE_EXTRACTION_PROMPT_VERSION, CLINICAL_REVIEW_PROMPT_VERSION].filter(
    (version) => !snapshot.promptVersions.includes(version),
  );
  if (stale.length > 0) {
    runtime.logger.warn(
      { recorded: snapshot.promptVersions, current: stale },
      'the Muse Spark snapshot predates these prompt versions: the seed reads their requests with the fake provider (re-record with `pnpm --filter @follow-up-engine/api demo:record`)',
    );
  }
}
if (process.env['SEED'] !== 'false') {
  const report = await seedSyntheticClinic(runtime, {
    apiKey,
    inboxApiKey,
    ...(config.demo?.llmMonthlyBudgetUsd === undefined
      ? {}
      : { llmMonthlyBudgetUsd: config.demo.llmMonthlyBudgetUsd }),
    ...(process.env['SEED_PATIENTS'] === undefined
      ? {}
      : { patients: Number(process.env['SEED_PATIENTS']) }),
  });
  runtime.logger.info(report, 'synthetic clinic seeded');
  if (process.env['SEED_REVIEWER'] !== 'false') {
    // The clinical reviewer's shadow pilot: the planted cohort, then one review per patient.
    runtime.logger.info(await seedReviewerPilot(runtime), 'clinical reviewer shadow pilot seeded');
  }
  if (process.env['SEED_ADJUDICATOR'] !== 'false') {
    // The adjudicator's shadow pilot: decisions on the inbox's ambiguous plan items.
    runtime.logger.info(await seedAdjudicatorPilot(runtime), 'adjudicator shadow pilot seeded');
  }
  if (runtime.llmReplay !== undefined) {
    const { hits, misses } = runtime.llmReplay.stats();
    runtime.logger.info(
      {
        replayed: hits,
        notInSnapshot: misses,
        provider: runtime.extractor.provider,
        model: runtime.extractor.model,
      },
      'seed model calls: recorded Muse Spark replies replayed, the rest read by the fake provider',
    );
  }
}
seeding = false;
const server = createApiServer(runtime, { ...loadApiConfig(), embeddedWorker: true });
const port = await server.listen();
process.stdout.write(
  `\nDemo clinic keys (synthetic, demo only; refused on a real clock):\n` +
    `  host integration (fhir:write, inbox, demo:clock, demo:ingest): ${apiKey}\n` +
    `  inbox (inbox:read, inbox:act, demo:clock, demo:ingest; no fhir:write): ${inboxApiKey}\n` +
    `  VITE_API_URL=http://localhost:${String(port)} VITE_API_KEY=${inboxApiKey} pnpm inbox\n\n`,
);

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
