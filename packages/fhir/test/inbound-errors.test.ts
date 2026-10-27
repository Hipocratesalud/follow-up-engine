import { describe, expect, it } from 'vitest';
import {
  buildConsultationBundle,
  mapBundleToBatches,
  validateBundle,
  type BundleMappingResult,
  type Encounter,
  type OperationOutcomeIssue,
} from '../src/index.ts';
import { clone, loadBundle } from './helpers.ts';

const OPTIONS = { clinicId: 'clinic-demo', receivedAt: new Date('2026-01-05T20:00:00Z') };

function map(bundle: unknown): BundleMappingResult {
  return mapBundleToBatches(bundle, OPTIONS);
}

function summary(result: BundleMappingResult): [string, string, string][] {
  return (result.issues?.issue ?? []).map((issue: OperationOutcomeIssue) => [
    issue.severity,
    issue.code,
    issue.expression?.[0] ?? '',
  ]);
}

function bundleOf(type: string, ...resources: Record<string, unknown>[]): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type,
    entry: resources.map((resource) => ({
      resource,
      request: {
        method: 'PUT',
        url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
      },
    })),
  };
}

const PATIENT_REF = { reference: 'Patient/p-1' };

describe('envelope', () => {
  it.each([
    [null, 'Bundle'],
    ['{}', 'Bundle'],
    [{ resourceType: 'Patient' }, 'Bundle.resourceType'],
    [{ resourceType: 'Bundle', type: 'searchset' }, 'Bundle.type'],
    [{ resourceType: 'Bundle', type: 'transaction', entry: {} }, 'Bundle.entry'],
  ])('rejects %j at %s', (input, expression) => {
    const result = map(input);
    expect(result.batches).toEqual([]);
    expect(result.resources).toEqual([]);
    expect(result.issues?.resourceType).toBe('OperationOutcome');
    expect(result.issues?.issue.map((issue) => issue.expression?.[0])).toContain(expression);
    expect(result.issues?.issue.every((issue) => issue.severity === 'error')).toBe(true);
  });

  it('explains which bundle types are accepted', () => {
    const result = map({ resourceType: 'Bundle', type: 'collection' });
    expect(result.issues?.issue[0]?.diagnostics).toBe(
      'only "transaction" and "batch" Bundles are accepted',
    );
  });

  it('accepts an empty transaction', () => {
    expect(map({ resourceType: 'Bundle', type: 'transaction' })).toEqual({
      batches: [],
      communications: [],
      resources: [],
      contextResources: [],
      issues: undefined,
      entryRefs: [],
      bundle: { resourceType: 'Bundle', type: 'transaction' },
      bundleType: 'transaction',
    });
  });
});

describe('transaction semantics: all or nothing', () => {
  it('rejects the whole transaction and points at every bad element', () => {
    const result = map(loadBundle('invalid-consultation'));
    expect(result.batches).toEqual([]);
    expect(result.resources).toEqual([]);
    expect(summary(result)).toEqual([
      ['error', 'not-found', 'Bundle.entry[0].resource.subject'],
      ['error', 'invariant', 'Bundle.entry[1].resource.code'],
      ['error', 'value', 'Bundle.entry[2].resource.subject'],
      ['error', 'value', 'Bundle.entry[3].resource.recordedDate'],
      ['error', 'processing', 'Bundle'],
    ]);
    expect(result.issues?.issue[2]?.diagnostics).toBe('expected a reference to Patient, got Group');
  });

  it('one bad entry rejects an otherwise valid transaction', () => {
    const bundle = clone(loadBundle('consultation-diabetology'));
    const entries = bundle['entry'] as { resource: Record<string, unknown> }[];
    const condition = entries[7]?.resource;
    if (condition === undefined) {
      throw new Error('fixture changed');
    }
    delete condition['subject'];
    const result = map(bundle);
    expect(result.batches).toEqual([]);
    expect(summary(result)).toEqual([
      ['error', 'required', 'Bundle.entry[7].resource.subject'],
      ['error', 'processing', 'Bundle'],
    ]);
  });
});

describe('batch semantics: entry by entry', () => {
  it('maps the valid entries and reports the invalid ones', () => {
    const bundle = clone(loadBundle('consultation-gynecology'));
    const entries = bundle['entry'] as { resource: Record<string, unknown> }[];
    const order = entries[4]?.resource;
    if (order === undefined) {
      throw new Error('fixture changed');
    }
    order['status'] = 'pending';
    const result = map(bundle);
    expect(summary(result)).toEqual([
      ['warning', 'code-invalid', 'Bundle.entry[3].resource.code'],
      ['error', 'value', 'Bundle.entry[4].resource.status'],
    ]);
    const ids = result.batches.flatMap((batch) => batch.events.map((event) => event.source.id));
    expect(ids).not.toContain('gyn-sr-pap');
    expect(ids).toContain('gyn-sr-us');
    expect(result.resources.map(({ resource }) => resource.id)).not.toContain('gyn-sr-pap');
  });
});

describe('entry identity', () => {
  it('requires an id, a urn:uuid fullUrl or a PUT url', () => {
    const result = map({
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        { resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
      ],
    });
    expect(summary(result)).toEqual([['error', 'required', 'Bundle.entry[0]']]);
  });

  it('takes the id from a PUT url when the resource has none', () => {
    const result = map({
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            extension: [
              {
                url: 'https://hipocratesalud.com/fhir/StructureDefinition/follow-up-opt-out',
                valueBoolean: true,
              },
            ],
          },
          request: { method: 'PUT', url: 'Patient/from-url' },
        },
      ],
    });
    expect(result.batches[0]?.patientId).toBe('from-url');
  });

  it('rejects the same resource twice', () => {
    const patient = { resourceType: 'Patient', id: 'p-1' };
    expect(summary(map(bundleOf('batch', patient, patient)))).toEqual([
      ['error', 'duplicate', 'Bundle.entry[1]'],
    ]);
  });

  it('resolves absolute references and history-pinned references', () => {
    const result = map(
      bundleOf('batch', {
        resourceType: 'Condition',
        id: 'dx-1',
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'E66.9' }] },
        subject: { reference: 'https://ehr.example.org/fhir/Patient/p-9/_history/3' },
      }),
    );
    expect(result.batches[0]?.patientId).toBe('p-9');
  });

  it('refuses a DELETE, ignores unsupported types, silently skips context types', () => {
    const result = map({
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        { request: { method: 'DELETE', url: 'Appointment/a-1' } },
        {
          resource: { resourceType: 'AllergyIntolerance', id: 'al-1', patient: PATIENT_REF },
          request: { method: 'PUT', url: 'AllergyIntolerance/al-1' },
        },
        {
          resource: { resourceType: 'Practitioner', id: 'doc-1' },
          request: { method: 'PUT', url: 'Practitioner/doc-1' },
        },
      ],
    });
    expect(summary(result)).toEqual([
      ['error', 'not-supported', 'Bundle.entry[0]'],
      ['information', 'not-supported', 'Bundle.entry[1].resource'],
    ]);
  });
});

describe('statuses that produce no event', () => {
  it('an unfinished Encounter still groups the consultation', () => {
    const bundle = buildConsultationBundle({
      consultationId: 'c-1',
      patient: { id: 'p-1' },
      specialty: 'diabetology',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      noteText: 'Nota.',
    });
    const encounter = bundle.entry?.[0]?.resource as Encounter | undefined;
    if (encounter?.resourceType !== 'Encounter') {
      throw new Error('builder changed');
    }
    encounter.status = 'in-progress';
    const result = map(bundle);
    expect(result.batches[0]?.encounterId).toBe('c-1-enc');
    expect(result.batches[0]?.events.map((event) => event.type)).toEqual(['note.received']);
    expect(summary(result)).toEqual([
      ['information', 'informational', 'Bundle.entry[0].resource.status'],
    ]);
  });

  it.each([
    [
      'resolved',
      {
        clinicalStatus: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
              code: 'resolved',
            },
          ],
        },
      },
      'information',
    ],
    [
      'SNOMED-only',
      { code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006' }] } },
      'warning',
    ],
  ])('a %s Condition gives no event', (_label, patch, severity) => {
    const result = map(
      bundleOf('batch', {
        resourceType: 'Condition',
        id: 'dx-1',
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' }] },
        subject: PATIENT_REF,
        ...patch,
      }),
    );
    expect(result.batches).toEqual([]);
    expect(result.issues?.issue.map((issue) => issue.severity)).toEqual([severity]);
  });

  it('a draft ServiceRequest or a proposal gives no event', () => {
    const order = (status: string, intent: string) => ({
      resourceType: 'ServiceRequest',
      id: `sr-${status}-${intent}`,
      status,
      intent,
      code: { text: 'Hemograma' },
      subject: PATIENT_REF,
    });
    const result = map(bundleOf('batch', order('draft', 'order'), order('active', 'proposal')));
    expect(result.batches).toEqual([]);
  });

  it('an Appointment needs a Patient participant and, when booked, a start', () => {
    const result = map(
      bundleOf(
        'batch',
        {
          resourceType: 'Appointment',
          id: 'a-1',
          status: 'booked',
          start: '2026-02-01T10:00:00Z',
          participant: [{ actor: { reference: 'Practitioner/doc-1' }, status: 'accepted' }],
        },
        {
          resourceType: 'Appointment',
          id: 'a-2',
          status: 'booked',
          participant: [{ actor: PATIENT_REF, status: 'accepted' }],
        },
      ),
    );
    expect(summary(result)).toEqual([
      ['error', 'required', 'Bundle.entry[0].resource.participant'],
      ['error', 'required', 'Bundle.entry[1].resource.start'],
    ]);
  });

  it('a MedicationRequest without any medication is invalid', () => {
    const result = map(
      bundleOf('batch', {
        resourceType: 'MedicationRequest',
        id: 'mr-1',
        status: 'active',
        intent: 'order',
        subject: PATIENT_REF,
      }),
    );
    expect(summary(result)).toEqual([
      ['error', 'invariant', 'Bundle.entry[0].resource.medication[x]'],
    ]);
  });
});

describe('validateBundle', () => {
  it('accepts every valid fixture, warnings included', () => {
    for (const name of [
      'consultation-diabetology',
      'consultation-hypertension',
      'consultation-psychology',
      'consultation-gynecology',
      'result-hba1c',
      'appointment-booked',
      'appointment-cancelled',
      'patient-opt-out',
    ]) {
      expect(validateBundle(loadBundle(name)).ok, name).toBe(true);
    }
  });

  it('rejects an invalid bundle with the same OperationOutcome the mapping gives', () => {
    const bundle = loadBundle('invalid-consultation');
    const validation = validateBundle(bundle);
    expect(validation.ok).toBe(false);
    expect(validation.outcome).toEqual(map(bundle).issues);
  });
});

describe('robustness: one bad field never costs the consultation', () => {
  const RECEIVED = new Date('2026-01-05T12:00:00Z');

  function consultationAt(occurredAt: string, noteText = 'Plan: control en 1 mes.'): unknown {
    return buildConsultationBundle({
      consultationId: 'c-dates',
      patient: { id: 'pat-dates', name: 'Paciente Prueba' },
      specialty: 'diabetology',
      occurredAt: new Date(occurredAt),
      noteText,
    });
  }

  it('rejects a clinical date outside 1900-2200 whatever the receipt time', () => {
    const { batches, issues } = mapBundleToBatches(consultationAt('9999-12-25T10:00:00Z'), {
      clinicId: 'clinic-demo',
      receivedAt: RECEIVED,
    });
    expect(batches).toEqual([]);
    expect(issues?.issue).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'value' }),
    );
  });

  it('checks future dates against the receipt only for live ingestion', () => {
    const future = consultationAt('2026-03-01T10:00:00Z');
    const live = mapBundleToBatches(future, {
      clinicId: 'clinic-demo',
      receivedAt: RECEIVED,
      checkFutureDates: true,
    });
    expect(live.batches).toHaveLength(1);
    expect(live.issues?.issue.map((issue) => issue.severity)).toContain('warning');
    const history = mapBundleToBatches(future, { clinicId: 'clinic-demo', receivedAt: RECEIVED });
    expect(history.issues).toBeUndefined();
    const nextYear = mapBundleToBatches(consultationAt('2027-06-01T10:00:00Z'), {
      clinicId: 'clinic-demo',
      receivedAt: RECEIVED,
      checkFutureDates: true,
    });
    expect(nextYear.batches).toEqual([]);
  });

  it('removes control characters with a warning and returns the cleaned Bundle', () => {
    const bundle = consultationAt('2026-01-05T10:00:00Z') as {
      entry: { resource: { name?: { text: string }[] } }[];
    };
    const patient = bundle.entry[0]?.resource;
    if (patient !== undefined) {
      patient.name = [{ text: 'Ana\u0000 Prueba' }];
    }
    const result = mapBundleToBatches(bundle, { clinicId: 'clinic-demo', receivedAt: RECEIVED });
    expect(result.batches).toHaveLength(1);
    expect(JSON.stringify(result.bundle)).not.toContain('\\u0000');
    expect(JSON.stringify(result.resources)).not.toContain('\\u0000');
    expect(result.issues?.issue).toEqual([
      expect.objectContaining({
        severity: 'warning',
        expression: ['Bundle.entry[0].resource.name[0].text'],
      }),
    ]);
  });
});
