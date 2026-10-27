import { createRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { loadApiConfig } from './config.ts';
import { createApiServer } from './server.ts';

/**
 * API process: `pnpm --filter @follow-up-engine/api start`. Migrates the
 * database (when `DATABASE_URL` is set), registers the demo clinic (when
 * `DEMO_API_KEY` is set), listens on `PORT`, and with `EMBEDDED_WORKER=true`
 * also runs the worker. Graceful shutdown on SIGTERM / SIGINT.
 */
const runtime = await createRuntime(loadRuntimeConfig(), { service: 'api' });
const server = createApiServer(runtime, loadApiConfig());
await server.listen();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  runtime.logger.info({ signal }, 'shutting down');
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
