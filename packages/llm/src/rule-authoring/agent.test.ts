import {
  type AuthoringToolbox,
  AUTHORING_TOOL_DEFINITIONS,
  clinicId,
  DEFAULT_AUTHORING_LIMITS,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import { DEFAULT_PRICING } from '../pricing.ts';
import { createFakeProvider, type FakeResponder } from '../providers/fake.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { createRuleAuthoringAgent } from './agent.ts';
import { RULE_AUTHORING_TASK } from './prompt.ts';
import { FAKE_RULE_AUTHOR_MODEL } from './scripted.ts';
import { createRepositoryTerminology } from './terminology.ts';

const CLINIC = clinicId('clinic-rule-agent-test');

function agentWith(replies: readonly { tool: string; args: unknown }[]) {
  let step = 0;
  const respond: FakeResponder = () => {
    const reply = replies[Math.min(step, replies.length - 1)];
    step += 1;
    return {
      thought: 'next',
      tool: reply?.tool ?? '',
      arguments: JSON.stringify(reply?.args ?? {}),
    };
  };
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond }) },
    tasks: {
      [RULE_AUTHORING_TASK]: { route: [{ provider: 'fake', model: FAKE_RULE_AUTHOR_MODEL }] },
    },
    usageLog: new InMemoryLlmUsageLog(),
    pricing: DEFAULT_PRICING,
    retry: { maxAttempts: 1 },
  });
  return createRuleAuthoringAgent({ gateway });
}

function recordingToolbox(): { toolbox: AuthoringToolbox; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    toolbox: {
      definitions: AUTHORING_TOOL_DEFINITIONS,
      execute: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve({ ok: true, result: {}, summary: 'ok' });
      },
    },
  };
}

describe('rule-authoring agent loop', () => {
  it('reads a "null" string as null (Muse Spark writes nullable ids so)', async () => {
    const { toolbox, calls } = recordingToolbox();
    const agent = agentWith([
      { tool: 'list_existing_rules', args: { query: 'null', id: 'null' } },
      { tool: 'abstain', args: { reason: 'not a rule' } },
    ]);
    const result = await agent.author(CLINIC, {
      request: 'x',
      toolbox,
      limits: DEFAULT_AUTHORING_LIMITS,
    });
    expect(calls).toEqual([{ name: 'list_existing_rules', args: { query: null, id: null } }]);
    expect(result.stopReason).toBe('abstained');
    expect(result.abstention).toBe('not a rule');
  });

  it('rejects an unknown tool and malformed arguments, each costing a step', async () => {
    const { toolbox, calls } = recordingToolbox();
    const agent = agentWith([
      { tool: 'enable_rule', args: {} },
      { tool: 'lookup_terminology', args: { query: '' } },
      { tool: 'abstain', args: { reason: 'done' } },
    ]);
    const result = await agent.author(CLINIC, {
      request: 'x',
      toolbox,
      limits: DEFAULT_AUTHORING_LIMITS,
    });
    expect(result.trace.map((step) => step.outcome)).toEqual([
      'unknown_tool',
      'invalid_arguments',
      'ok',
    ]);
    expect(calls).toEqual([]);
  });
});

describe('rule-authoring agent: a refused submission', () => {
  it('goes back to the agent with the issues instead of ending the run', async () => {
    const { toolbox } = recordingToolbox();
    let checks = 0;
    const checking: AuthoringToolbox = {
      ...toolbox,
      checkSubmission: () => {
        checks += 1;
        return checks === 1
          ? { ok: false, error: 'definition.trigger: required' }
          : { ok: true, result: {}, summary: 'valid' };
      },
    };
    const submit = {
      tool: 'submit_draft',
      args: {
        kind: 'rule',
        definition: { id: 'clinic_x' },
        labels: { en: 'X', es: 'X' },
        basedOn: null,
        rationale: { en: 'x', es: 'x' },
      },
    };
    const agent = agentWith([submit, submit]);
    const result = await agent.author(CLINIC, {
      request: 'x',
      toolbox: checking,
      limits: DEFAULT_AUTHORING_LIMITS,
    });
    expect(result.trace.map((step) => step.outcome)).toEqual(['invalid_submission', 'ok']);
    expect(result.stopReason).toBe('submitted');
  });
});

describe('repository terminology', () => {
  const terminology = createRepositoryTerminology();

  it('finds codes only the catalogs know, by name in either language or by code', () => {
    expect(terminology.search('hipotiroidismo', { system: 'icd10' })[0]?.code).toBe('E03');
    expect(terminology.search('levothyroxine', { system: 'atc' })[0]?.code).toBe('H03AA01');
    expect(terminology.search('colonoscopia', { system: 'loinc' })[0]?.code).toBe('18746-8');
    expect(terminology.find('icd10', 'E03.9')?.code).toBe('E03');
    expect(terminology.find('atc', 'H03AA')?.display).toContain('levothyrox');
    expect(terminology.find('loinc', '29771-3')?.group).toBe('fit');
    // Muse Spark's own query (2026-10-30): the FIT group, not guaiac stool tests.
    expect(terminology.search('FIT fecal occult blood', { system: 'loinc' })[0]?.group).toBe('fit');
  });

  it('knows nothing it was not given', () => {
    expect(terminology.find('loinc', '99999-9')).toBeUndefined();
    expect(terminology.find('icd10', 'X99')).toBeUndefined();
    expect(terminology.find('atc', 'Z99ZZ')).toBeUndefined();
    expect(terminology.search('unobtainium')).toEqual([]);
  });
});
