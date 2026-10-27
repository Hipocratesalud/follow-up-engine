import { randomUUID } from 'node:crypto';
import {
  type CaseEventActor,
  type CaseId,
  type ClinicId,
  type DomainEvent,
  type FollowUpCase,
  InvalidCaseTransitionError,
  isActiveCaseStatus,
  NotFoundError,
  type PatientContactPurpose,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/worker';
import { HttpError } from '../http/errors.ts';

/** Days the host has to reach the patient, as for engine-initiated requests. */
const CONTACT_DUE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

async function contactPurpose(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  followUpCase: FollowUpCase,
): Promise<PatientContactPurpose> {
  const [catalog, expectations] = await Promise.all([
    runtime.engine.catalog(clinicId),
    runtime.storage.readModel.expectationsByIds(
      clinicId,
      followUpCase.reasons.map((reason) => reason.expectationId),
    ),
  ]);
  for (const expectation of expectations) {
    const purpose = catalog.definition(expectation.ruleId)?.suggestedAction.patientContactPurpose;
    if (purpose !== undefined) {
      return purpose;
    }
  }
  return 'schedule_follow_up';
}

/**
 * The inbox's "Pedir contacto": a clinic user asks the host to contact the
 * patient now. Marks an open (or snoozed) case as notified through the
 * engine, then records `patient_contact_requested` in the case's audit trail
 * and emits `patient_contact.requested` to the outbox, in one transaction.
 *
 * Same guarantees as the engine's own requests: only when the clinic allows
 * contact and the patient has not opted out, and the payload carries ids, a
 * generic purpose and a date, never clinical content. Unlike the escalation
 * policy it does not wait 14 days since the last request: a person decided.
 *
 * Lives here because core has no user-initiated contact command yet
 * (proposed: `CaseCommands.requestPatientContact`).
 */
export async function requestPatientContact(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  caseId: CaseId,
  actor: CaseEventActor,
): Promise<FollowUpCase> {
  const current = await runtime.storage.stores.cases.get(clinicId, caseId);
  if (current === undefined) {
    throw new NotFoundError('FollowUpCase', caseId);
  }
  if (!isActiveCaseStatus(current.status)) {
    throw new InvalidCaseTransitionError(caseId, current.status, 'notified');
  }
  const contact = await runtime.engine.patientContactStatus(clinicId, current.patientId);
  if (!contact.allowed) {
    throw new HttpError(
      409,
      'patient_contact_not_allowed',
      contact.optedOut
        ? 'El paciente pidió no recibir mensajes del consultorio. Contáctalo por otra vía y luego resuelve el caso.'
        : 'El consultorio no tiene activado el contacto con pacientes.',
    );
  }
  const notified =
    current.status === 'open' || current.status === 'snoozed'
      ? await runtime.engine.cases.notify(clinicId, caseId, actor)
      : current;
  const purpose = await contactPurpose(runtime, clinicId, notified);
  const now = runtime.clock.now();
  const event: DomainEvent = {
    id: randomUUID(),
    type: 'patient_contact.requested',
    clinicId,
    occurredAt: now,
    payload: {
      caseId,
      patientId: notified.patientId,
      purpose,
      dueBy: new Date(now.getTime() + CONTACT_DUE_DAYS * MS_PER_DAY),
    },
  };
  await runtime.storage.unitOfWork.withTransaction(clinicId, async (stores) => {
    await stores.audit.append(clinicId, {
      clinicId,
      caseId,
      type: 'patient_contact_requested',
      actor,
      payload: { purpose, requestedBy: 'user' },
      at: now,
    });
    await stores.outbox.add(clinicId, event);
  });
  return notified;
}
