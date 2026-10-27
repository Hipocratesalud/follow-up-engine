import type { Expectation } from '../../domain/expectation.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { kindOfMatchKey } from '../matching/match-key.ts';
import { daysBetween } from '../support/time.ts';

/** Weights of the computed case priority. Higher is more urgent. */
export const PRIORITY_WEIGHTS = {
  chronicCondition: 15,
  pendingResults: 10,
  maxOverdueDays: 30,
  perExtraReason: 5,
  maxExtraReasons: 3,
} as const;

export interface PriorityInput {
  readonly reasons: readonly {
    readonly expectation: Expectation;
    readonly definition: ExpectationDefinition | undefined;
  }[];
  /** The patient has a condition enrolled in a care protocol. */
  readonly chronic: boolean;
  readonly now: Date;
}

/**
 * Priority of a case: the most urgent rule's base priority, plus a bonus for
 * chronic patients, for pending results, one point per overdue day (capped)
 * and a little per extra reason.
 */
export function computeCasePriority(input: PriorityInput): number {
  const base = Math.max(0, ...input.reasons.map((reason) => reason.definition?.priority ?? 0));
  const overdue = Math.max(
    0,
    ...input.reasons.map((reason) => daysBetween(reason.expectation.dueAt, input.now)),
  );
  const pendingResults = input.reasons.some((reason) => {
    const kind = reason.definition?.expects ?? kindOfMatchKey(reason.expectation.matchKey);
    return kind === 'lab' || kind === 'imaging';
  });
  const chronic =
    input.chronic || input.reasons.some((reason) => reason.expectation.layer === 'protocol');
  const extraReasons = Math.min(PRIORITY_WEIGHTS.maxExtraReasons, input.reasons.length - 1);
  return (
    base +
    (chronic ? PRIORITY_WEIGHTS.chronicCondition : 0) +
    (pendingResults ? PRIORITY_WEIGHTS.pendingResults : 0) +
    Math.min(PRIORITY_WEIGHTS.maxOverdueDays, overdue) +
    Math.max(0, extraReasons) * PRIORITY_WEIGHTS.perExtraReason
  );
}
