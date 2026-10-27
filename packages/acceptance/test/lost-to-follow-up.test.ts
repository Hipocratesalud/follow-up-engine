import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type FollowUpCase, patientId } from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  labOrderResource,
  observationResource,
  optOutBundle,
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
import { snapshotPatient } from '../src/scenario-runner.ts';

/**
 * HIP-117: a case is lost to follow-up only when the patient was actually
 * asked to come back and did not answer. When nobody contacted the patient
 * (the clinic does not allow it, the patient opted out, the case rests on a
 * probable condition, the case comes from the backfill), the case stays with
 * the coordinator until someone resolves or dismisses it.
 */

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
  await harness.engine.runEscalation(harness.clinicId, now);
}

async function days(harness: EngineHarness, from: number, to: number) {
  for (let n = from; n <= to; n += 1) {
    await day(harness, n);
  }
}

function labOrder(patient: string, at: number): unknown {
  return transactionOf(
    labOrderResource({
      id: `sr-${patient}`,
      patientId: patient,
      loinc: '2160-0',
      at: dayToDate(at),
    }),
  );
}

async function casesOf(harness: EngineHarness, patient: string): Promise<FollowUpCase[]> {
  return [...(await snapshotPatient(harness, patientId(patient))).cases];
}

async function resolutions(harness: EngineHarness): Promise<string[]> {
  return (await harness.pendingEvents()).flatMap((event) =>
    event.type === 'case.resolved' ? [event.payload.resolution] : [],
  );
}

function lostToFollowUp(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string, allowPatientContact: boolean): HarnessOptions => ({
    clinicId: clinicId(`clinic-lost-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
    settings: { allowPatientContact },
  });

  it('a clinic that never contacts patients keeps the case with the coordinator', async () => {
    const harness = await makeHarness(options('no-contact', false));
    await day(harness, 0, [labOrder('p-no-contact', 0)]);
    await days(harness, 1, 90);
    expect(await casesOf(harness, 'p-no-contact')).toMatchObject([
      { status: 'escalated', assignee: 'coordinator' },
    ]);
    expect(await resolutions(harness)).toEqual([]);
  });

  it('an opted-out patient is never declared lost; the case stays with the coordinator', async () => {
    const harness = await makeHarness(options('opt-out', true));
    await day(harness, 0, [
      labOrder('p-opt-out', 0),
      optOutBundle({ id: 'consent-opt-out', patientId: 'p-opt-out', at: dayToDate(0) }),
    ]);
    await days(harness, 1, 90);
    expect(await casesOf(harness, 'p-opt-out')).toMatchObject([
      { status: 'escalated', assignee: 'coordinator' },
    ]);
    expect(await resolutions(harness)).toEqual([]);
  });

  it('a case resting on a probable condition is never declared lost', async () => {
    const harness = await makeHarness(options('probable', true));
    // HbA1c 6.7 without a diagnosis: probable diabetes, protocol reminders only.
    await day(harness, 0, [
      transactionOf(
        observationResource({
          id: 'obs-probable',
          patientId: 'p-probable',
          loinc: '4548-4',
          value: 6.7,
          unit: '%',
          at: dayToDate(0),
        }),
      ),
    ]);
    await days(harness, 1, 200);
    const cases = await casesOf(harness, 'p-probable');
    expect(cases.filter((c) => c.status === 'lost_to_follow_up')).toEqual([]);
    expect(await resolutions(harness)).not.toContain('patient_unreachable');
  });

  it('after a contact request that got no answer, the case is lost (patient unreachable)', async () => {
    const harness = await makeHarness(options('contacted', true));
    await day(harness, 0, [labOrder('p-contacted', 0)]);
    await days(harness, 1, 60);
    expect(await casesOf(harness, 'p-contacted')).toMatchObject([
      { status: 'lost_to_follow_up', resolution: { kind: 'patient_unreachable' } },
    ]);
    const events = await harness.pendingEvents();
    expect(events.filter((event) => event.type === 'patient_contact.requested')).toHaveLength(1);
    expect(await resolutions(harness)).toEqual(['patient_unreachable']);
  });

  it('contacted, then the patient opted out: the case closes as patient declined', async () => {
    const harness = await makeHarness(options('declined', true));
    await day(harness, 0, [labOrder('p-declined', 0)]);
    await days(harness, 1, 35);
    await day(harness, 36, [
      optOutBundle({ id: 'consent-declined', patientId: 'p-declined', at: dayToDate(36) }),
    ]);
    await days(harness, 37, 60);
    expect(await casesOf(harness, 'p-declined')).toMatchObject([
      { status: 'lost_to_follow_up', resolution: { kind: 'patient_declined' } },
    ]);
    expect(await resolutions(harness)).toEqual(['patient_declined']);
  });

  it('a backfill case, never contacted automatically, is never declared lost', async () => {
    const harness = await makeHarness(options('backfill', true));
    const history = mapBundleToBatches(labOrder('p-backfill', -40), {
      clinicId: harness.clinicId,
      receivedAt: dayToDate(-40),
    });
    for (const batch of history.batches) {
      await harness.engine.backfill.stage(batch);
    }
    await harness.engine.backfill.run(harness.clinicId);
    await days(harness, 0, 90);
    expect(await casesOf(harness, 'p-backfill')).toMatchObject([
      { status: 'escalated', origin: 'backfill', assignee: 'coordinator' },
    ]);
    expect(await resolutions(harness)).toEqual([]);
  });
}

describe('lost to follow-up (memory)', () => {
  lostToFollowUp((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('lost to follow-up'), () => {
  const database = useIsolatedDatabase();
  lostToFollowUp((options) => postgresHarness(database(), options));
});
