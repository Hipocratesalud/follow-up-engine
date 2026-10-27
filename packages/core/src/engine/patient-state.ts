import { ACTIVE_CASE_STATUSES, type FollowUpCase } from '../domain/case.ts';
import type { PatientCondition } from '../domain/condition.ts';
import type { Expectation } from '../domain/expectation.ts';
import type { ClinicId, ExpectationId, PatientId } from '../domain/ids.ts';
import type { CaseListQuery } from '../ports/case-repository.ts';
import type { TransactionalStores } from '../ports/unit-of-work.ts';
import { PatientTimeline } from './timeline.ts';

const PAGE_SIZE = 100;

/** Every case of a patient matching `query`, across pages. */
export async function listPatientCases(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
  query: Omit<CaseListQuery, 'patientId' | 'limit' | 'cursor'> = {},
): Promise<FollowUpCase[]> {
  const cases: FollowUpCase[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.cases.list(clinicId, {
      ...query,
      patientId,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    cases.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return cases;
}

/**
 * Expectations still in play: `open` ones plus `expired` ones grouped into an
 * active case (they can still be fulfilled late and resolve the case).
 * Mutable within one operation so later steps see earlier writes.
 */
export class LiveExpectations {
  readonly #byId = new Map<ExpectationId, Expectation>();

  constructor(expectations: readonly Expectation[]) {
    for (const expectation of expectations) {
      this.#byId.set(expectation.id, expectation);
    }
  }

  /** Live expectations, by due date. */
  list(): Expectation[] {
    return [...this.#byId.values()]
      .filter((expectation) => expectation.status === 'open' || expectation.status === 'expired')
      .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  }

  put(expectation: Expectation): void {
    this.#byId.set(expectation.id, expectation);
  }
}

/** What the engine knows about one patient at the start of an operation. */
export interface PatientState {
  readonly timeline: PatientTimeline;
  readonly conditions: readonly PatientCondition[];
  readonly activeCases: readonly FollowUpCase[];
  readonly live: LiveExpectations;
}

export async function loadPatientState(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<PatientState> {
  const [events, conditions, activeCases, open] = await Promise.all([
    stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
    stores.conditions.listByPatient(clinicId, patientId),
    listPatientCases(stores, clinicId, patientId, { statuses: ACTIVE_CASE_STATUSES }),
    stores.expectations.findOpenByPatient(clinicId, patientId),
  ]);
  const openIds = new Set(open.map((expectation) => expectation.id));
  const grouped = await Promise.all(
    activeCases
      .flatMap((followUpCase) => followUpCase.reasons.map((reason) => reason.expectationId))
      .filter((id) => !openIds.has(id))
      .map((id) => stores.expectations.get(clinicId, id)),
  );
  const expired = grouped.filter(
    (expectation): expectation is Expectation => expectation?.status === 'expired',
  );
  return {
    timeline: new PatientTimeline(events),
    conditions,
    activeCases,
    live: new LiveExpectations([...open, ...expired]),
  };
}
