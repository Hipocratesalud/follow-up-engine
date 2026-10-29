import { randomUUID } from 'node:crypto';
import {
  type ClinicalEvent,
  type ClinicId,
  type Expectation,
  type FakeClock,
  type PatientId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  buildConsultationBundle,
  buildRecordBundle,
  type ConsultationDiagnosisInput,
  type ConsultationOrderInput,
  type ConsultationPrescriptionInput,
  type RecordEntryInput,
} from '@follow-up-engine/fhir';
import {
  type EngineRuntime,
  labIngestion,
  NOTE_EXTRACTION_TASK,
  ruleConfigOf,
} from '@follow-up-engine/runtime';
import type { ApiMessages } from '../i18n/index.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import type { EngineTestDef } from './engine-tests-catalog.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function plusDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** Everything a scenario needs: the evaluator's own lab clinic, its clock and the current patient. */
export interface ScenarioContext {
  readonly runtime: EngineRuntime;
  readonly clinicId: ClinicId;
  readonly clock: FakeClock;
  readonly evaluatorEmail: string;
  readonly t: ApiMessages;
  readonly patientId: PatientId;
  /** Moves the lab clinic's own clock forward (never the shared demo clock). */
  readonly advanceTo: (target: Date) => Promise<void>;
}

function withPatient(ctx: ScenarioContext, patientId: PatientId): ScenarioContext {
  return { ...ctx, patientId };
}

function freshPatient(): { readonly id: PatientId; readonly name: string } {
  return { id: toPatientId(`et-${randomUUID()}`), name: 'Engine test patient' };
}

export type ExpectationDiffTag =
  'new' | 'fulfilled' | 'superseded' | 'expired' | 'cancelled' | 'still_open';

export interface ExpectationRowView {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly layer: string;
  readonly label: string;
  readonly status: string;
  readonly dueAt: string;
  readonly diff: ExpectationDiffTag;
}

export interface TimelineEntryView {
  readonly type: string;
  readonly occurredAt: string;
  readonly source: 'rules' | 'ai';
  readonly detail: string;
  readonly llm?: { readonly provider: string; readonly model: string };
}

export interface AutoCheckView {
  readonly expected: string;
  readonly observed: string;
  readonly passed: boolean;
}

export interface RuleCardView {
  readonly ruleId: string;
  readonly layer: string;
  readonly version: string;
  readonly trigger: string;
  readonly fulfilledBy: readonly string[];
  readonly supersededBy: readonly string[];
  readonly escalationPolicy: string;
  readonly dueInDays: number;
}

export interface ScenarioOutcome {
  readonly timeline: readonly TimelineEntryView[];
  readonly expectations: readonly ExpectationRowView[];
  readonly autoCheck: AutoCheckView;
  readonly supported: boolean;
  readonly ruleCard?: RuleCardView;
}

// ---------------------------------------------------------------- helpers

async function ingestRecord(
  ctx: ScenarioContext,
  entry: RecordEntryInput,
  occurredAt: Date,
  patientName?: string,
) {
  const bundle = buildRecordBundle({
    recordId: `et-${randomUUID()}`,
    patient: { id: ctx.patientId, ...(patientName === undefined ? {} : { name: patientName }) },
    occurredAt,
    entry,
  });
  return labIngestion(ctx.runtime, ctx.clock).accept(ctx.clinicId, bundle, 'sync');
}

interface NoteOptions {
  readonly noteText: string;
  readonly occurredAt: Date;
  readonly specialty?: string;
  readonly patientName?: string;
  readonly orders?: readonly ConsultationOrderInput[];
  readonly prescriptions?: readonly ConsultationPrescriptionInput[];
  readonly diagnoses?: readonly ConsultationDiagnosisInput[];
}

async function ingestNote(ctx: ScenarioContext, options: NoteOptions) {
  const bundle = buildConsultationBundle({
    consultationId: `et-${randomUUID()}`,
    patient: {
      id: ctx.patientId,
      ...(options.patientName === undefined ? {} : { name: options.patientName }),
    },
    specialty: options.specialty ?? 'internal_medicine',
    occurredAt: options.occurredAt,
    noteText: options.noteText,
    ...(options.orders === undefined ? {} : { orders: options.orders }),
    ...(options.prescriptions === undefined ? {} : { prescriptions: options.prescriptions }),
    ...(options.diagnoses === undefined ? {} : { diagnoses: options.diagnoses }),
  });
  return labIngestion(ctx.runtime, ctx.clock).accept(ctx.clinicId, bundle, 'sync');
}

async function visitOnly(ctx: ScenarioContext, occurredAt: Date, patientName?: string) {
  return ingestRecord(ctx, { kind: 'visit' }, occurredAt, patientName);
}

async function snapshot(ctx: ScenarioContext): Promise<readonly Expectation[]> {
  return ctx.runtime.storage.stores.expectations.listByPatient(ctx.clinicId, ctx.patientId);
}

function tagOf(
  beforeById: ReadonlyMap<string, Expectation>,
  after: Expectation,
): ExpectationDiffTag {
  const prior = beforeById.get(after.id);
  if (prior === undefined) {
    return 'new';
  }
  if (after.status !== 'open') {
    return after.status;
  }
  return 'still_open';
}

/** Snapshots the patient's expectations after a step and tags each against `before`. */
async function finalize(
  ctx: ScenarioContext,
  before: readonly Expectation[],
): Promise<{ readonly raw: readonly Expectation[]; readonly view: readonly ExpectationRowView[] }> {
  const after = await snapshot(ctx);
  const beforeById = new Map(before.map((expectation) => [expectation.id, expectation]));
  const presenter = await InboxPresenter.create(ctx.runtime, ctx.clinicId, ctx.t);
  const sorted = [...after].sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  const view = sorted.map((expectation) => ({
    id: expectation.id,
    ruleId: expectation.ruleId,
    ruleVersion: expectation.ruleVersion,
    layer: expectation.layer,
    label: presenter.reasonLabel(expectation.ruleId, expectation),
    status: expectation.status,
    dueAt: expectation.dueAt.toISOString(),
    diff: tagOf(beforeById, expectation),
  }));
  return { raw: after, view };
}

function eventDetail(event: ClinicalEvent): string {
  switch (event.type) {
    case 'service_request.created':
      return `${event.code.display ?? event.code.code} (${event.code.code}), ${event.category}`;
    case 'result.received':
      return `${event.code.display ?? event.code.code} (${event.code.code}): ${event.interpretation}${
        event.value === undefined ? '' : ` ${String(event.value.value)}${event.value.unit ?? ''}`
      }`;
    case 'medication.prescribed':
      return `${event.medication.text}${
        event.durationDays === undefined ? '' : `, ${String(event.durationDays)} days`
      }`;
    case 'condition.recorded':
      return `${event.code.display ?? event.code.code} (${event.code.code}), ${event.verification}`;
    case 'encounter.finished':
      return 'Visit completed';
    case 'appointment.booked':
      return `Appointment booked for ${event.scheduledFor.toISOString().slice(0, 10)}`;
    case 'appointment.cancelled':
      return 'Appointment cancelled';
    case 'note.received':
      return 'Clinical note saved';
    case 'plan.extracted': {
      const items = event.items.map((item) => item.description).join(', ');
      return items === '' ? 'No follow-up plan found' : `Plan: ${items}`;
    }
    case 'allergy.recorded':
    case 'patient.language_recorded':
    case 'patient.opted_out':
    case 'record.withdrawn':
      return event.type;
  }
}

function eventSource(event: ClinicalEvent): 'rules' | 'ai' {
  if (event.type === 'note.received' || event.type === 'plan.extracted') {
    return 'ai';
  }
  if (event.type === 'condition.recorded' && event.source.resourceType === 'DocumentReference') {
    return 'ai';
  }
  return 'rules';
}

async function timelineOf(
  ctx: ScenarioContext,
  llm?: { readonly provider: string; readonly model: string },
): Promise<readonly TimelineEntryView[]> {
  const events = await ctx.runtime.storage.stores.clinicalRecords.listEventsForPatient(
    ctx.clinicId,
    ctx.patientId,
  );
  return events.map((event) => {
    const source = eventSource(event);
    return {
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      source,
      detail: eventDetail(event),
      ...(source === 'ai' && llm !== undefined ? { llm } : {}),
    };
  });
}

async function noteExtractionCalls(ctx: ScenarioContext): Promise<number> {
  const summary = await ctx.runtime.storage.llmUsage.summary(ctx.clinicId, new Date(0), {
    task: NOTE_EXTRACTION_TASK,
  });
  return summary.calls;
}

// ---------------------------------------------------------------- scenarios: data intake

async function structuredNoLlm(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  const callsBefore = await noteExtractionCalls(ctx);
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  await ingestRecord(
    ctx,
    { kind: 'prescription', text: 'Metformina 850mg', durationDays: 90 },
    day0,
  );
  await ingestRecord(
    ctx,
    { kind: 'result', loinc: '4548-4', display: 'HbA1c', value: 7.2, interpretation: 'abnormal' },
    plusDays(day0, 1),
  );
  const callsAfter = await noteExtractionCalls(ctx);
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const allRules = timeline.every((entry) => entry.source === 'rules');
  const newCalls = callsAfter - callsBefore;
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'Every event is read by rules; zero note-extraction calls',
      observed: `${String(timeline.length)} structured event(s), all read by rules; ${String(newCalls)} note-extraction call(s)`,
      passed: allRules && newCalls === 0,
    },
    supported: true,
  };
}

async function noteAiOncePerSave(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  const callsBefore = await noteExtractionCalls(ctx);
  await ingestNote(ctx, {
    noteText: 'Paciente con diabetes tipo 2. Control en 1 mes.',
    occurredAt: day0,
    patientName: 'Engine test patient',
  });
  const callsAfterSave = await noteExtractionCalls(ctx);
  await ctx.advanceTo(plusDays(ctx.clock.now(), 5));
  const callsAfterAdvance = await noteExtractionCalls(ctx);
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  const onSave = callsAfterSave - callsBefore;
  const onAdvance = callsAfterAdvance - callsAfterSave;
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: '1 note-extraction call on save, 0 more when the clock advances',
      observed: `${String(onSave)} call(s) on save, ${String(onAdvance)} more after advancing 5 days`,
      passed: onSave === 1 && onAdvance === 0,
    },
    supported: true,
  };
}

async function noteExtractionQuotes(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  const noteText =
    'Paciente con diabetes tipo 2. Se indica Metformina 850mg por 90 dias. Control en 1 mes.';
  const acceptance = await ingestNote(ctx, {
    noteText,
    occurredAt: day0,
    patientName: 'Engine test patient',
  });
  const note = (acceptance.reports ?? []).flatMap((report) => report.notes)[0];
  const extraction = note?.extraction;
  const hasCondition =
    extraction !== undefined &&
    extraction.conditions.length > 0 &&
    (extraction.conditions[0]?.evidenceQuote.length ?? 0) > 0;
  const hasMedication =
    extraction !== undefined &&
    extraction.medications.length > 0 &&
    (extraction.medications[0]?.evidenceQuote.length ?? 0) > 0;
  const hasPlan =
    extraction !== undefined &&
    extraction.planItems.length > 0 &&
    (extraction.planItems[0]?.evidenceQuote.length ?? 0) > 0;
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'A diagnosis (ICD-10), a medication and a plan item, each with a verbatim quote',
      observed:
        extraction === undefined
          ? 'No extraction was recorded'
          : `${String(extraction.conditions.length)} diagnosis, ${String(extraction.medications.length)} medication, ${String(extraction.planItems.length)} plan item(s); quotes: diagnosis=${String(hasCondition)}, medication=${String(hasMedication)}, plan=${String(hasPlan)}`,
      passed: hasCondition && hasMedication && hasPlan,
    },
    supported: true,
  };
}

async function planItemConfirm(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await ingestNote(ctx, {
    noteText: 'Paciente estable. Control en 1 mes.',
    occurredAt: day0,
    patientName: 'Engine test patient',
  });
  const afterNote = await snapshot(ctx);
  const planExpectation = afterNote.find((expectation) => expectation.layer === 'doctor_plan');
  let confirmedBy: string | undefined;
  if (planExpectation !== undefined) {
    const result = await ctx.runtime.engine.planItems.confirm(
      ctx.clinicId,
      planExpectation.id,
      ctx.evaluatorEmail,
    );
    confirmedBy = result.expectation.confirmedBy;
  }
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'The plan item is marked confirmed by the evaluator with one call',
      observed:
        planExpectation === undefined
          ? 'No doctor-plan expectation was created to confirm'
          : `confirmedBy = ${confirmedBy ?? 'none'}`,
      passed: confirmedBy === ctx.evaluatorEmail,
    },
    supported: true,
  };
}

async function conditionInferred(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'prescription', text: 'Metformina 850mg', durationDays: 90 },
    day0,
    'Engine test patient',
  );
  const medConditions = await ctx.runtime.storage.stores.conditions.listByPatient(
    ctx.clinicId,
    ctx.patientId,
  );
  const fromMedication = medConditions.some(
    (condition) =>
      condition.sourceType === 'inferred_from_medication' && condition.code.code.startsWith('E1'),
  );

  const second = freshPatient();
  const secondCtx = withPatient(ctx, second.id);
  await ingestRecord(
    secondCtx,
    { kind: 'result', loinc: '4548-4', display: 'HbA1c', value: 7.0, interpretation: 'abnormal' },
    day0,
    second.name,
  );
  const resultConditions = await ctx.runtime.storage.stores.conditions.listByPatient(
    ctx.clinicId,
    second.id,
  );
  const fromResult = resultConditions.some(
    (condition) =>
      condition.sourceType === 'inferred_from_result' && condition.code.code.startsWith('E1'),
  );

  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  return {
    timeline,
    expectations,
    autoCheck: {
      expected:
        'A diabetes condition is inferred both from a metformin prescription and from an HbA1c >= 6.5 result',
      observed: `from medication: ${String(fromMedication)}; from result: ${String(fromResult)}`,
      passed: fromMedication && fromResult,
    },
    supported: true,
  };
}

// ---------------------------------------------------------------- scenarios: expectations

async function expectationHasDueDate(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const created = expectations.find((expectation) => expectation.diff === 'new');
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'The order creates an expectation with a concrete due date',
      observed: created === undefined ? 'No expectation was created' : `Due at ${created.dueAt}`,
      passed: created !== undefined && created.dueAt.length > 0,
    },
    supported: true,
  };
}

async function universalLayer(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  await ingestRecord(
    ctx,
    { kind: 'prescription', text: 'Amoxicilina 500mg', durationDays: 7 },
    day0,
  );
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const order = expectations.find(
    (expectation) => expectation.ruleId === 'lab_order_result_pending',
  );
  const treatment = expectations.find(
    (expectation) => expectation.ruleId === 'short_treatment_followup',
  );
  return {
    timeline,
    expectations,
    autoCheck: {
      expected:
        'An order with no result and a short treatment with no control each open a universal-layer expectation',
      observed: `lab_order_result_pending: ${order?.status ?? 'missing'}; short_treatment_followup: ${treatment?.status ?? 'missing'}`,
      passed: order?.status === 'open' && treatment?.status === 'open',
    },
    supported: true,
  };
}

async function doctorPlanLayer(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await ingestNote(ctx, {
    noteText: 'Paciente estable. Control en 1 mes.',
    occurredAt: day0,
    patientName: 'Engine test patient',
  });
  const { view: expectations, raw } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  const planRaw = raw.find((expectation) => expectation.layer === 'doctor_plan');
  const days = planRaw === undefined ? undefined : daysBetween(day0, planRaw.dueAt);
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'The doctor\'s plan "control en 1 mes" opens an expectation due in about 30 days',
      observed:
        planRaw === undefined
          ? 'No doctor-plan expectation was created'
          : `Due in ${String(days)} day(s)`,
      passed: days !== undefined && days >= 25 && days <= 35,
    },
    supported: true,
  };
}

async function cadenceBreak(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const day0 = ctx.clock.now();
  await visitOnly(ctx, day0, 'Engine test patient');
  const visit2At = plusDays(day0, 30);
  await ctx.advanceTo(visit2At);
  const before = await snapshot(ctx);
  await visitOnly(ctx, visit2At);
  const { view: expectations, raw } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const cadenceRaw = raw.find((expectation) => expectation.ruleId === 'cadence_break');
  let becameCase = false;
  if (cadenceRaw !== undefined) {
    await ctx.advanceTo(plusDays(cadenceRaw.dueAt, 1));
    const refreshed = await ctx.runtime.storage.stores.expectations.get(
      ctx.clinicId,
      cadenceRaw.id,
    );
    becameCase = refreshed?.status === 'expired' && refreshed.caseId !== undefined;
  }

  const onlyOne = freshPatient();
  const onlyOneCtx = withPatient(ctx, onlyOne.id);
  await visitOnly(onlyOneCtx, day0, onlyOne.name);
  const onlyOneExpectations = await ctx.runtime.storage.stores.expectations.listByPatient(
    ctx.clinicId,
    onlyOne.id,
  );
  const noCadenceWithOneVisit = !onlyOneExpectations.some(
    (expectation) => expectation.ruleId === 'cadence_break',
  );

  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'Two prior visits and a broken rhythm open a case; one visit alone opens nothing',
      observed: `cadence expectation after 2 visits: ${String(cadenceRaw !== undefined)}; became a case: ${String(becameCase)}; nothing with 1 visit: ${String(noCadenceWithOneVisit)}`,
      passed: cadenceRaw !== undefined && becameCase && noCadenceWithOneVisit,
    },
    supported: true,
  };
}

async function enrollDiabetesWithPlan(ctx: ScenarioContext, day0: Date): Promise<void> {
  await ingestNote(ctx, {
    noteText: 'Paciente con diabetes tipo 2. Control de HbA1c en 2 meses.',
    occurredAt: day0,
    patientName: 'Engine test patient',
    diagnoses: [{ icd10: 'E11', display: 'Type 2 diabetes mellitus', verification: 'confirmed' }],
  });
  // A visit a few days later lets the protocol layer schedule what the plan left open.
  await visitOnly(ctx, plusDays(day0, 2));
}

async function protocolFillsGaps(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await enrollDiabetesWithPlan(ctx, day0);
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  const protocolLayer = expectations.filter((expectation) => expectation.layer === 'protocol');
  return {
    timeline,
    expectations,
    autoCheck: {
      expected:
        "The diabetes protocol fills what the doctor's plan did not cover (lipid panel, fundus exam, routine visit)",
      observed: `protocol-layer expectations: ${protocolLayer.map((expectation) => expectation.ruleId).join(', ') || 'none'}`,
      passed: protocolLayer.length > 0,
    },
    supported: true,
  };
}

async function planBeatsProtocol(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await enrollDiabetesWithPlan(ctx, day0);
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  const planHba1c = expectations.find((expectation) => expectation.layer === 'doctor_plan');
  const protocolHba1c = expectations.find(
    (expectation) => expectation.layer === 'protocol' && expectation.ruleId.includes('hba1c'),
  );
  return {
    timeline,
    expectations,
    autoCheck: {
      expected:
        "The doctor's own HbA1c control wins; the protocol does not open a second one for the same test",
      observed: `doctor_plan expectation: ${String(planHba1c !== undefined)}; protocol hba1c expectation: ${String(protocolHba1c !== undefined)}`,
      passed: planHba1c !== undefined && protocolHba1c === undefined,
    },
    supported: true,
  };
}

async function autoCloseFulfilled(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  const before = await snapshot(ctx);
  await ingestRecord(
    ctx,
    { kind: 'result', loinc: '4548-4', display: 'HbA1c', value: 6.0, interpretation: 'normal' },
    plusDays(day0, 3),
  );
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const target = expectations.find(
    (expectation) => expectation.ruleId === 'lab_order_result_pending',
  );
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'The result closes the order automatically: fulfilled, no human action',
      observed: `status = ${target?.status ?? 'missing'}`,
      passed: target?.status === 'fulfilled' && target.diff === 'fulfilled',
    },
    supported: true,
  };
}

async function supersession(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  const firstRaw = (await snapshot(ctx)).find(
    (expectation) => expectation.ruleId === 'lab_order_result_pending',
  );
  const before = await snapshot(ctx);
  const secondOrderAt = plusDays(day0, 5);
  await ingestRecord(ctx, { kind: 'order', loinc: '4548-4', display: 'HbA1c' }, secondOrderAt);
  const { view: expectations, raw: after } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const oldOne = after.find((expectation) => expectation.id === firstRaw?.id);
  const newOne = after.find(
    (expectation) =>
      expectation.ruleId === 'lab_order_result_pending' && expectation.id !== firstRaw?.id,
  );
  const dueDays = newOne === undefined ? undefined : daysBetween(secondOrderAt, newOne.dueAt);
  return {
    timeline,
    expectations,
    autoCheck: {
      expected:
        "The new order supersedes the old one; its own 15-day clock starts from the new order's date",
      observed: `old status = ${oldOne?.status ?? 'missing'}; new due in ${dueDays === undefined ? 'n/a' : String(dueDays)} day(s) from the new order`,
      passed: oldOne?.status === 'superseded' && dueDays === 15,
    },
    supported: true,
  };
}

async function independentClocks(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  const afterFirst = await snapshot(ctx);
  const secondAt = plusDays(day0, 5);
  // The first order stays untouched (still_open) while a second, unrelated test opens its own clock.
  await ingestRecord(ctx, { kind: 'order', loinc: '24331-1', display: 'Lipid panel' }, secondAt);
  const { view: expectations, raw } = await finalize(ctx, afterFirst);
  const timeline = await timelineOf(ctx);
  const first = raw.find((expectation) => expectation.matchKey.includes('4548-4'));
  const second = raw.find((expectation) => expectation.matchKey.includes('24331-1'));
  const firstDue = first === undefined ? undefined : daysBetween(day0, first.dueAt);
  const secondDue = second === undefined ? undefined : daysBetween(secondAt, second.dueAt);
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: "Each test keeps its own 15-day due date, independent of the other's clock",
      observed:
        first === undefined || second === undefined
          ? 'One of the two expectations is missing'
          : `HbA1c due ${String(firstDue)}d after its own order; lipid panel due ${String(secondDue)}d after its own`,
      passed: firstDue === 15 && secondDue === 15,
    },
    supported: true,
  };
}

async function visitClosesControlsNotTests(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  await ingestRecord(
    ctx,
    { kind: 'prescription', text: 'Amoxicilina 500mg', durationDays: 7 },
    day0,
  );
  const before = await snapshot(ctx);
  await visitOnly(ctx, plusDays(day0, 8));
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  const treatment = expectations.find(
    (expectation) => expectation.ruleId === 'short_treatment_followup',
  );
  const order = expectations.find(
    (expectation) => expectation.ruleId === 'lab_order_result_pending',
  );
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'The visit closes the pending control but leaves the pending lab test open',
      observed: `control (short_treatment_followup) = ${treatment?.status ?? 'missing'}; lab order (lab_order_result_pending) = ${order?.status ?? 'missing'}`,
      passed: treatment?.status === 'fulfilled' && order?.status === 'open',
    },
    supported: true,
  };
}

async function noteWithoutPlanFinding(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const before = await snapshot(ctx);
  const day0 = ctx.clock.now();
  await ingestNote(ctx, {
    noteText: 'Paciente refiere mejoria. Signos vitales estables. Sin hallazgos relevantes.',
    occurredAt: day0,
    patientName: 'Engine test patient',
  });
  const { view: expectations } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx, ctx.runtime.extractor);
  const findings = await ctx.runtime.storage.stores.qualityFindings.listByPatient(
    ctx.clinicId,
    ctx.patientId,
  );
  return {
    timeline,
    expectations,
    autoCheck: {
      expected: 'A note with no follow-up plan is recorded as a documentation-quality finding',
      observed: `${String(findings.length)} quality finding(s)`,
      passed: findings.length > 0,
    },
    supported: true,
  };
}

// ---------------------------------------------------------------- scenarios: rules

async function ruleIsConfiguration(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const ruleId = 'lab_order_result_pending';
  const config = ruleConfigOf(ruleId);
  const views = await ctx.runtime.engine.ruleOverrides.list(ctx.clinicId);
  const view = views.find((candidate) => candidate.ruleId === ruleId);
  const ruleCard: RuleCardView | undefined =
    config === undefined
      ? undefined
      : {
          ruleId,
          layer: config.layer,
          version: view?.version ?? config.version,
          trigger: config.trigger.event,
          fulfilledBy: config.fulfilledBy.map((correlation) => correlation.event),
          supersededBy: (config.supersededBy ?? []).map((correlation) => correlation.event),
          escalationPolicy: config.escalationPolicy.id ?? 'inline',
          dueInDays: view?.effective.dueInDays ?? config.dueInDays,
        };
  return {
    timeline: [],
    expectations: [],
    autoCheck: {
      expected:
        'The rule card (trigger, fulfilment, supersession, escalation, version) reads straight from config/rules',
      observed:
        ruleCard === undefined
          ? 'Rule not found in config'
          : `trigger=${ruleCard.trigger}, fulfilledBy=${String(ruleCard.fulfilledBy.length)} way(s), supersededBy=${String(ruleCard.supersededBy.length)} way(s), escalationPolicy=${ruleCard.escalationPolicy}, version=${ruleCard.version}`,
      passed: ruleCard !== undefined,
    },
    supported: true,
    ...(ruleCard === undefined ? {} : { ruleCard }),
  };
}

async function caseKeepsRuleVersion(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const ruleId = 'lab_order_result_pending';
  const day0 = ctx.clock.now();
  await ingestRecord(
    ctx,
    { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
    day0,
    'Engine test patient',
  );
  const openExpectation = (await snapshot(ctx)).find(
    (expectation) => expectation.ruleId === ruleId,
  );
  const originalVersion = openExpectation?.ruleVersion;
  await ctx.advanceTo(plusDays(day0, 20));
  const expired =
    openExpectation === undefined
      ? undefined
      : await ctx.runtime.storage.stores.expectations.get(ctx.clinicId, openExpectation.id);
  const hasCase = expired?.caseId !== undefined;
  const overrideResult = await ctx.runtime.engine.ruleOverrides.set(
    ctx.clinicId,
    ruleId,
    { dueInDays: 10 },
    { actor: ctx.evaluatorEmail, reason: 'Engine test: version pinning check' },
  );
  try {
    const afterOverride =
      expired === undefined
        ? undefined
        : await ctx.runtime.storage.stores.expectations.get(ctx.clinicId, expired.id);
    const versionUnchanged = afterOverride?.ruleVersion === originalVersion;
    const { view: expectations } = await finalize(ctx, []);
    const timeline = await timelineOf(ctx);
    return {
      timeline,
      expectations,
      autoCheck: {
        expected:
          "The case's expectation keeps the rule version it opened with, even after the clinic's rules change",
        observed: `opened with ${originalVersion ?? 'n/a'}, still ${afterOverride?.ruleVersion ?? 'n/a'} after the clinic override (now ${overrideResult.rule.version})`,
        passed: hasCase && versionUnchanged && originalVersion !== undefined,
      },
      supported: true,
    };
  } finally {
    await ctx.runtime.engine.ruleOverrides.reset(ctx.clinicId, ruleId, {
      actor: ctx.evaluatorEmail,
      reason: 'Engine test cleanup',
    });
  }
}

async function perClinicOverride(ctx: ScenarioContext): Promise<ScenarioOutcome> {
  const ruleId = 'lab_order_result_pending';
  try {
    const before = await snapshot(ctx);
    const day0 = ctx.clock.now();
    await ingestRecord(
      ctx,
      { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
      day0,
      'Engine test patient',
    );
    const beforeOverride = (await snapshot(ctx)).find(
      (expectation) => expectation.ruleId === ruleId,
    );
    const daysBeforeOverride =
      beforeOverride === undefined ? undefined : daysBetween(day0, beforeOverride.dueAt);

    await ctx.runtime.engine.ruleOverrides.set(
      ctx.clinicId,
      ruleId,
      { dueInDays: 10 },
      { actor: ctx.evaluatorEmail, reason: 'Engine test: lab clinic override' },
    );

    const second = freshPatient();
    const secondCtx = withPatient(ctx, second.id);
    await ingestRecord(
      secondCtx,
      { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
      day0,
      second.name,
    );
    const afterOverride = (
      await ctx.runtime.storage.stores.expectations.listByPatient(ctx.clinicId, second.id)
    ).find((expectation) => expectation.ruleId === ruleId);
    const daysAfterOverride =
      afterOverride === undefined ? undefined : daysBetween(day0, afterOverride.dueAt);

    const { view: expectations } = await finalize(ctx, before);
    const timeline = await timelineOf(ctx);
    return {
      timeline,
      expectations,
      autoCheck: {
        expected:
          "The lab clinic's own override moves the due date from 15 to 10 days, scoped to this clinic only",
        observed: `before override: ${daysBeforeOverride === undefined ? 'n/a' : String(daysBeforeOverride)} day(s); after override: ${daysAfterOverride === undefined ? 'n/a' : String(daysAfterOverride)} day(s)`,
        passed: daysBeforeOverride === 15 && daysAfterOverride === 10,
      },
      supported: true,
    };
  } finally {
    await ctx.runtime.engine.ruleOverrides.reset(ctx.clinicId, ruleId, {
      actor: ctx.evaluatorEmail,
      reason: 'Engine test cleanup',
    });
  }
}

// ---------------------------------------------------------------- dispatch

type ScenarioRunner = (ctx: ScenarioContext) => Promise<ScenarioOutcome>;

const SCENARIOS: Readonly<Record<string, ScenarioRunner>> = {
  'structured-no-llm': structuredNoLlm,
  'note-ai-once-per-save': noteAiOncePerSave,
  'note-extraction-quotes': noteExtractionQuotes,
  'plan-item-confirm': planItemConfirm,
  'condition-inferred': conditionInferred,
  'expectation-has-due-date': expectationHasDueDate,
  'universal-layer': universalLayer,
  'doctor-plan-layer': doctorPlanLayer,
  'cadence-break': cadenceBreak,
  'protocol-fills-gaps': protocolFillsGaps,
  'plan-beats-protocol': planBeatsProtocol,
  'auto-close-fulfilled': autoCloseFulfilled,
  supersession,
  'independent-clocks': independentClocks,
  'visit-closes-controls-not-tests': visitClosesControlsNotTests,
  'note-without-plan-finding': noteWithoutPlanFinding,
  'rule-is-configuration': ruleIsConfiguration,
  'case-keeps-rule-version': caseKeepsRuleVersion,
  'per-clinic-override': perClinicOverride,
};

/** Runs one scenario, over a brand-new fictitious patient of the evaluator's lab clinic. */
export async function runScenario(
  def: EngineTestDef,
  base: Omit<ScenarioContext, 'patientId'>,
): Promise<{ readonly patientId: string } & ScenarioOutcome> {
  const runner = SCENARIOS[def.id];
  if (runner === undefined) {
    return {
      patientId: '',
      timeline: [],
      expectations: [],
      autoCheck: {
        expected: 'The scenario is implemented',
        observed: 'Unknown scenario id',
        passed: false,
      },
      supported: false,
    };
  }
  const patient = freshPatient();
  const ctx: ScenarioContext = { ...base, patientId: patient.id };
  const outcome = await runner(ctx);
  return { patientId: patient.id, ...outcome };
}
