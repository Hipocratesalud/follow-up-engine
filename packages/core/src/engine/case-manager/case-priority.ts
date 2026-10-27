import { ACTIVE_CASE_STATUSES, type FollowUpCase } from '../../domain/case.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import type { Catalog } from '../catalog.ts';
import { caseExpectations, policyOf } from '../escalation/schedule.ts';
import { computeCasePriority, confirmedProtocols, escalationPriorityBonus } from './priority.ts';

/**
 * The priority of a case now: its reasons still in play (all of them when
 * none is), the patient's conditions and what its escalation raised.
 */
export function priorityOfCase(input: {
  readonly catalog: Catalog;
  readonly reasons: readonly Expectation[];
  readonly conditions: readonly PatientCondition[];
  readonly escalationStep: number;
  readonly now: Date;
}): number {
  const live = input.reasons.filter(
    (expectation) => expectation.status === 'open' || expectation.status === 'expired',
  );
  const reasons = live.length > 0 ? live : input.reasons;
  return computeCasePriority({
    reasons: reasons.map((expectation) => ({
      expectation,
      definition: input.catalog.definition(expectation.ruleId),
    })),
    confirmedProtocols: confirmedProtocols(input.catalog, input.conditions),
    escalationBonus: escalationPriorityBonus(
      policyOf(input.catalog, input.reasons),
      input.escalationStep,
    ),
    now: input.now,
  });
}

/**
 * Recomputes the priority of every active case of the clinic (the overdue
 * factor moves with the calendar), one transaction per page. Writes only the
 * priority, and only when it changed.
 *
 * @returns how many cases changed priority.
 */
export async function refreshCasePriorities(input: {
  readonly unitOfWork: UnitOfWork;
  readonly clinicId: ClinicId;
  readonly catalog: Catalog;
  readonly now: Date;
  readonly pageSize: number;
}): Promise<number> {
  const { unitOfWork, clinicId, catalog, now } = input;
  let changed = 0;
  let cursor: string | undefined;
  do {
    cursor = await unitOfWork.withTransaction(clinicId, async (stores) => {
      const page = await stores.cases.list(clinicId, {
        statuses: ACTIVE_CASE_STATUSES,
        orderBy: 'created_at',
        limit: input.pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const conditions = new Map<PatientId, readonly PatientCondition[]>();
      for (const followUpCase of page.items) {
        const known =
          conditions.get(followUpCase.patientId) ??
          (await stores.conditions.listByPatient(clinicId, followUpCase.patientId));
        conditions.set(followUpCase.patientId, known);
        const priority = await currentPriority(followUpCase, known);
        if (
          priority !== followUpCase.priority &&
          (await stores.cases.setPriority(clinicId, followUpCase.id, priority))
        ) {
          changed += 1;
        }
      }
      return page.nextCursor;

      async function currentPriority(
        followUpCase: FollowUpCase,
        patientConditions: readonly PatientCondition[],
      ): Promise<number> {
        return priorityOfCase({
          catalog,
          reasons: await caseExpectations(stores, clinicId, followUpCase),
          conditions: patientConditions,
          escalationStep: followUpCase.escalationStep,
          now,
        });
      }
    });
  } while (cursor !== undefined);
  return changed;
}
