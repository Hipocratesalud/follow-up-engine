import { createRuntime, loadRuntimeConfig } from '@follow-up-engine/worker';
import { seedSyntheticClinic } from './seed.ts';

/**
 * `pnpm --filter @follow-up-engine/api seed`: loads the synthetic demo clinic
 * into the database `DATABASE_URL` points at. Needs `DEMO_API_KEY` (the key
 * the inbox will use); forces the fake clock. `SEED_PATIENTS=N` loads only
 * the first N patients.
 */
const config = loadRuntimeConfig({ ...process.env, CLOCK: 'fake' });
if (config.demoApiKey === undefined) {
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
    apiKey: config.demoApiKey,
    ...(patients === undefined ? {} : { patients: Number(patients) }),
    onProgress: (done, total) => {
      runtime.logger.info({ done, total }, 'seeding');
    },
  });
  runtime.logger.info(report, 'synthetic clinic seeded');
} finally {
  await runtime.close();
}
