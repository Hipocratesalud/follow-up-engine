import type { EscalationPolicy } from '../../config/common.ts';
import type { FollowUpCase } from '../../domain/case.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId } from '../../domain/ids.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import type { Catalog } from '../catalog.ts';
import { withoutKey } from '../case-manager/case-writer.ts';
import { addDays } from '../support/time.ts';

/** Used when a case's rule is no longer enabled: notify once, nothing else. */
export const FALLBACK_ESCALATION_POLICY: EscalationPolicy = {
  id: 'fallback',
  steps: [{ afterDays: 0, action: 'notify_clinic' }],
};

/**
 * When step `stepIndex` is due, counting from `from` (the moment the
 * previous step ran, or the user last acted): the gap between the step's
 * `afterDays` and the previous step's. `undefined` when no step is left.
 */
export function nextActionAfter(
  policy: EscalationPolicy,
  stepIndex: number,
  from: Date,
): Date | undefined {
  const next = policy.steps[stepIndex];
  if (next === undefined) {
    return undefined;
  }
  const previous = policy.steps[stepIndex - 1]?.afterDays ?? 0;
  return addDays(from, next.afterDays - previous);
}

/** Sets or clears `nextActionAt`. */
export function withNextActionAt(followUpCase: FollowUpCase, at: Date | undefined): FollowUpCase {
  const base = withoutKey(followUpCase, 'nextActionAt');
  return at === undefined ? base : { ...base, nextActionAt: at };
}

/** The expectations grouped in a case, in reason order. */
export async function caseExpectations(
  stores: TransactionalStores,
  clinicId: ClinicId,
  followUpCase: FollowUpCase,
): Promise<Expectation[]> {
  const loaded = await Promise.all(
    followUpCase.reasons.map((reason) => stores.expectations.get(clinicId, reason.expectationId)),
  );
  return loaded.filter((expectation): expectation is Expectation => expectation !== undefined);
}

/** The escalation policy of a case: the one of the rule that opened it. */
export function policyOf(catalog: Catalog, reasons: readonly Expectation[]): EscalationPolicy {
  const [first] = reasons;
  return (
    (first === undefined ? undefined : catalog.definition(first.ruleId)?.escalationPolicy) ??
    FALLBACK_ESCALATION_POLICY
  );
}
