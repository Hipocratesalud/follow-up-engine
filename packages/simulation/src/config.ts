import { TEST_GROUPS } from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * The simulation's configuration (config/simulation/*.json): the cohort,
 * the order mix, the patient personas and their behaviour, the clinic's
 * operations and the economics. Every number in it is an ASSUMPTION stated
 * next to its rationale, not a measurement: the file is versioned so a
 * report always names the assumptions it ran on.
 */

/** The patient behaviours the simulation models (docs/simulation.md#personas). */
export const PERSONA_IDS = [
  'fast_responder',
  'second_try',
  'slot_friction',
  'wrong_number',
  'reads_never_answers',
  'never_answers',
  'opts_out',
  'elsewhere_photo',
] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

/** Kinds of slot the agent's ladder offers (the rung's `slotPreference`). */
export const SLOT_FITS = ['earliest', 'other_time', 'saturday'] as const;
export type SlotFit = (typeof SLOT_FITS)[number];

const Probability = z.number().min(0).max(1);
const DayRange = z
  .tuple([z.number().min(0), z.number().min(0)])
  .refine(([min, max]) => min <= max, 'range min must not exceed max');

export const PersonaSchema = z.object({
  id: z.enum(PERSONA_IDS),
  /** Share of the cohort (normalized over all personas). */
  weight: z.number().positive(),
  summary: z.string().min(1),
  /** Why these numbers: plain words, labeled as assumptions. */
  rationale: z.string().min(1),
  /** `undelivered`: the phone on file is wrong until reception fixes it. */
  delivery: z.enum(['ok', 'undelivered']),
  /**
   * P(the patient replies) to the k-th message that reaches them (agent
   * message or generic reminder alike); the last value repeats.
   */
  engage: z.array(Probability).min(1),
  /** P(an offered slot of this kind works for them), when they reply. */
  slotFit: z.object({ earliest: Probability, other_time: Probability, saturday: Probability }),
  /** Control arm: P(after engaging with a generic reminder they book or do it on their own). */
  selfBooksAfterReminder: Probability,
  /** P(they answer a phone call from reception or the doctor). */
  answersCall: Probability,
  /** P(their reply is an opt-out). */
  optOutOnReply: Probability,
  /** For each test order, P(they did it at an outside lab, so no in-clinic result ever arrives). */
  testDoneElsewhere: Probability,
  /** P(they send a photo of an outside result when asked about the test). */
  sendsPhoto: Probability,
  /** P(they complete an order with no contact at all), and when (days after the order). */
  selfCompletion: z.object({ probability: Probability, days: DayRange }),
  /** P(they attend a booked visit or lab slot). */
  showUp: Probability,
});
export type Persona = z.infer<typeof PersonaSchema>;

const testGroupIds = new Set(TEST_GROUPS.map((group) => group.id));
const TestGroupId = z
  .string()
  .refine(
    (id) => testGroupIds.has(id),
    'unknown test group (packages/core/src/engine/terminology/test-names.ts)',
  );

/** One order of an order set; tests are drawn uniformly from `tests`, notes from `notes`. */
export const OrderSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lab'), tests: z.array(TestGroupId).min(1) }),
  z.object({ kind: z.literal('imaging'), tests: z.array(TestGroupId).min(1) }),
  /** A control visit the doctor wrote in the note ("control en 4 semanas"): the engine reads it. */
  z.object({ kind: z.literal('visit'), notes: z.array(z.string().min(1)).min(1) }),
  /** An abnormal result: the engine's urgent follow-up visit within 7 days. */
  z.object({ kind: z.literal('urgent'), tests: z.array(TestGroupId).min(1) }),
]);
export type OrderSpec = z.infer<typeof OrderSpecSchema>;
export type OrderKind = OrderSpec['kind'];

export const OrderSetSchema = z.object({
  id: z.string().min(1),
  weight: z.number().positive(),
  orders: z.array(OrderSpecSchema).min(1),
});
export type OrderSet = z.infer<typeof OrderSetSchema>;

export const SimulationConfigSchema = z.object({
  version: z.string().min(1),
  notice: z.string().min(1),
  cohort: z.object({
    patientsPerArm: z.number().int().positive(),
    /** Share of patients in the control arm, by hash of the patient id. */
    controlShare: z.number().gt(0).lt(1),
    /** Orders are placed over the first days of the window. */
    enrolmentDays: z.number().int().positive(),
    horizonDays: z.number().int().positive(),
    /** ISO instant of day 0 (its local date in `timeZone` is the first day; 05:00 local works). */
    start: z.iso.datetime(),
    timeZone: z.string().min(1),
    seeds: z.number().int().positive(),
  }),
  orderSets: z.array(OrderSetSchema).min(1),
  personas: z.array(PersonaSchema).length(PERSONA_IDS.length),
  operations: z.object({
    /** P(reception or the doctor does a staff task on its due day). */
    staffCompletesTask: Probability,
    /** P(an "update the phone" task finds the right number in the records). */
    phoneFoundByReception: Probability,
    /** P(an "other contact" task reaches a relative who passes on the right number). */
    otherContactReached: Probability,
    /** P(a patient who answers a call books on that call). */
    callBooks: Probability,
    /** P(a patient who declined a slot answers the agent's alternative). */
    keepsTalking: Probability,
    replyDelayHours: DayRange,
    labResultLagDays: DayRange,
    imagingResultLagDays: DayRange,
    /** Control arm: days between deciding to book and the visit or lab visit. */
    selfBookLeadDays: DayRange,
    /** How old an outside result is when its photo arrives. */
    photoAgeDays: DayRange,
    /** The agent starts on a control visit this many days before it is due. */
    visitWindowDays: z.number().int().min(0),
    /** Self-completion of an urgent visit is scaled by this (the patient does not know the result). */
    urgentSelfCompletionFactor: Probability,
  }),
  economics: z.object({
    consultationPrice: z.number().nonnegative(),
    currency: z.string().length(3),
    patientsPerMonth: z.number().int().positive(),
  }),
  assumptions: z.array(z.string().min(1)).min(1),
});
export type SimulationConfig = z.infer<typeof SimulationConfigSchema>;

/** Validates a parsed config file; every persona must appear exactly once. */
export function parseSimulationConfig(raw: unknown): SimulationConfig {
  const config = SimulationConfigSchema.parse(raw);
  const ids = new Set(config.personas.map((persona) => persona.id));
  if (ids.size !== PERSONA_IDS.length) {
    throw new Error('Every persona must appear exactly once in the simulation config');
  }
  return config;
}

/** The config with some cohort fields replaced (smaller runs, tests). */
export function withCohort(
  config: SimulationConfig,
  cohort: Partial<SimulationConfig['cohort']>,
): SimulationConfig {
  return { ...config, cohort: { ...config.cohort, ...cohort } };
}
