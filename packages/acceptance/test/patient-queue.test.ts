import {
  ACTIVE_CASE_STATUSES,
  caseId,
  clinicId,
  type FollowUpCase,
  patientId,
  PatientContactNotAllowedError,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  encounterResource,
  labOrderResource,
  noteResource,
  transactionOf,
} from '../src/bundles.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

/**
 * HIP-141: one card per patient. The engine keeps one case per patient and
 * reason group (escalation, deduplication and audit stay per reason); the
 * inbox reads them grouped by patient (`CaseRepository.listPatients`), acts
 * on each case, and asks the host to contact the patient once for all of
 * them (`requestPatientContactForPatient`), within the per-patient contact
 * window.
 *
 * Day 0: an internal medicine visit whose note asks for a control in one
 * month, with an HbA1c ordered. Day 31: the HbA1c result never came (pending
 * results, due day 15) and the control did not happen (follow-up, due day
 * 30): two cases of one patient.
 */

const USER = { type: 'user', id: 'dra-mora' } as const;
const ACTIVE = ACTIVE_CASE_STATUSES;

function visitWithPlanAndLab(patient: string, at: number): unknown {
  return transactionOf(
    encounterResource({
      id: `enc-${patient}`,
      patientId: patient,
      specialty: 'internal_medicine',
      at: dayToDate(at),
    }),
    noteResource({
      id: `note-${patient}`,
      patientId: patient,
      encounterId: `enc-${patient}`,
      specialty: 'internal_medicine',
      text: 'Paciente estable. Se solicita HbA1c. Control en 1 mes.',
      at: dayToDate(at),
    }),
    labOrderResource({
      id: `sr-${patient}`,
      patientId: patient,
      loinc: '4548-4',
      encounterId: `enc-${patient}`,
      at: dayToDate(at),
    }),
  );
}

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
}

function ids(cases: readonly FollowUpCase[]): string[] {
  return cases.map((item) => item.id);
}

function patientQueue(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string, contact = true): HarnessOptions => ({
    clinicId: clinicId(`clinic-queue-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    settings: { allowPatientContact: contact },
  });

  async function twoCases(harness: EngineHarness, patient: string): Promise<FollowUpCase[]> {
    await day(harness, 0, [visitWithPlanAndLab(patient, 0)]);
    await day(harness, 31);
    const page = await harness.read((stores) =>
      stores.cases.listPatients(harness.clinicId, {
        statuses: ACTIVE,
        releasedAsOf: dayToDate(31),
        limit: 10,
      }),
    );
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item?.patientId).toBe(patient);
    return [...(item?.cases ?? [])];
  }

  it('a patient with two cases is one queue item with both cases, most urgent first', async () => {
    const harness = await makeHarness(options('group'));
    const cases = await twoCases(harness, 'p-two');
    expect(cases).toHaveLength(2);
    expect(new Set(cases.map((item) => item.dedupKey))).toEqual(
      new Set(['p-two:follow_up', 'p-two:pending_results']),
    );
    expect(cases[0]?.priority).toBeGreaterThanOrEqual(cases[1]?.priority ?? 0);
    expect(
      await harness.read((stores) => stores.cases.count(harness.clinicId, { statuses: ACTIVE })),
    ).toEqual({ patients: 1, cases: 2 });
  });

  it('actions stay per case: dismissing one leaves the other on the card', async () => {
    const harness = await makeHarness(options('per-case'));
    const [first, second] = await twoCases(harness, 'p-per-case');
    if (first === undefined || second === undefined) throw new Error('expected two cases');
    await harness.engine.cases.dismiss(harness.clinicId, second.id, USER, {
      reason: 'already_done',
    });
    await harness.engine.cases.snooze(harness.clinicId, first.id, dayToDate(40), USER);
    const page = await harness.read((stores) =>
      stores.cases.listPatients(harness.clinicId, { statuses: ACTIVE, limit: 10 }),
    );
    expect(page.items.map((item) => ids(item.cases))).toEqual([[first.id]]);
    expect(page.items[0]?.cases[0]?.status).toBe('snoozed');
    const audit = await harness.read((stores) =>
      stores.audit.listForCase(harness.clinicId, second.id),
    );
    expect(audit.map((event) => event.type)).toContain('dismissed');
  });

  it('one contact request for the patient, whatever the number of cases, once per window', async () => {
    const harness = await makeHarness(options('contact'));
    const cases = await twoCases(harness, 'p-contact');
    const result = await harness.engine.cases.requestPatientContactForPatient(
      harness.clinicId,
      patientId('p-contact'),
      USER,
      'Llamar por la tarde',
    );
    // One attempt, on the most urgent case; both cases now notified.
    expect(result.primaryCaseId).toBe(cases[0]?.id);
    expect(result.cases.map((item) => item.status)).toEqual(['notified', 'notified']);
    const requests = await harness.read((stores) =>
      stores.contacts.listRequestsForPatient(harness.clinicId, patientId('p-contact')),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ caseId: cases[0]?.id, trigger: 'user', attempt: 1 });
    const contactEvents = (await harness.pendingEvents()).filter(
      (event) => event.type === 'patient_contact.requested',
    );
    expect(contactEvents).toHaveLength(1);
    // The other case's history shows the shared request.
    const otherAudit = await harness.read((stores) =>
      stores.audit.listForCase(harness.clinicId, cases[1]?.id ?? caseId('none')),
    );
    expect(otherAudit.find((event) => event.type === 'patient_contact_requested')).toMatchObject({
      payload: {
        requestId: result.request.id,
        sharedFromCaseId: cases[0]?.id,
        note: 'Llamar por la tarde',
      },
    });
    // The window is per patient: neither the patient nor either case can ask again.
    await expect(
      harness.engine.cases.requestPatientContactForPatient(
        harness.clinicId,
        patientId('p-contact'),
        USER,
      ),
    ).rejects.toMatchObject({ name: 'PatientContactNotAllowedError', reason: 'contact_window' });
    await expect(
      harness.engine.cases.requestPatientContact(
        harness.clinicId,
        cases[1]?.id ?? caseId('none'),
        USER,
      ),
    ).rejects.toBeInstanceOf(PatientContactNotAllowedError);
    // After the window it may ask again.
    harness.clock.set(dayToDate(31 + 15));
    const again = await harness.engine.cases.requestPatientContactForPatient(
      harness.clinicId,
      patientId('p-contact'),
      USER,
    );
    expect(again.request.attempt).toBe(2);
  });

  it('a clinic that does not allow contact refuses the patient request, and nothing changes', async () => {
    const harness = await makeHarness(options('no-contact', false));
    const cases = await twoCases(harness, 'p-no-contact');
    await expect(
      harness.engine.cases.requestPatientContactForPatient(
        harness.clinicId,
        patientId('p-no-contact'),
        USER,
      ),
    ).rejects.toMatchObject({ reason: 'clinic_disallows_contact' });
    const page = await harness.read((stores) =>
      stores.cases.listPatients(harness.clinicId, { statuses: ACTIVE, limit: 10 }),
    );
    expect(page.items[0]?.cases.map((item) => item.status)).toEqual(cases.map(() => 'open'));
    await expect(
      harness.engine.cases.requestPatientContactForPatient(
        harness.clinicId,
        patientId('p-nobody'),
        USER,
      ),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });
}

const TIMEOUT_MS = 30_000;

describe('patient queue: one card per patient (memory)', { timeout: TIMEOUT_MS }, () => {
  patientQueue((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('patient queue: one card per patient'),
  { timeout: TIMEOUT_MS },
  () => {
    const database = useIsolatedDatabase();
    patientQueue((options) => postgresHarness(database(), options));
  },
);
