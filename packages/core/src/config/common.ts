import { z } from 'zod';
import { CLINICAL_EVENT_TYPES } from '../domain/clinical-event.ts';
import { PATIENT_CONTACT_PURPOSES } from '../domain/domain-event.ts';

/** Lowercase dotted / dashed / underscored id, for example `imaging.result-pending`. */
export const ConfigIdSchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, {
  message: 'expected a lowercase id such as "imaging.result_pending"',
});

/** Semantic version of a rule or protocol, recorded on every expectation it creates. */
export const ConfigVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, {
  message: 'expected a semantic version such as "1.0.0"',
});

/** Machine code plus Spanish UI label. */
export const ReasonSchema = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
});

const FilterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Declarative filter on event fields. Keys are dot paths into the event
 * (`category`, `code.code`, `interpretation`); a value must equal the
 * literal, or be one of the listed literals.
 *
 * @example { "category": "imaging", "code.system": "http://loinc.org" }
 */
export const EventFilterSchema = z.record(
  z.string().min(1),
  z.union([FilterValueSchema, z.array(FilterValueSchema).min(1)]),
);

/** Selects clinical events by type and optional filter. */
export const EventMatcherSchema = z.strictObject({
  event: z.enum(CLINICAL_EVENT_TYPES),
  filter: EventFilterSchema.optional(),
});

/**
 * How a candidate event is correlated with the expectation it may close:
 * - `same_order`: the event answers the triggering order (`basedOnOrderId`).
 * - `same_code`: same terminology code as the trigger.
 * - `same_specialty`: same specialty as the triggering encounter.
 * - `any`: any matching event for the patient after the expectation was created.
 */
export const MATCH_STRATEGIES = ['same_order', 'same_code', 'same_specialty', 'any'] as const;
export type MatchStrategy = (typeof MATCH_STRATEGIES)[number];

export const EventCorrelationSchema = z.strictObject({
  event: z.enum(CLINICAL_EVENT_TYPES),
  filter: EventFilterSchema.optional(),
  match: z.enum(MATCH_STRATEGIES),
});

export const ESCALATION_ACTIONS = [
  'notify_clinic',
  'request_patient_contact',
  'raise_priority',
  'mark_lost_to_follow_up',
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/** Steps applied after the expectation expires, in order; `afterDays` counts from `dueAt`. */
export const EscalationPolicySchema = z.strictObject({
  steps: z
    .array(
      z.strictObject({
        afterDays: z.number().int().nonnegative(),
        action: z.enum(ESCALATION_ACTIONS),
        priorityDelta: z.number().int().optional(),
      }),
    )
    .min(1)
    .refine(
      (steps) =>
        steps.every(
          (step, index) => index === 0 || step.afterDays >= (steps[index - 1]?.afterDays ?? 0),
        ),
      { message: 'steps must be sorted by afterDays' },
    ),
});
export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;

/** What the inbox suggests the team do about a case. `label` is Spanish UI copy. */
export const SuggestedActionSchema = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
  patientContactPurpose: z.enum(PATIENT_CONTACT_PURPOSES).optional(),
});
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;
