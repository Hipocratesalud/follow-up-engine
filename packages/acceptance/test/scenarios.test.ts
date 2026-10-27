import { clinicId } from '@follow-up-engine/core';
import { BASE_DATE, loadScenarios } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { type EngineHarness, memoryHarness, postgresHarness } from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';
import { runScenario, scenarioExtractor } from '../src/scenario-runner.ts';

const scenarios = loadScenarios();

function options(name: string, scenario: (typeof scenarios)[number]) {
  return {
    clinicId: clinicId(`${scenario.clinicId}-${name}`),
    start: BASE_DATE,
    extractor: scenarioExtractor(scenario),
  };
}

async function expectScenario(harness: EngineHarness, scenario: (typeof scenarios)[number]) {
  expect(await runScenario(harness, scenario)).toEqual([]);
}

describe('testkit FHIR scenarios end to end (memory)', () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (name, scenario) => {
      await expectScenario(memoryHarness(options(name, scenario)), scenario);
    },
  );
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('testkit FHIR scenarios end to end'), () => {
  const database = useIsolatedDatabase();
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (name, scenario) => {
      await expectScenario(await postgresHarness(database(), options(name, scenario)), scenario);
    },
    60_000,
  );
});
