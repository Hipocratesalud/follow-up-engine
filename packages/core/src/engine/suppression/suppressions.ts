import type { CaseEventActor } from '../../domain/case.ts';
import type { DismissReason, RuleSuppression } from '../../domain/contact.ts';
import type { Reason } from '../../domain/common.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { Expectation } from '../../domain/expectation.ts';
import {
  type CaseId,
  type ClinicId,
  type PatientId,
  type SuppressionId,
  suppressionId,
} from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { Clock } from '../../ports/clock.ts';
import { annotate } from '../annotator/annotate.ts';
import { currentFulfillment, recheckAtFor } from '../annotator/recheck.ts';
import { fulfillmentReason, toCorrelationTarget } from '../matching/correlation.ts';
import { PatientTimeline } from '../timeline.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, reopened, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import type { EngineSettings } from '../settings.ts';
import { SUPPRESSED_FOR_PATIENT } from './active.ts';

export { SUPPRESSED_FOR_PATIENT, suppressedRuleIds } from './active.ts';

export interface SuppressInput {
  readonly patientId: PatientId;
  readonly ruleId: string;
  readonly reason: Reason;
  readonly dismissReason: DismissReason;
  readonly note?: string;
  readonly caseId?: CaseId;
  readonly actor: CaseEventActor;
  readonly now: Date;
}

/**
 * Suppresses a rule for a patient, inside the caller's transaction: records
 * the suppression (reusing an active one) and withdraws the patient's live
 * expectations of that rule (`cancelled`, `suppressed_for_patient`),
 * resolving any case left without an open reason.
 */
export async function suppressRule(
  context: {
    readonly stores: TransactionalStores;
    readonly ids: IdGenerator;
    readonly clinicId: ClinicId;
  },
  input: SuppressInput,
): Promise<RuleSuppression> {
  const { stores, ids, clinicId } = context;
  const existing = (
    await stores.suppressions.listForPatient(clinicId, input.patientId, { activeOnly: true })
  ).find((suppression) => suppression.ruleId === input.ruleId);
  if (existing !== undefined) {
    return existing;
  }
  const suppression: RuleSuppression = {
    id: suppressionId(ids.next('suppression')),
    clinicId,
    patientId: input.patientId,
    ruleId: input.ruleId,
    reason: input.reason,
    dismissReason: input.dismissReason,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
    ...(input.actor.type === 'user' && input.actor.id !== undefined
      ? { createdBy: input.actor.id }
      : {}),
    createdAt: input.now,
  };
  await stores.suppressions.create(clinicId, suppression);
  const live = (
    await stores.expectations.listByPatient(clinicId, input.patientId, ['open', 'expired'])
  ).filter((expectation) => expectation.ruleId === input.ruleId);
  const touchedCases: CaseId[] = [];
  for (const expectation of live) {
    const closed: Expectation = await closeExpectation(
      stores,
      expectation,
      'cancelled',
      SUPPRESSED_FOR_PATIENT,
      input.now,
    );
    if (closed.caseId !== undefined) {
      touchedCases.push(closed.caseId);
    }
  }
  await resolveSatisfiedCases({
    stores,
    writer: new CaseWriter(stores, ids, clinicId),
    clinicId,
    caseIds: touchedCases,
    actor: input.actor,
    now: input.now,
  });
  return suppression;
}

export interface SuppressionCommandDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly settings: EngineSettings;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

/** Per-patient suppressions of rules ("Recordatorios desactivados" on the patient page). */
export interface SuppressionCommands {
  /**
   * Stops a rule or protocol item for one patient. `ValidationError` for a
   * rule the clinic does not have; reuses an active suppression.
   */
  suppress(
    clinicId: ClinicId,
    input: {
      readonly patientId: PatientId;
      readonly ruleId: string;
      readonly dismissReason?: DismissReason;
      readonly note?: string;
      readonly actor: CaseEventActor;
    },
  ): Promise<RuleSuppression>;
  /**
   * "Volver a activar": revokes the suppression (kept as history), opens
   * again the expectations it withdrew and lets the protocols fill the
   * patient's gaps right away; a rule fires again on its next trigger. `NotFoundError` for an unknown or already
   * revoked suppression.
   */
  reactivate(
    clinicId: ClinicId,
    id: SuppressionId,
    actor: CaseEventActor,
  ): Promise<RuleSuppression>;
  list(
    clinicId: ClinicId,
    patientId: PatientId,
    options?: { readonly activeOnly?: boolean },
  ): Promise<readonly RuleSuppression[]>;
}

export function createSuppressionCommands(deps: SuppressionCommandDeps): SuppressionCommands {
  return {
    async suppress(clinicId, input) {
      const catalog = await deps.loadCatalog(clinicId);
      const definition = catalog.definition(input.ruleId);
      if (definition === undefined) {
        throw new ValidationError('ruleId', `Unknown rule ${input.ruleId}`);
      }
      return deps.unitOfWork.withTransaction(clinicId, (stores) =>
        suppressRule(
          { stores, ids: deps.ids, clinicId },
          {
            patientId: input.patientId,
            ruleId: input.ruleId,
            reason: definition.reason,
            dismissReason: input.dismissReason ?? 'not_applicable_to_patient',
            ...(input.note === undefined ? {} : { note: input.note }),
            actor: input.actor,
            now: deps.clock.now(),
          },
        ),
      );
    },
    async reactivate(clinicId, id, actor) {
      const catalog = await deps.loadCatalog(clinicId);
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const revoked = await stores.suppressions.revoke(clinicId, id, {
          revokedAt: now,
          ...(actor.id === undefined ? {} : { revokedBy: actor.id }),
        });
        if (revoked === undefined) {
          throw new NotFoundError('RuleSuppression', id);
        }
        // What the suppression withdrew is expected again (the watcher opens
        // a case for what is already due).
        const withdrawn = (
          await stores.expectations.listByPatient(clinicId, revoked.patientId, ['cancelled'])
        ).filter(
          (expectation) =>
            expectation.ruleId === revoked.ruleId &&
            expectation.closedReason === SUPPRESSED_FOR_PATIENT &&
            (expectation.closedAt?.getTime() ?? 0) >= revoked.createdAt.getTime(),
        );
        // What happened meanwhile counts: a test done while the rule was
        // suppressed fulfills the reminder instead of reopening it stale.
        const timeline = new PatientTimeline(
          await stores.clinicalRecords.listEventsForPatient(clinicId, revoked.patientId),
        );
        const graceDays = deps.settings.bookingVisitGraceDays;
        for (const expectation of withdrawn) {
          const open = reopened(expectation, now);
          const definition = catalog.definition(expectation.ruleId);
          const event =
            definition === undefined
              ? undefined
              : currentFulfillment(
                  toCorrelationTarget(open, definition, timeline, {
                    now,
                    bookingGraceDays: graceDays,
                  }),
                  timeline,
                );
          if (event === undefined) {
            await stores.expectations.update(clinicId, open);
          } else {
            await closeExpectation(
              stores,
              open,
              'fulfilled',
              fulfillmentReason(event),
              now,
              event.source,
              recheckAtFor(event, graceDays),
            );
          }
        }
        // Protocol items are gaps the engine fills from the record: drafted
        // again now, instead of waiting for the patient's next consultation.
        await annotate(
          {
            clinicId,
            patientId: revoked.patientId,
            stores,
            catalog,
            ids: deps.ids,
            settings: deps.settings,
            now,
          },
          [],
        );
        return revoked;
      });
    },
    list: (clinicId, patientId, options) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.suppressions.listForPatient(clinicId, patientId, options),
      ),
  };
}
