import type { NoteReceivedEvent } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_CODE_SYSTEMS,
  expectationToTask,
  mapBundleToBatches,
  type BundleMappingResult,
  type OperationOutcomeIssue,
} from '../src/index.ts';
import { decodeBase64Text } from '../src/support/text.ts';
import { expiredPlanExpectation } from './domain-fixtures.ts';

/** HIP-134: FHIR ingestion v2 (charsets, unsupported methods, duplicate index, expired Tasks). */

const OPTIONS = { clinicId: 'clinic-demo', receivedAt: new Date('2026-01-05T20:00:00Z') };
const PATIENT = { resourceType: 'Patient', id: 'p-1' };
const NOTE_TEXT = 'Paciente con DM2. Evolución estable.\nPlan: control en 2 semanas.';

function map(bundle: unknown): BundleMappingResult {
  return mapBundleToBatches(bundle, OPTIONS);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function noteBundle(data: string, contentType = 'text/plain'): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      { resource: PATIENT, request: { method: 'PUT', url: 'Patient/p-1' } },
      {
        resource: {
          resourceType: 'DocumentReference',
          id: 'note-1',
          status: 'current',
          subject: { reference: 'Patient/p-1' },
          date: '2026-01-05T10:00:00Z',
          content: [{ attachment: { contentType, data } }],
        },
        request: { method: 'PUT', url: 'DocumentReference/note-1' },
      },
    ],
  };
}

function noteText(result: BundleMappingResult): string | undefined {
  const event = result.batches
    .flatMap((batch) => batch.events)
    .find((candidate): candidate is NoteReceivedEvent => candidate.type === 'note.received');
  return event?.text;
}

function issuesAt(result: BundleMappingResult, prefix: string): OperationOutcomeIssue[] {
  return (result.issues?.issue ?? []).filter((issue) =>
    (issue.expression?.[0] ?? '').startsWith(prefix),
  );
}

describe('base64 notes: charsets and bad bytes', () => {
  it('replaces an invalid UTF-8 byte with U+FFFD and keeps the note, with a warning', () => {
    const utf8 = new TextEncoder().encode(NOTE_TEXT);
    const bytes = new Uint8Array([...utf8, 0xff]);
    const result = map(noteBundle(base64(bytes)));
    expect(noteText(result)).toBe(`${NOTE_TEXT}�`);
    expect(issuesAt(result, 'Bundle.entry[1].resource.content[0].attachment.data')).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'value' }),
    ]);
  });

  it('decodes a Latin-1 note when the content type declares the charset', () => {
    const latin1 = Uint8Array.from(NOTE_TEXT, (char) => char.charCodeAt(0));
    const result = map(noteBundle(base64(latin1), 'text/plain; charset=ISO-8859-1'));
    expect(noteText(result)).toBe(NOTE_TEXT);
    expect(issuesAt(result, 'Bundle.entry[1]')).toEqual([]);
  });

  it('warns when control characters are removed from a decoded note', () => {
    const bytes = new TextEncoder().encode('Paciente con DM2.\u0000\u0007\nPlan: control.');
    const result = map(noteBundle(base64(bytes)));
    expect(noteText(result)).toBe('Paciente con DM2.\nPlan: control.');
    expect(issuesAt(result, 'Bundle.entry[1].resource.content[0].attachment.data')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'invalid',
        diagnostics: expect.stringMatching(/control characters/) as unknown,
      }),
    ]);
  });

  it('decodeBase64Text reports what it repaired; undefined only for invalid base64', () => {
    expect(decodeBase64Text('//79')).toEqual({ text: '���', repaired: ['bytes'] });
    expect(decodeBase64Text('SG9sYQ==', 'text/plain; charset="utf-8"')).toEqual({
      text: 'Hola',
      repaired: [],
    });
    expect(decodeBase64Text('%%%')).toBeUndefined();
    expect(decodeBase64Text('SG9sYQ==', 'text/plain; charset=x-made-up')).toEqual({
      text: 'Hola',
      repaired: ['charset'],
    });
  });
});

describe('request methods in a Bundle', () => {
  const sr = {
    resourceType: 'ServiceRequest',
    id: 'sr-1',
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/p-1' },
    code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
    authoredOn: '2026-01-05T10:00:00Z',
  };

  it('refuses DELETE and GET entries in a batch, entry by entry, and never creates from a DELETE', () => {
    const result = map({
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        { request: { method: 'DELETE', url: 'ServiceRequest/sr-0' } },
        { resource: sr, request: { method: 'DELETE', url: 'ServiceRequest/sr-1' } },
        { request: { method: 'GET', url: 'Task?patient=p-1' } },
        { resource: PATIENT, request: { method: 'PUT', url: 'Patient/p-1' } },
      ],
    });
    const methodErrors = (result.issues?.issue ?? []).filter(
      (issue) => issue.severity === 'error' && issue.code === 'not-supported',
    );
    expect(methodErrors.map((issue) => issue.expression?.[0])).toEqual([
      'Bundle.entry[0]',
      'Bundle.entry[1]',
      'Bundle.entry[2]',
    ]);
    expect(result.resources.map((entry) => entry.resource.id)).toEqual(['p-1']);
    expect(result.batches).toEqual([]);
  });

  it('rejects a whole transaction with an unsupported method', () => {
    const result = map({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: PATIENT, request: { method: 'PUT', url: 'Patient/p-1' } },
        { request: { method: 'DELETE', url: 'ServiceRequest/sr-1' } },
      ],
    });
    expect(result.resources).toEqual([]);
    expect(issuesAt(result, 'Bundle.entry[1]')).toEqual([
      expect.objectContaining({ severity: 'error', code: 'not-supported' }),
    ]);
  });

  it('exposes the bundle type', () => {
    expect(map({ resourceType: 'Bundle', type: 'batch', entry: [] }).bundleType).toBe('batch');
  });
});

describe('duplicate entries', () => {
  it('names the entry the resource first appeared in, counting entries without a resource', () => {
    const result = map({
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        { request: { method: 'POST', url: 'Patient' } },
        { resource: { resourceType: 'Patient', id: 'dup-a' } },
        { resource: { resourceType: 'Patient', id: 'dup-b' } },
        { resource: { resourceType: 'Patient', id: 'dup-a' } },
      ],
    });
    const duplicate = (result.issues?.issue ?? []).find((issue) => issue.code === 'duplicate');
    expect(duplicate).toMatchObject({
      diagnostics: 'Patient/dup-a already appears in entry[1]',
      expression: ['Bundle.entry[3]'],
    });
  });
});

describe('expired expectation → Task', () => {
  it('carries statusReason expired_unmet and executionPeriod.end even without closedReason', () => {
    const expired = { ...expiredPlanExpectation };
    delete (expired as { closedReason?: string }).closedReason;
    delete (expired as { closedAt?: Date }).closedAt;
    const task = expectationToTask(expired);
    expect(task.status).toBe('failed');
    expect(task.statusReason).toEqual({
      coding: [{ system: ENGINE_CODE_SYSTEMS.closedReason, code: 'expired_unmet' }],
    });
    expect(task.executionPeriod?.end).toBe(expired.updatedAt.toISOString());
  });
});
