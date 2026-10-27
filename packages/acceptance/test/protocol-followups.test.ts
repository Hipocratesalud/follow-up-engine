import { FakeNoteExtractor, loadConfigDirectory } from '@follow-up-engine/adapter-memory';
import { clinicId, type Expectation, patientId } from '@follow-up-engine/core';
import {
  BASE_DATE,
  loadReviewerCohort,
  loadSyntheticClinic,
  type SyntheticPatient,
} from '@follow-up-engine/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readClinicState, stageHistory } from '../src/clinic.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

/*
 * HIP-139: protocol noise found when the feature wave was merged, replayed
 * on the synthetic clinic's own patients through the initial backfill (the
 * way the demo clinic is switched on, every protocol enabled):
 *
 * - psychotherapy patients with a coded F32/F41 and no medication (a
 *   discharge, a dropout) are not in the treatment follow-up protocol: a
 *   diagnosis alone does not enroll, and a discharge closes it;
 * - a drug already in course the first time the record sees the patient is
 *   not a start ("en tto con atorvastatina"), while "se inicia" still is.
 */

const TIMEOUT = 300_000;
const ALL_PROTOCOLS = loadConfigDirectory().protocols.map((protocol) => protocol.id);

const TREATMENT_VISIT = 'protocol_treatment_followup_visit';
const LIPIDS = 'protocol_dyslipidemia_lipids';
const TSH = 'protocol_hypothyroidism_tsh';

/** Psychotherapy only (F32/F41 coded, never a prescription): discharged, or dropped out. */
const PSYCHOTHERAPY_ONLY = [
  'pat-0067',
  'pat-0069',
  'pat-0071',
  'pat-0074',
  'pat-0076',
  'pat-0077',
  'pat-0091',
];
/** An antidepressant started by the internist ("Se inicia sertralina"), some with a dose change. */
const ON_ANTIDEPRESSANT = ['pat-0131', 'pat-0132', 'pat-0133', 'pat-0134', 'pat-0135'];
/** A drug in course at the first visit ("en tto con ..."): its first prescription anchors nothing. */
const ALREADY_ON_TREATMENT: readonly (readonly [string, string, string])[] = [
  ['pat-0015', 'pat-0015-mr02', LIPIDS],
  ['pat-0020', 'pat-0020-mr02', LIPIDS],
  ['pat-0139', 'pat-0139-mr01', TSH],
  ['pat-0137', 'pat-0137-mr01', TSH],
  ['rev-0007', 'rev-0007-mr03', TSH],
];
/** Started at the first visit ("Se inicia atorvastatina", "Se inicia levotiroxina"): a start. */
const REAL_STARTS: readonly (readonly [string, string, string])[] = [
  ['pat-0136', 'pat-0136-mr01', TSH],
  ['pat-0140', 'pat-0140-mr01', LIPIDS],
  ['pat-0141', 'pat-0141-mr01', LIPIDS],
  ['pat-0142', 'pat-0142-mr01', LIPIDS],
];

const WANTED = new Set([
  ...PSYCHOTHERAPY_ONLY,
  ...ON_ANTIDEPRESSANT,
  ...ALREADY_ON_TREATMENT.map(([id]) => id),
  ...REAL_STARTS.map(([id]) => id),
]);
const PATIENTS: SyntheticPatient[] = [
  ...loadSyntheticClinic().patients,
  ...(loadReviewerCohort().patients as unknown as SyntheticPatient[]),
].filter((patient) => WANTED.has(patient.patientId));

let sequence = 0;

function followUpsSuite(make: (options: HarnessOptions) => Promise<EngineHarness>): void {
  let expectations: readonly Expectation[] = [];

  beforeAll(async () => {
    sequence += 1;
    const harness = await make({
      clinicId: clinicId(`clinic-hip139-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
      settings: { enabledProtocols: ALL_PROTOCOLS },
    });
    await stageHistory(harness, PATIENTS);
    const report = await harness.engine.backfill.run(harness.clinicId);
    expect(report.progress.status).toBe('completed');
    expectations = (
      await readClinicState(
        harness,
        PATIENTS.map((patient) => patientId(patient.patientId)),
      )
    ).expectations;
  }, TIMEOUT);

  const of = (patient: string, ruleId: string): Expectation[] =>
    expectations.filter(
      (expectation) => expectation.patientId === patient && expectation.ruleId === ruleId,
    );

  it('found every named patient in the fixtures', () => {
    expect(PATIENTS.map((patient) => patient.patientId).sort()).toEqual([...WANTED].sort());
  });

  it('a diagnosis alone (psychotherapy, a discharge, a dropout) never enrolls in treatment follow-up', () => {
    for (const patient of PSYCHOTHERAPY_ONLY) {
      expect(of(patient, TREATMENT_VISIT), patient).toEqual([]);
    }
  });

  it('a patient on an antidepressant stays in treatment follow-up', () => {
    for (const patient of ON_ANTIDEPRESSANT) {
      expect(of(patient, TREATMENT_VISIT).length, patient).toBeGreaterThan(0);
    }
  });

  it('a drug in course at the first visit is not a start: its first prescription anchors nothing', () => {
    for (const [patient, prescription, ruleId] of ALREADY_ON_TREATMENT) {
      const anchored = of(patient, ruleId).filter(
        (expectation) => expectation.source.id === prescription,
      );
      expect(anchored, `${patient} ${ruleId}`).toEqual([]);
    }
  });

  it('a drug the note starts ("se inicia") is still a start', () => {
    for (const [patient, prescription, ruleId] of REAL_STARTS) {
      const anchored = of(patient, ruleId).filter(
        (expectation) => expectation.source.id === prescription,
      );
      expect(anchored.length, `${patient} ${ruleId}`).toBe(1);
    }
  });
}

describe('protocol follow-ups on the synthetic clinic, HIP-139 (memory)', () => {
  followUpsSuite((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('protocol follow-ups, HIP-139'), () => {
  const pool = useIsolatedDatabase();
  followUpsSuite((options) => postgresHarness(pool(), options));
});
