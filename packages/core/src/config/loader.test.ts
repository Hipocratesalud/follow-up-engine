import { describe, expect, it } from 'vitest';
import {
  applyRuleOverrides,
  ConfigValidationError,
  loadEscalationPoliciesFromJson,
  loadProtocolsFromJson,
  loadRulesFromJson,
} from './loader.ts';

const policy = { id: 'default_v1', steps: [{ afterDays: 0, action: 'notify_clinic' }] };
const rule = {
  id: 'lab_order_result_pending',
  version: '1.0.0',
  layer: 'universal',
  description: 'A lab order should have a result.',
  reason: { code: 'lab_order_result_pending', label: 'Resultado pendiente' },
  trigger: { event: 'service_request.created', filter: { category: 'laboratory' } },
  dueInDays: 15,
  fulfilledBy: [{ event: 'result.received', match: 'same_order' }],
  priority: 40,
  escalationPolicy: 'default_v1',
  suggestedAction: { code: 'contact', label: 'Contactar' },
};

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

describe('config loaders', () => {
  const escalationPolicies = loadEscalationPoliciesFromJson([policy]);

  it('loads rules from single documents and arrays, resolving policy references', () => {
    const rules = loadRulesFromJson([[rule], { ...rule, id: 'other_rule' }], {
      escalationPolicies,
    });
    expect(rules.map((loaded) => loaded.id)).toEqual(['lab_order_result_pending', 'other_rule']);
    expect(rules[0]?.escalationPolicy).toEqual(policy);
  });

  it('reports every problem with its location', () => {
    const issues = issuesOf(() =>
      loadRulesFromJson(
        [[rule, rule], { ...rule, id: 'x', escalationPolicy: 'missing', dueInDays: -1 }],
        {
          escalationPolicies,
          documentNames: ['universal.json', 'broken.json'],
        },
      ),
    );
    expect(issues).toContain('universal.json[1]: duplicate rule id "lab_order_result_pending"');
    expect(issues).toContain('broken.json.escalationPolicy: unknown escalation policy "missing"');
    expect(issues.some((issue) => issue.startsWith('broken.json.dueInDays'))).toBe(true);
    expect(issuesOf(() => loadEscalationPoliciesFromJson([{ steps: policy.steps }]))[0]).toMatch(
      /^document\[0\]\.id/u,
    );
    expect(issuesOf(() => loadProtocolsFromJson([{}])).length).toBeGreaterThan(0);
  });

  it('applies clinic overrides', () => {
    const [loaded] = loadRulesFromJson([rule], { escalationPolicies });
    if (loaded === undefined) {
      throw new Error('expected a rule');
    }
    expect(
      applyRuleOverrides([loaded], { lab_order_result_pending: { dueInDays: 10 } })[0]?.dueInDays,
    ).toBe(10);
    expect(applyRuleOverrides([loaded], { lab_order_result_pending: { enabled: false } })).toEqual(
      [],
    );
    expect(applyRuleOverrides([loaded], { lab_order_result_pending: {} })[0]?.dueInDays).toBe(15);
    expect(applyRuleOverrides([loaded], {})).toEqual([loaded]);
  });
});
