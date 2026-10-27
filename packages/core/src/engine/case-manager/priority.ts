import type { EscalationPolicy } from '../../config/common.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { protocolConditions } from '../annotator/conditions.ts';
import type { Catalog, ExpectationDefinition } from '../catalog.ts';
import { kindOfMatchKey } from '../matching/match-key.ts';
import { daysBetween } from '../support/time.ts';

/**
 * What a reason is about, from most to least clinically pressing: a
 * critical (panic) result, an abnormal result nobody reviewed, a result the
 * doctor ordered that never came, the doctor's own plan (or the control
 * after a treatment the doctor prescribed), a break in the patient's visit
 * pattern, a guideline gap.
 */
export type PriorityCategory =
  'critical_result' | 'abnormal_result' | 'pending_result' | 'doctor_plan' | 'cadence' | 'protocol';

/**
 * The case priority model (0 to 100, higher first; the inbox reads ≥ 90 as
 * urgent, ≥ 75 high, ≥ 60 medium). Recomputed on every watcher tick, so the
 * overdue factor follows the calendar instead of freezing at opening.
 *
 * For each reason: the base of its category (critical result 90, abnormal
 * result 75, ordered result 60, doctor's plan 50, cadence 38, protocol 32),
 * nudged by the
 * rule's own `priority` ((priority − 40) / 4, at most ±5), minus 10 for a
 * protocol reminder that rests only on a probable condition, plus 3 for any
 * other reason of a patient with a confirmed chronic condition, plus the
 * overdue factor. The case takes its most pressing reason, plus 3 per extra
 * reason (at most 2), plus what its escalation already raised
 * (`raise_priority`, +20 in `default_v1`), never above the cap of the most
 * pressing category among its reasons (critical and abnormal result 100,
 * ordered result 89, doctor's plan 82, cadence and protocol 74): only a
 * result that came back abnormal can be urgent, however long the rest waits.
 *
 * Overdue factor: half a point per day overdue up to +6 (day 12); flat
 * until day 90; then it decays one point every 15 days down to −20, so a
 * control missed a year and a half ago (the initial backfill) ranks below
 * what is missed now.
 *
 * Consequences: a fresh ordered result is medium (61), a fresh abnormal
 * result high (80), a fresh critical result urgent (95); only an abnormal
 * result left without action until its escalation becomes urgent; an
 * ordered result or the doctor's plan tops out high (89, 82) whatever its
 * extra reasons and escalation; a probable-only protocol reminder stays low
 * (≤ 48).
 */
export const PRIORITY_MODEL = {
  categoryBase: {
    critical_result: 90,
    abnormal_result: 75,
    pending_result: 60,
    doctor_plan: 50,
    cadence: 38,
    protocol: 32,
  } satisfies Record<PriorityCategory, number>,
  categoryCap: {
    critical_result: 100,
    abnormal_result: 100,
    pending_result: 89,
    doctor_plan: 82,
    cadence: 74,
    protocol: 74,
  } satisfies Record<PriorityCategory, number>,
  rulePivot: 40,
  ruleDivisor: 4,
  maxRuleAdjustment: 5,
  probableOnlyProtocol: -10,
  confirmedChronicPatient: 3,
  overduePointsPerDay: 0.5,
  maxOverdueBonus: 6,
  staleAfterDays: 90,
  staleDaysPerPoint: 15,
  maxStalePenalty: 20,
  perExtraReason: 3,
  maxExtraReasons: 2,
  min: 0,
  max: 100,
} as const;

export interface PriorityReason {
  readonly expectation: Expectation;
  readonly definition: ExpectationDefinition | undefined;
}

export interface PriorityInput {
  readonly reasons: readonly PriorityReason[];
  /** Protocols the patient is enrolled in through a confirmed condition. */
  readonly confirmedProtocols: ReadonlySet<string>;
  /** Priority already added by the case's escalation (`raise_priority` steps run). */
  readonly escalationBonus?: number;
  readonly now: Date;
}

export function priorityCategory(reason: PriorityReason): PriorityCategory {
  const { expectation, definition } = reason;
  switch (expectation.layer) {
    case 'protocol':
      return 'protocol';
    case 'cadence':
      return 'cadence';
    case 'doctor_plan':
      return 'doctor_plan';
    case 'universal': {
      if (definition?.trigger?.event === 'result.received') {
        return expectation.severity === 'critical' ? 'critical_result' : 'abnormal_result';
      }
      const kind = definition?.expects ?? kindOfMatchKey(expectation.matchKey);
      return kind === 'lab' || kind === 'imaging' ? 'pending_result' : 'doctor_plan';
    }
  }
}

/** Points for being overdue: rises for three weeks, then decays for very old items. */
export function overdueFactor(overdueDays: number): number {
  const model = PRIORITY_MODEL;
  if (overdueDays <= 0) {
    return 0;
  }
  if (overdueDays <= model.staleAfterDays) {
    return Math.min(model.maxOverdueBonus, overdueDays * model.overduePointsPerDay);
  }
  return Math.max(
    -model.maxStalePenalty,
    model.maxOverdueBonus - (overdueDays - model.staleAfterDays) / model.staleDaysPerPoint,
  );
}

function reasonScore(reason: PriorityReason, input: PriorityInput): number {
  const model = PRIORITY_MODEL;
  const category = priorityCategory(reason);
  const rule = reason.definition?.priority ?? model.rulePivot;
  const adjustment = Math.max(
    -model.maxRuleAdjustment,
    Math.min(model.maxRuleAdjustment, (rule - model.rulePivot) / model.ruleDivisor),
  );
  const protocolId = reason.expectation.protocolId;
  const confidence =
    category === 'protocol'
      ? protocolId !== undefined && input.confirmedProtocols.has(protocolId)
        ? 0
        : model.probableOnlyProtocol
      : input.confirmedProtocols.size > 0
        ? model.confirmedChronicPatient
        : 0;
  const overdue = overdueFactor(daysBetween(reason.expectation.dueAt, input.now));
  return model.categoryBase[category] + adjustment + confidence + overdue;
}

/** Priority of a case from its reasons (see {@link PRIORITY_MODEL}). */
export function computeCasePriority(input: PriorityInput): number {
  const model = PRIORITY_MODEL;
  if (input.reasons.length === 0) {
    return model.min;
  }
  const best = Math.max(...input.reasons.map((reason) => reasonScore(reason, input)));
  const extra = Math.min(model.maxExtraReasons, input.reasons.length - 1) * model.perExtraReason;
  const cap = Math.max(
    ...input.reasons.map((reason) => model.categoryCap[priorityCategory(reason)]),
  );
  const total = best + extra + (input.escalationBonus ?? 0);
  return Math.round(Math.max(model.min, Math.min(model.max, cap, total)));
}

/** Protocols the patient is enrolled in through a confirmed (not just probable) condition. */
export function confirmedProtocols(
  catalog: Catalog,
  conditions: readonly PatientCondition[],
): Set<string> {
  return new Set(
    catalog.protocols
      .filter((protocol) =>
        protocolConditions(protocol, conditions).some(
          (condition) => condition.status === 'confirmed',
        ),
      )
      .map((protocol) => protocol.id),
  );
}

/** What the `raise_priority` steps before `escalationStep` added. */
export function escalationPriorityBonus(policy: EscalationPolicy, escalationStep: number): number {
  return policy.steps
    .slice(0, escalationStep)
    .reduce(
      (total, step) =>
        step.action === 'raise_priority' ? total + (step.priorityDelta ?? 10) : total,
      0,
    );
}
