import {
  CALL_OUTCOMES,
  CASE_FEEDBACK_REASONS,
  CASE_STATUSES,
  CONTACT_CHANNELS,
  CONTACT_OUTCOMES,
  DISMISS_REASONS,
  ESCALATION_ACTIONS,
  EXPECTATION_LAYERS,
  EXPECTATION_STATUSES,
  PLAN_ITEM_KINDS,
  PROTOCOL_STATUSES,
} from '@follow-up-engine/core';
import { z } from 'zod';
import { CONTACT_LOOP_MESSAGES } from '../inbox/labels.ts';
import { PlanItemViewSchema } from './plan-item-schemas.ts';

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
/** A recorded verdict's reason: a feedback reason, or the reason of a dismissal. */
export const VerdictReasonSchema = z.enum(CASE_FEEDBACK_REASONS);
export const DismissReasonSchema = z.enum(DISMISS_REASONS);
export const ContactChannelSchema = z.enum(CONTACT_CHANNELS);
export const ContactOutcomeSchema = z.enum(CONTACT_OUTCOMES);
export const CallOutcomeSchema = z.enum(CALL_OUTCOMES);

export const ErrorBodySchema = z
  .object({
    error: z.object({
      code: z.string().meta({
        description:
          'Stable code: invalid_request (422, see fields), not_found, insufficient_scope, ...',
      }),
      message: z.string().meta({ description: 'Spanish, ready to show to the clinic team' }),
      fields: z
        .array(
          z.object({
            path: z.string().meta({ description: 'Dotted path in the body or query (note)' }),
            message: z.string().meta({ description: 'Spanish: what is wrong with the field' }),
          }),
        )
        .optional()
        .meta({ description: 'invalid_request only: one entry per invalid field' }),
    }),
  })
  .meta({ id: 'Error' });

export const PatientSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    age: z.number().int().optional(),
    sex: SexSchema.optional(),
  })
  .meta({ id: 'PatientSummary' });

export const ContactFlagViewSchema = z
  .object({
    issue: z.enum(['wrong_number']),
    label: z.string().meta({ description: 'Spanish: "Número equivocado"' }),
    raisedAt: isoDate,
    channel: ContactChannelSchema.optional(),
  })
  .meta({ id: 'ContactFlagView' });

export const PatientContactSchema = z
  .object({
    allowed: z.boolean(),
    optedOut: z.boolean(),
    lastContactAt: isoDate
      .optional()
      .meta({ description: 'The last message the host was asked to send (calls do not count)' }),
    contactDataInvalid: z.boolean().optional().meta({
      description:
        'The contact data is flagged (a wrong number): messages are skipped, calls go on',
    }),
    contactFlag: ContactFlagViewSchema.optional(),
  })
  .meta({ id: 'PatientContact' });

/**
 * The care protocol behind a `protocol` layer expectation. `name` and
 * `status` come from the protocol the clinic runs today; both are absent
 * when the protocol is no longer enabled for the clinic (only the id and the
 * version that created the expectation are known then).
 */
export const ProtocolRefViewSchema = z
  .object({
    id: z.string().meta({ example: 'pregnancy' }),
    version: z
      .string()
      .meta({ description: 'Version of the protocol that created the expectation' }),
    name: z.string().optional().meta({
      description:
        'Spanish name of the protocol, ready to show ("Embarazo y puerperio"). Absent when the protocol is no longer enabled for the clinic',
    }),
    status: z.enum(PROTOCOL_STATUSES).optional().meta({
      description:
        'draft: not yet validated by the clinical team (the inbox flags it); validated: approved. Status of the version the clinic runs today; absent when the protocol is no longer enabled for the clinic',
    }),
  })
  .meta({ id: 'ProtocolRef' });

export const CaseReasonViewSchema = z
  .object({
    expectationId: z.string(),
    ruleId: z.string(),
    layer: LayerSchema,
    label: z.string().meta({ description: 'Spanish; never includes a day count' }),
    protocol: ProtocolRefViewSchema.optional().meta({
      description: 'Only for protocol layer reasons: the protocol it comes from',
    }),
    dueAt: isoDate,
    overdueDays: z.number().int(),
    suppressible: z.boolean().meta({
      description:
        'A protocol item or the visit pattern: "Dejar de recordarlo para este paciente" can stop it (dismiss with suppress)',
    }),
    source: z.object({ resourceType: z.string(), id: z.string(), display: z.string() }),
    evidence: z
      .object({
        quote: z.string(),
        documentId: z.string(),
        authoredAt: isoDate,
        noteExcerpt: z.string().optional(),
      })
      .optional(),
    planItem: PlanItemViewSchema.optional().meta({
      description: "Doctor's plan reasons only: the AI reading and its review (HIP-141)",
    }),
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
    scheduledAt: isoDate.optional().meta({
      description:
        'Pending steps of an active case: when the step runs if nobody acts, counted the way the engine does (from the next scheduled step, the end of a snooze, or the release day of a held case)',
    }),
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
  reason: VerdictReasonSchema.optional(),
  comment: z.string().optional(),
});

export const ContactCommunicationViewSchema = z
  .object({
    id: z.string().meta({ description: 'The Communication id' }),
    at: isoDate,
    status: z.string().meta({ description: 'FHIR Communication.status' }),
    outcome: ContactOutcomeSchema.optional(),
    outcomeLabel: z.string().optional(),
    sender: z.enum(['host', 'user']),
    senderName: z.string().optional(),
  })
  .meta({ id: 'ContactCommunicationView' });

export const ContactAttemptViewSchema = z
  .object({
    id: z.string().meta({ description: 'The CommunicationRequest id' }),
    attempt: z.number().int(),
    channel: ContactChannelSchema.optional(),
    channelLabel: z.string(),
    trigger: z.enum(['policy', 'user', 'wrong_number']),
    requestedAt: isoDate,
    dueBy: isoDate,
    requestedBy: z.string().optional(),
    status: z.enum(['waiting', 'answered', 'unreached', 'unanswered', 'pending_call', 'closed']),
    statusLabel: z.string(),
    outcome: ContactOutcomeSchema.optional(),
    outcomeLabel: z.string().optional(),
    outcomeAt: isoDate.optional(),
    communications: z.array(ContactCommunicationViewSchema),
  })
  .meta({ id: 'ContactAttemptView' });

export const CallTaskViewSchema = z
  .object({
    requestId: z.string(),
    dueBy: isoDate,
    overdue: z.boolean(),
    trigger: z.enum(['policy', 'user', 'wrong_number']),
    outcomes: z.array(z.object({ outcome: CallOutcomeSchema, label: z.string() })),
  })
  .meta({ id: 'CallTaskView' });

export const SuppressionViewSchema = z
  .object({
    id: z.string(),
    ruleId: z.string(),
    label: z.string(),
    dismissReason: DismissReasonSchema,
    dismissReasonLabel: z.string(),
    note: z.string().optional(),
    caseId: z.string().optional(),
    createdAt: isoDate,
    createdBy: z.string().optional(),
    active: z.boolean(),
    revokedAt: isoDate.optional(),
    revokedBy: z.string().optional(),
  })
  .meta({ id: 'SuppressionView' });

export const DismissalViewSchema = z
  .object({
    reason: DismissReasonSchema,
    reasonLabel: z.string(),
    note: z.string().optional(),
    by: z.string().optional(),
    at: isoDate,
    suppressions: z.array(SuppressionViewSchema),
  })
  .meta({ id: 'DismissalView' });

export const CaseDetailSchema = CaseViewSchema.extend({
  timeline: z.array(CaseTimelineEntrySchema),
  feedback: CaseFeedbackViewSchema.optional(),
  contactAttempts: z.array(ContactAttemptViewSchema),
  callTask: CallTaskViewSchema.optional(),
  dismissal: DismissalViewSchema.optional(),
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
    reason: DismissReasonSchema.optional().meta({ description: 'dismiss: required' }),
    suppress: z.boolean().optional().meta({
      description:
        'dismiss with not_applicable_to_patient: stop the case rules for this patient ("Dejar de recordarlo")',
    }),
  })
  .refine((body) => body.action !== 'snooze' || body.snoozeDays !== undefined, {
    message: 'Indica por cuántos días posponer el caso.',
    path: ['snoozeDays'],
  })
  .refine((body) => body.action !== 'dismiss' || body.reason !== undefined, {
    message: 'Elige por qué descartas el caso.',
    path: ['reason'],
  })
  .refine(
    (body) =>
      body.action !== 'dismiss' || body.reason !== 'other' || (body.note ?? '').trim() !== '',
    { message: 'Escribe una nota que explique el motivo.', path: ['note'] },
  )
  .refine(
    (body) =>
      body.action !== 'dismiss' ||
      body.suppress !== true ||
      body.reason === 'not_applicable_to_patient',
    { message: CONTACT_LOOP_MESSAGES.suppressNeedsNotApplicable, path: ['suppress'] },
  )
  .meta({ id: 'CaseActionRequest' });

export const CallOutcomeRequestSchema = z
  .object({
    outcome: CallOutcomeSchema,
    requestId: z.string().max(64).optional().meta({
      description: 'The call (callTask.requestId); the latest call of the case when absent',
    }),
  })
  .meta({ id: 'CallOutcomeRequest' });

export const RuleCalibrationViewSchema = z
  .object({
    ruleId: z.string(),
    label: z.string(),
    layer: LayerSchema.optional(),
    casesWithFeedback: z.number().int(),
    useful: z.number().int(),
    notUseful: z.number().int(),
    usefulRate: z.number().optional(),
    dismissals: z.record(DismissReasonSchema, z.number().int()),
    notUsefulReasons: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'RuleCalibrationView' });

export const CalibrationReportSchema = z
  .object({ since: isoDate.optional(), rules: z.array(RuleCalibrationViewSchema) })
  .meta({ id: 'CalibrationReport' });

export const CalibrationQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
});

/** `reason` is required when the case was not useful (and optional when it was). */
export const FeedbackRequestSchema = z
  .discriminatedUnion('useful', [
    z.object({
      useful: z.literal(true),
      reason: FeedbackReasonSchema.optional(),
      comment: z.string().max(2_000).optional(),
    }),
    z.object({
      useful: z.literal(false),
      reason: FeedbackReasonSchema,
      comment: z.string().max(2_000).optional(),
    }),
  ])
  .meta({ id: 'FeedbackRequest' });

export const ConditionViewSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    display: z.string(),
    status: z.enum(['confirmed', 'probable', 'resolved', 'rejected', 'entered_in_error']),
    rejectedBy: z.enum(['host', 'clinician']).optional().meta({
      description:
        "For a rejected condition: who said the patient does not have it, the host's record (refuted) or a clinician of the team",
    }),
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
  protocol: ProtocolRefViewSchema.optional().meta({
    description: 'Only for protocol layer expectations: the protocol it comes from',
  }),
  status: z.enum(EXPECTATION_STATUSES),
  dueAt: isoDate,
  closedReason: z.string().optional().meta({
    description: 'Why the engine closed it, in Spanish ("El médico dio de alta al paciente")',
  }),
  evidence: z.object({ quote: z.string(), documentId: z.string() }).optional(),
  planItem: PlanItemViewSchema.optional().meta({
    description: "Doctor's plan expectations only: the AI reading and its review (HIP-141)",
  }),
});

export const QualityFindingViewSchema = z.object({
  id: z.string(),
  code: z.enum(['note_without_plan', 'note_truncated']),
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
    suppressions: z.array(SuppressionViewSchema).meta({
      description: 'Rules stopped for this patient, active first ("Recordatorios desactivados")',
    }),
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
    activePatients: z
      .number()
      .int()
      .meta({ description: 'Patients with an active case in the inbox (one card each)' }),
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
  protocol: ProtocolRefViewSchema.optional().meta({
    description: 'Only for protocol layer expectations: the protocol it comes from',
  }),
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
export type ProtocolRefView = z.infer<typeof ProtocolRefViewSchema>;
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
export type ContactAttemptView = z.infer<typeof ContactAttemptViewSchema>;
export type ContactCommunicationView = z.infer<typeof ContactCommunicationViewSchema>;
export type CallTaskView = z.infer<typeof CallTaskViewSchema>;
export type SuppressionView = z.infer<typeof SuppressionViewSchema>;
export type DismissalView = z.infer<typeof DismissalViewSchema>;
export type ContactFlagView = z.infer<typeof ContactFlagViewSchema>;
export type CalibrationReportView = z.infer<typeof CalibrationReportSchema>;

/** `GET /jobs/:id`: an asynchronous ingestion as the host can follow it. */
export const JobStatusViewSchema = z
  .object({
    id: z.string(),
    /** `fhir.ingest_bundle` for a Bundle. */
    type: z.string(),
    /** `failed`: every attempt failed; `lastError` says why. */
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastError: z.string().optional(),
    createdAt: isoDate,
    /** When a pending job runs (again). */
    nextAttemptAt: isoDate.optional(),
  })
  .meta({ id: 'JobStatus' });

export type JobStatusView = z.infer<typeof JobStatusViewSchema>;
