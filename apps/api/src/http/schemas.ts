import {
  CASE_STATUSES,
  ESCALATION_ACTIONS,
  EXPECTATION_LAYERS,
  EXPECTATION_STATUSES,
  PLAN_ITEM_KINDS,
} from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * The inbox JSON contract (`/api`), as zod schemas: requests are validated
 * with them, responses are typed from them, and the OpenAPI document is
 * generated from them. Mirrors `apps/inbox/src/api/contract.ts`.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const LayerSchema = z.enum(EXPECTATION_LAYERS);
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export const PriorityLabelSchema = z.enum(['baja', 'media', 'alta', 'urgente']);
export const SexSchema = z.enum(['female', 'male', 'other', 'unknown']);
export const OriginSchema = z.enum(['live', 'backfill']);
export const FeedbackReasonSchema = z.enum([
  'wrong_rule',
  'wrong_interval',
  'bad_extraction',
  'already_handled',
  'other',
]);

export const ErrorBodySchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .meta({ id: 'Error' });

export const PatientSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    age: z.number().int().optional(),
    sex: SexSchema.optional(),
  })
  .meta({ id: 'PatientSummary' });

export const PatientContactSchema = z
  .object({ allowed: z.boolean(), optedOut: z.boolean(), lastContactAt: isoDate.optional() })
  .meta({ id: 'PatientContact' });

export const CaseReasonViewSchema = z
  .object({
    expectationId: z.string(),
    ruleId: z.string(),
    layer: LayerSchema,
    label: z.string().meta({ description: 'Spanish; never includes a day count' }),
    dueAt: isoDate,
    overdueDays: z.number().int(),
    source: z.object({ resourceType: z.string(), id: z.string(), display: z.string() }),
    evidence: z
      .object({
        quote: z.string(),
        documentId: z.string(),
        authoredAt: isoDate,
        noteExcerpt: z.string().optional(),
      })
      .optional(),
  })
  .meta({ id: 'CaseReasonView' });

export const EscalationStepViewSchema = z
  .object({
    action: z.enum(ESCALATION_ACTIONS),
    label: z.string().meta({ description: 'Spanish label of the step' }),
    afterDays: z.number().int().meta({ description: 'Days after the case opened, per the policy' }),
    outcome: z.enum(['done', 'skipped']).optional().meta({
      description:
        'Case detail only, for steps already passed: done, or skipped when it could not happen (for example no automatic patient contact for a backfill case)',
    }),
    at: isoDate.optional().meta({ description: 'Case detail only: when a done step ran' }),
  })
  .meta({ id: 'EscalationStepView' });

export const EscalationViewSchema = z
  .object({
    policyId: z.string(),
    currentStep: z
      .number()
      .int()
      .meta({ description: 'Steps of the policy already passed (the case escalationStep)' }),
    steps: z.array(EscalationStepViewSchema),
    next: z
      .object({ action: z.enum(ESCALATION_ACTIONS), label: z.string(), at: isoDate })
      .optional()
      .meta({ description: 'The next step and when it runs; absent on closed cases' }),
  })
  .meta({ id: 'EscalationView' });

export const CaseViewSchema = z
  .object({
    id: z.string(),
    patient: PatientSummarySchema,
    status: CaseStatusSchema,
    priority: z.number().int(),
    priorityLabel: PriorityLabelSchema,
    escalationStep: z.number().int(),
    escalation: EscalationViewSchema,
    assignee: z.string().optional().meta({ description: 'Display name of the owner' }),
    assigneeId: z.string().optional().meta({
      description: 'Owner id (a practitioner id or a role), as the assignee filter takes it',
    }),
    origin: OriginSchema,
    openedAt: isoDate,
    nextActionAt: isoDate.optional(),
    releaseAt: isoDate.optional(),
    snoozedUntil: isoDate.optional(),
    reasons: z.array(CaseReasonViewSchema),
    suggestedAction: z.string(),
    patientContact: PatientContactSchema,
  })
  .meta({ id: 'CaseView' });

export const CaseTimelineEntrySchema = z
  .object({
    at: isoDate,
    type: z.string(),
    actor: z.object({
      type: z.enum(['rule', 'user', 'patient', 'system']),
      id: z.string().optional(),
    }),
    label: z.string(),
    note: z
      .string()
      .optional()
      .meta({ description: 'Internal note the team wrote with the action' }),
  })
  .meta({ id: 'CaseTimelineEntry' });

export const CaseFeedbackViewSchema = z.object({
  useful: z.boolean(),
  reason: FeedbackReasonSchema.optional(),
  comment: z.string().optional(),
});

export const CaseDetailSchema = CaseViewSchema.extend({
  timeline: z.array(CaseTimelineEntrySchema),
  feedback: CaseFeedbackViewSchema.optional(),
}).meta({ id: 'CaseDetail' });

export const CasePageSchema = z
  .object({
    items: z.array(CaseViewSchema),
    nextCursor: z.string().optional(),
    total: z.number().int().meta({ description: 'Cases matching the query, across all pages' }),
  })
  .meta({ id: 'CasePage' });

export const RecoveryPageSchema = CasePageSchema.meta({ id: 'RecoveryPage' });

export const CaseListQuerySchema = z.object({
  view: z.enum(['active', 'closed', 'all']).optional().default('active'),
  origin: OriginSchema.optional(),
  /** Owner id (from `/api/inbox/owners`). */
  assignee: z.string().max(120).optional(),
  /** Patient name or id contains this text. */
  q: z.string().trim().max(100).optional(),
  /** Only the cases of this patient. */
  patient: z.string().trim().max(64).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const OwnerViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    activeCases: z.number().int(),
  })
  .meta({ id: 'OwnerView' });

export const OwnerListSchema = z
  .object({ items: z.array(OwnerViewSchema) })
  .meta({ id: 'OwnerList' });

export const PageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const CaseActionRequestSchema = z
  .object({
    action: z.enum(['notify', 'snooze', 'resolve', 'dismiss']),
    snoozeDays: z.number().int().min(1).max(365).optional(),
    note: z.string().max(2_000).optional(),
  })
  .refine((body) => body.action !== 'snooze' || body.snoozeDays !== undefined, {
    message: 'Indica por cuántos días posponer el caso.',
    path: ['snoozeDays'],
  })
  .meta({ id: 'CaseActionRequest' });

export const FeedbackRequestSchema = z
  .object({
    useful: z.boolean(),
    reason: FeedbackReasonSchema.optional(),
    comment: z.string().max(2_000).optional(),
  })
  .meta({ id: 'FeedbackRequest' });

export const ConditionViewSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    display: z.string(),
    status: z.enum(['confirmed', 'probable', 'resolved', 'rejected']),
    confidence: z.number(),
    sourceType: z.string(),
    evidence: z.object({ quote: z.string(), documentId: z.string() }).optional(),
  })
  .meta({ id: 'ConditionView' });

export const PatientExpectationViewSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  layer: LayerSchema,
  label: z.string(),
  status: z.enum(EXPECTATION_STATUSES),
  dueAt: isoDate,
  evidence: z.object({ quote: z.string(), documentId: z.string() }).optional(),
});

export const QualityFindingViewSchema = z.object({
  id: z.string(),
  code: z.literal('note_without_plan'),
  documentId: z.string(),
  at: isoDate,
  label: z.string(),
});

export const PatientDetailSchema = z
  .object({
    patient: PatientSummarySchema.extend({
      birthDate: z.string().optional(),
      contact: PatientContactSchema,
    }),
    contact: PatientContactSchema,
    conditions: z.array(ConditionViewSchema),
    expectations: z.array(PatientExpectationViewSchema),
    qualityFindings: z.array(QualityFindingViewSchema),
  })
  .meta({ id: 'PatientDetail' });

export const PatientSearchQuerySchema = z.object({
  query: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(20),
});

export const PatientListSchema = z
  .object({ items: z.array(PatientSummarySchema) })
  .meta({ id: 'PatientList' });

export const ClinicViewSchema = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: 'Clinic' });

export const InboxStatsSchema = z
  .object({
    activeCases: z.number().int(),
    byLayer: z.record(LayerSchema, z.number().int()),
    byStatus: z.record(z.string(), z.number().int()),
    feedback: z.object({ total: z.number().int(), usefulRate: z.number() }),
    llm: z.object({
      monthCostUsd: z.number(),
      calls: z.number().int(),
      avgCostPerNoteUsd: z.number(),
      provider: z.string(),
      model: z.string(),
    }),
  })
  .meta({ id: 'InboxStats' });

export const DemoClockSchema = z
  .object({ now: isoDate, fake: z.boolean() })
  .meta({ id: 'DemoClock' });

export const AdvanceClockRequestSchema = z
  .object({ days: z.number().int().min(1).max(365) })
  .meta({ id: 'AdvanceClockRequest' });

export const DemoConsultationRequestSchema = z
  .object({
    patientId: z.string().trim().min(1).max(64).optional(),
    patientName: z.string().trim().min(1).max(120).optional(),
    specialty: z.string().trim().min(1).max(64),
    noteText: z.string().trim().min(1).max(20_000),
    orders: z
      .array(z.object({ loinc: z.string().min(1).max(20), display: z.string().min(1).max(120) }))
      .max(20)
      .optional(),
  })
  .meta({ id: 'DemoConsultationRequest' });

export const CreatedExpectationSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  layer: LayerSchema,
  label: z.string(),
  dueAt: isoDate,
});

export const DemoConsultationResponseSchema = z
  .object({
    bundle: z.unknown().meta({ description: 'The FHIR transaction Bundle that was ingested' }),
    extraction: z.object({
      model: z.string(),
      hasPlan: z.boolean(),
      conditions: z.array(
        z.object({
          code: z.object({
            system: z.string().optional(),
            code: z.string(),
            display: z.string().optional(),
          }),
          confidence: z.number(),
          evidenceQuote: z.string(),
        }),
      ),
      medications: z.array(
        z.object({
          text: z.string(),
          durationDays: z.number().optional(),
          evidenceQuote: z.string(),
        }),
      ),
      planItems: z.array(
        z.object({
          kind: z.enum(PLAN_ITEM_KINDS),
          description: z.string(),
          dueAt: isoDate,
          evidenceQuote: z.string(),
          confidence: z.number(),
        }),
      ),
      costUsd: z.number(),
      latencyMs: z.number(),
    }),
    expectationsCreated: z.array(CreatedExpectationSchema),
  })
  .meta({ id: 'DemoConsultationResponse' });

export const WebhookDeliverySchema = z.object({
  at: isoDate,
  type: z.string(),
  payload: z.unknown(),
  signatureValid: z.boolean(),
  delivered: z.boolean(),
});

export const WebhookListSchema = z
  .object({ items: z.array(WebhookDeliverySchema) })
  .meta({ id: 'WebhookList' });

export const LimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(30),
});

export const WebhookQuerySchema = LimitQuerySchema.extend({
  /** Only one event type (`case.opened`, ...). */
  type: z.string().trim().min(1).max(60).optional(),
});

export type CaseView = z.infer<typeof CaseViewSchema>;
export type EscalationView = z.infer<typeof EscalationViewSchema>;
export type EscalationStepView = z.infer<typeof EscalationStepViewSchema>;
export type OwnerView = z.infer<typeof OwnerViewSchema>;
export type CaseReasonView = z.infer<typeof CaseReasonViewSchema>;
export type CaseDetail = z.infer<typeof CaseDetailSchema>;
export type CaseTimelineEntry = z.infer<typeof CaseTimelineEntrySchema>;
export type ConditionView = z.infer<typeof ConditionViewSchema>;
export type PatientSummary = z.infer<typeof PatientSummarySchema>;
export type PatientContact = z.infer<typeof PatientContactSchema>;
export type PatientDetail = z.infer<typeof PatientDetailSchema>;
export type PatientExpectationView = z.infer<typeof PatientExpectationViewSchema>;
export type InboxStats = z.infer<typeof InboxStatsSchema>;
export type DemoConsultationResponse = z.infer<typeof DemoConsultationResponseSchema>;
export type CreatedExpectation = z.infer<typeof CreatedExpectationSchema>;
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;
