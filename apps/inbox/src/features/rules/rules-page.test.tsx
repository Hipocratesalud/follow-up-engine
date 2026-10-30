import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { AuthoredRuleView, RuleDraftRequest } from '../../api/rules-contract.ts';
import { en } from '../../i18n/en.ts';
import { es } from '../../i18n/es.ts';
import { renderApp } from '../../test/render.tsx';

const NOW = '2026-01-05T12:00:00.000Z';
const FIT_EN = en.rules.examples[1] ?? '';
const FIT_ES = es.rules.examples[1] ?? '';

function fitRule(status: AuthoredRuleView['status']): AuthoredRuleView {
  return {
    ruleId: 'clinic_positive_fit_colonoscopy',
    status,
    live: status === 'enabled',
    version: status === 'draft' ? 1 : 2,
    updatedAt: NOW,
    updatedBy: 'dr@example.com',
    request: 'After a positive FIT, colonoscopy within 60 days',
    labels: { en: 'Colonoscopy after a positive FIT', es: 'Colonoscopia tras un FIT positivo' },
    kind: 'rule',
    definition: {
      id: 'clinic_positive_fit_colonoscopy',
      trigger: {
        event: 'result.received',
        filter: { 'code.code': ['29771-3'], interpretation: 'abnormal' },
      },
      dueInDays: 60,
      expects: 'imaging',
      fulfilledBy: [
        { event: 'result.received', filter: { 'code.code': ['18746-8'] }, match: 'any' },
      ],
      escalationPolicy: { id: 'default_v1', steps: [] },
    },
    provenance: {
      mode: 'scripted',
      modelId: 'fake:fake-rule-author',
      promptVersion: 'rule-authoring@1',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      steps: 2,
      trace: [
        {
          index: 1,
          tool: 'validate_rule',
          arguments: { kind: 'rule' },
          outcome: 'ok',
          summary: 'valid',
        },
        { index: 2, tool: 'submit_draft', arguments: {}, outcome: 'ok', summary: 'submitted' },
      ],
      firstValidationPassed: true,
      dryRun: {
        asOf: NOW,
        patientsScanned: 9,
        truncated: false,
        patientsMatched: 2,
        expectations: { total: 2, open: 0, overdue: 1, closed: 1 },
        overlaps: { expectations: 0, patients: 0, byRule: [] },
        examples: [{ patientRef: 'P-1a2b3c', status: 'overdue', dueInDays: -20, overlapsWith: [] }],
      },
      terminology: [
        {
          system: 'loinc',
          code: '29771-3',
          display: 'fecal immunochemical test (FIT)',
          displayEs: 'test inmunoquímico fecal (FIT)',
          catalog: 'test-names',
        },
        {
          system: 'loinc',
          code: '18746-8',
          display: 'colonoscopy',
          displayEs: 'colonoscopia',
          catalog: 'test-names',
        },
      ],
      rationale: { en: 'A new rule.', es: 'Una regla nueva.' },
      draftedBy: 'dr@example.com',
      draftedAt: NOW,
    },
    ruleLabels: {},
    ...(status === 'draft' ? {} : { validatedBy: 'dr@example.com', validatedAt: NOW }),
  };
}

function rulesApi(): {
  readonly handlers: () => ReturnType<typeof http.get>[];
  readonly requests: RuleDraftRequest[];
} {
  let items: AuthoredRuleView[] = [];
  const requests: RuleDraftRequest[] = [];
  return {
    requests,
    handlers: () => [
      http.get('*/api/demo/lab/clock', () => HttpResponse.json({ now: NOW })),
      http.get('*/api/demo/lab/rules', () =>
        HttpResponse.json({ items, liveAvailable: false, patients: 9 }),
      ),
      http.post('*/api/demo/lab/rules/drafts', async ({ request }) => {
        requests.push((await request.json()) as RuleDraftRequest);
        items = [fitRule('draft')];
        return HttpResponse.json(
          { status: 'drafted', rule: items[0], run: { trace: [] } },
          { status: 201 },
        );
      }),
      http.post('*/api/demo/lab/rules/:ruleId/enable', () => {
        items = [fitRule('enabled')];
        return HttpResponse.json({ ruleId: items[0]?.ruleId, version: 2, rule: items[0] });
      }),
    ],
  };
}

describe('Rules page (rule-authoring agent)', () => {
  it('drafts from an example, shows the rule, its dry run and trace, and enables it on click', async () => {
    const api = rulesApi();
    const { user } = renderApp('/rules', { handlers: api.handlers });
    expect(await screen.findByRole('heading', { level: 1, name: en.rules.title })).toBeVisible();

    // The button never disables: an empty request is explained on click.
    await user.click(await screen.findByRole('button', { name: en.rules.draft }));
    expect(await screen.findByText(en.rules.requestRequired)).toBeVisible();

    await user.click(screen.getByRole('button', { name: FIT_EN }));
    expect(screen.getByLabelText(en.rules.requestLabel)).toHaveValue(FIT_EN);
    await user.click(screen.getByRole('button', { name: en.rules.draft }));
    await waitFor(() => {
      expect(api.requests).toEqual([{ request: FIT_EN, mode: 'scripted' }]);
    });

    const card = await screen.findByRole('region', { name: 'Colonoscopy after a positive FIT' });
    expect(within(card).getByText(en.rules.status['draft'] ?? '')).toBeVisible();
    expect(
      within(card).getByText(
        en.rules.describe.within(
          en.rules.describe.kinds['imaging'] ?? '',
          en.rules.describe.aboutMonths(en.rules.describe.days(60), 2),
        ),
      ),
    ).toBeVisible();
    expect(within(card).getByText(en.rules.dryRun.overdueBy(20))).toBeVisible();
    expect(within(card).getByText(en.rules.trace.title)).toBeVisible();

    await user.click(within(card).getByRole('button', { name: en.rules.enable }));
    expect(await within(card).findByText(en.rules.status['enabled'] ?? '')).toBeVisible();
    expect(within(card).queryByRole('button', { name: en.rules.enable })).not.toBeInTheDocument();
  });

  it('speaks neutral Spanish, the rule included', async () => {
    const api = rulesApi();
    const { user } = renderApp('/rules', { handlers: api.handlers, locale: 'es' });
    expect(await screen.findByRole('heading', { level: 1, name: es.rules.title })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: FIT_ES }));
    await user.click(screen.getByRole('button', { name: es.rules.draft }));
    const card = await screen.findByRole('region', { name: 'Colonoscopia tras un FIT positivo' });
    expect(within(card).getByText(es.rules.status['draft'] ?? '')).toBeVisible();
    expect(within(card).getByRole('button', { name: es.rules.enable })).toBeVisible();
    expect(within(card).getByText('Una regla nueva.')).toBeVisible();
  });
});
