import {
  ADJUDICATION_DECISIONS,
  ADJUDICATION_OVERRIDES,
  ADJUDICATION_REASON_CODES,
  ADJUDICATOR_MODES,
} from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * The adjudicator's JSON contract (`/api/inbox/adjudications`, PRD V2):
 * decisions on ambiguous plan items and the doctor's override. Mirrors
 * `apps/inbox/src/api/adjudication-contract.ts`.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const AdjudicationDecisionSchema = z.enum(ADJUDICATION_DECISIONS);

export const AdjudicationViewSchema = z
  .object({
    id: z.string(),
    expectationId: z.string(),
    patientId: z.string(),
    caseId: z.string().optional(),
    decision: AdjudicationDecisionSchema.meta({
      description: "What the engine applies: the model's answer after the engine's checks",
    }),
    decisionLabel: z.string(),
    modelDecision: AdjudicationDecisionSchema.meta({ description: 'What the model answered' }),
    probability: z.number().meta({
      description: 'Calibrated probability, 0 to 1, that the note really asks for the follow-up',
    }),
    reasons: z.array(z.object({ code: z.enum(ADJUDICATION_REASON_CODES), label: z.string() })),
    rationale: z.string().meta({ description: "The model's rationale, in the response language" }),
    quotes: z.array(
      z.object({
        quote: z.string().meta({ description: 'Verbatim from the note (checked by the engine)' }),
        sourceDocumentId: z.string(),
      }),
    ),
    inputConfidence: z.number().meta({
      description: "The extractor's confidence that made the item ambiguous",
    }),
    mode: z.enum(['shadow', 'active']).meta({
      description: 'shadow: recorded only, nothing changed; active: discard suppressed the item',
    }),
    applied: z.boolean(),
    provider: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    costUsd: z.number(),
    createdAt: isoDate,
    override: z
      .object({
        decision: z.enum(ADJUDICATION_OVERRIDES),
        decisionLabel: z.string(),
        by: z.string(),
        at: isoDate,
        note: z.string().optional(),
      })
      .optional(),
  })
  .meta({ id: 'Adjudication' });

export const AdjudicationListSchema = z
  .object({
    items: z.array(AdjudicationViewSchema),
    settings: z.object({
      mode: z.enum(ADJUDICATOR_MODES),
      minConfidence: z.number(),
      maxConfidence: z.number(),
    }),
  })
  .meta({ id: 'AdjudicationList' });

export const AdjudicationListQuerySchema = z.object({
  caseId: z.string().min(1).max(200).optional(),
  patientId: z.string().min(1).max(200).optional(),
  decision: AdjudicationDecisionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const AdjudicationOverrideRequestSchema = z
  .object({
    decision: z.enum(ADJUDICATION_OVERRIDES).meta({
      description: 'open: keep (or restore) and confirm the item; discard: reject it',
    }),
    note: z.string().trim().max(1000).optional(),
  })
  .meta({ id: 'AdjudicationOverrideRequest' });

export const AdjudicationOverrideResponseSchema = z
  .object({
    adjudication: AdjudicationViewSchema,
    casesResolved: z.array(z.string()),
  })
  .meta({ id: 'AdjudicationOverrideResponse' });

export type AdjudicationView = z.infer<typeof AdjudicationViewSchema>;
export type AdjudicationList = z.infer<typeof AdjudicationListSchema>;
