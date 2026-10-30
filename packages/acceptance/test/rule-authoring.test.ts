import {
  createMemoryStores,
  DEFAULT_CLINIC_SETTINGS,
  FakeNoteExtractor,
  FileEscalationPolicySource,
  FileProtocolSource,
  FileRuleSource,
  loadConfigDirectory,
  MemoryClinicDirectory,
  MemoryDatabase,
  MemoryUnitOfWork,
  SequentialIdGenerator,
} from '@follow-up-engine/adapter-memory';
import {
  type AuthoredDefinition,
  type ClinicId,
  clinicId,
  createFollowUpEngine,
  createRuleAuthoring,
  FakeClock,
  type FollowUpEngine,
  patientId,
  type RuleAuthoringService,
  validateAuthoredDraft,
} from '@follow-up-engine/core';
import {
  createFakeProvider,
  createLlmGateway,
  createRepositoryTerminology,
  createRuleAuthoringAgent,
  DEFAULT_PRICING,
  FAKE_RULE_AUTHOR_MODEL,
  InMemoryLlmUsageLog,
  RULE_AUTHORING_TASK,
  scriptedRuleAuthorResponder,
} from '@follow-up-engine/llm';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  conditionResource,
  encounterResource,
  observationResource,
  prescriptionResource,
  transactionOf,
} from '../src/bundles.ts';
import { ingestBundle } from '../src/harness.ts';

/**
 * The rule-authoring agent (docs/agent/rule-authoring.md), end to end on
 * the memory adapter: the scripted agent drafts the three example requests
 * through the real loop, validator and dry run; code rejects invented
 * codes; the dry run counts what the real engine would create on a seeded
 * clinic and writes nothing; a draft never runs until a clinician enables
 * it; one clinic's rules never reach another.
 */

const FIT_RULE = 'clinic_positive_fit_colonoscopy';
const TSH_PROTOCOL = 'clinic_hypothyroidism_tsh_6m';
const EXAMPLES = {
  hypothyroidism: 'Para mis pacientes con hipotiroidismo en levotiroxina, TSH cada 6 meses',
  fit: 'After a positive FIT, colonoscopy within 60 days',
  hba1c: 'If HbA1c comes back above 9%, a control visit within 30 days',
} as const;
const DR = 'dr-ruiz';
const PROTOCOL_IDS = loadConfigDirectory().protocols.map((protocol) => protocol.id);

interface World {
  readonly engine: FollowUpEngine;
  readonly authoring: RuleAuthoringService;
  readonly clock: FakeClock;
  readonly unitOfWork: MemoryUnitOfWork;
}

/** One database, one engine, several clinics: as the API runs them. */
function world(clinics: readonly ClinicId[]): World {
  const clock = new FakeClock(BASE_DATE);
  const db = new MemoryDatabase();
  const stores = createMemoryStores(db, clock);
  const unitOfWork = new MemoryUnitOfWork(db, stores);
  const directory = new MemoryClinicDirectory(
    clinics.map((id) => ({
      clinic: {
        id,
        name: `Clinic ${id}`,
        active: true,
        settings: { ...DEFAULT_CLINIC_SETTINGS, enabledProtocols: PROTOCOL_IDS },
      },
    })),
  );
  const engine = createFollowUpEngine({
    unitOfWork,
    ruleOverrides: stores.ruleOverrides,
    noteExtractor: new FakeNoteExtractor(),
    rules: new FileRuleSource(),
    protocols: new FileProtocolSource(),
    escalationPolicies: new FileEscalationPolicySource(),
    clinics: directory,
    clock,
    ids: new SequentialIdGenerator(),
  });
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond: scriptedRuleAuthorResponder }) },
    tasks: {
      [RULE_AUTHORING_TASK]: { route: [{ provider: 'fake', model: FAKE_RULE_AUTHOR_MODEL }] },
    },
    usageLog: new InMemoryLlmUsageLog(),
    pricing: DEFAULT_PRICING,
    retry: { maxAttempts: 1 },
  });
  const agent = createRuleAuthoringAgent({ gateway });
  const authoring = createRuleAuthoring({
    catalog: (id) => engine.catalog(id),
    authoredRules: engine.authoredRules,
    agents: { live: agent, scripted: agent },
    terminology: createRepositoryTerminology(),
    clock,
  });
  return { engine, authoring, clock, unitOfWork };
}

let sequence = 0;
function next(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence)}`;
}

async function ingest(w: World, clinic: ClinicId, bundle: unknown, day: number): Promise<void> {
  await ingestBundle(
    { clinicId: clinic, unitOfWork: w.unitOfWork, engine: w.engine },
    bundle,
    dayToDate(day),
  );
}

async function fitResult(
  w: World,
  clinic: ClinicId,
  patient: string,
  day: number,
  positive: boolean,
): Promise<void> {
  const encounter = next('enc');
  await ingest(
    w,
    clinic,
    transactionOf(
      encounterResource({
        id: encounter,
        patientId: patient,
        specialty: 'internal_medicine',
        at: dayToDate(day),
      }),
      observationResource({
        id: next('obs-fit'),
        patientId: patient,
        loinc: '29771-3',
        value: positive ? 1 : 0,
        unit: '{presence}',
        interpretation: positive ? 'H' : 'N',
        encounterId: encounter,
        at: dayToDate(day),
      }),
    ),
    day,
  );
}

async function colonoscopy(
  w: World,
  clinic: ClinicId,
  patient: string,
  day: number,
): Promise<void> {
  await ingest(
    w,
    clinic,
    transactionOf(
      observationResource({
        id: next('obs-colonoscopy'),
        patientId: patient,
        loinc: '18746-8',
        value: 0,
        unit: '{finding}',
        interpretation: 'N',
        at: dayToDate(day),
      }),
    ),
    day,
  );
}

async function hypothyroid(
  w: World,
  clinic: ClinicId,
  patient: string,
  options: { readonly levothyroxineDay?: number; readonly tshDay: number },
): Promise<void> {
  const day = Math.min(options.tshDay, options.levothyroxineDay ?? options.tshDay) - 5;
  await ingest(
    w,
    clinic,
    transactionOf(
      conditionResource({
        id: next('cond'),
        patientId: patient,
        icd10: 'E03.9',
        verification: 'confirmed',
        at: dayToDate(day),
      }),
    ),
    day,
  );
  if (options.levothyroxineDay !== undefined) {
    await ingest(
      w,
      clinic,
      transactionOf(
        prescriptionResource({
          id: next('rx'),
          patientId: patient,
          text: 'Levotiroxina 100 mcg',
          durationDays: 180,
          at: dayToDate(options.levothyroxineDay),
        }),
      ),
      options.levothyroxineDay,
    );
  }
  await ingest(
    w,
    clinic,
    transactionOf(
      observationResource({
        id: next('obs-tsh'),
        patientId: patient,
        loinc: '3016-3',
        value: 2.1,
        unit: 'mIU/L',
        interpretation: 'N',
        at: dayToDate(options.tshDay),
      }),
    ),
    options.tshDay,
  );
}

async function expectationsOf(w: World, clinic: ClinicId, patient: string) {
  return w.unitOfWork.withTransaction(clinic, (stores) =>
    stores.expectations.listByPatient(clinic, patientId(patient)),
  );
}

async function draftOf(w: World, clinic: ClinicId, request: string) {
  const outcome = await w.authoring.draft(clinic, { request, mode: 'scripted', actor: DR });
  if (outcome.status !== 'drafted') {
    throw new Error(`no draft: ${outcome.reason} ${outcome.issues.join('; ')}`);
  }
  return outcome;
}

describe('rule authoring: the scripted agent on the three examples', () => {
  it('drafts each one valid on the first try, through every tool, and stores it as a draft', async () => {
    const clinic = clinicId('authoring-examples');
    const w = world([clinic]);
    for (const request of Object.values(EXAMPLES)) {
      const outcome = await draftOf(w, clinic, request);
      expect(outcome.rule.authored.status).toBe('draft');
      expect(outcome.rule.live).toBe(false);
      expect(outcome.rule.authored.provenance.firstValidationPassed).toBe(true);
      expect(outcome.rule.authored.request).toBe(request);
      const tools = outcome.run.trace.map((step) => step.tool);
      expect(tools[0]).toBe('list_existing_rules');
      expect(tools).toContain('lookup_terminology');
      expect(tools.slice(-3)).toEqual(['validate_rule', 'dry_run_rule', 'submit_draft']);
      expect(outcome.run.trace.every((step) => step.outcome === 'ok')).toBe(true);
      expect(outcome.rule.authored.provenance.terminology.length).toBeGreaterThan(0);
    }
    const listed = await w.engine.authoredRules.list(clinic);
    expect(listed.map((rule) => rule.ruleId).sort()).toEqual(
      ['clinic_hba1c_above_9_visit', TSH_PROTOCOL, FIT_RULE].sort(),
    );
    // None of them runs: the catalog is the versioned one.
    const catalog = await w.engine.catalog(clinic);
    expect(catalog.rules.some((rule) => rule.id.startsWith('clinic_'))).toBe(false);
    expect(catalog.protocols.some((protocol) => protocol.id.startsWith('clinic_'))).toBe(false);
  });

  it('abstains on a request that is not a follow-up rule', async () => {
    const clinic = clinicId('authoring-abstain');
    const w = world([clinic]);
    const outcome = await w.authoring.draft(clinic, {
      request: 'Send a WhatsApp to every diabetic telling them their results',
      mode: 'scripted',
      actor: DR,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.reason : undefined).toBe('abstained');
    expect(await w.engine.authoredRules.list(clinic)).toEqual([]);
  });
});

describe('rule authoring: validation is code, not the model', () => {
  const clinic = clinicId('authoring-validation');
  const w = world([clinic]);

  async function validate(kind: 'rule' | 'protocol', definition: Record<string, unknown>) {
    const catalog = await w.engine.catalog(clinic);
    return validateAuthoredDraft(
      { kind, definition },
      {
        terminology: createRepositoryTerminology(),
        catalog,
        authoredIds: new Set(),
        knownSources: catalog.protocols.flatMap((protocol) => protocol.sources),
        now: BASE_DATE,
      },
    );
  }

  const fitRule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: FIT_RULE,
    version: '1.0.0',
    layer: 'universal',
    description: 'Positive FIT, colonoscopy within 60 days',
    reason: { code: FIT_RULE, label: 'Colonoscopy after a positive FIT' },
    trigger: {
      event: 'result.received',
      filter: { 'code.code': ['29771-3'], interpretation: 'abnormal' },
    },
    dueInDays: 60,
    expects: 'imaging',
    fulfilledBy: [{ event: 'result.received', filter: { 'code.code': ['18746-8'] }, match: 'any' }],
    priority: 50,
    escalationPolicy: 'default_v1',
    suggestedAction: { code: 'order_follow_up_study', label: 'Order a colonoscopy' },
    ...overrides,
  });

  it('accepts a draft whose every code the catalogs know', async () => {
    const result = await validate('rule', fitRule());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.terminology.map((citation) => citation.code).sort()).toEqual([
      '18746-8',
      '29771-3',
    ]);
  });

  it('rejects an invented LOINC, ICD-10 or ATC code', async () => {
    const invented = await validate(
      'rule',
      fitRule({
        fulfilledBy: [
          { event: 'result.received', filter: { 'code.code': ['99999-9'] }, match: 'any' },
        ],
      }),
    );
    expect(invented.ok).toBe(false);
    expect(invented.issues.join('\n')).toContain('unknown LOINC code "99999-9"');

    const protocol = await validate('protocol', {
      id: 'clinic_invented',
      version: '1.0.0',
      status: 'draft',
      description: 'Invented codes',
      reason: { code: 'protocol_clinic_invented', label: 'Invented' },
      enrollment: {
        conditionCodes: ['X99'],
        minimumStatus: 'probable',
        activeTreatment: { atc: ['Z99ZZ'] },
      },
      items: [
        {
          key: 'tsh',
          kind: 'lab',
          code: { system: 'http://loinc.org', code: '3016-3' },
          reason: { code: 'protocol_clinic_invented_tsh', label: 'TSH' },
          everyDays: 182,
          fulfilledBy: [
            { event: 'result.received', filter: { 'code.code': ['3016-3'] }, match: 'any' },
          ],
          priority: 30,
          suggestedAction: { code: 'order_lab', label: 'Order TSH' },
        },
      ],
      escalationPolicy: 'default_v1',
    });
    const issues = protocol.issues.join('\n');
    expect(protocol.ok).toBe(false);
    expect(issues).toContain('unknown ICD10 code "X99"');
    expect(issues).toContain('unknown ATC code "Z99ZZ"');
  });

  it('rejects an insane interval, fulfillment by another test, an existing id and an unknown field', async () => {
    const result = await validate(
      'rule',
      fitRule({
        id: 'lab_order_result_pending',
        reason: { code: 'lab_order_result_pending', label: 'x' },
        dueInDays: 5000,
        trigger: {
          event: 'result.received',
          filter: { 'code.code': ['29771-3'], patientName: 'x' },
        },
        fulfilledBy: [
          { event: 'result.received', filter: { 'code.code': ['3016-3'] }, match: 'any' },
        ],
      }),
    );
    const issues = result.issues.join('\n');
    expect(result.ok).toBe(false);
    expect(issues).toContain('starts with "clinic_"');
    expect(issues).toContain('is an existing rule');
    expect(issues).toContain('outside the sane range');
    expect(issues).toContain('may only test');
    expect(issues).toContain('the fulfilling test is lab, not imaging');
  });
});

describe('rule authoring: the dry run on a seeded clinic', () => {
  it('counts what the real engine would create, overdue first, and writes nothing', async () => {
    const clinic = clinicId('authoring-dry-run');
    const w = world([clinic]);
    // FIT: P1 positive and nothing since (overdue), P2 positive then a
    // colonoscopy (fulfilled), P3 negative (nothing).
    await fitResult(w, clinic, 'p1', -90, true);
    await fitResult(w, clinic, 'p2', -100, true);
    await colonoscopy(w, clinic, 'p2', -60);
    await fitResult(w, clinic, 'p3', -50, false);
    // Hypothyroidism: P4 on levothyroxine, last TSH 250 days ago (overdue);
    // P5 on levothyroxine, TSH a month ago (on time); P6 not on it (not enrolled).
    await hypothyroid(w, clinic, 'p4', { levothyroxineDay: -30, tshDay: -250 });
    await hypothyroid(w, clinic, 'p5', { levothyroxineDay: -40, tshDay: -30 });
    await hypothyroid(w, clinic, 'p6', { tshDay: -250 });

    const before = await Promise.all(
      ['p1', 'p2', 'p4', 'p5'].map((p) => expectationsOf(w, clinic, p)),
    );
    const fit = await draftOf(w, clinic, EXAMPLES.fit);
    const fitRun = fit.rule.authored.provenance.dryRun;
    expect(fitRun.patientsScanned).toBe(6);
    expect(fitRun.patientsMatched).toBe(2);
    expect(fitRun.expectations).toEqual({ total: 2, open: 0, overdue: 1, closed: 1 });
    expect(fitRun.examples[0]).toMatchObject({ status: 'overdue', dueInDays: -30 });
    expect(fitRun.examples.every((example) => /^P-[0-9a-f]{6}$/.test(example.patientRef))).toBe(
      true,
    );

    const tsh = await draftOf(w, clinic, EXAMPLES.hypothyroidism);
    const tshRun = tsh.rule.authored.provenance.dryRun;
    expect(tshRun.patientsMatched).toBe(2);
    expect(tshRun.expectations.overdue).toBeGreaterThanOrEqual(1);
    expect(tshRun.expectations.open).toBeGreaterThanOrEqual(1);
    // The existing hypothyroidism protocol already asks P4 and P5 for a TSH.
    expect(tshRun.overlaps.byRule.map((item) => item.ruleId)).toContain(
      'protocol_hypothyroidism_tsh',
    );

    const after = await Promise.all(
      ['p1', 'p2', 'p4', 'p5'].map((p) => expectationsOf(w, clinic, p)),
    );
    expect(after).toEqual(before);
    expect(after.flat().some((expectation) => expectation.ruleId.includes('clinic_'))).toBe(false);
  });
});

describe('rule authoring: a draft never runs until a clinician enables it', () => {
  it('drafts nothing as a draft, runs once enabled (validatedBy kept), stops when switched off', async () => {
    const clinic = clinicId('authoring-enable');
    const w = world([clinic]);
    await draftOf(w, clinic, EXAMPLES.fit);

    w.clock.set(dayToDate(1));
    await fitResult(w, clinic, 'q1', 1, true);
    expect((await expectationsOf(w, clinic, 'q1')).some((e) => e.ruleId === FIT_RULE)).toBe(false);

    w.clock.set(dayToDate(2));
    const enabled = await w.engine.authoredRules.enable(clinic, FIT_RULE, { actor: 'dra-mendez' });
    expect(enabled.rule?.live).toBe(true);
    expect(enabled.rule?.authored.validatedBy).toBe('dra-mendez');
    expect(enabled.rule?.authored.validatedAt).toBe(dayToDate(2).toISOString());
    const catalog = await w.engine.catalog(clinic);
    expect(catalog.rules.find((rule) => rule.id === FIT_RULE)?.version).toBe('1.0.0+clinic.2');
    // Not retroactive: the earlier positive FIT stays without an expectation.
    expect((await expectationsOf(w, clinic, 'q1')).some((e) => e.ruleId === FIT_RULE)).toBe(false);

    w.clock.set(dayToDate(3));
    await fitResult(w, clinic, 'q2', 3, true);
    const created = (await expectationsOf(w, clinic, 'q2')).find((e) => e.ruleId === FIT_RULE);
    expect(created?.ruleVersion).toBe('1.0.0+clinic.2');
    expect(created?.dueAt).toEqual(dayToDate(63));

    w.clock.set(dayToDate(4));
    await w.engine.authoredRules.discard(clinic, FIT_RULE, { actor: 'dra-mendez' });
    await fitResult(w, clinic, 'q3', 4, true);
    expect((await expectationsOf(w, clinic, 'q3')).some((e) => e.ruleId === FIT_RULE)).toBe(false);
    // Switched off, not forgotten: its expectation still closes under it.
    expect((await w.engine.catalog(clinic)).definition(FIT_RULE)).toBeDefined();
    await colonoscopy(w, clinic, 'q2', 5);
    expect((await expectationsOf(w, clinic, 'q2')).find((e) => e.ruleId === FIT_RULE)?.status).toBe(
      'fulfilled',
    );
  });

  it('discards a draft without a trace in the catalog, keeping it in the history', async () => {
    const clinic = clinicId('authoring-discard');
    const w = world([clinic]);
    await draftOf(w, clinic, EXAMPLES.hba1c);
    await w.engine.authoredRules.discard(clinic, 'clinic_hba1c_above_9_visit', { actor: DR });
    expect(await w.engine.authoredRules.list(clinic)).toEqual([]);
    const history = await w.engine.ruleOverrides.history(clinic, {
      ruleId: 'clinic_hba1c_above_9_visit',
    });
    expect(history.map((change) => change.action)).toEqual(['reset', 'set']);
    await expect(
      w.engine.authoredRules.enable(clinic, 'clinic_hba1c_above_9_visit', { actor: DR }),
    ).rejects.toThrow(/not found/);
  });
});

describe('rule authoring: tenant isolation', () => {
  it("never shows, runs or enables one clinic's rule in another", async () => {
    const a = clinicId('authoring-tenant-a');
    const b = clinicId('authoring-tenant-b');
    const w = world([a, b]);
    await fitResult(w, b, 'b1', -90, true);
    const draft = await draftOf(w, a, EXAMPLES.fit);
    // A's dry run only sees A's records: B's positive FIT is not counted.
    expect(draft.rule.authored.provenance.dryRun.patientsScanned).toBe(0);
    await w.engine.authoredRules.enable(a, FIT_RULE, { actor: DR });

    expect(await w.engine.authoredRules.list(b)).toEqual([]);
    expect(await w.engine.authoredRules.get(b, FIT_RULE)).toBeUndefined();
    expect((await w.engine.catalog(b)).definition(FIT_RULE)).toBeUndefined();
    await expect(w.engine.authoredRules.enable(b, FIT_RULE, { actor: DR })).rejects.toThrow(
      /not found/,
    );
    w.clock.set(dayToDate(1));
    await fitResult(w, b, 'b2', 1, true);
    expect((await expectationsOf(w, b, 'b2')).some((e) => e.ruleId === FIT_RULE)).toBe(false);

    const definition: AuthoredDefinition = draft.rule.authored.definition;
    const report = await w.engine.authoredRules.dryRun(b, definition);
    expect(report.patientsScanned).toBe(2);
    expect(report.patientsMatched).toBe(2);
  });
});
