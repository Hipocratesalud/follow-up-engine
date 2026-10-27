import {
  CORRECTED_BY_CLINICIAN,
  type Expectation,
  isClosedByClinician,
  planItemReading,
  REJECTED_BY_CLINICIAN,
} from '@follow-up-engine/core';
import type { PlanItemView } from '../http/plan-item-schemas.ts';
import type { ApiMessages } from '../i18n/index.ts';

/**
 * How a doctor's-plan expectation shows its AI reading and the clinician's
 * review (HIP-141); `undefined` for every other layer. `userName` turns a
 * host user id into the name the team knows.
 */
export async function planItemView(
  t: ApiMessages,
  expectation: Expectation,
  userName: (id: string) => Promise<string>,
): Promise<PlanItemView | undefined> {
  if (expectation.layer !== 'doctor_plan') {
    return undefined;
  }
  const { kind } = planItemReading(expectation);
  const review: PlanItemView['review'] =
    expectation.closedReason === CORRECTED_BY_CLINICIAN
      ? 'corrected'
      : expectation.closedReason === REJECTED_BY_CLINICIAN
        ? 'rejected'
        : expectation.confirmedBy === undefined
          ? 'pending'
          : 'confirmed';
  return {
    kind,
    kindLabel: t.planItemKinds[kind],
    review,
    ...(expectation.confirmedBy === undefined
      ? {}
      : { confirmedBy: await userName(expectation.confirmedBy) }),
    ...(expectation.confirmedAt === undefined
      ? {}
      : { confirmedAt: expectation.confirmedAt.toISOString() }),
    ...(expectation.correctionOf === undefined ? {} : { correctionOf: expectation.correctionOf }),
    actionable:
      !isClosedByClinician(expectation) &&
      (expectation.status === 'open' || expectation.status === 'expired'),
  };
}
