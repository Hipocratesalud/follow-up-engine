import { createRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { loadApiConfig } from '../config.ts';
import { createApiServer } from '../server.ts';
import { seedSyntheticClinic } from './seed.ts';

/**
 * `pnpm --filter @follow-up-engine/api demo`: the whole product in one
 * process with no infrastructure. Fake clock, embedded worker, in-process
 * signed webhook sink, memory storage unless `DATABASE_URL` is set, and the
 * synthetic clinic seeded at startup (`SEED_PATIENTS`: 30 in memory, all 120
 * on Postgres; `SEED=false` skips it, for an already seeded database).
 */
const apiKey = process.env['DEMO_API_KEY'] ?? 'demo-clinic-key';
const config = loadRuntimeConfig({ ...process.env, CLOCK: 'fake', DEMO_API_KEY: apiKey });
const runtime = await createRuntime(config, { service: 'api' });
if (process.env['SEED'] !== 'false') {
  const report = await seedSyntheticClinic(runtime, {
    apiKey,
    // Memory storage snapshots per transaction: a subset keeps startup short.
    patients: Number(
      process.env['SEED_PATIENTS'] ?? (config.databaseUrl === undefined ? '30' : '120'),
    ),
  });
  runtime.logger.info(report, 'synthetic clinic seeded');
}
const server = createApiServer(runtime, { ...loadApiConfig(), embeddedWorker: true });
await server.listen();

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
