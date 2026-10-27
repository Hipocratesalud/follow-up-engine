import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type FollowUpCase, isActiveCaseStatus, patientId } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { appointmentBundle, optOutBundle } from '../src/bundles.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';
import { snapshotPatient } from '../src/scenario-runner.ts';

const PATIENT = 'pat-behaviors';
const patient = patientId(PATIENT);

/** Day 0: postpartum consultation whose plan asks for a control in 6 weeks (due day 42). */
function postpartumPlan(): FakeNoteExtractor {
  return new FakeNoteExtractor().setExtraction('postpartum-0-note', {
    hasPlan: true,
    planItems: [
      {
        kind: 'follow_up_visit',
        description: 'postpartum control',
        dueAt: dayToDate(42),
        evidenceQuote: 'control puerperal en 6 semanas',
        confidence: 0.95,
      },
    ],
  });
}

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
  await harness.engine.runEscalation(harness.clinicId, now);
}

function consultation(at: number, input: { orders?: boolean } = {}) {
  return buildConsultationBundle({
    consultationId: `postpartum-${String(at)}`,
    patient: { id: PATIENT, name: 'Paciente Sintética' },
    specialty: 'gynecology',
    occurredAt: dayToDate(at),
    noteText: 'Puérpera sin complicaciones. Plan: control puerperal en 6 semanas.',
    ...(input.orders === true ? { orders: [{ loinc: '718-7', display: 'Hemoglobina' }] } : {}),
  });
}

function booking(id: string, bookedDay: number, startDay: number, cancelledDay?: number) {
  return appointmentBundle({
    id,
    patientId: PATIENT,
    specialty: 'gynecology',
    start: dayToDate(startDay),
    bookedAt: dayToDate(bookedDay),
    ...(cancelledDay === undefined ? {} : { cancelledAt: dayToDate(cancelledDay) }),
  });
}

function active<TCase extends FollowUpCase>(cases: readonly TCase[]): TCase[] {
  return cases.filter((c) => isActiveCaseStatus(c.status));
}

function behaviors(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string, extractor: FakeNoteExtractor): HarnessOptions => ({
    clinicId: clinicId(`clinic-behaviors-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor,
    settings: { allowPatientContact: true },
  });

  it('a cancelled appointment reopens the plan it fulfilled; the case opens on time', async () => {
    const harness = await makeHarness(options('cancel-before-due', postpartumPlan()));
    // The note id is derived from the consultation id by the builder.
    await day(harness, 0, [consultation(0)]);
    await day(harness, 30, [booking('appt-1', 30, 40)]);
    let snapshot = await snapshotPatient(harness, patient);
    expect(snapshot.expectations.find((e) => e.ruleId === 'doctor_plan_followup')).toMatchObject({
      status: 'fulfilled',
      closedBy: { resourceType: 'Appointment', id: 'appt-1' },
    });
    await day(harness, 35, [booking('appt-1', 30, 40, 35)]);
    snapshot = await snapshotPatient(harness, patient);
    expect(snapshot.expectations.find((e) => e.ruleId === 'doctor_plan_followup')?.status).toBe(
      'open',
    );
    await day(harness, 43);
    snapshot = await snapshotPatient(harness, patient);
    expect(active(snapshot.cases).map((c) => c.ruleIds)).toEqual([['doctor_plan_followup']]);
  });

  it('cancelling the booking that resolved a case opens a new case for the reopened plan', async () => {
    const harness = await makeHarness(options('cancel-after-case', postpartumPlan()));
    await day(harness, 0, [consultation(0)]);
    await day(harness, 43);
    await day(harness, 45, [booking('appt-2', 45, 50)]);
    let snapshot = await snapshotPatient(harness, patient);
    expect(active(snapshot.cases)).toEqual([]);
    expect(snapshot.cases.map((c) => c.resolution?.kind)).toEqual(['fulfilled']);
    await day(harness, 47, [booking('appt-2', 45, 50, 47)]);
    snapshot = await snapshotPatient(harness, patient);
    expect(active(snapshot.cases).map((c) => c.ruleIds)).toEqual([['doctor_plan_followup']]);
  });

  it('a cancellation reopens nothing that a visit already fulfilled', async () => {
    const harness = await makeHarness(options('cancel-after-visit', postpartumPlan()));
    await day(harness, 0, [consultation(0)]);
    await day(harness, 30, [booking('appt-3', 30, 45)]);
    await day(harness, 38, [consultation(38)]);
    await day(harness, 40, [booking('appt-3', 30, 45, 40)]);
    await day(harness, 60);
    const snapshot = await snapshotPatient(harness, patient);
    const plans = snapshot.expectations.filter(
      (e) => e.ruleId === 'doctor_plan_followup' && e.source.id === 'postpartum-0-note',
    );
    expect(plans.map((e) => e.status)).toEqual(['fulfilled']);
  });

  it('an opt-out stops patient contact only: the case opens and escalates to the coordinator', async () => {
    const harness = await makeHarness(options('opt-out', new FakeNoteExtractor()));
    await day(harness, 0, [consultation(0, { orders: true })]);
    await day(harness, 5, [
      optOutBundle({ id: 'consent-1', patientId: PATIENT, at: dayToDate(5) }),
    ]);
    for (let n = 6; n <= 40; n += 1) await day(harness, n);
    const snapshot = await snapshotPatient(harness, patient);
    const [labCase] = active(snapshot.cases).filter((c) =>
      c.ruleIds.includes('lab_order_result_pending'),
    );
    expect(labCase).toMatchObject({ status: 'escalated', assignee: 'coordinator' });
    const events = await harness.pendingEvents();
    expect(events.filter((event) => event.type === 'patient_contact.requested')).toEqual([]);
    expect(events.some((event) => event.type === 'case.escalated')).toBe(true);
    expect(await harness.engine.patientContactStatus(harness.clinicId, patient)).toMatchObject({
      allowed: false,
      optedOut: true,
    });
  });
}

describe('engine behaviors through FHIR (memory)', () => {
  behaviors((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('engine behaviors through FHIR'), () => {
  const database = useIsolatedDatabase();
  behaviors((options) => postgresHarness(database(), options));
});
