import { DEMO_CLINIC } from '@follow-up-engine/runtime';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../http/app.ts';
import type { App } from '../http/context.ts';
import type {
  CaseReasonView,
  CaseView,
  PatientDetail,
  PatientExpectationView,
  PatientSummary,
} from '../http/schemas.ts';
import { seedSyntheticClinic } from '../test/seed.ts';

/*
 * HIP-137: every reason that comes from a care protocol says which protocol
 * (its Spanish name) and whether the clinical team validated it, so the
 * inbox can flag the ones still unvalidated. The synthetic clinic enables
 * every protocol of config/protocols; none is `validated` yet (diabetes and
 * hypertension have a sign-off package and are `ready_for_signoff`, the
 * rest are still `draft`).
 */

const KEY = 'protocol-reasons-key';

/** Words that would let the front desk infer a mental-health condition. */
const MENTAL_HEALTH = /depres|ansie|anxi|antidep|psiq|mental|ánimo|animo/i;

/** Protocol names per language (HIP-138: English by default, Spanish with Accept-Language). */
const PROTOCOL_NAMES: Readonly<Record<'en' | 'es', Readonly<Record<string, string>>>> = {
  en: {
    diabetes: 'Diabetes follow-up',
    hypertension: 'Hypertension follow-up',
    pregnancy: 'Pregnancy and postpartum',
    treatment_followup: 'Treatment follow-up',
    hypothyroidism: 'Hypothyroidism follow-up',
    dyslipidemia: 'Dyslipidemia follow-up',
    chronic_kidney_disease: 'Chronic kidney disease follow-up',
  },
  es: {
    diabetes: 'Control de diabetes',
    hypertension: 'Control de hipertensión',
    pregnancy: 'Embarazo y puerperio',
    treatment_followup: 'Seguimiento de tratamiento',
    hypothyroidism: 'Control de hipotiroidismo',
    dyslipidemia: 'Control de dislipidemia',
    chronic_kidney_disease: 'Control de enfermedad renal crónica',
  },
};

/**
 * Exact status per protocol (docs/protocols/signoff): diabetes and
 * hypertension have a sign-off package, every other protocol is still a
 * plain draft with none.
 */
const PROTOCOL_STATUS: Readonly<Record<string, 'draft' | 'ready_for_signoff'>> = {
  diabetes: 'ready_for_signoff',
  hypertension: 'ready_for_signoff',
  pregnancy: 'draft',
  treatment_followup: 'draft',
  hypothyroidism: 'draft',
  dyslipidemia: 'draft',
  chronic_kidney_disease: 'draft',
};

describe('protocol reasons in the inbox API', () => {
  let runtime: EngineRuntime;
  let app: App;
  let reasons: CaseReasonView[] = [];
  let spanishReasons: CaseReasonView[] = [];
  let expectations: PatientExpectationView[] = [];

  async function get<T>(path: string, language?: string): Promise<T> {
    const response = await app.request(path, {
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(language === undefined ? {} : { 'accept-language': language }),
      },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  async function allExpectations(): Promise<PatientExpectationView[]> {
    const { items } = await get<{ items: PatientSummary[] }>('/api/inbox/patients?limit=500');
    const details = await Promise.all(
      items.map((patient) => get<PatientDetail>(`/api/inbox/patients/${patient.id}`)),
    );
    return details.flatMap((detail) => detail.expectations);
  }

  beforeAll(async () => {
    runtime = await createRuntime(loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent' }));
    await seedSyntheticClinic(runtime, { apiKey: KEY });
    app = createApp(runtime, { corsOrigins: [] });
    const page = await get<{ items: CaseView[] }>('/api/inbox/cases?view=all&limit=200');
    reasons = page.items.flatMap((item) => item.reasons);
    const spanish = await get<{ items: CaseView[] }>('/api/inbox/cases?view=all&limit=200', 'es');
    spanishReasons = spanish.items.flatMap((item) => item.reasons);
    expectations = await allExpectations();
  }, 60_000);

  afterAll(async () => {
    await runtime.close();
  });

  it('names the unvalidated protocol behind each protocol reason of a case', () => {
    const fromProtocols = reasons.filter((reason) => reason.layer === 'protocol');
    expect(fromProtocols.length).toBeGreaterThan(0);
    for (const reason of fromProtocols) {
      const { protocol } = reason;
      expect(protocol, reason.ruleId).toBeDefined();
      expect(reason.ruleId.startsWith(`protocol_${protocol?.id ?? ''}_`)).toBe(true);
      expect(protocol?.status).toBe(PROTOCOL_STATUS[protocol?.id ?? '']);
      expect(protocol?.name).toBe(PROTOCOL_NAMES.en[protocol?.id ?? '']);
      expect(protocol?.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('names protocols and their reasons in Spanish when the user asks for it', () => {
    const fromProtocols = spanishReasons.filter((reason) => reason.layer === 'protocol');
    expect(fromProtocols.length).toBeGreaterThan(0);
    for (const reason of fromProtocols) {
      expect(reason.protocol?.name).toBe(PROTOCOL_NAMES.es[reason.protocol?.id ?? '']);
      const english = reasons.find((item) => item.expectationId === reason.expectationId);
      // Same reason, other words: the catalog has a Spanish text for every protocol item.
      expect(reason.label).not.toBe(english?.label);
    }
  });

  it('adds no protocol to reasons of the other layers', () => {
    for (const reason of reasons.filter((item) => item.layer !== 'protocol')) {
      expect(reason.protocol).toBeUndefined();
    }
    for (const expectation of expectations.filter((item) => item.layer !== 'protocol')) {
      expect(expectation.protocol).toBeUndefined();
    }
  });

  it("names the protocol on the patient's expectations, with catalog labels", () => {
    const fromProtocols = expectations.filter((item) => item.layer === 'protocol');
    const ids = new Set(fromProtocols.map((item) => item.protocol?.id));
    // The synthetic clinic has patients under several protocols, pregnancy included.
    expect(ids.size).toBeGreaterThanOrEqual(3);
    expect(ids).toContain('pregnancy');
    for (const expectation of fromProtocols) {
      expect(expectation.protocol?.status).toBe(PROTOCOL_STATUS[expectation.protocol?.id ?? '']);
      expect(expectation.protocol?.name).toBe(PROTOCOL_NAMES.en[expectation.protocol?.id ?? '']);
      // Labels come from the catalog: copy, never a rule id.
      expect(expectation.label).not.toMatch(/_|protocol/);
    }
  });

  it('labels every closed reason the engine wrote, protocol closures included', () => {
    for (const expectation of expectations) {
      if (expectation.status === 'cancelled' || expectation.status === 'superseded') {
        expect(expectation.closedReason, expectation.ruleId).toBeDefined();
        expect(expectation.closedReason).not.toMatch(/_/);
      }
    }
  });

  it('never names a mental-health condition on the treatment follow-up protocol', () => {
    const followUp = [
      ...reasons.filter((reason) => reason.protocol?.id === 'treatment_followup'),
      ...expectations.filter((item) => item.protocol?.id === 'treatment_followup'),
    ];
    expect(followUp.length).toBeGreaterThan(0);
    for (const item of followUp) {
      expect(item.protocol?.name).toBe('Treatment follow-up');
      expect(`${item.label} ${item.protocol?.name ?? ''}`).not.toMatch(MENTAL_HEALTH);
    }
  });

  it('keeps only the id and version of a protocol the clinic turned off', async () => {
    const pregnancy = expectations.find((item) => item.protocol?.id === 'pregnancy');
    expect(pregnancy).toBeDefined();
    await runtime.registerClinic({
      id: DEMO_CLINIC.id,
      name: DEMO_CLINIC.name,
      apiKey: KEY,
      settings: { enabledProtocols: ['diabetes'] },
    });
    const after = (await allExpectations()).find((item) => item.id === pregnancy?.id);
    expect(after?.protocol).toEqual({ id: 'pregnancy', version: pregnancy?.protocol?.version });
  });
});
