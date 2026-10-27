import { readdirSync, readFileSync } from 'node:fs';
import { FIXTURES_DIR } from '../fixtures/load.ts';
import { type ReviewerCohort, ReviewerCohortPatientSchema } from './schema.ts';

/** The reviewer cohort: synthetic patients with planted findings and their controls (committed fixtures). */
export function loadReviewerCohort(): ReviewerCohort {
  const dir = new URL('reviewer-cohort/', FIXTURES_DIR);
  const patients = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const json: unknown = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
      const parsed = ReviewerCohortPatientSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Invalid fixture reviewer-cohort/${file}: ${parsed.error.message}`);
      }
      return parsed.data;
    });
  return { patients };
}
