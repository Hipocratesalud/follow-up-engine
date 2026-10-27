/**
 * Regenerates the clinical reviewer cohort fixtures
 * (`fixtures/reviewer-cohort/*.json`) from `src/reviewer/cohort.ts`. Every
 * bundle is validated against the FHIR R4 schema. Run with
 * `pnpm --filter @follow-up-engine/testkit generate:reviewer`.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { assertValidFhirR4 } from '../src/fhir/validate.ts';
import { generateReviewerCohort } from '../src/reviewer/cohort.ts';

const dir = new URL('../fixtures/reviewer-cohort/', import.meta.url);
const path = fileURLToPath(dir);
mkdirSync(path, { recursive: true });
for (const file of readdirSync(path)) {
  if (file.endsWith('.json')) rmSync(new URL(file, dir));
}
const patients = generateReviewerCohort();
for (const patient of patients) {
  for (const entry of patient.entries) {
    assertValidFhirR4(entry.bundle, `${patient.patientId} ${entry.at}`);
  }
  const target = fileURLToPath(new URL(`${patient.patientId}.json`, dir));
  const options = (await resolveConfig(target)) ?? {};
  writeFileSync(target, await format(JSON.stringify(patient), { ...options, filepath: target }));
}
process.stdout.write(
  `Wrote ${String(patients.length)} cohort patients (${String(patients.filter((p) => p.kind === 'planted').length)} planted).\n`,
);
