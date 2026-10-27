import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaseView, DemoConsultationResponse, PatientDetail } from './http/schemas.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from './test/harness.ts';

/**
 * HIP-138, the language model through the API (docs/adr/0007): labels in the
 * user's `Accept-Language`, else the clinic's locale, else English; the
 * patient's preferred language read from `Patient.communication`; clinical
 * text never translated.
 */

interface CasePage {
  readonly items: readonly CaseView[];
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function put(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    resource,
    request: {
      method: 'PUT',
      url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
    },
  };
}

describe.each(STORAGES)('language model through the API (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers in English by default and says so (Content-Language, Vary)', async () => {
    const response = await h.call<ErrorBody>('/api/inbox/cases/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('We could not find that case.');
    expect(response.headers.get('content-language')).toBe('en');
    expect(response.headers.get('vary')).toMatch(/Accept-Language/);
  });

  it("follows the user's Accept-Language, before authentication too", async () => {
    const spanish = await h.call<ErrorBody>('/api/inbox/cases/nope', {
      headers: { 'accept-language': 'es-VE,es;q=0.9' },
    });
    expect(spanish.body.error.message).toBe('No encontramos ese caso.');
    expect(spanish.headers.get('content-language')).toBe('es');
    const unauthenticated = await h.call<ErrorBody>('/api/inbox/cases', {
      key: '',
      headers: { 'accept-language': 'es' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.message).toMatch(/^Falta la clave de API/);
  });

  it("falls back to the clinic's locale, and the user's language still wins", async () => {
    await h.runtime.registerClinic({
      id: 'clinic-b',
      name: 'Clínica B',
      apiKey: KEY_B,
      settings: { locale: 'es-VE' },
    });
    const clinicLocale = await h.call<ErrorBody>('/api/inbox/cases/nope', { key: KEY_B });
    expect(clinicLocale.body.error.message).toBe('No encontramos ese caso.');
    const userLocale = await h.call<ErrorBody>('/api/inbox/cases/nope', {
      key: KEY_B,
      headers: { 'accept-language': 'en-GB' },
    });
    expect(userLocale.body.error.message).toBe('We could not find that case.');
    // A language without a catalog falls through to the clinic's.
    const portuguese = await h.call<ErrorBody>('/api/inbox/cases/nope', {
      key: KEY_B,
      headers: { 'accept-language': 'pt-BR' },
    });
    expect(portuguese.headers.get('content-language')).toBe('es');
  });

  it("shows the patient's preferred language, and keeps clinical text as written", async () => {
    const now = (await h.call<{ now: string }>('/api/demo/clock')).body.now;
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        put({
          resourceType: 'Patient',
          id: 'pat-lang',
          name: [{ text: 'Paciente Idioma' }],
          communication: [
            { language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'pt-BR' }] } },
            {
              language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'es-VE' }] },
              preferred: true,
            },
          ],
        }),
        put({
          resourceType: 'ServiceRequest',
          id: 'sr-lang',
          status: 'active',
          intent: 'order',
          category: [{ coding: [{ system: 'http://snomed.info/sct', code: '108252007' }] }],
          code: {
            text: 'HbA1c de control',
            coding: [{ system: 'http://loinc.org', code: '4548-4' }],
          },
          subject: { reference: 'Patient/pat-lang' },
          authoredOn: now,
        }),
      ],
    };
    expect((await h.call('/fhir?sync=true', { body: bundle, fhir: true })).status).toBe(200);
    const english = await h.call<PatientDetail>('/api/inbox/patients/pat-lang');
    expect(english.body.language).toBe('es-VE');
    expect(english.body.expectations[0]?.label).toBe('Lab result pending');

    expect((await h.call('/api/demo/clock/advance', { body: { days: 16 } })).status).toBe(200);
    const page = await h.call<CasePage>('/api/inbox/cases?view=active&patient=pat-lang', {
      headers: { 'accept-language': 'es' },
    });
    const [reason] = page.body.items[0]?.reasons ?? [];
    expect(reason?.label).toBe('Resultado de laboratorio pendiente');
    // The host's own text names the order: never translated.
    expect(reason?.source.display).toBe('HbA1c de control');
    expect(page.body.items[0]?.suggestedAction).toBe(
      'Contactar al paciente para completar el examen',
    );
  });

  it('reads each note in its own language and quotes it verbatim', async () => {
    const consult = (noteText: string) =>
      h.call<DemoConsultationResponse>('/api/demo/consultations', {
        body: { specialty: 'diabetology', noteText },
      });
    const spanish = await consult(
      'Paciente con DM2 en tratamiento con metformina. Niega HTA. Plan: control en 3 meses con HbA1c.',
    );
    expect(spanish.status).toBe(201);
    expect(spanish.body.extraction.noteLanguage).toBe('es');
    const english = await consult(
      'Pt with T2DM on metformin 1000 mg BID. Denies HTN. Plan: repeat A1c, f/u in 3 months.',
    );
    expect(english.status).toBe(201);
    expect(english.body.extraction.noteLanguage).toBe('en');
    const quotes = english.body.extraction.planItems.map((item) => item.evidenceQuote);
    expect(quotes.length).toBeGreaterThan(0);
    for (const quote of quotes) {
      expect(
        'Pt with T2DM on metformin 1000 mg BID. Denies HTN. Plan: repeat A1c, f/u in 3 months.',
      ).toContain(quote);
    }
    // English labels for a Spanish note, by default.
    expect(spanish.body.expectationsCreated.map((item) => item.label)).toContain(
      'Follow-up visit in the plan',
    );
  });
});
