import type { FakeResponder } from '../providers/fake.ts';
import type { ReviewerAction } from '../reviewer/prompt.ts';
import type { ProviderRequest } from '../usage.ts';
import { RULE_AUTHORING_ACTION_NAME } from './prompt.ts';

/** Model id of the scripted rule-authoring agent on the fake provider. */
export const FAKE_RULE_AUTHOR_MODEL = 'fake-rule-author';

interface Step {
  readonly thought: string;
  readonly tool: string;
  readonly args: unknown;
}

const TSH_CODES = ['3016-3', '11580-8'];
const FIT_CODES = ['29771-3', '57905-2', '56490-6', '56491-4'];
const COLONOSCOPY_CODES = ['18746-8'];
const HBA1C_PERCENT_CODES = ['4548-4', '17856-6', '4549-2'];

const HYPOTHYROIDISM_DRAFT = {
  kind: 'protocol',
  definition: {
    id: 'clinic_hypothyroidism_tsh_6m',
    version: '1.0.0',
    status: 'draft',
    description:
      "Hypothyroidism on levothyroxine: a TSH every 6 months (182 days) after the last one, the clinic's own cadence on top of the yearly control of the hypothyroidism protocol.",
    reason: { code: 'protocol_clinic_hypothyroidism_tsh_6m', label: 'TSH every 6 months' },
    sources: [
      {
        title: 'Guidelines for the Treatment of Hypothyroidism',
        organization: 'American Thyroid Association',
        year: 2014,
        url: 'https://doi.org/10.1089/thy.2014.0028',
      },
    ],
    caseGroup: 'follow_up',
    enrollment: {
      conditionCodes: ['E03'],
      minimumStatus: 'probable',
      medications: [{ atc: ['H03AA'], conditionCode: 'E03.9' }],
      activeTreatment: { atc: ['H03AA'] },
    },
    items: [
      {
        key: 'tsh',
        kind: 'lab',
        code: { system: 'http://loinc.org', code: '3016-3', display: 'TSH' },
        reason: {
          code: 'protocol_clinic_hypothyroidism_tsh_6m_tsh',
          label: 'TSH due (every 6 months)',
        },
        everyDays: 182,
        fulfilledBy: [
          { event: 'result.received', filter: { 'code.code': TSH_CODES }, match: 'any' },
        ],
        planTerms: ['tsh', 'tirotropina', 'perfil tiroideo', 'thyrotropin'],
        priority: 30,
        suggestedAction: {
          code: 'order_lab',
          label: 'Order TSH',
          patientContactPurpose: 'complete_pending_test',
        },
      },
    ],
    escalationPolicy: 'default_v1',
  },
};

const FIT_DRAFT = {
  kind: 'rule',
  definition: {
    id: 'clinic_positive_fit_colonoscopy',
    version: '1.0.0',
    layer: 'universal',
    description:
      'A positive fecal immunochemical test (FIT, any LOINC of the group) should be followed by a colonoscopy within 60 days; a colonoscopy result fulfills it.',
    reason: { code: 'clinic_positive_fit_colonoscopy', label: 'Colonoscopy after a positive FIT' },
    trigger: {
      event: 'result.received',
      filter: { 'code.code': FIT_CODES, interpretation: 'abnormal' },
    },
    dueInDays: 60,
    expects: 'imaging',
    caseGroup: 'pending_results',
    fulfilledBy: [
      { event: 'result.received', filter: { 'code.code': COLONOSCOPY_CODES }, match: 'any' },
    ],
    priority: 50,
    escalationPolicy: 'default_v1',
    suggestedAction: {
      code: 'order_follow_up_study',
      label: 'Order a colonoscopy',
      patientContactPurpose: 'complete_pending_test',
    },
  },
};

const HBA1C_DRAFT = {
  kind: 'rule',
  definition: {
    id: 'clinic_hba1c_above_9_visit',
    version: '1.0.0',
    layer: 'universal',
    description:
      "An HbA1c above 9 % (NGSP, any % LOINC code) should be followed by a visit within 30 days, unless the doctor's plan already asks for one by then.",
    reason: { code: 'clinic_hba1c_above_9_visit', label: 'Visit after HbA1c above 9 %' },
    trigger: {
      event: 'result.received',
      filter: { 'code.code': HBA1C_PERCENT_CODES, 'value.value': { gt: 9 } },
    },
    dueInDays: 30,
    expects: 'follow_up_visit',
    fulfilledBy: [
      { event: 'encounter.finished', match: 'any' },
      { event: 'appointment.booked', match: 'any' },
    ],
    coveredByPlan: true,
    priority: 60,
    escalationPolicy: 'default_v1',
    suggestedAction: {
      code: 'schedule_follow_up',
      label: 'Schedule a visit within 30 days',
      patientContactPurpose: 'schedule_follow_up',
    },
  },
};

interface Recipe {
  readonly matches: RegExp;
  readonly steps: readonly Step[];
}

function lookup(query: string, system: string): Step {
  return {
    thought: `Looking up the ${system.toUpperCase()} code for "${query}".`,
    tool: 'lookup_terminology',
    args: { query, system },
  };
}

function finishing(draft: unknown, submit: Record<string, unknown>): readonly Step[] {
  return [
    { thought: 'Validating the draft with the engine.', tool: 'validate_rule', args: draft },
    {
      thought: "Dry-running it on the clinic's records.",
      tool: 'dry_run_rule',
      args: draft,
    },
    {
      thought: 'Submitting the draft for clinical validation.',
      tool: 'submit_draft',
      args: { ...(draft as Record<string, unknown>), ...submit },
    },
  ];
}

const RECIPES: readonly Recipe[] = [
  {
    matches: /tsh|levotirox|levothyrox|hipotiroid|hypothyroid/,
    steps: [
      {
        thought: 'Checking what the clinic already tracks for thyroid patients.',
        tool: 'list_existing_rules',
        args: { query: 'thyroid', id: null },
      },
      {
        thought: 'Reading the existing hypothyroidism protocol as a template.',
        tool: 'list_existing_rules',
        args: { query: null, id: 'hypothyroidism' },
      },
      lookup('hypothyroidism', 'icd10'),
      lookup('levothyroxine', 'atc'),
      lookup('TSH', 'loinc'),
      ...finishing(HYPOTHYROIDISM_DRAFT, {
        labels: { en: 'TSH every 6 months', es: 'TSH cada 6 meses' },
        basedOn: 'hypothyroidism',
        rationale:
          'Adapts the hypothyroidism protocol: same enrollment (E03 on levothyroxine), TSH every 182 days instead of yearly; it overlaps with that protocol, whose TSH item stays on.',
      }),
    ],
  },
  {
    matches: /\bfit\b|colonosc|sangre oculta|occult|inmunoquimic|immunochemical/,
    steps: [
      {
        thought: 'Checking whether a rule already follows up stool tests or colonoscopies.',
        tool: 'list_existing_rules',
        args: { query: 'stool', id: null },
      },
      lookup('FIT', 'loinc'),
      lookup('colonoscopy', 'loinc'),
      ...finishing(FIT_DRAFT, {
        labels: {
          en: 'Colonoscopy after a positive FIT',
          es: 'Colonoscopia tras un FIT positivo',
        },
        basedOn: null,
        rationale:
          'New rule: no existing rule follows a positive FIT; any FIT LOINC code that comes back abnormal expects a colonoscopy result within 60 days.',
      }),
    ],
  },
  {
    matches: /hba1c|a1c|glicosilada|glucosilada|glicada|glycated/,
    steps: [
      {
        thought: 'Checking what already follows up an abnormal HbA1c.',
        tool: 'list_existing_rules',
        args: { query: 'abnormal', id: null },
      },
      lookup('HbA1c', 'loinc'),
      ...finishing(HBA1C_DRAFT, {
        labels: {
          en: 'Visit after HbA1c above 9 %',
          es: 'Control por HbA1c mayor de 9 %',
        },
        basedOn: null,
        rationale:
          'New rule with a fixed 9 % threshold and a 30-day visit; it overlaps with the abnormal-result rule for results the lab flags, and adds the ones it does not.',
      }),
    ],
  },
];

function requestOf(request: ProviderRequest<unknown>): string {
  for (const message of request.messages) {
    if (message.role !== 'user') continue;
    const match = /<clinician_request>([\s\S]*?)<\/clinician_request>/.exec(message.content);
    if (match?.[1] === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(match[1]);
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return '';
    }
  }
  return '';
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function action(step: Step): ReviewerAction {
  return { thought: step.thought, tool: step.tool, arguments: JSON.stringify(step.args) };
}

/**
 * A deterministic stand-in for the authoring model, for CI, demos and the
 * evaluator's sandbox without a key. It speaks the real protocol through
 * the real gateway, loop, validator and dry run, and knows three requests
 * (hypothyroidism on levothyroxine and TSH every 6 months; a positive FIT
 * and a colonoscopy within 60 days; HbA1c above 9 % and a visit within 30
 * days), in English or Spanish. Any other request: it lists the rules,
 * looks the words up and abstains; the live model handles those.
 */
export const scriptedRuleAuthorResponder: FakeResponder = (request) => {
  if (request.output.name !== RULE_AUTHORING_ACTION_NAME) return undefined;
  const text = fold(requestOf(request));
  const done = request.messages.filter((message) => message.role === 'assistant').length;
  const recipe = RECIPES.find((candidate) => candidate.matches.test(text));
  const steps: readonly Step[] = recipe?.steps ?? [
    {
      thought: 'Listing what the clinic already tracks.',
      tool: 'list_existing_rules',
      args: { query: null, id: null },
    },
    {
      thought: 'Looking the request up in the catalogs.',
      tool: 'lookup_terminology',
      args: { query: text.slice(0, 80) || 'follow-up', system: null },
    },
    {
      thought: 'The scripted agent only drafts its three example requests.',
      tool: 'abstain',
      args: {
        reason:
          'The scripted agent only drafts the three example requests; run this one live with Muse Spark.',
      },
    },
  ];
  const next = steps[Math.min(done, steps.length - 1)];
  return next === undefined ? undefined : action(next);
};
