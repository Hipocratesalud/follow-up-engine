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

/**
 * The expectations grouped in a case, in reason order. Read one after the
 * other: a transaction's connection runs one statement at a time.
 */
export async function caseExpectations(
  stores: TransactionalStores,
  clinicId: ClinicId,
  followUpCase: FollowUpCase,
): Promise<Expectation[]> {
  const loaded: Expectation[] = [];
  for (const reason of followUpCase.reasons) {
    const expectation = await stores.expectations.get(clinicId, reason.expectationId);
    if (expectation !== undefined) {
      loaded.push(expectation);
    }
  }
  return loaded;
}

/**
 * The escalation policy of a case: the named policy it was pinned to when it
 * opened (`escalationPolicyId`), else the one of the rule that opened it.
 */
export function policyOf(
  catalog: Catalog,
  reasons: readonly Expectation[],
  followUpCase?: Pick<FollowUpCase, 'escalationPolicyId'>,
): EscalationPolicy {
  const pinned = followUpCase?.escalationPolicyId;
  if (pinned !== undefined) {
    const policy = catalog.policy(pinned);
    if (policy !== undefined) {
      return policy;
    }
  }
  const [first] = reasons;
  return (
    (first === undefined ? undefined : catalog.definition(first.ruleId)?.escalationPolicy) ??
    FALLBACK_ESCALATION_POLICY
  );
}

/** The named policy a case opening on `expectation` is pinned to, if its policy has an id. */
export function pinnedPolicyId(catalog: Catalog, expectation: Expectation): string | undefined {
  return catalog.definition(expectation.ruleId)?.escalationPolicy.id;
}
