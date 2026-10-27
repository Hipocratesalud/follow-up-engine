import {
  type ClinicalEvent,
  type ClinicId,
  type Expectation,
  type FollowUpCase,
  type PatientId,
  patientId as toPatientId,
  type TransactionalStores,
  type UnitOfWork,
} from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import type { SyntheticPatient } from '@follow-up-engine/testkit';
import type { EngineHarness } from './harness.ts';

/**
 * Imports the synthetic clinic's history the way a host would before turning
 * the engine on: every bundle mapped from FHIR and staged (stored, not
 * annotated), one staging call per patient.
 *
 * @returns how many events were staged.
 */
export async function stageHistory(
  harness: EngineHarness,
  patients: readonly SyntheticPatient[],
): Promise<number> {
  let staged = 0;
  for (const patient of patients) {
    const events: ClinicalEvent[] = [];
    for (const entry of patient.entries) {
      const mapped = mapBundleToBatches(entry.bundle, {
        clinicId: harness.clinicId,
        receivedAt: new Date(entry.at),
      });
      events.push(...mapped.batches.flatMap((batch) => batch.events));
    }
    const { inserted } = await harness.engine.backfill.stage({
      clinicId: harness.clinicId,
      patientId: toPatientId(patient.patientId),
      receivedAt: new Date(patient.entries.at(-1)?.at ?? 0),
      events,
    });
    staged += inserted;
  }
  return staged;
}

/** Everything the engine stores for a set of patients, keyed by what the engine keys on (not ids). */
export interface ClinicState {
  readonly expectations: readonly Expectation[];
  readonly cases: readonly FollowUpCase[];
  /** Id-free, comparable view: identical engines produce identical fingerprints. */
  readonly fingerprint: string;
}

export async function readClinicState(
  harness: EngineHarness,
  patients: readonly PatientId[],
): Promise<ClinicState> {
  const { clinicId } = harness;
  return harness.read(async (stores) => {
    const expectations: Expectation[] = [];
    const cases: FollowUpCase[] = [];
    const conditions: unknown[] = [];
    const findings: unknown[] = [];
    for (const patient of patients) {
      expectations.push(...(await stores.expectations.listByPatient(clinicId, patient)));
      cases.push(
        ...(await stores.cases.list(clinicId, { patientId: patient, limit: 10_000 })).items,
      );
      conditions.push(...(await stores.conditions.listByPatient(clinicId, patient)));
      findings.push(...(await stores.qualityFindings.listByPatient(clinicId, patient)));
    }
    return {
      expectations,
      cases,
      fingerprint: fingerprint(expectations, cases, conditions, findings).replaceAll(
        clinicId,
        '<clinic>',
      ),
    };
  });
}

function fingerprint(
  expectations: readonly Expectation[],
  cases: readonly FollowUpCase[],
  conditions: readonly unknown[],
  findings: readonly unknown[],
): string {
  const keyOf = new Map(expectations.map((e) => [e.id, e.idempotencyKey]));
  // Ids are left out: two engines mint them differently for the same state.
  const exp = expectations
    .map((expectation) => {
      const { caseId, ...rest } = expectation;
      return {
        ...rest,
        id: undefined,
        case: cases.find((c) => c.id === caseId)?.dedupKey,
      };
    })
    .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
  const cs = cases
    .map((followUpCase) => ({
      ...followUpCase,
      id: undefined,
      reasons: followUpCase.reasons.map((reason) => keyOf.get(reason.expectationId)).sort(),
    }))
    .sort((a, b) => `${a.dedupKey}${a.status}`.localeCompare(`${b.dedupKey}${b.status}`));
  return JSON.stringify({ exp, cs, conditions, findings });
}

/** Thrown by {@link CrashingUnitOfWork}: a worker dying in the middle of a transaction. */
export class InjectedCrash extends Error {
  override readonly name = 'InjectedCrash';
}

/**
 * A unit of work that, once armed, lets `after` more transactions commit and
 * then crashes the next one after its work ran (so it rolls back).
 */
export class CrashingUnitOfWork implements UnitOfWork {
  readonly #inner: UnitOfWork;
  #remaining: number | undefined;

  constructor(inner: UnitOfWork) {
    this.#inner = inner;
  }

  arm(after: number): void {
    this.#remaining = after;
  }

  disarm(): void {
    this.#remaining = undefined;
  }

  withTransaction<TResult>(
    clinicId: ClinicId,
    work: (stores: TransactionalStores) => Promise<TResult>,
  ): Promise<TResult> {
    return this.#inner.withTransaction(clinicId, async (stores) => {
      const result = await work(stores);
      if (this.#remaining !== undefined) {
        if (this.#remaining === 0) {
          this.#remaining = undefined;
          throw new InjectedCrash('crash injected after the work of a transaction');
        }
        this.#remaining -= 1;
      }
      return result;
    });
  }
}
