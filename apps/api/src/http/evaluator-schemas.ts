import { z } from 'zod';

/** `GET /api/demo/evaluator-events`: the chronological activity log, or its CSV export. */
export const EvaluatorEventsQuerySchema = z
  .object({
    format: z.enum(['json', 'csv']).optional().default('json'),
    evaluatorEmail: z.string().trim().min(1).max(254).optional(),
    /** Ignored when `format=csv`: the export is always the whole log. */
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
    cursor: z.string().trim().min(1).optional(),
  })
  .meta({ id: 'EvaluatorEventsQuery' });

export type EvaluatorEventsQuery = z.infer<typeof EvaluatorEventsQuerySchema>;

/** Pages of the inbox whose views are tracked (`page_viewed`). */
export const TRACKED_PAGES = [
  'inbox',
  'lab',
  'agent',
  'value',
  'engine_tests',
  'clinical_review',
  'patient',
  'metrics',
  'demo',
  'evaluators',
  'recovery',
] as const;

/**
 * `POST /api/evaluator/events`: what only the browser sees, reported by the
 * inbox. A closed list: a page view, or one of the agent page's selects.
 */
export const ClientEvaluatorEventSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('page_viewed'),
      page: z.enum(TRACKED_PAGES),
      /** The patient page's patient. */
      patientId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('agent_model_switched'), mode: z.enum(['scripted', 'live']) })
    .strict(),
  z
    .object({ action: z.literal('agent_language_switched'), language: z.enum(['en', 'es']) })
    .strict(),
]);
