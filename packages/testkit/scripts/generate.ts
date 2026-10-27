/**
 * Regenerates the committed synthetic fixtures (clinic and scenarios) from
 * their deterministic generators. No network. Run with
 * `pnpm --filter @follow-up-engine/testkit generate`.
 *
 * Gold notes are hand-written and are not touched by this script.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { assertValidFhirR4 } from '../src/fhir/validate.ts';
import { buildScenarios } from '../src/scenarios/definitions.ts';
import { generateSyntheticClinic } from '../src/synthetic/clinic.ts';

const fixtures = new URL('../fixtures/', import.meta.url);

async function writeJson(url: URL, value: unknown): Promise<void> {
  const path = fileURLToPath(url);
  const options = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(JSON.stringify(value), { ...options, filepath: path }));
}

function resetDir(url: URL): void {
  const path = fileURLToPath(url);
  mkdirSync(path, { recursive: true });
  for (const file of readdirSync(path)) {
    if (file.endsWith('.json')) rmSync(new URL(file, url));
  }
}

async function main(): Promise<void> {
  const { clinic, patients } = generateSyntheticClinic();
  const patientsDir = new URL('clinic/patients/', fixtures);
  resetDir(patientsDir);
  for (const patient of patients) {
    for (const entry of patient.entries)
      assertValidFhirR4(entry.bundle, `${patient.patientId} ${entry.bundle.id}`);
    await writeJson(new URL(`${patient.patientId}.json`, patientsDir), patient);
  }
  await writeJson(new URL('clinic/clinic.json', fixtures), clinic);

  const scenarios = buildScenarios();
  const scenariosDir = new URL('scenarios/', fixtures);
  resetDir(scenariosDir);
  for (const scenario of scenarios) {
    for (const step of scenario.steps)
      assertValidFhirR4(step.bundle, `${scenario.name} day ${String(step.day)}`);
    await writeJson(new URL(`${scenario.name}.json`, scenariosDir), scenario);
  }

  process.stdout.write(
    `Wrote ${String(patients.length)} patients (${String(clinic.stats.bundles)} bundles) and ${String(scenarios.length)} scenarios.\n` +
      `${JSON.stringify(clinic.stats, null, 2)}\n`,
  );
}

await main();
