import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  type ClinicalEvent,
  clinicId,
  type Expectation,
  isActiveCaseStatus,
  patientId,
} from '@follow-up-engine/core';
import {
  buildConsultationBundle,
  type ConsultationInput,
  mapBundleToBatches,
} from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
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
 * Clinical audit 2026-10-27, internal medicine (and gynecology): what an
 * acute episode of 2024 asked for (a blood count for a cold, the control
 * of a sore throat, the end of a 14-day omeprazole course) must not become
 * a case when the clinic is switched on in 2026, and a discharge ends what
 * the episode still asked for. Chronic care keeps its old gaps.
 */

type Visit = Omit<ConsultationInput, 'patient' | 'occurredAt' | 'specialty'> & {
  readonly day: number;
  readonly specialty?: string;
};

function bundles(patient: string, visits: readonly Visit[]): [Date, unknown][] {
  return visits.map(({ day, specialty, ...visit }) => [
    dayToDate(day),
    buildConsultationBundle({
      ...visit,
      patient: { id: patient },
      specialty: specialty ?? 'internal_medicine',
      practitionerId: 'prac-im-1',
      occurredAt: dayToDate(day),
    }),
  ]);
}

const HISTORIES: Record<string, readonly Visit[]> = {
  // pat-0056: a cold, a blood count never done, discharged four days later.
  cold: [
    {
      day: -650,
      consultationId: 'cold-1',
      noteText: 'Rinorrea y odinofagia. Dx: IRA alta. Tto: azitromicina 500 mg x 3 días.',
      diagnoses: [{ icd10: 'J06.9' }],
      prescriptions: [{ text: 'Azitromicina 500 mg', durationDays: 3 }],
      orders: [{ loinc: '58410-2', display: 'Hematología completa' }],
    },
    {
      day: -646,
      consultationId: 'cold-2',
      noteText: 'Completó tratamiento. Asintomático. Se da de alta.',
    },
  ],
  // pat-0058: a sore throat whose 10-day control never happened.
  throat: [
    {
      day: -540,
      consultationId: 'throat-1',
      noteText:
        'Faringoamigdalitis. Plan: amoxicilina 500 mg c/8h x 7 días. Cita control en 10 días.',
      diagnoses: [{ icd10: 'J02.9' }],
      prescriptions: [{ text: 'Amoxicilina 500 mg', durationDays: 7 }],
    },
  ],
  // pat-0055: a 14-day omeprazole course, no control asked for.
  gastritis: [
    {
      day: -650,
      consultationId: 'gastritis-1',
      noteText: 'Epigastralgia. Dx: gastritis. Tto: omeprazol 20 mg en ayunas x 14 dias.',
      diagnoses: [{ icd10: 'K29.7' }],
      prescriptions: [{ text: 'Omeprazol 20 mg', durationDays: 14 }],
    },
  ],
  // pat-0097: a routine control whose 1-month results visit never happened.
  routine: [
    {
      day: -450,
      specialty: 'gynecology',
      consultationId: 'routine-1',
      noteText: 'Control ginecológico de rutina. Se solicita citología. Próximo control en 1 mes.',
      diagnoses: [{ icd10: 'Z01.4' }],
    },
  ],
  // pat-0050: uncontrolled hypertension, a 2-month control lost 20 months ago: still a gap.
  chronic: [
    {
      day: -600,
      consultationId: 'chronic-1',
      noteText: 'HTA no controlada, se ajusta tto. Volver a consulta en 2 meses.',
      diagnoses: [{ icd10: 'I10' }],
      prescriptions: [{ text: 'Losartán 50 mg' }],
    },
  ],
  // A yearly gynecology control missed long ago: not a short control, still a gap.
  yearly: [
    {
      day: -800,
      specialty: 'gynecology',
      consultationId: 'yearly-1',
      noteText: 'Control ginecológico de rutina. Control en 1 año.',
      diagnoses: [{ icd10: 'Z01.4' }],
    },
  ],
  // An acute control missed last week: a real, fresh gap.
  fresh: [
    {
      day: -20,
      consultationId: 'fresh-1',
      noteText: 'Faringoamigdalitis. Plan: amoxicilina 500 mg x 7 días. Cita control en 10 días.',
      diagnoses: [{ icd10: 'J02.9' }],
      prescriptions: [{ text: 'Amoxicilina 500 mg', durationDays: 7 }],
    },
  ],
};

interface PatientView {
  readonly activeCaseRules: readonly string[];
  readonly closed: readonly { readonly ruleId: string; readonly reason: string | undefined }[];
}

async function viewOf(harness: EngineHarness, patient: string): Promise<PatientView> {
  const snapshot = await snapshotPatient(harness, patientId(patient));
  return {
    activeCaseRules: snapshot.cases
      .filter((c) => isActiveCaseStatus(c.status))
      .flatMap((c) => c.ruleIds)
      .sort(),
    closed: snapshot.expectations
      .filter((e: Expectation) => e.status === 'cancelled')
      .map((e) => ({ ruleId: e.ruleId, reason: e.closedReason }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
  };
}

function suite(make: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessFor = (name: string) => {
    sequence += 1;
    return make({
      clinicId: clinicId(`clinic-relevance-${name}-${String(sequence)}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
    });
  };

  async function backfilled(): Promise<EngineHarness> {
    const harness = await harnessFor('backfill');
    for (const [name, visits] of Object.entries(HISTORIES)) {
      const events: ClinicalEvent[] = [];
      for (const [instant, bundle] of bundles(`p-${name}`, visits)) {
        events.push(
          ...mapBundleToBatches(bundle, {
            clinicId: harness.clinicId,
            receivedAt: instant,
          }).batches.flatMap((batch) => batch.events),
        );
      }
      await harness.engine.backfill.stage({
        clinicId: harness.clinicId,
        patientId: patientId(`p-${name}`),
        receivedAt: dayToDate(0),
        events,
      });
    }
    await harness.engine.backfill.run(harness.clinicId);
    return harness;
  }

  it('the backfill opens no case for what an acute episode asked for long ago', async () => {
    const harness = await backfilled();
    // A discharge ends the episode: the blood count it asked for is closed.
    expect(await viewOf(harness, 'p-cold')).toEqual({
      activeCaseRules: [],
      closed: [{ ruleId: 'lab_order_result_pending', reason: 'episode_closed' }],
    });
    // The control of a sore throat of 2024, and a 14-day course's end.
    expect(await viewOf(harness, 'p-throat')).toMatchObject({
      activeCaseRules: [],
      closed: expect.arrayContaining([
        { ruleId: 'doctor_plan_followup', reason: 'past_relevance_horizon' },
      ]) as unknown,
    });
    expect(await viewOf(harness, 'p-gastritis')).toEqual({
      activeCaseRules: [],
      closed: [{ ruleId: 'short_treatment_followup', reason: 'past_relevance_horizon' }],
    });
    // A routine visit's 1-month control, 15 months later.
    expect(await viewOf(harness, 'p-routine')).toEqual({
      activeCaseRules: [],
      closed: [{ ruleId: 'doctor_plan_followup', reason: 'past_relevance_horizon' }],
    });
  });

  it('chronic care, yearly controls and fresh gaps still open their case', async () => {
    const harness = await backfilled();
    for (const name of ['chronic', 'yearly', 'fresh']) {
      const view = await viewOf(harness, `p-${name}`);
      expect(view.activeCaseRules, name).toContain('doctor_plan_followup');
      expect(
        view.closed.map((closed) => closed.reason),
        name,
      ).not.toContain('past_relevance_horizon');
    }
  });

  it('live, a discharge closes the lab the episode ordered before it was due', async () => {
    const harness = await harnessFor('live');
    for (const [instant, bundle] of bundles('p-cold', HISTORIES['cold'] ?? [])) {
      harness.clock.set(instant);
      await ingestBundle(harness, bundle, instant);
      await harness.engine.runWatcher(harness.clinicId, instant);
    }
    harness.clock.set(dayToDate(-600));
    await harness.engine.runWatcher(harness.clinicId, dayToDate(-600));
    expect(await viewOf(harness, 'p-cold')).toEqual({
      activeCaseRules: [],
      closed: [{ ruleId: 'lab_order_result_pending', reason: 'episode_closed' }],
    });
  });
}

describe('clinical relevance of old episodes (memory)', () => {
  suite((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('clinical relevance of old episodes'), () => {
  const database = useIsolatedDatabase();
  suite((options) => postgresHarness(database(), options));
});
