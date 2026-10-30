import { describe, expect, it } from 'vitest';
import { isTestEvaluator, loadTestEvaluatorPolicy } from './test-evaluators.ts';

describe('test and QA evaluator accounts (config/demo/test-evaluators.json)', () => {
  const policy = loadTestEvaluatorPolicy();

  it('lists the orchestrator account explicitly and every example.com address', () => {
    expect(policy.emails).toContain('evidence-orchestrator@example.com');
    expect(isTestEvaluator('evidence-orchestrator@example.com', policy)).toBe(true);
    expect(isTestEvaluator('QA-Bot@Example.com ', policy)).toBe(true);
    expect(isTestEvaluator('agent@example.org', policy)).toBe(true);
  });

  it('never flags a physician, a look-alike domain or a missing actor', () => {
    expect(isTestEvaluator('dra.rojas@gmail.com', policy)).toBe(false);
    expect(isTestEvaluator('someone@notexample.com', policy)).toBe(false);
    expect(isTestEvaluator('someone@example.com.ve', policy)).toBe(false);
    expect(isTestEvaluator('inbox-user', policy)).toBe(false);
    expect(isTestEvaluator(undefined, policy)).toBe(false);
  });

  it('flags an address listed explicitly, whatever its domain', () => {
    const custom = { domains: [], emails: ['tester@hospital.org'] };
    expect(isTestEvaluator('tester@hospital.org', custom)).toBe(true);
    expect(isTestEvaluator('doctor@hospital.org', custom)).toBe(false);
  });
});
