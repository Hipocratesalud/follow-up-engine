import { z } from 'zod';
import { PLAN_ITEM_KINDS } from '../domain/clinical-event.ts';
import { EXPECTATION_LAYERS } from '../domain/expectation.ts';
import {
  CodingSchema,
  ConfigIdSchema,
  ConfigVersionSchema,
  EscalationPolicySchema,
  EventCorrelationSchema,
  EventMatcherSchema,
  FilterConditionSchema,
  ReasonSchema,
  SuggestedActionSchema,
} from './common.ts';

const PhrasesSchema = z.array(z.string().min(1)).min(1);

/**
 * What makes a prescription a short treatment that needs a control when it
 * ends (`short_treatment_followup`). The trigger filter bounds the duration;
 * these criteria rule out what only looks short: a chronic drug dispensed a
 * month at a time, a drug taken only when needed, a treatment whose note
 * asks the patient to come back only if symptoms persist.
 */
export const TreatmentCriteriaSchema = z.strictObject({
  /** More refills than this means a chronic prescription (`numberOfRepeatsAllowed`). */
  maxRefills: z.number().int().nonnegative(),
  /**
   * Chronic drug classes, never a short treatment: medication code prefixes
   * (ATC `C10` statins, `A10` antidiabetics, ...) and case- and
   * accent-insensitive substrings of the medication text.
   */
  chronicMedications: z.strictObject({
    codePrefixes: z.array(z.string().min(1)).optional(),
    text: z.array(z.string().min(1)).optional(),
  }),
  /**
   * Phrases of the dosage or medication text that mean "only when needed"
   * (`PRN`, `SOS`, `si dolor`). A FHIR `asNeeded` dosage counts too. Such a
   * drug never expects a control by itself.
   */
  asNeededPhrases: PhrasesSchema,
  /**
   * Phrases of the consultation's note that make the control conditional
   * ("reconsultar si persiste"): the patient comes back only if needed, so
   * the end of the treatment expects nothing.
   */
  conditionalReturnPhrases: PhrasesSchema,
});
export type TreatmentCriteria = z.infer<typeof TreatmentCriteriaSchema>;

/**
 * A condition-aware target for a result (`abnormal_result_followup`): a
 * result of `code` in a patient already known to have one of
 * `conditionCodes` is at target, so not actionable, while its value
 * satisfies `atTarget`. HbA1c 6.8 % is flagged H by the lab, yet it is at
 * goal for a known diabetic (< 8 %).
 */
export const ResultTargetSchema = z.strictObject({
  code: CodingSchema,
  /** ICD-10 codes or prefixes of the known condition (confirmed or probable, not inferred from this result). */
  conditionCodes: z.array(z.string().min(1)).min(1),
  /** Bounds on the numeric value that mean "at target". */
  atTarget: FilterConditionSchema,
  /** English, for maintainers: the guideline behind the target. */
  description: z.string().min(1).optional(),
});
export type ResultTarget = z.infer<typeof ResultTargetSchema>;

/**
 * An episode that ends, after which its visits are not part of the
 * patient's usual pattern (pregnancy: prenatal controls end with the
 * postpartum visit). Codes are ICD-10 codes or prefixes recorded at the
 * visit (`Z34` matches `Z34.9`).
 */
export const CadenceEpisodeSchema = z.strictObject({
  key: ConfigIdSchema,
  /** Diagnoses that put a visit in the episode. */
  conditionCodes: z.array(z.string().min(1)).min(1),
  /** Diagnoses that close it: the episode's visits, these included, leave the pattern. */
  closedBy: z.array(z.string().min(1)).min(1),
});
export type CadenceEpisode = z.infer<typeof CadenceEpisodeSchema>;

/** Days within which a critical (panic) result is expected to be acted on. */
export const DEFAULT_CRITICAL_RESULT_DUE_IN_DAYS = 1;

/**
 * A versioned rule (config/rules/*.json): when `trigger` happens, expect one
 * of `fulfilledBy` within `dueInDays`, otherwise escalate.
 *
 * For `doctor_plan` rules the plan item's own `dueAt` wins and `dueInDays`
 * is the fallback.
 */
export const RuleSchema = z.strictObject({
  id: ConfigIdSchema,
  version: ConfigVersionSchema,
  layer: z.enum(EXPECTATION_LAYERS),
  /** English, for maintainers. */
  description: z.string().min(1),
  reason: ReasonSchema,
  trigger: EventMatcherSchema,
  dueInDays: z.number().int().positive(),
  fulfilledBy: z.array(EventCorrelationSchema).min(1),
  /** Events that replace the expectation (for example a newer order of the same test). */
  supersededBy: z.array(EventCorrelationSchema).optional(),
  /** Events that look like fulfillment but must not count (for example a cancelled appointment). */
  notFulfilledBy: z.array(EventMatcherSchema).optional(),
  /** Base priority of the case it opens; higher is more urgent. */
  priority: z.number().int().nonnegative(),
  escalationPolicy: EscalationPolicySchema,
  suggestedAction: SuggestedActionSchema,
  /**
   * What the rule expects to happen. Drives the match key (`visit` or the
   * trigger's code) and which events count as fulfillment. Defaults to
   * `lab`/`imaging` for orders of that category and `follow_up_visit` otherwise.
   */
  expects: z.enum(PLAN_ITEM_KINDS).optional(),
  /**
   * Expectations of rules sharing a case group merge into one case per
   * patient (`<patientId>:<caseGroup>`). Defaults to the reason code.
   */
  caseGroup: ConfigIdSchema.optional(),
  /**
   * What `dueInDays` counts from: the trigger event (default) or the end of
   * the prescribed treatment (`startAt + durationDays`).
   */
  dueFrom: z.enum(['trigger', 'treatment_end']).optional(),
  /** Parameters of a `cadence` rule: due after `multiplier` times the patient's usual interval. */
  cadence: z
    .strictObject({
      multiplier: z.number().positive(),
      /**
       * Visits of the same specialty the patient must already have (the
       * latest one included) before the next one is expected: 2 means one
       * interval, the PRD's minimum pattern.
       */
      minPreviousVisits: z.number().int().positive(),
      /** Intervals shorter than this are ignored (same-week repeats). */
      minIntervalDays: z.number().int().nonnegative().optional(),
      /** Episodes whose visits leave the pattern once they close (pregnancy and postpartum). */
      episodes: z.array(CadenceEpisodeSchema).optional(),
      /**
       * An acute episode and its control are not a pattern: a visit that
       * started a short treatment (as `treatmentRule` defines it, as-needed
       * drugs included) and the next visit of the specialty within the
       * treatment plus `controlWithinDays` both leave the pattern.
       */
      acuteEpisode: z
        .strictObject({
          treatmentRule: ConfigIdSchema,
          controlWithinDays: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
  /** Short-treatment criteria of a `medication.prescribed` rule. */
  treatment: TreatmentCriteriaSchema.optional(),
  /** Condition-aware targets of a `result.received` rule. */
  resultTargets: z.array(ResultTargetSchema).optional(),
  /**
   * `result.received` rules: days within which a critical (panic) result is
   * expected to be acted on, instead of `dueInDays`. Defaults to
   * {@link DEFAULT_CRITICAL_RESULT_DUE_IN_DAYS}.
   */
  criticalDueInDays: z.number().int().positive().optional(),
  /**
   * Universal rules: skip (or withdraw) the expectation when a live
   * doctor's-plan expectation already asks for the same thing (same match
   * key) no later than this one would be due, the same day included: the
   * doctor's explicit plan beats the generic rule ("control en 10 días" after
   * a 7-day antibiotic is one reason, not two).
   */
  coveredByPlan: z.boolean().optional(),
});

export type Rule = z.infer<typeof RuleSchema>;
