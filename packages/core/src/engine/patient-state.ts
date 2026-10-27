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

/**
 * Loads a patient's state at the start of an operation.
 *
 * With `asOf` (the backfill's replay), the state is the one the patient had
 * just before that instant, so a replay takes the same decisions whether it
 * runs for the first time or again over its own results: the timeline holds
 * the events up to `asOf`; live expectations are those created before it
 * and not closed before it (the replay stamps `createdAt` and `closedAt`
 * with each batch's time); conditions are those known up to it, plus every
 * clinician review (never overridden by automation).
 */
export async function loadPatientState(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
  asOf?: Date,
): Promise<PatientState> {
  const events = await stores.clinicalRecords.listEventsForPatient(
    clinicId,
    patientId,
    asOf === undefined ? {} : { until: new Date(asOf.getTime() + 1) },
  );
  const conditions = await stores.conditions.listByPatient(clinicId, patientId);
  const activeCases = await listPatientCases(stores, clinicId, patientId, {
    statuses: ACTIVE_CASE_STATUSES,
  });
  if (asOf !== undefined) {
    const all = await stores.expectations.listByPatient(clinicId, patientId);
    return {
      timeline: new PatientTimeline(events),
      conditions: conditions.filter(
        (condition) =>
          // A step decides with the conditions it upserts itself, so those stay visible.
          condition.confirmedBy !== undefined || condition.updatedAt.getTime() <= asOf.getTime(),
      ),
      activeCases,
      live: new LiveExpectations(
        all.filter((expectation) => wasLive(expectation, asOf)).map(asOpen),
      ),
    };
  }
  const open = await stores.expectations.findOpenByPatient(clinicId, patientId);
  const openIds = new Set(open.map((expectation) => expectation.id));
  const expired: Expectation[] = [];
  for (const followUpCase of activeCases) {
    for (const reason of followUpCase.reasons) {
      if (openIds.has(reason.expectationId)) {
        continue;
      }
      const grouped = await stores.expectations.get(clinicId, reason.expectationId);
      if (grouped?.status === 'expired') {
        expired.push(grouped);
      }
    }
  }
  return {
    timeline: new PatientTimeline(events),
    conditions,
    activeCases,
    live: new LiveExpectations([...open, ...expired]),
  };
}

/** Whether an expectation was in play just before `asOf`: created earlier, not closed earlier. */
export function wasLive(expectation: Expectation, asOf: Date): boolean {
  return (
    expectation.createdAt.getTime() < asOf.getTime() &&
    (expectation.closedAt === undefined || expectation.closedAt.getTime() >= asOf.getTime())
  );
}

/**
 * An expectation as it was while still open during a replay: a later closure
 * or expiry undone (a replay groups expired expectations into cases only at
 * the end of the patient, so back then it had no case either).
 */
export function asOpen(expectation: Expectation): Expectation {
  if (expectation.status === 'open') {
    return expectation;
  }
  const open: { -readonly [K in keyof Expectation]: Expectation[K] } = {
    ...expectation,
    status: 'open',
  };
  delete open.closedAt;
  delete open.closedReason;
  delete open.closedBy;
  delete open.caseId;
  delete open.recheckAt;
  return open;
}
