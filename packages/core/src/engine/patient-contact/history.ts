import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { listPatientCases } from '../patient-state.ts';

/** The last time the engine asked the host to contact this patient, from any of their cases. */
export async function lastPatientContactAt(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<Date | undefined> {
  const cases = await listPatientCases(stores, clinicId, patientId);
  let last: Date | undefined;
  for (const followUpCase of cases) {
    const events = await stores.audit.listForCase(clinicId, followUpCase.id);
    for (const event of events) {
      if (
        event.type === 'patient_contact_requested' &&
        (last === undefined || event.at.getTime() > last.getTime())
      ) {
        last = event.at;
      }
    }
  }
  return last;
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
