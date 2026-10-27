import {
  createRuntime,
  DEFAULT_DEMO_INBOX_API_KEY,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { seedReviewerPilot } from './seed-reviewer.ts';
import { seedSyntheticClinic } from './seed.ts';

/**
 * `pnpm --filter @follow-up-engine/api seed`: loads the synthetic demo clinic
 * into the database `DATABASE_URL` points at. Needs `DEMO_API_KEY` (the host
 * integration key of the demo clinic); `DEMO_INBOX_API_KEY` (default
 * `demo-inbox-key`) is the inbox key to put in `VITE_API_KEY`. Forces the
 * fake clock. `SEED_PATIENTS=N` loads only the first N patients.
 */
const config = loadRuntimeConfig({
  DEMO_INBOX_API_KEY: DEFAULT_DEMO_INBOX_API_KEY,
  ...process.env,
  CLOCK: 'fake',
});
if (config.demo === undefined) {
  throw new Error('Set DEMO_API_KEY: the seeded clinic is reachable with it');
}
if (config.databaseUrl === undefined) {
  throw new Error(
    'Set DATABASE_URL: an in-memory seed would vanish with this process (use `pnpm --filter @follow-up-engine/api demo` instead)',
  );
}
const runtime = await createRuntime(config, { service: 'seed' });
const patients = process.env['SEED_PATIENTS'];
try {
  const report = await seedSyntheticClinic(runtime, {
    apiKey: config.demo.apiKey,
    ...(config.demo.inboxApiKey === undefined ? {} : { inboxApiKey: config.demo.inboxApiKey }),
    ...(patients === undefined ? {} : { patients: Number(patients) }),
    onProgress: (done, total) => {
      runtime.logger.info({ done, total }, 'seeding');
    },
  });
  runtime.logger.info(report, 'synthetic clinic seeded');
  if (process.env['SEED_REVIEWER'] !== 'false') {
    runtime.logger.info(await seedReviewerPilot(runtime), 'clinical reviewer shadow pilot seeded');
  }
  if (config.demo.inboxApiKey !== undefined) {
    process.stdout.write(
      `\nInbox key (inbox:read, inbox:act, demo:clock, demo:ingest; no fhir:write): ${config.demo.inboxApiKey}\n` +
        `  VITE_API_URL=http://localhost:3000 VITE_API_KEY=${config.demo.inboxApiKey} pnpm inbox\n`,
    );
  }
} finally {
  await runtime.close();
}
