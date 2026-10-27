import {
  createRuntime,
  DEFAULT_DEMO_API_KEY,
  DEFAULT_DEMO_INBOX_API_KEY,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { loadApiConfig } from '../config.ts';
import { createApiServer } from '../server.ts';
import { seedSyntheticClinic } from './seed.ts';

/**
 * `pnpm --filter @follow-up-engine/api demo`: the whole product in one
 * process with no infrastructure. Fake clock, embedded worker, in-process
 * signed webhook sink, memory storage unless `DATABASE_URL` is set, and the
 * synthetic clinic loaded at startup through the initial backfill (all 120
 * patients; `SEED_PATIENTS=N` loads fewer, `SEED=false` skips it). Seeding an
 * already seeded database is a no-op.
 */
const apiKey = process.env['DEMO_API_KEY'] ?? DEFAULT_DEMO_API_KEY;
const inboxApiKey = process.env['DEMO_INBOX_API_KEY'] ?? DEFAULT_DEMO_INBOX_API_KEY;
const config = loadRuntimeConfig({
  ...process.env,
  CLOCK: 'fake',
  DEMO_API_KEY: apiKey,
  DEMO_INBOX_API_KEY: inboxApiKey,
});
const runtime = await createRuntime(config, { service: 'api' });
if (process.env['SEED'] !== 'false') {
  const report = await seedSyntheticClinic(runtime, {
    apiKey,
    inboxApiKey,
    ...(process.env['SEED_PATIENTS'] === undefined
      ? {}
      : { patients: Number(process.env['SEED_PATIENTS']) }),
  });
  runtime.logger.info(report, 'synthetic clinic seeded');
}
const server = createApiServer(runtime, { ...loadApiConfig(), embeddedWorker: true });
const port = await server.listen();
process.stdout.write(
  `\nDemo clinic keys (synthetic, demo only; refused on a real clock):\n` +
    `  host integration (fhir:write, inbox, demo): ${apiKey}\n` +
    `  inbox (inbox:read, inbox:act, demo; no fhir:write): ${inboxApiKey}\n` +
    `  VITE_API_URL=http://localhost:${String(port)} VITE_API_KEY=${inboxApiKey} pnpm inbox\n\n`,
);

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
