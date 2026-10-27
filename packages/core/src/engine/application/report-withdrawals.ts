import type { ClinicalEvent, RecordWithdrawnEvent } from '../../domain/clinical-event.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { refKey } from '../timeline.ts';

function isReportWithdrawal(event: ClinicalEvent): event is RecordWithdrawnEvent {
  return event.type === 'record.withdrawn' && event.source.resourceType === 'DiagnosticReport';
}

/**
 * A report withdrawn as a whole (entered in error, cancelled) withdraws the
 * results it listed when it arrived, even when the host re-sends it without
 * its `result` list: one `record.withdrawn` per listed result the batch does
 * not withdraw already, dated and keyed after the report's withdrawal (the
 * FHIR mapping does the same when the list comes along). The lists are read
 * from the batch and from the stored `result.received` of each report.
 */
export async function withListedResultWithdrawals(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
  events: readonly ClinicalEvent[],
): Promise<ClinicalEvent[]> {
  const reports = events.filter(isReportWithdrawal);
  if (reports.length === 0) {
    return [...events];
  }
  const stored = await stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
    types: ['result.received'],
  });
  const listed = new Map<string, Map<string, ClinicalEvent['source']>>();
  for (const event of [...stored, ...events]) {
    if (event.type !== 'result.received' || event.listedResults === undefined) {
      continue;
    }
    const members = listed.get(refKey(event.source)) ?? new Map<string, ClinicalEvent['source']>();
    for (const member of event.listedResults) {
      members.set(refKey(member), member);
    }
    listed.set(refKey(event.source), members);
  }
  const withdrawn = new Set(
    events.flatMap((event) => (event.type === 'record.withdrawn' ? [refKey(event.source)] : [])),
  );
  const added: RecordWithdrawnEvent[] = [];
  for (const report of reports) {
    for (const [key, member] of listed.get(refKey(report.source)) ?? []) {
      if (withdrawn.has(key)) {
        continue;
      }
      withdrawn.add(key);
      added.push({
        ...report,
        source: member,
        idempotencyKey: `${report.idempotencyKey}:${key}`,
      });
    }
  }
  return [...events, ...added];
}
