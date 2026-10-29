import type { EngineRuntime, EvaluatorEvent } from '@follow-up-engine/runtime';
import { readQuery } from './errors.ts';
import { EvaluatorEventsQuerySchema } from './evaluator-schemas.ts';
import type { App } from './context.ts';

/** The whole log, for the CSV export (an internal eval tool's modest volume: one page is enough). */
const CSV_EXPORT_LIMIT = 10_000;

function eventView(event: EvaluatorEvent): Record<string, unknown> {
  return {
    id: event.id,
    clinicId: event.clinicId,
    evaluatorEmail: event.evaluatorEmail,
    action: event.action,
    ...(event.entityType === undefined ? {} : { entityType: event.entityType }),
    ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
    ...(event.patientId === undefined ? {} : { patientId: event.patientId }),
    ...(event.payload === undefined ? {} : { payload: event.payload }),
    simulatedAt: event.simulatedAt.toISOString(),
    occurredAt: event.occurredAt.toISOString(),
  };
}

/** One CSV field, quoted when it holds a comma, a quote or a newline (RFC 4180). */
function csvField(value: unknown): string {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_COLUMNS = [
  'occurredAt',
  'simulatedAt',
  'evaluatorEmail',
  'action',
  'clinicId',
  'entityType',
  'entityId',
  'patientId',
  'payload',
] as const;

function toCsv(events: readonly EvaluatorEvent[]): string {
  const rows = events.map(eventView);
  const lines = [
    CSV_COLUMNS.join(','),
    ...rows.map((row) => CSV_COLUMNS.map((column) => csvField(row[column])).join(',')),
  ];
  return lines.join('\r\n');
}

/**
 * The hosted demo's "Evaluators" admin page (docs/deploy.md#hosted-demo):
 * per evaluator, last seen and counts by action, and the full chronological
 * activity log, exportable as CSV. Registered only on a fake clock,
 * alongside the rest of `/api/demo/*` (`requireScope({ demoRoutes: true })`
 * in `demo-routes.ts` already covers this path prefix).
 */
export function registerEvaluatorRoutes(app: App, runtime: EngineRuntime): void {
  app.get('/api/demo/evaluators', async (c) => {
    const summaries = await runtime.storage.evaluatorEvents.summary();
    return c.json({
      items: summaries.map((summary) => ({
        evaluatorEmail: summary.evaluatorEmail,
        firstSeenAt: summary.firstSeenAt.toISOString(),
        lastSeenAt: summary.lastSeenAt.toISOString(),
        total: summary.total,
        byAction: summary.byAction,
      })),
    });
  });

  app.get('/api/demo/evaluator-events', async (c) => {
    const query = readQuery(c, EvaluatorEventsQuerySchema);
    if (query.format === 'csv') {
      const page = await runtime.storage.evaluatorEvents.list({
        limit: CSV_EXPORT_LIMIT,
        ...(query.evaluatorEmail === undefined ? {} : { evaluatorEmail: query.evaluatorEmail }),
      });
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', 'attachment; filename="evaluator-events.csv"');
      return c.body(toCsv(page.items));
    }
    const page = await runtime.storage.evaluatorEvents.list({
      limit: query.limit,
      ...(query.evaluatorEmail === undefined ? {} : { evaluatorEmail: query.evaluatorEmail }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return c.json({
      items: page.items.map(eventView),
      total: page.total,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });
}
