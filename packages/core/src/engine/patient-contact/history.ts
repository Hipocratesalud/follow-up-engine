import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { listPatientCases } from '../patient-state.ts';

/** Every time the engine asked the host to contact this patient, from any of their cases, oldest first. */
export async function patientContactRequestTimes(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<Date[]> {
  const cases = await listPatientCases(stores, clinicId, patientId);
  const times: Date[] = [];
  for (const followUpCase of cases) {
    const events = await stores.audit.listForCase(clinicId, followUpCase.id);
    for (const event of events) {
      if (event.type === 'patient_contact_requested') times.push(event.at);
    }
  }
  return times.sort((a, b) => a.getTime() - b.getTime());
}

/** The last time the engine asked the host to contact this patient, from any of their cases. */
export async function lastPatientContactAt(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<Date | undefined> {
  return (await patientContactRequestTimes(stores, clinicId, patientId)).at(-1);
}

/** Whether the patient asked not to be followed up. */
export async function hasOptedOut(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<boolean> {
  const events = await stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
    types: ['patient.opted_out'],
  });
  return events.length > 0;
}

/**
 * The patient's preferred language (BCP-47) from the latest
 * `patient.language_recorded` event; `undefined` when the host never stated
 * one or its latest Patient no longer does.
 */
export async function patientLanguage(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<string | undefined> {
  const events = await stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
    types: ['patient.language_recorded'],
  });
  const latest = events.at(-1);
  return latest?.type === 'patient.language_recorded' ? latest.language : undefined;
}
