import { describe, expect, it } from 'vitest';
import { validateFhirR4 } from '../src/fhir/validate.ts';
import { generateReviewerCohort, REVIEWER_COHORT_SIZE } from '../src/reviewer/cohort.ts';
import { loadReviewerCohort } from '../src/reviewer/load.ts';

describe('reviewer cohort fixtures (HIP-112)', () => {
  const committed = loadReviewerCohort();

  it('are exactly what the generator produces (regenerate with generate:reviewer)', () => {
    expect(JSON.parse(JSON.stringify(generateReviewerCohort()))).toEqual(committed.patients);
  });

  it('hold 10 planted patients with ground truth and 10 controls with none', () => {
    const planted = committed.patients.filter((patient) => patient.kind === 'planted');
    const controls = committed.patients.filter((patient) => patient.kind === 'control');
    expect(planted).toHaveLength(REVIEWER_COHORT_SIZE.planted);
    expect(controls).toHaveLength(REVIEWER_COHORT_SIZE.control);
    expect(planted.every((patient) => patient.expected.length > 0)).toBe(true);
    expect(controls.every((patient) => patient.expected.length === 0)).toBe(true);
  });

  it('every bundle is FHIR R4', () => {
    for (const patient of committed.patients) {
      for (const entry of patient.entries) {
        expect(validateFhirR4(entry.bundle).issues, `${patient.patientId} ${entry.at}`).toEqual([]);
      }
    }
  });
});
