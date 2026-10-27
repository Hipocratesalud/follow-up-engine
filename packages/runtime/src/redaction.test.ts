import {
  clinicId,
  type ClinicId,
  type NoteExtraction,
  type NoteExtractionInput,
  type NoteExtractor,
  patientId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { patientRedactTerms, withPatientRedaction } from './redaction.ts';
import { createRuntime } from './runtime.ts';

const CLINIC: ClinicId = clinicId('clinic-demo');
const RECEIVED = new Date('2026-01-05T12:00:00Z');

const PATIENT = {
  resourceType: 'Patient',
  id: 'pat-77',
  identifier: [{ system: 'urn:ci', value: 'V-12.345.678' }, { value: 'SECMARK-77' }],
  name: [{ text: 'Zacarías Marcadorapellido', family: 'Marcadorapellido', given: ['Zacarías'] }],
  telecom: [{ system: 'phone', value: '+58 412 555 0101' }],
};

const EMPTY: NoteExtraction = {
  hasPlan: false,
  conditions: [],
  medications: [],
  planItems: [],
  model: 'm',
  promptVersion: 'p',
  costUsd: 0,
};

function recordingExtractor(): NoteExtractor & { readonly inputs: NoteExtractionInput[] } {
  const inputs: NoteExtractionInput[] = [];
  return {
    inputs,
    extract: (_clinic, input) => {
      inputs.push(input);
      return Promise.resolve(EMPTY);
    },
  };
}

describe('patient name masking context (HIP-121, security #2)', () => {
  it('collects names, identifiers and phone numbers from a Patient resource', () => {
    expect(patientRedactTerms(PATIENT)).toEqual([
      'Zacarías Marcadorapellido',
      'Marcadorapellido',
      'Zacarías',
      'V-12.345.678',
      'SECMARK-77',
      '+58 412 555 0101',
    ]);
  });

  it('passes the note author patient names to the extractor', async () => {
    const runtime = await createRuntime(loadRuntimeConfig({ LOG_LEVEL: 'silent' }));
    try {
      const records = runtime.storage.stores.clinicalRecords;
      await records.saveResource(CLINIC, patientId('pat-77'), PATIENT, RECEIVED);
      await records.saveResource(
        CLINIC,
        patientId('pat-77'),
        {
          resourceType: 'DocumentReference',
          id: 'doc-77',
          subject: { reference: 'Patient/pat-77' },
        },
        RECEIVED,
      );
      const inner = recordingExtractor();
      const extractor = withPatientRedaction(inner, records);
      await extractor.extract(CLINIC, {
        documentId: 'doc-77',
        text: 'Paciente Zacarías con DM2.',
        authoredAt: RECEIVED,
      });
      expect(inner.inputs[0]?.redactTerms).toContain('Zacarías Marcadorapellido');
      expect(inner.inputs[0]?.redactTerms).toContain('V-12.345.678');

      // A note whose patient the engine does not hold goes through unchanged.
      await extractor.extract(CLINIC, { documentId: 'doc-x', text: 'DM2.', authoredAt: RECEIVED });
      expect(inner.inputs[1]?.redactTerms).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('is wired into the runtime: the configured extractor never sends the name', async () => {
    const runtime = await createRuntime(
      loadRuntimeConfig({ LOG_LEVEL: 'silent', CLOCK: 'fake', DEMO_API_KEY: 'k' }),
    );
    try {
      const bundle = {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            fullUrl: 'urn:uuid:p',
            resource: PATIENT,
            request: { method: 'PUT', url: 'Patient/pat-77' },
          },
          {
            fullUrl: 'urn:uuid:d',
            resource: {
              resourceType: 'DocumentReference',
              id: 'doc-77',
              status: 'current',
              subject: { reference: 'Patient/pat-77' },
              date: '2026-01-05T12:00:00Z',
              content: [
                {
                  attachment: {
                    contentType: 'text/plain',
                    data: Buffer.from(
                      'Paciente Zacarías Marcadorapellido con DM2 no controlada. Control en 3 meses.',
                    ).toString('base64'),
                  },
                },
              ],
            },
            request: { method: 'PUT', url: 'DocumentReference/doc-77' },
          },
        ],
      };
      const accepted = await runtime.ingestion.accept(CLINIC, bundle, 'sync');
      expect(accepted.ok).toBe(true);
      const note = accepted.reports?.flatMap((report) => report.notes)[0];
      expect(note?.status).toBe('extracted');
      // The note is still read; the model saw it masked.
      expect(note?.extraction?.conditions.map((c) => c.code.code)).toEqual(['E11']);
      const warnings = (note?.extraction as { warnings?: readonly string[] } | undefined)?.warnings;
      expect(warnings).toContain('names_masked');
    } finally {
      await runtime.close();
    }
  });

  it('a given name that is also a clinical word does not hide the discharge (clinical #11)', async () => {
    const runtime = await createRuntime(
      loadRuntimeConfig({ LOG_LEVEL: 'silent', CLOCK: 'fake', DEMO_API_KEY: 'k' }),
    );
    try {
      const patient = {
        resourceType: 'Patient',
        id: 'pat-alta',
        name: [{ family: 'Rivas', given: ['Alta', 'Gracia'] }],
        telecom: [{ system: 'phone', value: '+58 412 555 1234' }],
        identifier: [{ value: 'V-15.120.850' }],
      };
      const text =
        'Sesion 4. Paciente Alta Gracia Rivas refiere mejoria, TA 120/80, sertralina 50 mg. Se da de alta.';
      const bundle = {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            fullUrl: 'urn:uuid:p',
            resource: patient,
            request: { method: 'PUT', url: 'Patient/pat-alta' },
          },
          {
            fullUrl: 'urn:uuid:d',
            resource: {
              resourceType: 'DocumentReference',
              id: 'doc-alta',
              status: 'current',
              subject: { reference: 'Patient/pat-alta' },
              date: '2026-01-05T12:00:00Z',
              content: [
                {
                  attachment: {
                    contentType: 'text/plain',
                    data: Buffer.from(text).toString('base64'),
                  },
                },
              ],
            },
            request: { method: 'PUT', url: 'DocumentReference/doc-alta' },
          },
        ],
      };
      const accepted = await runtime.ingestion.accept(CLINIC, bundle, 'sync');
      expect(accepted.ok).toBe(true);
      const note = accepted.reports?.flatMap((report) => report.notes)[0];
      expect(note?.status).toBe('extracted');
      expect(note?.extraction?.discharged).toBe(true);
      const warnings = (note?.extraction as { warnings?: readonly string[] } | undefined)?.warnings;
      expect(warnings).toContain('names_masked');
    } finally {
      await runtime.close();
    }
  });
});
