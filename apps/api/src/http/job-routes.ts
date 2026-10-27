import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { App } from './context.ts';
import { notFound } from './errors.ts';
import type { JobStatusView } from './schemas.ts';

/**
 * `GET /jobs/:id`: the status of a job the clinic's own request enqueued
 * (`X-FollowUp-Job` / `Content-Location` of an asynchronous `POST /fhir`).
 * Another clinic's job, or an unknown id, is 404.
 */
export function registerJobRoutes(app: App, runtime: EngineRuntime): void {
  app.get('/jobs/:id', async (c) => {
    const job = await runtime.storage.readModel.getJob(c.var.clinicId, c.req.param('id'));
    if (job === undefined) {
      throw notFound('No encontramos ese trabajo.');
    }
    const view: JobStatusView = {
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
      createdAt: job.createdAt.toISOString(),
      ...(job.status === 'pending' ? { nextAttemptAt: job.runAt.toISOString() } : {}),
    };
    return c.json(view);
  });
}
