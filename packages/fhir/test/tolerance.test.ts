import type { ClinicalEvent } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { mapBundleToBatches, type BundleMappingResult } from '../src/index.ts';
import { clone, loadBundle } from './helpers.ts';

/**
 * Property-style tests: hosts send whatever their EHR produces. Dropping any
 * element the engine does not strictly need, or adding elements it does not
 * know, must never crash the mapping or turn a valid bundle into an error.
 */

const RECEIVED_AT = new Date('2026-01-05T20:00:00Z');
const FIXTURES = [
  'consultation-diabetology',
  'consultation-hypertension',
  'consultation-psychology',
  'consultation-gynecology',
  'result-hba1c',
  'appointment-booked',
  'patient-opt-out',
] as const;
const SEEDS = Array.from({ length: 40 }, (_, seed) => seed + 1);

/** Elements the mapping needs: never dropped by the generator. */
const NEEDED: Readonly<Record<string, readonly string[]>> = {
  '*': ['resourceType', 'id', 'status', 'intent', 'subject', 'code'],
  Encounter: ['class'],
  Appointment: ['participant', 'start'],
  MedicationRequest: ['medicationCodeableConcept', 'medicationReference'],
  DocumentReference: ['content'],
  Composition: ['type', 'date', 'title', 'author', 'section'],
  Consent: ['patient', 'category', 'provision'],
  Patient: ['extension'],
};

/** Mulberry32: tiny deterministic PRNG so failures reproduce from the seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Json = Record<string, unknown>;

function resourcesOf(bundle: Json): Json[] {
  return (bundle['entry'] as { resource?: Json }[]).flatMap((entry) =>
    entry.resource === undefined ? [] : [entry.resource],
  );
}

function dropOptional(bundle: Json, random: () => number): Json {
  const copy = clone(bundle);
  for (const entry of copy['entry'] as { resource?: Json }[]) {
    const resource = entry.resource;
    if (resource === undefined) {
      continue;
    }
    const needed = [...(NEEDED['*'] ?? []), ...(NEEDED[String(resource['resourceType'])] ?? [])];
    entry.resource = Object.fromEntries(
      Object.entries(resource).filter(([key]) => needed.includes(key) || random() >= 0.5),
    );
  }
  return copy;
}

function addUnknown(bundle: Json, random: () => number): Json {
  const copy = clone(bundle);
  copy['meta'] = { tag: [{ system: 'https://ehr.example.org/tags', code: 'synthetic' }] };
  for (const resource of resourcesOf(copy)) {
    resource['extension'] = [
      ...((resource['extension'] as unknown[] | undefined) ?? []),
      { url: 'https://ehr.example.org/fhir/ext/source-system', valueString: 'ehr-x' },
    ];
    resource['implicitRules'] = 'https://ehr.example.org/fhir/rules';
    resource['_status'] = { extension: [{ url: 'https://ehr.example.org/x', valueInteger: 1 }] };
    if (random() < 0.5) {
      resource['contained'] = [{ resourceType: 'Basic', id: 'local', code: { text: 'x' } }];
    }
  }
  return copy;
}

function errorsOf(result: BundleMappingResult): string[] {
  return (result.issues?.issue ?? [])
    .filter((issue) => issue.severity === 'error' || issue.severity === 'fatal')
    .map((issue) => `${issue.expression?.[0] ?? ''}: ${issue.diagnostics ?? ''}`);
}

function withoutKeys(events: readonly ClinicalEvent[]): unknown[] {
  return events.map((event) => ({ ...event, idempotencyKey: undefined }));
}

function allEvents(result: BundleMappingResult): ClinicalEvent[] {
  return result.batches.flatMap((batch) => [...batch.events]);
}

describe.each(FIXTURES)('%s', (name) => {
  const original = loadBundle(name);
  const baseline = mapBundleToBatches(original, {
    clinicId: 'clinic-demo',
    receivedAt: RECEIVED_AT,
  });

  it.each(SEEDS)('dropping optional elements never errors (seed %i)', (seed) => {
    const mutated = dropOptional(original, prng(seed));
    const result = mapBundleToBatches(mutated, {
      clinicId: 'clinic-demo',
      receivedAt: RECEIVED_AT,
    });
    expect(errorsOf(result)).toEqual([]);
    for (const event of allEvents(result)) {
      expect(Number.isNaN(event.occurredAt.getTime())).toBe(false);
      expect(event.idempotencyKey).toMatch(/^[A-Za-z]+\/[A-Za-z0-9\-.]+\/[^#]+#[a-z_.]+$/);
      expect(event.clinicId).toBe('clinic-demo');
    }
    // Every event of the original survives, at most with less detail.
    expect(allEvents(result).map((event) => `${event.type}@${event.source.id}`)).toEqual(
      allEvents(baseline).map((event) => `${event.type}@${event.source.id}`),
    );
  });

  it.each(SEEDS.slice(0, 10))(
    'unknown elements change nothing but the content hash (seed %i)',
    (seed) => {
      const result = mapBundleToBatches(addUnknown(original, prng(seed)), {
        clinicId: 'clinic-demo',
        receivedAt: RECEIVED_AT,
      });
      expect(errorsOf(result)).toEqual([]);
      expect(withoutKeys(allEvents(result))).toEqual(withoutKeys(allEvents(baseline)));
    },
  );
});

describe('dropped clinical times fall back to receivedAt', () => {
  it('an order without authoredOn happened when the engine received it', () => {
    const result = mapBundleToBatches(
      {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [
          {
            resource: {
              resourceType: 'ServiceRequest',
              id: 'sr-1',
              status: 'active',
              intent: 'order',
              code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
              subject: { reference: 'Patient/p-1' },
            },
          },
        ],
      },
      { clinicId: 'clinic-demo', receivedAt: RECEIVED_AT },
    );
    expect(allEvents(result)[0]?.occurredAt).toEqual(RECEIVED_AT);
  });
});

describe('uncoded, text-only medications', () => {
  const prescription = (medication: Json): Json => ({
    resourceType: 'Bundle',
    type: 'batch',
    entry: [
      {
        resource: {
          resourceType: 'MedicationRequest',
          id: 'mr-1',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/p-1' },
          ...medication,
        },
      },
    ],
  });
  const medicationOf = (medication: Json): unknown => {
    const event = allEvents(
      mapBundleToBatches(prescription(medication), { clinicId: 'c', receivedAt: RECEIVED_AT }),
    )[0];
    return event?.type === 'medication.prescribed' ? event.medication : undefined;
  };

  it.each([
    [{ medicationCodeableConcept: { text: 'enalapril 10 mg' } }, { text: 'enalapril 10 mg' }],
    [
      { medicationCodeableConcept: { coding: [{ code: 'X1', display: 'Enalapril' }] } },
      { text: 'Enalapril' },
    ],
    [
      { medicationCodeableConcept: { coding: [{ system: 'urn:local:meds', code: 'enal-10' }] } },
      { text: 'enal-10', code: { system: 'urn:local:meds', code: 'enal-10' } },
    ],
    [
      { medicationReference: { display: 'enalapril (vademécum local)' } },
      { text: 'enalapril (vademécum local)' },
    ],
    [
      { medicationReference: { reference: 'Medication/not-in-bundle', display: 'Enalapril' } },
      { text: 'Enalapril' },
    ],
  ])('%j reads as %j', (medication, expected) => {
    expect(medicationOf(medication)).toEqual(expected);
  });
});
