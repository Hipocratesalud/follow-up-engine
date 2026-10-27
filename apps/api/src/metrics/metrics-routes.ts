import type { ClinicMetrics } from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { App } from '../http/context.ts';
import { readQuery } from '../http/errors.ts';
import { type ClinicMetricsView, MetricsQuerySchema } from './schemas.ts';

/** The engine's metrics as the inbox reads them: dates as ISO strings, nothing else changes. */
export function metricsView(metrics: ClinicMetrics): ClinicMetricsView {
  return {
    period: { from: metrics.period.from.toISOString(), to: metrics.period.to.toISOString() },
    asOf: metrics.asOf.toISOString(),
    cases: metrics.cases,
    bookings: metrics.bookings,
    timeToFirstAction: metrics.timeToFirstAction,
    feedback: metrics.feedback,
    dismissals: metrics.dismissals,
    extractionReviews: metrics.extractionReviews,
    aiCost: { ...metrics.aiCost, byTask: [...metrics.aiCost.byTask] },
    backfill: metrics.backfill,
  };
}

/**
 * `GET /api/inbox/metrics?from=&to=` (HIP-141): the clinic's metrics over
 * `[from, to)`, default the last 30 days up to the engine clock. A period
 * that does not start before it ends, or longer than the maximum, is a 422.
 */
export function registerMetricsRoutes(app: App, runtime: EngineRuntime): void {
  app.get('/api/inbox/metrics', async (c) => {
    const query = readQuery(c, MetricsQuerySchema);
    const metrics = await runtime.engine.metrics(c.var.clinicId, {
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
    });
    return c.json(metricsView(metrics));
  });
}
