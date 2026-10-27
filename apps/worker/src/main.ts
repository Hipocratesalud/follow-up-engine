import { createRuntime, loadRuntimeConfig, Worker } from './index.ts';

/**
 * Standalone worker process: `pnpm --filter @follow-up-engine/worker start`.
 * Stops gracefully on SIGTERM / SIGINT (finishes the passes in flight).
 */
const config = loadRuntimeConfig();
const runtime = await createRuntime(config, { service: 'worker' });
const worker = new Worker(runtime);
worker.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  runtime.logger.info({ signal }, 'shutting down');
  await worker.stop();
  await runtime.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
