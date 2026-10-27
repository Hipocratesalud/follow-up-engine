import { ENGINE_CODE_SYSTEMS, ENGINE_FHIR_BASE, mapBundleToBatches } from '@follow-up-engine/fhir';
import {
  DEMO_CLINIC_ID,
  ENGINE_FHIR_BASE as TESTKIT_FHIR_BASE,
  loadScenarios,
  loadSyntheticClinic,
  SPECIALTIES,
  SYSTEMS,
  type TransactionBundle,
} from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';

interface Labeled {
  readonly label: string;
  readonly bundle: TransactionBundle;
  readonly at: Date;
}

const clinic = loadSyntheticClinic();
const scenarios = loadScenarios();
const bundles: Labeled[] = [
  ...clinic.patients.flatMap((patient) =>
    patient.entries.map((entry) => ({
      label: `${patient.patientId} ${entry.bundle.id}`,
      bundle: entry.bundle,
      at: new Date(entry.at),
    })),
  ),
  ...scenarios.flatMap((scenario) =>
    scenario.steps.map((step) => ({
      label: `${scenario.name} day ${String(step.day)}`,
      bundle: step.bundle,
      at: new Date(0),
    })),
  ),
];

function mapped(item: Labeled) {
  return mapBundleToBatches(item.bundle, { clinicId: DEMO_CLINIC_ID, receivedAt: item.at });
}

describe('FHIR mapping of every synthetic bundle', () => {
  it('shares one base URL for every engine-defined system', () => {
    expect(TESTKIT_FHIR_BASE).toBe(ENGINE_FHIR_BASE);
    expect(SYSTEMS.specialty).toBe(ENGINE_CODE_SYSTEMS.specialty);
    expect(ENGINE_FHIR_BASE).toBe('https://hipocratesalud.com/fhir');
  });

  it('maps all of them with zero issues', () => {
    expect(bundles.length).toBeGreaterThan(1600);
    const withIssues = bundles.flatMap((item) => {
      const issues = mapped(item).issues?.issue ?? [];
      return issues.length === 0
        ? []
        : [
            {
              bundle: item.label,
              issues: issues.map(
                (issue) =>
                  `${issue.severity}: ${issue.diagnostics ?? ''} @ ${(issue.expression ?? []).join(',')}`,
              ),
            },
          ];
    });
    expect(withIssues).toEqual([]);
  });

  it('puts the encounter on every event of a consultation and the order id on every order', () => {
    for (const item of bundles) {
      for (const batch of mapped(item).batches) {
        for (const event of batch.events) {
          if (batch.encounterId !== undefined) {
            expect(event.encounterId, `${item.label} ${event.idempotencyKey}`).toBe(
              batch.encounterId,
            );
          }
          if (event.type === 'service_request.created') {
            expect(event.orderId).toBe(event.source.id);
          }
        }
      }
    }
  });

  it('reads the specialty code from Encounter.serviceType', () => {
    const specialties = new Set<string>();
    for (const item of bundles) {
      for (const batch of mapped(item).batches) {
        for (const event of batch.events) {
          if (event.type === 'encounter.finished') {
            expect(event.specialty, item.label).toBeDefined();
            specialties.add(event.specialty ?? '');
          }
          if (event.type === 'note.received') {
            expect(event.specialty, item.label).toBeDefined();
          }
        }
      }
    }
    expect([...specialties].sort()).toEqual([...SPECIALTIES].sort());
  });

  it('carries Observation.valueQuantity into result values', () => {
    const results = bundles.flatMap((item) =>
      mapped(item).batches.flatMap((batch) =>
        batch.events.filter((event) => event.type === 'result.received'),
      ),
    );
    const hba1c = results.filter(
      (event) => event.code.code === '4548-4' && event.source.resourceType === 'Observation',
    );
    expect(hba1c.length).toBeGreaterThan(0);
    for (const event of hba1c) {
      expect(event.value?.value).toEqual(expect.any(Number));
      expect(event.value?.unit).toBe('%');
    }
  });
});
