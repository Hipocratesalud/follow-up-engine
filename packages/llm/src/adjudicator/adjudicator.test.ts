import type { AdjudicationInput, ClinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import { isStrictCompatible, toJsonSchema } from '../json-schema.ts';
import { DEFAULT_PRICING } from '../pricing.ts';
import { createFakeProvider } from '../providers/fake.ts';
import type { ProviderRequest } from '../usage.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { calibrateProbability, createAdjudicator } from './agent.ts';
import { ADJUDICATION_TASK, AdjudicationOutputSchema } from './prompt.ts';
import { FAKE_ADJUDICATOR_MODEL, scriptedAdjudicatorResponder } from './scripted.ts';

const CLINIC = 'clinic-a' as ClinicId;
const NOTE =
  'Paciente Marta Quintero Ruiz, CI 12345678. HTA.\nPlan: Marta Quintero: control en 4 semanas con registro de TA.';

const INPUT: AdjudicationInput = {
  itemRef: 'ITEM-1',
  kind: 'follow_up_visit',
  description: 'control visit',
  evidenceQuote: 'Marta Quintero: control en 4 semanas',
  extractionConfidence: 0.6,
  noteDate: '2026-01-05',
  dueInDays: 28,
  otherPlanItems: [],
  noteText: NOTE,
};

function gatewayWith(respond: (request: ProviderRequest<unknown>) => unknown) {
  const usageLog = new InMemoryLlmUsageLog();
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond }) },
    tasks: {
      [ADJUDICATION_TASK]: { route: [{ provider: 'fake', model: FAKE_ADJUDICATOR_MODEL }] },
    },
    usageLog,
    pricing: DEFAULT_PRICING,
  });
  return { gateway, usageLog };
}

describe('adjudicator on the gateway', () => {
  it('sends a strict schema and never the patient name or document number', async () => {
    expect(isStrictCompatible(toJsonSchema(AdjudicationOutputSchema))).toBe(true);
    const seen: ProviderRequest<unknown>[] = [];
    const { gateway, usageLog } = gatewayWith((request) => {
      seen.push(request);
      return scriptedAdjudicatorResponder(request);
    });
    const result = await createAdjudicator({ gateway }).decide(CLINIC, {
      input: INPUT,
      redactTerms: ['Marta Quintero Ruiz', '12345678'],
    });
    const sent = seen.flatMap((request) => request.messages.map((message) => message.content));
    expect(sent.join('\n')).not.toMatch(/Marta|Quintero|12345678|clinic-a/u);
    expect(sent.join('\n')).toContain('[REDACTADO]');
    expect(result).toMatchObject({
      decision: 'open',
      provider: 'fake',
      model: FAKE_ADJUDICATOR_MODEL,
      promptVersion: 'adjudicator@1',
    });
    // The quote the model copied from the masked note maps back to the original text.
    expect(result.quotes[0]).toContain('Marta Quintero: control en 4 semanas');
    expect(NOTE).toContain(result.quotes[0]);
    expect(usageLog.records).toHaveLength(1);
  });

  it('calibrates a real provider toward 0.5 and keeps the scripted one as is', () => {
    expect(calibrateProbability(0.9, 'fake')).toBe(0.9);
    expect(calibrateProbability(1, 'meta')).toBeLessThan(1);
    expect(calibrateProbability(0, 'meta')).toBeGreaterThan(0);
    expect(calibrateProbability(Number.NaN, 'meta')).toBe(0.5);
  });

  it('the scripted adjudicator discards a negated item and doubts a conditional one', async () => {
    const { gateway } = gatewayWith(scriptedAdjudicatorResponder);
    const adjudicator = createAdjudicator({ gateway });
    const negated = await adjudicator.decide(CLINIC, {
      input: {
        ...INPUT,
        evidenceQuote: 'No requiere control',
        noteText: 'Faringitis resuelta. Plan: No requiere control, alta.',
      },
      redactTerms: [],
    });
    expect(negated).toMatchObject({ decision: 'discard', reasonCodes: ['negated'] });
    const conditional = await adjudicator.decide(CLINIC, {
      input: {
        ...INPUT,
        evidenceQuote: 'solicitar ecografía',
        noteText: 'Dolor leve. Plan: si persiste el dolor, solicitar ecografía abdominal.',
      },
      redactTerms: [],
    });
    expect(conditional).toMatchObject({
      decision: 'needs_human',
      reasonCodes: ['conditional_plan'],
    });
  });
});
