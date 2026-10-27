import { describe, expect, it } from 'vitest';
import { mapBundleToBatches } from '../src/index.ts';

/** HIP-138: the patient's preferred language and the language of a note, from FHIR. */

const RECEIVED_AT = new Date('2026-01-05T12:00:00Z');

function bundle(...resources: Record<string, unknown>[]): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type: 'batch',
    entry: resources.map((resource) => ({
      resource,
      request: {
        method: 'PUT',
        url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
      },
    })),
  };
}

function map(...resources: Record<string, unknown>[]) {
  const result = mapBundleToBatches(bundle(...resources), {
    clinicId: 'clinic-demo',
    receivedAt: RECEIVED_AT,
  });
  return {
    events: result.batches.flatMap((batch) => [...batch.events]),
    warnings: (result.issues?.issue ?? [])
      .filter((issue) => issue.severity === 'warning')
      .map((issue) => `${issue.expression?.[0] ?? ''}: ${issue.diagnostics ?? ''}`),
    errors: (result.issues?.issue ?? []).filter((issue) => issue.severity === 'error'),
  };
}

const bcp47 = (code: string) => ({ coding: [{ system: 'urn:ietf:bcp:47', code }] });

function patient(communication?: unknown[]): Record<string, unknown> {
  return {
    resourceType: 'Patient',
    id: 'pat-1',
    meta: { versionId: '3', lastUpdated: '2026-01-04T10:00:00Z' },
    ...(communication === undefined ? {} : { communication }),
  };
}

function note(extra: Record<string, unknown>, attachment: Record<string, unknown> = {}) {
  return {
    resourceType: 'DocumentReference',
    id: 'note-1',
    status: 'current',
    subject: { reference: 'Patient/pat-1' },
    date: '2026-01-05T10:00:00Z',
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          data: Buffer.from('Plan: f/u in 3 months.').toString('base64'),
          ...attachment,
        },
      },
    ],
    ...extra,
  };
}

describe('Patient.communication', () => {
  it('records the preferred language, whatever its position', () => {
    const { events, warnings } = map(
      patient([{ language: bcp47('en') }, { language: bcp47('es-ve'), preferred: true }]),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'patient.language_recorded',
        language: 'es-VE',
        occurredAt: new Date('2026-01-04T10:00:00Z'),
        idempotencyKey: 'Patient/pat-1/3#patient.language_recorded',
      }),
    ]);
    expect(warnings).toEqual([]);
  });

  it('takes the first language with a tag when none is preferred; reads a text tag', () => {
    expect(
      map(patient([{ language: { text: 'Spanish' } }, { language: bcp47('pt-BR') }])).events,
    ).toMatchObject([{ type: 'patient.language_recorded', language: 'pt-BR' }]);
    expect(map(patient([{ language: { text: 'es' } }])).events).toMatchObject([{ language: 'es' }]);
  });

  it('clears the language when the list is empty, and warns when nothing in it is a tag', () => {
    const cleared = map(patient([])).events;
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).not.toHaveProperty('language');
    const unreadable = map(patient([{ language: { text: 'Castellano' } }]));
    expect(unreadable.events[0]).not.toHaveProperty('language');
    expect(unreadable.warnings).toEqual([
      expect.stringMatching(/communication: no communication.language is a BCP-47 tag/),
    ]);
    expect(unreadable.errors).toEqual([]);
  });

  it('records nothing for a Patient without communication', () => {
    expect(map(patient()).events).toEqual([]);
  });
});

describe('the language of a note', () => {
  it("reads the attachment's language first, then the resource's", () => {
    const [fromAttachment] = map(patient(), note({ language: 'es' }, { language: 'en-US' })).events;
    expect(fromAttachment).toMatchObject({ type: 'note.received', language: 'en-US' });
    const [fromResource] = map(patient(), note({ language: 'pt-br' })).events;
    expect(fromResource).toMatchObject({ language: 'pt-BR' });
  });

  it('leaves the language to the extractor when the host sends none or an invalid one', () => {
    const [none] = map(patient(), note({})).events;
    expect(none).not.toHaveProperty('language');
    const invalid = map(patient(), note({ language: 'english please' }));
    expect(invalid.events[0]).not.toHaveProperty('language');
    expect(invalid.warnings).toEqual([
      expect.stringMatching(/language: "english please" is not a BCP-47 language tag/),
    ]);
    expect(invalid.errors).toEqual([]);
  });

  it('reads Composition.language', () => {
    const composition = {
      resourceType: 'Composition',
      id: 'comp-1',
      language: 'en',
      status: 'final',
      type: { text: 'Progress note' },
      subject: { reference: 'Patient/pat-1' },
      date: '2026-01-05T10:00:00Z',
      title: 'Progress note',
      section: [{ title: 'Plan', text: { status: 'generated', div: '<div>RTC 6 wks</div>' } }],
    };
    expect(map(patient(), composition).events).toMatchObject([
      { type: 'note.received', language: 'en' },
    ]);
  });
});
