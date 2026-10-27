import type { PatientCondition } from '../../domain/condition.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { CaseId, ClinicId, PatientId } from '../../domain/ids.ts';
import { patientId as toPatientId } from '../../domain/ids.ts';
import type { Coding } from '../../domain/resource.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import { enrollingConditions } from '../annotator/conditions.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import { codeMatchKey, parseCodeMatchKey, sameCoding } from '../matching/match-key.ts';
import { loadPatientState } from '../patient-state.ts';

const SEPARATOR = '~';

/** Stable, URL-safe id of a patient condition: `<patientId>~icd10:E11`. */
export function conditionId(condition: Pick<PatientCondition, 'patientId' | 'code'>): string {
  return `${condition.patientId}${SEPARATOR}${encodeURIComponent(codeMatchKey(condition.code))}`;
}

/** Reverse of {@link conditionId}; `undefined` when malformed. */
export function parseConditionId(
  id: string,
): { readonly patientId: PatientId; readonly code: Coding } | undefined {
  const separator = id.lastIndexOf(SEPARATOR);
  if (separator <= 0) {
    return undefined;
  }
  const code = parseCodeMatchKey(decodeURIComponent(id.slice(separator + 1)));
  return code === undefined ? undefined : { patientId: toPatientId(id.slice(0, separator)), code };
}

export interface RejectConditionResult {
  readonly condition: PatientCondition;
  readonly expectationsCancelled: number;
  readonly casesResolved: readonly CaseId[];
}

/** A clinician confirms or rejects a condition the engine inferred or extracted. */
export interface ConditionCommands {
  confirm(
    clinicId: ClinicId,
    patientId: PatientId,
    code: Coding,
    userId: string,
  ): Promise<PatientCondition>;
  /**
   * Marks the condition as not present (`resolved`, confidence 0) and
   * cancels the protocol expectations that relied on it, resolving cases
   * left without reasons. Automation never re-infers a rejected condition.
   */
  reject(
    clinicId: ClinicId,
    patientId: PatientId,
    code: Coding,
    userId: string,
  ): Promise<RejectConditionResult>;
}

export interface ConditionCommandDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

export function createConditionCommands(deps: ConditionCommandDeps): ConditionCommands {
  async function find(
    conditions: readonly PatientCondition[],
    code: Coding,
  ): Promise<PatientCondition> {
    const found = conditions.find((condition) => sameCoding(condition.code, code));
    if (found === undefined) {
      throw new NotFoundError('PatientCondition', codeMatchKey(code));
    }
    return Promise.resolve(found);
  }

  return {
    async confirm(clinicId, patientId, code, userId) {
      if (userId.length === 0) {
        throw new ValidationError('userId', 'A clinician id is required to confirm a condition');
      }
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const existing = await find(
          await stores.conditions.listByPatient(clinicId, patientId),
          code,
        );
        const confirmed: PatientCondition = {
          ...existing,
          status: 'confirmed',
          confidence: 1,
          confirmedBy: userId,
          updatedAt: deps.clock.now(),
        };
        await stores.conditions.upsert(clinicId, confirmed);
        return confirmed;
      });
    },

    async reject(clinicId, patientId, code, userId) {
      if (userId.length === 0) {
        throw new ValidationError('userId', 'A clinician id is required to reject a condition');
      }
      const catalog = await deps.loadCatalog(clinicId);
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const conditions = await stores.conditions.listByPatient(clinicId, patientId);
        const existing = await find(conditions, code);
        const rejected: PatientCondition = {
          ...existing,
          status: 'resolved',
          confidence: 0,
          confirmedBy: userId,
          updatedAt: now,
        };
        await stores.conditions.upsert(clinicId, rejected);
        const remaining = conditions.map((condition) =>
          sameCoding(condition.code, code) ? rejected : condition,
        );
        const stillEnrolled = new Set(
          catalog.protocols
            .filter((protocol) => enrollingConditions(protocol, remaining).length > 0)
            .map((protocol) => protocol.id),
        );
        const state = await loadPatientState(stores, clinicId, patientId);
        const orphaned = state.live
          .list()
          .filter(
            (expectation) =>
              expectation.protocolId !== undefined && !stillEnrolled.has(expectation.protocolId),
          );
        for (const expectation of orphaned) {
          await closeExpectation(stores, expectation, 'cancelled', 'condition_rejected', now);
        }
        const casesResolved = await resolveSatisfiedCases({
          stores,
          writer: new CaseWriter(stores, deps.ids, clinicId),
          clinicId,
          caseIds: orphaned.flatMap((expectation) =>
            expectation.caseId === undefined ? [] : [expectation.caseId],
          ),
          actor: { type: 'user', id: userId },
          now,
        });
        return { condition: rejected, expectationsCancelled: orphaned.length, casesResolved };
      });
    },
  };
}
