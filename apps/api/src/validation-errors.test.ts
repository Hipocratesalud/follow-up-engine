import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './test/harness.ts';

/** HIP-127 (API): validation errors reach the clinic team in Spanish, field by field. */

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
  };
}

const ENGLISH = /\b(too big|too small|expected|invalid|required|option|string|number)\b/i;

describe('validation errors', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ app: { maxBodyBytes: 32 * 1024 } });
  });
  afterEach(async () => {
    await h.close();
  });

  it.each([
    [
      'a note over 2000 characters',
      '/api/inbox/cases/any/actions',
      { action: 'resolve', note: 'x'.repeat(2500) },
      'note',
      /como máximo 2000 caracteres/,
    ],
    [
      'an unknown action',
      '/api/inbox/cases/any/actions',
      { action: 'archive' },
      'action',
      /notify.*snooze.*resolve.*dismiss/,
    ],
    [
      'snoozeDays below 1',
      '/api/inbox/cases/any/actions',
      { action: 'snooze', snoozeDays: 0 },
      'snoozeDays',
      /al menos 1/,
    ],
    ['a missing field', '/api/inbox/cases/any/actions', {}, 'action', /obligatori/],
    [
      'a demo patient name over 120 characters',
      '/api/demo/consultations',
      { patientName: 'x'.repeat(150), specialty: 'diabetology', noteText: 'Plan: control.' },
      'patientName',
      /como máximo 120 caracteres/,
    ],
  ])('answers %s in Spanish with the field', async (_, path, body, field, message) => {
    const response = await h.call<ErrorBody>(path, { body });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.message).not.toMatch(ENGLISH);
    expect(response.body.error.fields).toContainEqual({
      path: field,
      message: expect.stringMatching(message) as unknown,
    });
    for (const item of response.body.error.fields ?? []) {
      expect(item.message).not.toMatch(ENGLISH);
    }
  });

  it('answers a query string over its limit in Spanish', async () => {
    const response = await h.call<ErrorBody>(`/api/inbox/cases?q=${'a'.repeat(120)}`);
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'invalid_request',
      fields: [{ path: 'q', message: 'Debe tener como máximo 100 caracteres.' }],
    });
    expect(response.body.error.message).toMatch(/^Revisa/);
  });

  it('answers a domain rule (a reason when the case was not useful) in Spanish', async () => {
    const response = await h.call<ErrorBody>('/api/inbox/cases/any/feedback', {
      body: { useful: 'maybe' },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.message).not.toMatch(ENGLISH);
  });
});

describe('413 and CORS', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({
      app: { maxBodyBytes: 1024, corsOrigins: ['http://localhost:5173'] },
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('lets the browser read a 413 (CORS headers on it)', async () => {
    const response = await h.call<ErrorBody>('/api/inbox/cases/any/actions', {
      body: { action: 'resolve', note: 'x'.repeat(4096) },
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.body.error.code).toBe('payload_too_large');
  });
});
