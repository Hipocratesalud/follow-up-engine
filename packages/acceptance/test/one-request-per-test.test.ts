import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  type ClinicalEvent,
  clinicId,
  type Expectation,
  isActiveCaseStatus,
  patientId,
  type PlanItem,
} from '@follow-up-engine/core';
import { buildConsultationBundle, mapBundleToBatches } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { observationResource, transactionOf } from '../src/bundles.ts';
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
 * Clinical audit 2026-10-27 (internal medicine, diabetology, gynecology):
 * one test is one pending request. A lipid panel in the doctor's plan and
 * the order of the same note opened two cases (pat-0039, pat-0045,
 * pat-0057, pat-0106...); an HbA1c asked for again at every visit for 19
 * months stayed live six times and one late result "fulfilled" them all
 * (pat-0024, pat-0026, pat-0027).
 */

const LOINC = 'http://loinc.org';

function labItem(day: number, code: string, quote: string): PlanItem {
  return {
    kind: 'lab',
    description: quote,
    dueAt: dayToDate(day),
    evidenceQuote: quote,
    confidence: 0.95,
    code: { system: LOINC, code },
  };
}

function extractor(): FakeNoteExtractor {
  return (
    new FakeNoteExtractor()
      // pat-0039: "se solicita creatinina, K+ y perfil lipidico ... cita control en 6 meses",
      // the panel ordered as 57698-3, read from the note as 24331-1.
      .setExtraction('lipids-1-note', {
        planItems: [labItem(-150, '24331-1', 'perfil lipidico')],
      })
      // pat-0027: "pendiente HbA1c" at three visits, then a result.
      .setExtraction('a1c-1-note', { planItems: [labItem(-510, '4548-4', 'se solicita HbA1c')] })
      .setExtraction('a1c-2-note', { planItems: [labItem(-410, '4548-4', 'pendiente HbA1c')] })
      .setExtraction('a1c-3-note', {
        planItems: [labItem(-310, '4548-4', 'pendiente HbA1c, se reitera')],
      })
  );
}

function history(): Record<string, [Date, unknown][]> {
  const visit = (patient: string, id: string, day: number, orders = false): [Date, unknown] => [
    dayToDate(day),
    buildConsultationBundle({
      consultationId: id,
      patient: { id: patient },
      specialty: 'internal_medicine',
      practitionerId: 'prac-im-1',
      occurredAt: dayToDate(day),
      noteText: 'HTA controlada. Plan: misma conducta.',
      diagnoses: [{ icd10: 'I10' }],
      ...(orders ? { orders: [{ loinc: '57698-3', display: 'Perfil lipídico' }] } : {}),
    }),
  ];
  return {
    'p-lipids': [visit('p-lipids', 'lipids-1', -330, true)],
    'p-a1c': [
      visit('p-a1c', 'a1c-1', -600),
      visit('p-a1c', 'a1c-2', -500),
      visit('p-a1c', 'a1c-3', -400),
      [
        dayToDate(-100),
        transactionOf(
          observationResource({
            id: 'a1c-result',
            patientId: 'p-a1c',
            loinc: '4548-4',
            value: 5.4,
            unit: '%',
            at: dayToDate(-100),
          }),
        ),
      ],
    ],
  };
}

function testRequests(expectations: readonly Expectation[], code: RegExp) {
  return expectations
    .filter((e) => code.test(e.matchKey))
    .map((e) => ({ rule: e.ruleId, status: e.status, reason: e.closedReason }))
    .sort((a, b) => `${a.rule}${a.status}`.localeCompare(`${b.rule}${b.status}`));
}

function suite(make: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessFor = (name: string) => {
    sequence += 1;
    return make({
      clinicId: clinicId(`clinic-one-request-${name}-${String(sequence)}`),
      start: BASE_DATE,
      extractor: extractor(),
    });
  };

  async function backfilled(): Promise<EngineHarness> {
    const harness = await harnessFor('backfill');
    for (const [patient, bundles] of Object.entries(history())) {
      const events: ClinicalEvent[] = bundles.flatMap(([instant, bundle]) =>
        mapBundleToBatches(bundle, {
          clinicId: harness.clinicId,
          receivedAt: instant,
        }).batches.flatMap((batch) => batch.events),
      );
      await harness.engine.backfill.stage({
        clinicId: harness.clinicId,
        patientId: patientId(patient),
        receivedAt: dayToDate(0),
        events,
      });
    }
    await harness.engine.backfill.run(harness.clinicId);
    return harness;
  }

  async function lived(): Promise<EngineHarness> {
    const harness = await harnessFor('live');
    for (const bundles of Object.values(history())) {
      for (const [instant, bundle] of bundles) {
        harness.clock.set(instant);
        await ingestBundle(harness, bundle, instant);
        await harness.engine.runWatcher(harness.clinicId, instant);
      }
    }
    harness.clock.set(dayToDate(0));
    await harness.engine.runWatcher(harness.clinicId, dayToDate(0));
    return harness;
  }

  it.each([
    ['backfill', backfilled],
    ['live', lived],
  ] as const)(
    '%s: a lipid panel in the plan and its order are one reason in one case',
    async (_, run) => {
      const harness = await run();
      const snapshot = await snapshotPatient(harness, patientId('p-lipids'));
      expect(testRequests(snapshot.expectations, /^loinc:(24331-1|57698-3)$/)).toEqual([
        { rule: 'doctor_plan_followup', status: 'cancelled', reason: 'covered_by_order' },
        { rule: 'lab_order_result_pending', status: 'expired', reason: undefined },
      ]);
      const lipidCases = snapshot.cases.filter(
        (c) =>
          isActiveCaseStatus(c.status) &&
          (c.ruleIds.includes('lab_order_result_pending') ||
            c.ruleIds.includes('doctor_plan_followup')),
      );
      expect(lipidCases.map((c) => c.ruleIds)).toEqual([['lab_order_result_pending']]);
    },
  );

  it.each([
    ['backfill', backfilled],
    ['live', lived],
  ] as const)(
    '%s: an HbA1c asked for again replaces the earlier request; the result answers the last',
    async (_, run) => {
      const harness = await run();
      const snapshot = await snapshotPatient(harness, patientId('p-a1c'));
      expect(testRequests(snapshot.expectations, /^loinc:4548-4$/)).toEqual([
        { rule: 'doctor_plan_followup', status: 'fulfilled', reason: 'fulfilled_by_result' },
        { rule: 'doctor_plan_followup', status: 'superseded', reason: 'superseded_by_new_request' },
        { rule: 'doctor_plan_followup', status: 'superseded', reason: 'superseded_by_new_request' },
      ]);
    },
  );
}

describe('one test, one pending request (memory)', () => {
  suite((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('one test, one pending request'), () => {
  const database = useIsolatedDatabase();
  suite((options) => postgresHarness(database(), options));
});
