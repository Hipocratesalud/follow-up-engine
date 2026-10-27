import { z } from 'zod';
import { ALL_RULE_IDS, type RuleId, SPECIALTIES } from '../constants.ts';
import { TIMELINE_ENTRY_KINDS } from '../synthetic/timeline.ts';

const PLAN_ITEM_KINDS = ['follow_up_visit', 'lab', 'imaging', 'session', 'other'] as const;
const PREGNANCY_OUTCOME_KINDS = ['vaginal_delivery', 'cesarean_delivery', 'loss'] as const;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const IsoInstant = z.iso.datetime();
const RuleIdSchema = z.enum(ALL_RULE_IDS as [RuleId, ...RuleId[]]);
const CodingSchema = z.strictObject({
  system: z.string().min(1),
  code: z.string().min(1),
  display: z.string().optional(),
});

/**
 * A hand-labeled note for the extraction evals. ICD-10 codes are compared by
 * category (first 3 characters); `dueInDays` counts from `authoredAt`.
 */
export const GoldNoteSchema = z.strictObject({
  id: z.string().regex(/^gold-\d{3}$/),
  specialty: z.enum(SPECIALTIES),
  authoredAt: IsoDate,
  text: z.string().min(1),
  expected: z.strictObject({
    hasPlan: z.boolean(),
    /** Present when the note discharges the patient from follow-up ("se da de alta"). */
    discharge: z.strictObject({ evidenceQuote: z.string().min(1) }).optional(),
    conditions: z.array(
      z.strictObject({
        icd10: z.string().regex(/^[A-Z]\d{2}(\.\d{1,2})?$/),
        evidenceQuote: z.string().min(1),
      }),
    ),
    medications: z.array(
      z.strictObject({ text: z.string().min(1), evidenceQuote: z.string().min(1) }),
    ),
    planItems: z.array(
      z.strictObject({
        kind: z.enum(PLAN_ITEM_KINDS),
        dueInDays: z.number().int().positive(),
        evidenceQuote: z.string().min(1),
      }),
    ),
    /**
     * The current pregnancy as the note writes it: its dating and, when the
     * note reports it, how it ended (`date` or `daysAgo` only when written).
     * Absent means the note reports no current pregnancy: obstetric history
     * ("G3P2, cesárea previa") and a routine "FUM" are not one.
     */
    pregnancy: z
      .strictObject({
        gestationalWeeks: z.number().int().min(0).max(45).optional(),
        gestationalDays: z.number().int().min(0).max(6).optional(),
        lastMenstrualPeriod: IsoDate.optional(),
        estimatedDeliveryDate: IsoDate.optional(),
        datingEvidenceQuote: z.string().min(1).optional(),
        outcome: z
          .strictObject({
            kind: z.enum(PREGNANCY_OUTCOME_KINDS),
            date: IsoDate.optional(),
            daysAgo: z.number().int().nonnegative().optional(),
            evidenceQuote: z.string().min(1),
          })
          .optional(),
      })
      .optional(),
  }),
});
export type GoldNote = z.infer<typeof GoldNoteSchema>;

const BundleSchema = z.looseObject({
  resourceType: z.literal('Bundle'),
  id: z.string(),
  type: z.literal('transaction'),
  timestamp: IsoInstant,
  entry: z.array(
    z.looseObject({
      fullUrl: z.string(),
      resource: z.looseObject({ resourceType: z.string(), id: z.string() }),
      request: z.strictObject({ method: z.literal('PUT'), url: z.string() }),
    }),
  ),
});

const ExpectationAssertionSchema = z.strictObject({
  ruleId: RuleIdSchema,
  matchKey: z
    .string()
    .regex(/^[a-z0-9-]+:.+$/)
    .optional(),
  dueDay: z.number().int().optional(),
});

const CaseAssertionSchema = z.strictObject({
  reasons: z.array(RuleIdSchema).min(1),
  resolution: z
    .enum(['fulfilled', 'handled_outside', 'not_needed', 'patient_declined', 'patient_unreachable'])
    .optional(),
});

const ExtractionSchema = z.strictObject({
  hasPlan: z.boolean(),
  conditions: z.array(
    z.strictObject({
      code: CodingSchema,
      confidence: z.number().min(0).max(1),
      evidenceQuote: z.string().min(1),
    }),
  ),
  medications: z.array(
    z.strictObject({
      text: z.string().min(1),
      code: CodingSchema.optional(),
      durationDays: z.number().int().positive().optional(),
      evidenceQuote: z.string().min(1),
    }),
  ),
  planItems: z.array(
    z.strictObject({
      kind: z.enum(PLAN_ITEM_KINDS),
      description: z.string().min(1),
      dueAt: IsoInstant,
      evidenceQuote: z.string().min(1),
      confidence: z.number().min(0).max(1),
      code: CodingSchema.optional(),
    }),
  ),
  model: z.string(),
  promptVersion: z.string(),
  costUsd: z.number().nonnegative(),
});

export const ScenarioSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_]+$/),
  description: z.string().min(1),
  clinicId: z.string().min(1),
  patientId: z.string().min(1),
  specialty: z.enum(SPECIALTIES),
  steps: z.array(z.strictObject({ day: z.number().int(), bundle: BundleSchema })).min(1),
  llmFixture: z.record(z.string(), ExtractionSchema),
  expect: z
    .array(
      z.strictObject({
        day: z.number().int(),
        openExpectations: z.array(ExpectationAssertionSchema).optional(),
        absentRuleIds: z.array(RuleIdSchema).optional(),
        closedExpectations: z
          .array(
            ExpectationAssertionSchema.extend({
              status: z.enum(['fulfilled', 'superseded', 'expired', 'cancelled']),
            }),
          )
          .optional(),
        activeCases: z.array(CaseAssertionSchema).optional(),
        resolvedCases: z.array(CaseAssertionSchema).optional(),
        qualityFindings: z.array(z.literal('note_without_plan')).optional(),
      }),
    )
    .min(1),
});

export const SyntheticPatientSchema = z.strictObject({
  clinicId: z.string(),
  patientId: z.string(),
  name: z.string(),
  gender: z.enum(['female', 'male']),
  birthDate: IsoDate,
  specialty: z.enum(SPECIALTIES),
  pattern: z.string(),
  entries: z.array(
    z.strictObject({ at: IsoInstant, kind: z.enum(TIMELINE_ENTRY_KINDS), bundle: BundleSchema }),
  ),
});
