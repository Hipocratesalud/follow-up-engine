import {
  CITATION_KINDS,
  FINDING_CATEGORIES,
  FINDING_MODES,
  FINDING_ORIGINS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_VERDICTS,
  REVIEW_RUN_STATUSES,
  REVIEW_TRIGGERS,
} from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * The clinical reviewer's JSON contract (`/api/inbox/findings`,
 * `/api/inbox/finding-flags`, `/api/demo/review`). Mirrors
 * `apps/inbox/src/api/reviewer-contract.ts`.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const FindingCategorySchema = z.enum(FINDING_CATEGORIES);
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export const FindingModeSchema = z.enum(FINDING_MODES);
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export const FindingVerdictSchema = z.enum(FINDING_VERDICTS);

export const CitationViewSchema = z
  .object({
    docId: z.string().meta({ description: 'The cited resource, `ResourceType/id`' }),
    kind: z.enum(CITATION_KINDS),
    quote: z
      .string()
      .meta({ description: 'Verbatim text of the document (checked before storing)' }),
    date: isoDate,
    title: z.string().meta({ description: 'Localized label: "Diabetology note", "Creatinine"' }),
    specialty: z.string().optional(),
    text: z
      .string()
      .optional()
      .meta({ description: 'Full text of a cited note (the UI highlights the quote inside it)' }),
  })
  .meta({ id: 'FindingCitation' });

export const TrendPointViewSchema = z.object({
  docId: z.string(),
  date: isoDate,
  value: z.number(),
  cited: z.boolean(),
});

export const TrendViewSchema = z
  .object({
    test: z.string(),
    label: z.string(),
    unit: z.string(),
    low: z.number().optional(),
    high: z.number().optional(),
    points: z.array(TrendPointViewSchema),
  })
  .meta({
    id: 'FindingTrend',
    description: 'Every value of the measurement a trend finding cites',
  });

export const CoverageViewSchema = z.object({
  kind: z.enum(['expectation', 'case']),
  id: z.string(),
  code: z.string(),
  label: z.string(),
});

export const FindingReviewViewSchema = z.object({
  verdict: FindingVerdictSchema,
  reason: z.string().optional(),
  reviewedBy: z.string(),
  reviewedAt: isoDate,
});

export const FindingViewSchema = z
  .object({
    id: z.string(),
    patient: z.object({
      id: z.string(),
      name: z.string(),
      age: z.number().int().optional(),
      sex: z.enum(['female', 'male', 'other', 'unknown']).optional(),
    }),
    category: FindingCategorySchema,
    categoryLabel: z.string(),
    severity: FindingSeveritySchema,
    mode: FindingModeSchema,
    status: FindingStatusSchema,
    summary: z.string(),
    rationale: z.string(),
    suggestion: z.string(),
    alreadyCovered: z.boolean(),
    coveredBy: z.array(CoverageViewSchema),
    citations: z.array(CitationViewSchema),
    trend: TrendViewSchema.optional(),
    specialty: z.string().optional(),
    origin: z.enum(FINDING_ORIGINS).meta({
      description:
        'confirmed: a detector signal the agent confirmed; added: found by the agent; fallback: detector signal stored when the agent could not run',
    }),
    modelId: z.string(),
    promptVersion: z.string(),
    runId: z.string(),
    createdAt: isoDate,
    review: FindingReviewViewSchema.optional(),
  })
  .meta({ id: 'Finding' });

export const ReviewStepViewSchema = z.object({
  index: z.number().int(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  outcome: z.string(),
  summary: z.string(),
});

export const ReviewRunViewSchema = z
  .object({
    id: z.string(),
    trigger: z.enum(REVIEW_TRIGGERS),
    status: z.enum(REVIEW_RUN_STATUSES),
    stopReason: z.string(),
    signalsCount: z.number().int(),
    findingsCount: z.number().int(),
    discardedCount: z.number().int(),
    duplicateCount: z.number().int(),
    discarded: z.array(z.object({ reason: z.string(), count: z.number().int() })),
    steps: z.number().int(),
    toolCalls: z.number().int(),
    trace: z.array(ReviewStepViewSchema),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number(),
    modelId: z.string(),
    promptVersion: z.string(),
    startedAt: isoDate,
    finishedAt: isoDate,
  })
  .meta({ id: 'ReviewRun' });

export const FindingDetailSchema = FindingViewSchema.extend({
  run: ReviewRunViewSchema.optional(),
}).meta({ id: 'FindingDetail' });

export const FindingCountsSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  byCategory: z.record(z.string(), z.number().int()),
  bySeverity: z.record(z.string(), z.number().int()),
});

export const FindingPageSchema = z
  .object({
    items: z.array(FindingViewSchema),
    nextCursor: z.string().optional(),
    counts: FindingCountsSchema.meta({
      description: 'Over the whole mode, ignoring other filters',
    }),
  })
  .meta({ id: 'FindingPage' });

/** A comma-separated query value (`?category=lab_trend,vital_trend`). */
const csv = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(item).min(1))
    .optional();

export const FindingListQuerySchema = z.object({
  mode: FindingModeSchema.default('shadow'),
  status: z
    .union([FindingStatusSchema, z.literal('reviewed')])
    .optional()
    .meta({ description: '`reviewed`: any verdict' }),
  category: csv(FindingCategorySchema),
  severity: csv(FindingSeveritySchema),
  patientId: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(500).optional(),
});

export const FindingReviewRequestSchema = z
  .object({
    verdict: FindingVerdictSchema,
    reason: z.string().trim().max(1000).optional().meta({
      description: 'Required when the verdict is not_relevant',
    }),
  })
  .meta({ id: 'FindingReviewRequest' });

export const FindingFlagViewSchema = z
  .object({
    category: FindingCategorySchema,
    label: z.string(),
    description: z.string(),
    implemented: z.boolean(),
    specialty: z.string().optional(),
    enabled: z.boolean(),
    mode: FindingModeSchema,
    validatedBy: z.string().optional(),
    validatedAt: isoDate.optional(),
    updatedBy: z.string().optional(),
    updatedAt: isoDate.optional(),
    review: z
      .object({
        reviewed: z.number().int(),
        relevant: z.number().int(),
        alreadyKnown: z.number().int(),
        notRelevant: z.number().int(),
        precision: z.number().optional().meta({ description: 'relevant / reviewed, 0..1' }),
      })
      .meta({ description: 'Shadow review so far: the evidence for going live' }),
  })
  .meta({ id: 'FindingFlag' });

export const FindingFlagListSchema = z
  .object({ items: z.array(FindingFlagViewSchema) })
  .meta({ id: 'FindingFlagList' });

export const FindingFlagUpdateSchema = z
  .object({
    category: FindingCategorySchema,
    specialty: z.string().trim().min(1).max(60).nullable().optional(),
    enabled: z.boolean(),
    mode: FindingModeSchema,
    validatedBy: z.string().trim().min(1).max(200).optional().meta({
      description: 'Who on the clinical team signs off the category: required to go live',
    }),
  })
  .meta({ id: 'FindingFlagUpdate' });

export const ReviewMetricsSchema = z
  .object({
    since: isoDate,
    runs: z.number().int(),
    patientsReviewed: z.number().int(),
    findings: z.number().int(),
    findingsPer100Patients: z.number(),
    discarded: z.number().int(),
    duplicates: z.number().int(),
    degraded: z.number().int(),
    avgToolCalls: z.number(),
    avgCostUsd: z.number(),
    costUsd: z.number(),
    reviewed: z.number().int(),
    relevant: z.number().int(),
    alreadyKnown: z.number().int(),
    precision: z.number().optional(),
  })
  .meta({ id: 'ReviewMetrics' });

export const DemoReviewResponseSchema = z
  .object({
    run: ReviewRunViewSchema,
    findings: z.array(FindingViewSchema),
  })
  .meta({ id: 'DemoReviewResponse' });

export const BeforeVisitResponseSchema = z
  .object({
    nextAppointmentAt: isoDate.optional(),
    items: z.array(FindingViewSchema).meta({
      description: 'Open pre_visit_question and abnormal_result_no_followup findings only',
    }),
  })
  .meta({
    id: 'BeforeVisitResponse',
    description:
      "What to check before the patient's next visit: the appointment and the open " +
      'questions or abnormal results worth raising. In a demo or lab clinic, shadow ' +
      'findings are included too (the UI marks them as not yet validated); elsewhere only ' +
      'live ones',
  });

export const InboxFindingQuerySchema = z.object({
  patientId: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const InboxFindingListSchema = z
  .object({
    items: z.array(FindingViewSchema).meta({
      description: 'Open findings of live, signed-off categories, most severe first, then newest',
    }),
    total: z.number().int().meta({ description: 'Every matching finding, not only `items`' }),
    byPatient: z.record(z.string(), z.number().int()).meta({
      description: "Matching findings per patient id (the badge on the patient's follow-up card)",
    }),
  })
  .meta({
    id: 'InboxFindingList',
    description:
      "The doctor's inbox cards of the clinical reviewer (PRD V3): only categories that are " +
      'live with a clinical sign-off under the flags in force now. A shadow category never ' +
      'appears here, whatever mode its findings were stored with; pre_visit_question goes to ' +
      '"Before the visit" instead',
  });

export type InboxFindingList = z.infer<typeof InboxFindingListSchema>;
export type FindingView = z.infer<typeof FindingViewSchema>;
export type FindingDetail = z.infer<typeof FindingDetailSchema>;
export type CitationView = z.infer<typeof CitationViewSchema>;
export type TrendView = z.infer<typeof TrendViewSchema>;
export type ReviewRunView = z.infer<typeof ReviewRunViewSchema>;
export type FindingFlagView = z.infer<typeof FindingFlagViewSchema>;
export type ReviewMetrics = z.infer<typeof ReviewMetricsSchema>;
export type BeforeVisitResponse = z.infer<typeof BeforeVisitResponseSchema>;
