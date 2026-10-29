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
