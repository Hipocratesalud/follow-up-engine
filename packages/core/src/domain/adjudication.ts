import type { Evidence } from './common.ts';
import type { CaseId, ClinicId, ExpectationId, PatientId } from './ids.ts';

/**
 * The adjudicator (PRD V2, workstream E): a decision model that looks only at
 * ambiguous expectations (a plan item the extractor read with a confidence
 * inside the clinic's band, by default 0.4 to 0.75) and says whether the
 * follow-up is real. Clear items never go through it.
 *
 * - `open`: the note asks for it; it is followed up like any other item and
 *   opens its case when due.
 * - `discard`: the note does not ask for it (negated, already done, only a
 *   possibility); in `active` mode the expectation stays suppressed
 *   (`cancelled`, {@link DISCARDED_BY_ADJUDICATOR}).
 * - `needs_human`: the model cannot tell, or its answer did not pass the
 *   engine's checks; the item goes to the doctor's review with the reason.
 */
export const ADJUDICATION_DECISIONS = ['open', 'discard', 'needs_human'] as const;
export type AdjudicationDecision = (typeof ADJUDICATION_DECISIONS)[number];

/**
 * Why the adjudicator decided what it did. A fixed list: the model picks
 * from the first eleven, the engine adds the last two when it overrules the
 * model (no quote it could find in the note, a probability that does not
 * back the decision).
 */
export const ADJUDICATION_REASON_CODES = [
  /** The note gives the instruction plainly ("solicito HbA1c en 3 meses"). */
  'explicit_instruction',
  /** The timing is written next to the instruction. */
  'timing_explicit',
  /** The timing is vague or missing ("más adelante", "próximamente"). */
  'timing_vague',
  /** Only if something happens ("si persiste", "según evolución"). */
  'conditional_plan',
  /** Mentioned as a possibility, not ordered ("evaluar", "considerar"). */
  'hypothetical_mention',
  /** The note says it is already done or the result is already in. */
  'already_done',
  /** The note says it is not needed ("no requiere control"). */
  'negated',
  /** The patient declined it. */
  'patient_declined',
  /** Another provider or clinic will take care of it. */
  'deferred_to_other_provider',
  /** The note says contradictory things about it. */
  'contradictory_signals',
  /** The note does not say enough to decide. */
  'insufficient_context',
  /** Engine: none of the model's quotes is in the note. */
  'no_verifiable_quote',
  /** Engine: the probability does not back the decision (below the clinic's threshold). */
  'low_probability',
] as const;
export type AdjudicationReasonCode = (typeof ADJUDICATION_REASON_CODES)[number];

/** The reason codes a model may return (the engine adds the others). */
export const MODEL_ADJUDICATION_REASON_CODES = ADJUDICATION_REASON_CODES.slice(
  0,
  11,
) as readonly Exclude<AdjudicationReasonCode, 'no_verifiable_quote' | 'low_probability'>[];

/**
 * `off`: never runs. `shadow`: decides and records, changes nothing (the
 * clinical team compares decisions against the doctors' reviews first).
 * `active`: decides and applies (`discard` suppresses the expectation).
 */
export const ADJUDICATOR_MODES = ['off', 'shadow', 'active'] as const;
export type AdjudicatorMode = (typeof ADJUDICATOR_MODES)[number];

/** `closedReason` of an expectation the adjudicator discarded in `active` mode. */
export const DISCARDED_BY_ADJUDICATOR = 'discarded_by_adjudicator';

/**
 * Per-clinic adjudicator settings (`ClinicSettings.adjudicator`). Absent
 * fields take {@link DEFAULT_ADJUDICATOR_SETTINGS}: off, band 0.4 to 0.75.
 */
export interface AdjudicatorSettings {
  readonly mode?: AdjudicatorMode;
  /** Extraction confidence from which an item is ambiguous (inclusive). */
  readonly minConfidence?: number;
  /** Extraction confidence from which an item is clear (exclusive). */
  readonly maxConfidence?: number;
  /** `open` needs at least this probability, else `needs_human`. */
  readonly minOpenProbability?: number;
  /** `discard` needs at most this probability, else `needs_human`. */
  readonly maxDiscardProbability?: number;
}

export type ResolvedAdjudicatorSettings = Required<AdjudicatorSettings>;

export const DEFAULT_ADJUDICATOR_SETTINGS: ResolvedAdjudicatorSettings = {
  mode: 'off',
  minConfidence: 0.4,
  maxConfidence: 0.75,
  minOpenProbability: 0.7,
  maxDiscardProbability: 0.3,
};

/** What a doctor can set over the adjudicator's decision. */
export const ADJUDICATION_OVERRIDES = ['open', 'discard'] as const;
export type AdjudicationOverrideDecision = (typeof ADJUDICATION_OVERRIDES)[number];

export interface AdjudicationOverride {
  readonly decision: AdjudicationOverrideDecision;
  /** Host user id of the doctor. */
  readonly userId: string;
  readonly at: Date;
  readonly note?: string;
}

/**
 * One decision of the adjudicator on one expectation, with its provenance
 * (model, prompt version, cost) and, once a doctor looked at it, their
 * override. The rationale and the quotes are for the clinical team; the
 * quotes are verbatim from the note (checked by the engine), never shown to
 * the patient.
 */
export interface Adjudication {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly expectationId: ExpectationId;
  /** The case the expectation belonged to when it was decided, if any. */
  readonly caseId?: CaseId;
  /** What the engine applies (the model's answer after the engine's checks). */
  readonly decision: AdjudicationDecision;
  /** What the model answered, before the engine's checks. */
  readonly modelDecision: AdjudicationDecision;
  /** Calibrated probability that the follow-up is real (the note asks for it), 0 to 1. */
  readonly probability: number;
  readonly reasonCodes: readonly AdjudicationReasonCode[];
  /** One or two sentences for the clinician, in English and in Spanish. */
  readonly rationale: { readonly en: string; readonly es: string };
  /** Verbatim quotes from the note that back the decision. */
  readonly quotes: readonly Evidence[];
  /** The extraction confidence that made the item ambiguous. */
  readonly inputConfidence: number;
  /** The clinic's mode when it was decided: `shadow` decisions changed nothing. */
  readonly mode: Exclude<AdjudicatorMode, 'off'>;
  /** Whether the engine applied an effect (only `discard` in `active` mode). */
  readonly applied: boolean;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly createdAt: Date;
  readonly override?: AdjudicationOverride;
}

/** Settings with every default filled in. */
export function resolveAdjudicatorSettings(
  settings: AdjudicatorSettings | undefined,
): ResolvedAdjudicatorSettings {
  return { ...DEFAULT_ADJUDICATOR_SETTINGS, ...settings };
}

/** Whether an extraction confidence falls in the clinic's ambiguous band (`[min, max)`). */
export function isAmbiguousConfidence(
  confidence: number | undefined,
  settings: Pick<ResolvedAdjudicatorSettings, 'minConfidence' | 'maxConfidence'>,
): boolean {
  return (
    confidence !== undefined &&
    Number.isFinite(confidence) &&
    confidence >= settings.minConfidence &&
    confidence < settings.maxConfidence
  );
}
