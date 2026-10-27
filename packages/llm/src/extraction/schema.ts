import { PLAN_ITEM_KINDS } from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * What the model returns. Deliberately free of numeric ranges, patterns and
 * optional keys: every field is required (nullable where absent), so the
 * schema is valid for strict structured output on every vendor, and range
 * or format problems are handled by deterministic post-checks in code
 * instead of costly repair round trips.
 */

export const TIME_UNITS = ['day', 'week', 'month', 'year'] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];

export const ModelTimingSchema = z
  .object({
    amount: z
      .number()
      .nullable()
      .describe('For a relative interval: how many units after the note date ("en 3 meses" -> 3).'),
    unit: z.enum(TIME_UNITS).nullable().describe('Unit of the relative interval.'),
    date: z
      .string()
      .nullable()
      .describe(
        'Only for a calendar date written in the note: ISO date YYYY-MM-DD. Never computed from an interval. Otherwise null.',
      ),
  })
  .describe(
    'When the item is due, exactly as the note states it. Never compute dates from intervals.',
  );

export const ModelConditionSchema = z.object({
  icd10: z.string().describe('ICD-10 code; the 3-character category is enough, e.g. "E11".'),
  display: z.string().describe('Short English name of the condition.'),
  confidence: z.number().describe('0 to 1.'),
  evidenceQuote: z.string().describe('Exact substring of the note that states the condition.'),
});

export const ModelMedicationSchema = z.object({
  text: z.string().describe('Medication as written, with dose and frequency when stated.'),
  duration: z
    .object({ amount: z.number(), unit: z.enum(TIME_UNITS) })
    .nullable()
    .describe('Treatment duration when the note states one ("por 7 dias"); otherwise null.'),
  evidenceQuote: z.string().describe('Exact substring of the note that mentions the medication.'),
});

export const ModelPlanItemSchema = z.object({
  kind: z.enum(PLAN_ITEM_KINDS),
  description: z
    .string()
    .describe(
      'Short English description naming only what the evidence quote names, e.g. "repeat HbA1c".',
    ),
  timing: ModelTimingSchema.nullable().describe('Null when the note gives no time for this item.'),
  loincCode: z
    .string()
    .nullable()
    .describe(
      'For lab items only: LOINC code of the test the evidence quote names, when certain (e.g. "4548-4" for HbA1c); otherwise null.',
    ),
  evidenceQuote: z.string().describe('Exact substring of the note that states this plan item.'),
  confidence: z.number().describe('0 to 1.'),
});

export const ModelDischargeSchema = z
  .object({
    evidenceQuote: z
      .string()
      .describe('Exact substring of the note where the clinician discharges the patient.'),
  })
  .describe(
    'Set only when the clinician explicitly ends follow-up in this specialty ("se da de alta", "se cierra el proceso terapeutico"); a past hospital discharge is not one. Otherwise null.',
  );

export const ModelExtractionSchema = z.object({
  hasPlan: z.boolean().describe('Whether the note states any follow-up plan.'),
  discharge: ModelDischargeSchema.nullable(),
  conditions: z
    .array(ModelConditionSchema)
    .describe(
      "This patient's current conditions only: no denied, family-history, risk or past-pregnancy conditions.",
    ),
  medications: z.array(ModelMedicationSchema),
  planItems: z
    .array(ModelPlanItemSchema)
    .describe('Scheduled follow-up only, one item per test; no conditional returns.'),
});

export type ModelTiming = z.infer<typeof ModelTimingSchema>;
export type ModelCondition = z.infer<typeof ModelConditionSchema>;
export type ModelMedication = z.infer<typeof ModelMedicationSchema>;
export type ModelPlanItem = z.infer<typeof ModelPlanItemSchema>;
export type ModelDischarge = z.infer<typeof ModelDischargeSchema>;
export type ModelExtraction = z.infer<typeof ModelExtractionSchema>;

/** Name of the structured output, sent to providers that name response formats. */
export const EXTRACTION_OUTPUT_NAME = 'note_extraction';
