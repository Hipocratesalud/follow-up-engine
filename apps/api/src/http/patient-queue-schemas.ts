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
  PriorityBandSchema,
  PriorityLabelSchema,
  ProtocolRefViewSchema,
} from './schemas.ts';

/*
 * The patient queue contract (HIP-141): one card per patient, all their
 * active cases and reasons grouped. The engine keeps one case per patient
 * and reason group; this is a presentation of them.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

/** A comma-separated query value (`?layer=universal,doctor_plan`). */
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

const ProtocolIdSchema = z.string().trim().min(1).max(100);

export const PatientQueueItemSchema = z
  .object({
    patient: PatientSummarySchema,
    priority: z.number().int().meta({ description: "The patient's most urgent case" }),
    priorityBand: PriorityBandSchema,
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
    liveFindings: z.number().int().optional().meta({
      description:
        'Open clinical reviewer findings of the patient in live, signed-off categories (their own cards in /api/inbox/live-findings); absent when none. Never counts a shadow category',
    }),
  })
  .meta({ id: 'PatientQueueItem' });

export const LayerFacetSchema = z
  .object({
    layer: LayerSchema,
    label: z.string().meta({ description: 'Localized ("Orders and results")' }),
    count: z.number().int().meta({ description: 'Patients matching it, ignoring `layer`' }),
  })
  .meta({ id: 'LayerFacet' });

export const ProtocolFacetSchema = z
  .object({
    id: z.string().meta({ example: 'pregnancy' }),
    label: z.string().meta({ description: 'Localized protocol name, from the catalog' }),
    count: z.number().int().meta({ description: 'Patients matching it, ignoring `protocol`' }),
  })
  .meta({ id: 'ProtocolFacet' });

export const PatientQueueFacetsSchema = z
  .object({
    layers: z.array(LayerFacetSchema).meta({ description: 'Every reason layer, in engine order' }),
    protocols: z
      .array(ProtocolFacetSchema)
      .meta({ description: 'Every protocol enabled for the clinic' }),
  })
  .meta({ id: 'PatientQueueFacets' });

export const PatientQueuePageSchema = z
  .object({
    items: z.array(PatientQueueItemSchema),
    nextCursor: z.string().optional(),
    total: z.number().int().meta({ description: 'Patients matching the query, across all pages' }),
    totalCases: z.number().int().meta({ description: 'Their cases matching the query' }),
    facets: PatientQueueFacetsSchema.meta({
      description:
        'Over the current view, search and owner, before `layer` and `protocol`: each facet ' +
        'ignores only its own filter, so picking a layer never hides a protocol count and back',
    }),
  })
  .meta({ id: 'PatientQueuePage' });

export const PatientQueueQuerySchema = z.object({
  view: z.enum(['active', 'closed', 'all']).optional().default('active'),
  origin: OriginSchema.optional(),
  /** Owner id (from `/api/inbox/owners`). */
  assignee: z.string().max(120).optional(),
  /** Patient name or id contains this text. */
  q: z.string().trim().max(100).optional(),
  /**
   * Reason layer(s), comma-separated: a patient matches if any open reason
   * (in the selected view) is in one of them.
   */
  layer: csv(LayerSchema),
  /** Protocol id(s), comma-separated (from the catalog); same OR-match rule as `layer`. */
  protocol: csv(ProtocolIdSchema),
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
export type PatientQueueFacets = z.infer<typeof PatientQueueFacetsSchema>;
export type PatientQueueQuery = z.infer<typeof PatientQueueQuerySchema>;
export type PlanItemReviewResponse = z.infer<typeof PlanItemReviewResponseSchema>;
