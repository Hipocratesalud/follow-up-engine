import { CASE_FEEDBACK_REASONS, DISMISS_REASONS } from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * The clinic metrics JSON contract (`GET /api/inbox/metrics`, HIP-141).
 * FHIR-free, for the inbox. Every number is defined in docs/metrics.md.
 * Mirrors `apps/inbox/src/features/metrics/contract.ts`.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });
const count = z.number().int().min(0);
const rate = z.number().min(0).max(1);
const usd = z.number().min(0);

export const MetricsQuerySchema = z.object({
  /** Start of the period (inclusive); default `to` minus 30 days. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** End of the period (exclusive); default now (the engine clock). */
  to: z.iso.datetime({ offset: true }).optional(),
});

const OriginSplitSchema = z
  .object({
    total: count,
    followUpCase: count.meta({ description: 'Booked from the case (the team worked it)' }),
    patientContact: count.meta({ description: 'Booked after a contact attempt' }),
    organic: count.meta({ description: 'Not attributed to the engine' }),
  })
  .meta({ id: 'MetricsOriginSplit' });

const DurationSchema = z
  .object({
    measured: count,
    pending: count,
    medianHours: z.number().min(0).optional(),
    p75Hours: z.number().min(0).optional(),
    p90Hours: z.number().min(0).optional(),
  })
  .meta({ id: 'MetricsDuration' });

const LlmTaskUsageSchema = z
  .object({
    task: z.string().meta({ description: 'Gateway task: note_extraction, clinical_review, ...' }),
    calls: count,
    successfulCalls: count,
    inputTokens: count,
    outputTokens: count,
    costUsd: usd,
  })
  .meta({ id: 'MetricsLlmTaskUsage' });

export const ClinicMetricsViewSchema = z
  .object({
    period: z.object({ from: isoDate, to: isoDate }),
    asOf: isoDate,
    cases: z.object({
      opened: count,
      live: count,
      backfill: count,
      active: count,
      resolved: count,
      dismissed: count,
      lostToFollowUp: count,
    }),
    bookings: z.object({
      booked: OriginSplitSchema,
      attended: OriginSplitSchema,
      resolvedByBooking: OriginSplitSchema,
      bookedRate: rate.optional(),
      attendedRate: rate.optional(),
      attributedShare: rate.optional(),
    }),
    timeToFirstAction: DurationSchema,
    feedback: z.object({
      casesWithFeedback: count,
      useful: count,
      notUseful: count,
      usefulRate: rate.optional(),
      notUsefulReasons: z.record(z.enum(CASE_FEEDBACK_REASONS), count),
    }),
    dismissals: z.object({
      total: count,
      byReason: z.record(z.enum(DISMISS_REASONS), count),
    }),
    extractionReviews: z.object({
      conditions: z.object({
        reviewed: count,
        confirmed: count,
        rejected: count,
        pendingReview: count,
        confirmRate: rate.optional(),
        rejectRate: rate.optional(),
      }),
      planItems: z.object({
        total: count,
        confirmed: count,
        corrected: count,
        rejected: count,
        correctionRate: rate.optional(),
      }),
    }),
    aiCost: z.object({
      totalUsd: usd,
      calls: count,
      byTask: z.array(LlmTaskUsageSchema),
      attributedToCasesUsd: usd,
      casesWithAttributedCost: count,
      perCaseUsd: usd.optional(),
      allInPerCaseUsd: usd.optional(),
      reviewRuns: count,
      reviewerUsd: usd,
      perReviewRunUsd: usd.optional(),
    }),
    backfill: z.object({
      cases: count,
      recoveredPatients: count,
      recoveredCases: count,
    }),
  })
  .meta({ id: 'ClinicMetrics' });

export type ClinicMetricsView = z.infer<typeof ClinicMetricsViewSchema>;
