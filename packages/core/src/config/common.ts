import { z } from 'zod';
import { CLINICAL_EVENT_TYPES, PLAN_ITEM_KINDS } from '../domain/clinical-event.ts';
import { CONTACT_CHANNELS, PATIENT_CONTACT_PURPOSES } from '../domain/contact.ts';

/** Lowercase dotted / dashed / underscored id, for example `imaging.result-pending`. */
export const ConfigIdSchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, {
  message: 'expected a lowercase id such as "imaging.result_pending"',
});

/** Semantic version of a rule or protocol, recorded on every expectation it creates. */
export const ConfigVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, {
  message: 'expected a semantic version such as "1.0.0"',
});

/** A terminology code, like a FHIR `Coding`. */
export const CodingSchema = z.strictObject({
  system: z.string().min(1),
  code: z.string().min(1),
  display: z.string().min(1).optional(),
});

/** Machine code plus Spanish UI label. */
export const ReasonSchema = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
});

const FilterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Numeric comparison or presence check on an event field, for example
 * `{ "lte": 30 }` (short treatments) or `{ "exists": true }`. Every given
 * bound must hold.
 */
export const FilterConditionSchema = z
  .strictObject({
    lt: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    exists: z.boolean().optional(),
  })
  .refine((condition) => Object.keys(condition).length > 0, {
    message: 'expected at least one of lt, lte, gt, gte, exists',
  });
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

/**
 * Declarative filter on event fields. Keys are dot paths into the event
 * (`category`, `code.code`, `interpretation`); a value must equal the
 * literal, be one of the listed literals, or satisfy a
 * {@link FilterConditionSchema} (`{ "lte": 30 }`).
 *
 * @example { "category": "imaging", "code.system": "http://loinc.org" }
 */
export const EventFilterSchema = z.record(
  z.string().min(1),
  z.union([FilterValueSchema, z.array(FilterValueSchema).min(1), FilterConditionSchema]),
);
export type EventFilter = z.infer<typeof EventFilterSchema>;

/** Selects clinical events by type and optional filter. */
export const EventMatcherSchema = z.strictObject({
  event: z.enum(CLINICAL_EVENT_TYPES),
  filter: EventFilterSchema.optional(),
});
export type EventMatcher = z.infer<typeof EventMatcherSchema>;

/**
 * How a candidate event is correlated with the expectation it may close:
 * - `same_order`: the event answers the triggering order (`basedOnOrderId`).
 * - `same_code`: same terminology code as the trigger.
 * - `same_specialty`: same specialty as the triggering encounter.
 * - `any`: any matching event for the patient after the expectation was created.
 *
 * Whatever the strategy, a booked appointment must be scheduled on time
 * (`toleranceDays`), and a visit fulfills a visit expectation only when it
 * is of the expectation's specialty or with its practitioner (see
 * `correlates` in the engine).
 */
export const MATCH_STRATEGIES = ['same_order', 'same_code', 'same_specialty', 'any'] as const;
export type MatchStrategy = (typeof MATCH_STRATEGIES)[number];

/**
 * Minimum days a booked appointment may fall after the due date and still
 * fulfill the expectation, unless the correlation says otherwise
 * (`toleranceDays`).
 */
export const DEFAULT_BOOKING_TOLERANCE_DAYS = 3;

/**
 * Share of the expectation's interval (trigger to due date) a booked
 * appointment may fall after the due date, when that is more than
 * `toleranceDays`: 14 days on a 3-month control, 27 on a 6-month one.
 */
export const DEFAULT_BOOKING_TOLERANCE_FRACTION = 0.15;

export const EventCorrelationSchema = z.strictObject({
  event: z.enum(CLINICAL_EVENT_TYPES),
  filter: EventFilterSchema.optional(),
  match: z.enum(MATCH_STRATEGIES),
  /**
   * Restricts the correlation to expectations of these kinds (doctor's plan
   * rules, whose items can be visits, labs or imaging). All kinds when absent.
   */
  forKinds: z.array(z.enum(PLAN_ITEM_KINDS)).min(1).optional(),
  /**
   * For `appointment.booked`: at least how many days after the expectation's
   * due date the appointment may be scheduled and still count. Defaults to
   * {@link DEFAULT_BOOKING_TOLERANCE_DAYS}.
   */
  toleranceDays: z.number().int().nonnegative().optional(),
  /**
   * For `appointment.booked`: the share of the expectation's interval the
   * appointment may fall after the due date, when larger than
   * `toleranceDays` (`0` keeps the tolerance fixed). Defaults to
   * {@link DEFAULT_BOOKING_TOLERANCE_FRACTION}.
   */
  toleranceFraction: z.number().min(0).max(1).optional(),
});
export type EventCorrelation = z.infer<typeof EventCorrelationSchema>;

export const ESCALATION_ACTIONS = [
  'notify_clinic',
  'request_patient_contact',
  'raise_priority',
  'escalate_to_coordinator',
  'mark_lost_to_follow_up',
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/**
 * One step of an escalation policy.
 *
 * A `request_patient_contact` step is a contact attempt. Its optional
 * `channel` is the hint the host gets (`whatsapp`, `sms`, `email`), or
 * `phone_call` for a call the clinic team makes from the inbox; its
 * `answerWindowDays` is how long the patient has to answer before the
 * attempt counts as unanswered (default `EngineSettings.patientContactDueInDays`);
 * `skipIfAnswered` skips it when the patient already answered an attempt
 * since the case opened. Policies written before attempts had channels
 * (`default_v1`) keep working unchanged.
 */
export const EscalationStepSchema = z
  .strictObject({
    afterDays: z.number().int().nonnegative(),
    action: z.enum(ESCALATION_ACTIONS),
    priorityDelta: z.number().int().optional(),
    channel: z.enum(CONTACT_CHANNELS).optional(),
    answerWindowDays: z.number().int().nonnegative().optional(),
    skipIfAnswered: z.boolean().optional(),
  })
  .superRefine((step, context) => {
    if (step.action === 'request_patient_contact') {
      return;
    }
    for (const field of ['channel', 'answerWindowDays', 'skipIfAnswered'] as const) {
      if (step[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `only a request_patient_contact step takes ${field}`,
        });
      }
    }
  });
export type EscalationStep = z.infer<typeof EscalationStepSchema>;

/**
 * Steps applied to a case, in order. `afterDays` counts from the moment the
 * case opened; a user action on the case (notify, snooze) restarts the wait
 * for the next step, so "14 days without action" means exactly that.
 */
export const EscalationPolicySchema = z.strictObject({
  /**
   * Named policies (for example `default_v1`) can be referenced from rules
   * by id. The id carries the version: a changed policy gets a new id
   * (`default_v2`), and a case keeps the one it opened with.
   */
  id: ConfigIdSchema.optional(),
  steps: z
    .array(EscalationStepSchema)
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
