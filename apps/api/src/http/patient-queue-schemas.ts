import { z } from 'zod';
import {
  CaseReasonViewSchema,
  CaseStatusSchema,
  CaseViewSchema,
  LayerSchema,
  OriginSchema,
  PatientContactSchema,
  PatientExpectationViewSchema,
  PatientSummarySchema,
  PriorityLabelSchema,
  ProtocolRefViewSchema,
} from './schemas.ts';

/*
 * The patient queue contract (HIP-141): one card per patient, all their
 * active cases and reasons grouped. The engine keeps one case per patient
 * and reason group; this is a presentation of them.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const PatientQueueItemSchema = z
  .object({
    patient: PatientSummarySchema,
    priority: z.number().int().meta({ description: "The patient's most urgent case" }),
    priorityLabel: PriorityLabelSchema,
    status: CaseStatusSchema.meta({
      description:
        'The most pressing status among the cases: escalated, then notified, open, snoozed; a closed one only when every case is closed',
    }),
    caseCount: z.number().int(),
    reasonCount: z.number().int(),
    topReason: CaseReasonViewSchema.optional().meta({
      description: 'The reason that titles the card: the first reason of the most urgent case',
    }),
    layers: z.array(LayerSchema).meta({ description: 'Distinct layers of every reason' }),
    protocols: z
      .array(ProtocolRefViewSchema)
      .meta({ description: 'Distinct protocols behind the reasons, by id' }),
    escalation: z.object({
      currentStep: z.number().int().meta({ description: 'The furthest step among the cases' }),
      escalated: z.boolean().meta({ description: 'A case reached the coordinator' }),
      next: z
        .object({ caseId: z.string(), label: z.string(), at: isoDate })
        .optional()
        .meta({ description: 'The earliest step the engine runs next, and on which case' }),
    }),
    nextAction: z.object({
      caseId: z.string(),
      label: z.string().meta({ description: 'Suggested action of the most urgent case' }),
    }),
    origin: OriginSchema.meta({ description: 'live when any case is live' }),
    openedAt: isoDate.meta({ description: 'The oldest case' }),
    latestOpenedAt: isoDate.meta({ description: 'The newest case (the inbox marks it "new")' }),
    assignees: z.array(z.string()).meta({ description: 'Display names of the case owners' }),
    patientContact: PatientContactSchema,
    cases: z.array(CaseViewSchema).meta({ description: 'The cases, most urgent first' }),
  })
  .meta({ id: 'PatientQueueItem' });

export const PatientQueuePageSchema = z
  .object({
    items: z.array(PatientQueueItemSchema),
    nextCursor: z.string().optional(),
    total: z.number().int().meta({ description: 'Patients matching the query, across all pages' }),
    totalCases: z.number().int().meta({ description: 'Their cases matching the query' }),
  })
  .meta({ id: 'PatientQueuePage' });

export const PatientQueueQuerySchema = z.object({
  view: z.enum(['active', 'closed', 'all']).optional().default('active'),
  origin: OriginSchema.optional(),
  /** Owner id (from `/api/inbox/owners`). */
  assignee: z.string().max(120).optional(),
  /** Patient name or id contains this text. */
  q: z.string().trim().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const PatientContactRequestSchema = z
  .object({ note: z.string().max(2000).optional() })
  .meta({ id: 'PatientContactRequest' });

export const PlanItemReviewResponseSchema = z
  .object({
    expectation: PatientExpectationViewSchema,
    replacement: PatientExpectationViewSchema.optional().meta({
      description: 'correct only: the corrected item that replaced it',
    }),
    casesResolved: z
      .array(z.string())
      .meta({ description: 'Cases resolved because the item was their last unmet reason' }),
  })
  .meta({ id: 'PlanItemReviewResponse' });

export type PatientQueueItem = z.infer<typeof PatientQueueItemSchema>;
export type PatientQueuePage = z.infer<typeof PatientQueuePageSchema>;
export type PlanItemReviewResponse = z.infer<typeof PlanItemReviewResponseSchema>;
