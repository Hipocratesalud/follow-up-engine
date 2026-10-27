import type { CaseStatus, ExpectationStatus } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  caseEventToProvenance,
  caseToTask,
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  exportableConditions,
  expectationToTask,
  fhirToPatientCondition,
  isActiveCaseTask,
  patientConditionToFhir,
  qualityFindingToDetectedIssue,
  taskPriority,
  taskToCase,
  taskToExpectation,
  toSearchsetBundle,
  FhirRepresentationError,
  type Extension,
} from '../src/index.ts';
import {
  CLINIC,
  caseEvents,
  confirmedCondition,
  escalatedCase,
  expiredPlanExpectation,
  extractedCondition,
  noteWithoutPlan,
  openExpectation,
  rejectedCondition,
  resolvedCase,
  resolvedCondition,
  snoozedCase,
} from './domain-fixtures.ts';

function extension(
  extensions: readonly Extension[] | undefined,
  url: string,
): Extension | undefined {
  return extensions?.find((candidate) => candidate.url === url);
}

describe('expectation → Task', () => {
  it('maps an open universal expectation on an order', () => {
    const task = expectationToTask(openExpectation);
    expect(task).toMatchObject({
      resourceType: 'Task',
      id: 'exp-hba1c-0001',
      status: 'requested',
      intent: 'plan',
      businessStatus: { coding: [{ system: ENGINE_CODE_SYSTEMS.expectationStatus, code: 'open' }] },
      code: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.expectation, code: 'lab_order_result_pending' }],
        text: 'Lab result pending',
      },
      focus: { reference: 'ServiceRequest/sr-hba1c' },
      basedOn: [{ reference: 'ServiceRequest/sr-hba1c' }],
      for: { reference: 'Patient/pat-dm-0001' },
      restriction: { period: { end: '2026-01-26T12:00:00.000Z' } },
      authoredOn: '2026-01-05T12:00:00.000Z',
    });
    expect(task.partOf).toBeUndefined();
    expect(task.statusReason).toBeUndefined();
    expect(extension(task.extension, ENGINE_EXTENSIONS.layer)?.valueCode).toBe('universal');
    expect(extension(task.extension, ENGINE_EXTENSIONS.ruleVersion)?.valueString).toBe('1.0.0');
  });

  it('maps an expired doctor-plan expectation with its case, protocol and evidence', () => {
    const task = expectationToTask(expiredPlanExpectation);
    expect(task).toMatchObject({
      status: 'failed',
      businessStatus: { coding: [{ code: 'expired' }] },
      statusReason: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.closedReason, code: 'expired_unmet' }],
      },
      partOf: [{ reference: 'Task/case-0001' }],
      focus: { reference: 'DocumentReference/note-1' },
      executionPeriod: { end: '2026-04-06T00:00:00.000Z' },
    });
    expect(task.basedOn).toBeUndefined();
    expect(extension(task.extension, ENGINE_EXTENSIONS.origin)?.valueCode).toBe('backfill');
    expect(extension(task.extension, ENGINE_EXTENSIONS.protocolId)?.valueString).toBe('diabetes');
    expect(extension(task.extension, ENGINE_EXTENSIONS.evidence)?.extension).toEqual([
      { url: 'quote', valueString: 'Control en 3 meses con resultados.' },
      {
        url: 'source',
        valueReference: { reference: 'DocumentReference/note-1', type: 'DocumentReference' },
      },
    ]);
  });

  it.each<[ExpectationStatus, string]>([
    ['open', 'requested'],
    ['fulfilled', 'completed'],
    ['superseded', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['expired', 'failed'],
  ])('status %s → Task.status %s, businessStatus keeps the exact state', (status, fhirStatus) => {
    const task = expectationToTask({ ...openExpectation, status });
    expect(task.status).toBe(fhirStatus);
    expect(task.businessStatus?.coding?.[0]?.code).toBe(status);
  });

  it.each([openExpectation, expiredPlanExpectation])(
    'round-trips losslessly (%#)',
    (expectation) => {
      expect(taskToExpectation(expectationToTask(expectation), CLINIC)).toEqual(expectation);
    },
  );
});

describe('case → Task', () => {
  it('maps an escalated, assigned backfill case', () => {
    const task = caseToTask(escalatedCase);
    expect(task).toMatchObject({
      resourceType: 'Task',
      id: 'case-0001',
      status: 'in-progress',
      intent: 'proposal',
      priority: 'urgent',
      businessStatus: { coding: [{ system: ENGINE_CODE_SYSTEMS.caseStatus, code: 'escalated' }] },
      code: { coding: [{ system: ENGINE_CODE_SYSTEMS.taskType, code: 'follow-up-case' }] },
      for: { reference: 'Patient/pat-dm-0001' },
      owner: { identifier: { value: 'user-reception-1' } },
      input: [
        {
          type: { coding: [{ system: ENGINE_CODE_SYSTEMS.reason, code: 'doctor_plan_followup' }] },
          valueReference: { reference: 'Task/exp-plan-0002' },
        },
        {
          type: { coding: [{ code: 'lab_order_result_pending' }] },
          valueReference: { reference: 'Task/exp-hba1c-0001' },
        },
      ],
    });
    expect(extension(task.extension, ENGINE_EXTENSIONS.escalationStep)?.valueInteger).toBe(1);
    expect(extension(task.extension, ENGINE_EXTENSIONS.releaseAt)?.valueDateTime).toBe(
      '2026-04-06T12:00:00.000Z',
    );
    expect(isActiveCaseTask(task)).toBe(true);
  });

  it('maps a resolution to statusReason, execution end and the resolution extension', () => {
    const task = caseToTask(resolvedCase);
    expect(task).toMatchObject({
      status: 'completed',
      statusReason: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.caseResolution, code: 'handled_outside' }],
      },
      executionPeriod: { end: '2026-04-10T15:00:00.000Z' },
      priority: 'routine',
    });
    expect(extension(task.extension, ENGINE_EXTENSIONS.resolution)?.extension).toEqual([
      { url: 'kind', valueCode: 'handled_outside' },
      { url: 'resolvedAt', valueDateTime: '2026-04-10T15:00:00.000Z' },
      { url: 'resolvedBy', valueString: 'user-doctor-7' },
      { url: 'note', valueString: 'Se controló en otra sede.' },
    ]);
    expect(isActiveCaseTask(task)).toBe(false);
  });

  it.each<[CaseStatus, string]>([
    ['open', 'ready'],
    ['notified', 'ready'],
    ['snoozed', 'on-hold'],
    ['escalated', 'in-progress'],
    ['resolved', 'completed'],
    ['dismissed', 'cancelled'],
    ['lost_to_follow_up', 'failed'],
  ])('status %s → Task.status %s', (status, fhirStatus) => {
    const task = caseToTask({ ...escalatedCase, status });
    expect(task.status).toBe(fhirStatus);
    expect(task.businessStatus?.coding?.[0]?.code).toBe(status);
  });

  it.each([
    [0, 'routine'],
    [59, 'routine'],
    [60, 'urgent'],
    [75, 'asap'],
    [90, 'stat'],
    [150, 'stat'],
  ] as const)('priority %i → %s', (priority, expected) => {
    expect(taskPriority(priority)).toBe(expected);
  });

  it.each([escalatedCase, resolvedCase, snoozedCase])(
    'round-trips losslessly (%#)',
    (followUpCase) => {
      expect(taskToCase(caseToTask(followUpCase), CLINIC)).toEqual(followUpCase);
    },
  );

  it('refuses to read an expectation Task as a case', () => {
    expect(() => taskToCase(expectationToTask(openExpectation), CLINIC)).toThrow(
      FhirRepresentationError,
    );
  });
});

describe('patient condition → Condition', () => {
  it('maps an extracted condition as provisional with confidence and the quote', () => {
    const condition = patientConditionToFhir(extractedCondition);
    expect(condition).toMatchObject({
      resourceType: 'Condition',
      id: 'pat-dm-0001-E11.9',
      verificationStatus: { coding: [{ code: 'provisional' }] },
      clinicalStatus: { coding: [{ code: 'active' }] },
      category: [{ coding: [{ code: 'problem-list-item' }] }],
      code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' }] },
      subject: { reference: 'Patient/pat-dm-0001' },
      evidence: [{ detail: [{ reference: 'DocumentReference/note-1' }] }],
    });
    expect(extension(condition.extension, ENGINE_EXTENSIONS.confidence)?.valueDecimal).toBe(0.86);
    expect(
      extension(condition.extension, ENGINE_EXTENSIONS.evidence)?.extension?.[0]?.valueString,
    ).toBe('DM2');
  });

  it('maps confirmed and resolved conditions', () => {
    expect(patientConditionToFhir(confirmedCondition).verificationStatus?.coding?.[0]?.code).toBe(
      'confirmed',
    );
    expect(patientConditionToFhir(resolvedCondition).clinicalStatus?.coding?.[0]?.code).toBe(
      'resolved',
    );
  });

  it('maps a rejected condition as refuted, never confirmed, naming who refuted it', () => {
    const condition = patientConditionToFhir(rejectedCondition);
    expect(condition.verificationStatus?.coding?.[0]?.code).toBe('refuted');
    expect(condition.clinicalStatus?.coding?.[0]?.code).toBe('inactive');
    expect(extension(condition.extension, ENGINE_EXTENSIONS.confirmedBy)).toBeUndefined();
    expect(extension(condition.extension, ENGINE_EXTENSIONS.refutedBy)?.valueString).toBe(
      'user-doctor-7',
    );
  });

  it('does not export a provisional code subsumed by a confirmed, more specific one', () => {
    const icd10 = 'http://hl7.org/fhir/sid/icd-10';
    const parent = { ...extractedCondition, code: { system: icd10, code: 'E11' } };
    const child = { ...extractedCondition, code: { system: icd10, code: 'E11.9' } };
    const confirmedChild = { ...child, status: 'confirmed' as const, confidence: 1 };
    const unrelated = { ...extractedCondition, code: { system: icd10, code: 'I10' } };
    expect(exportableConditions([parent, confirmedChild, unrelated])).toEqual([
      confirmedChild,
      unrelated,
    ]);
    // Without a confirmed child the provisional parent stays, and so does a refuted one.
    expect(exportableConditions([parent, child])).toEqual([parent, child]);
    const refutedParent = { ...rejectedCondition, code: { system: icd10, code: 'E11' } };
    expect(exportableConditions([refutedParent, confirmedChild])).toEqual([
      refutedParent,
      confirmedChild,
    ]);
  });

  it.each([extractedCondition, confirmedCondition, resolvedCondition, rejectedCondition])(
    'round-trips losslessly (%#)',
    (condition) => {
      const fhir = patientConditionToFhir(condition);
      expect(fhirToPatientCondition(fhir, CLINIC)).toEqual({ ...condition, id: fhir.id });
    },
  );
});

describe('quality finding → DetectedIssue', () => {
  it('flags a note without plan for the clinician', () => {
    expect(qualityFindingToDetectedIssue(noteWithoutPlan)).toEqual({
      resourceType: 'DetectedIssue',
      id: 'qf-0001',
      status: 'preliminary',
      code: {
        coding: [
          {
            system: ENGINE_CODE_SYSTEMS.qualityFinding,
            code: 'note-without-plan',
            display: 'Clinical note without a follow-up plan',
          },
        ],
        text: 'Clinical note without a follow-up plan',
      },
      severity: 'low',
      patient: { reference: 'Patient/pat-dm-0001', type: 'Patient' },
      identifiedDateTime: '2026-01-05T12:01:00.000Z',
      implicated: [{ reference: 'DocumentReference/note-2', type: 'DocumentReference' }],
    });
  });
});

describe('case event → Provenance', () => {
  it('targets the case Task and names the agent by actor type', () => {
    const [opened, escalated, assigned, dismissed] = caseEvents.map(caseEventToProvenance);
    expect(opened).toMatchObject({
      target: [{ reference: 'Task/case-0001' }],
      recorded: '2026-04-06T00:00:00.000Z',
      activity: { coding: [{ system: ENGINE_CODE_SYSTEMS.caseEvent, code: 'opened' }] },
      agent: [{ who: { type: 'Device', identifier: { value: 'doctor_plan_followup' } } }],
    });
    expect(extension(opened?.extension, ENGINE_EXTENSIONS.caseEventPayload)?.valueString).toBe(
      '{"expectationIds":["exp-plan-0002"]}',
    );
    expect(escalated?.agent[0]?.who.display).toBe('Follow-up Engine');
    expect(assigned?.agent[0]?.who).toMatchObject({ identifier: { value: 'user-reception-1' } });
    expect(assigned?.extension).toBeUndefined();
    expect(dismissed?.agent[0]?.who).toEqual({ reference: 'Patient/pat-dm-0001', type: 'Patient' });
  });

  it('gives every event a distinct, valid id', () => {
    const ids = caseEvents.map((event) => caseEventToProvenance(event).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9\-.]{1,64}$/);
    }
  });
});

describe('searchset Bundle', () => {
  it('wraps resources with absolute fullUrls and paging links', () => {
    const bundle = toSearchsetBundle([caseToTask(escalatedCase), caseToTask(snoozedCase)], {
      baseUrl: 'https://engine.example.org/fhir/',
      total: 7,
      selfUrl: 'https://engine.example.org/fhir/Task?code=follow-up-case',
      nextUrl: 'https://engine.example.org/fhir/Task?code=follow-up-case&_cursor=abc',
    });
    expect(bundle).toMatchObject({
      resourceType: 'Bundle',
      type: 'searchset',
      total: 7,
      link: [{ relation: 'self' }, { relation: 'next' }],
    });
    expect(bundle.entry?.map((entry) => [entry.fullUrl, entry.search?.mode])).toEqual([
      ['https://engine.example.org/fhir/Task/case-0001', 'match'],
      ['https://engine.example.org/fhir/Task/case-0003', 'match'],
    ]);
  });

  it('an empty result has no entry array (FHIR forbids empty arrays)', () => {
    expect(toSearchsetBundle([])).toEqual({ resourceType: 'Bundle', type: 'searchset', total: 0 });
  });
});
