import { serve } from '@hono/node-server';
import {
  createLogger,
  createWebhookSinkApp,
  DEV_WEBHOOK_SECRET,
  WEBHOOK_SINK_PATH,
  WebhookSink,
} from '@follow-up-engine/runtime';

/**
 * Development webhook receiver (`pnpm --filter @follow-up-engine/worker webhook-sink`):
 * verifies signatures like a host must and serves the last deliveries at
 * `GET /deliveries`. Never deploy it as a real host endpoint.
 */
const port = Number(process.env['PORT'] ?? '4000');
const secret = process.env['WEBHOOK_SECRET'] ?? DEV_WEBHOOK_SECRET;
const logger = createLogger({ level: process.env['LOG_LEVEL'] ?? 'info', service: 'webhook-sink' });
const sink = new WebhookSink({ secret });
const server = serve({ fetch: createWebhookSinkApp(sink).fetch, port }, (info) => {
  logger.info({ port: info.port, path: WEBHOOK_SINK_PATH }, 'webhook sink listening');
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
