import { randomUUID } from 'node:crypto';
import {
  type ClinicalEvent,
  type ClinicId,
  type ConditionVerification,
  type Expectation,
  type ExpectationStatus,
  type FakeClock,
  type PatientId,
  type PlanItem,
  type ResultInterpretation,
  type ServiceCategory,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  buildConsultationBundle,
  buildRecordBundle,
  type ConsultationDiagnosisInput,
} from '@follow-up-engine/fhir';
import {
  type EngineRuntime,
  labIngestion,
  NOTE_EXTRACTION_TASK,
  ruleConfigOf,
} from '@follow-up-engine/runtime';
import type { ApiMessages } from '../i18n/index.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import { icd10Label, loincLabel } from '../inbox/terminology.ts';
import { extractDocumentText } from '../lab/extract-document.ts';
import { HttpError } from './errors.ts';
import { dayAsDate, recordEntry } from './lab-records-routes.ts';
import type {
  ClockStepValue,
  ConfirmPlanStepValue,
  DocumentStepValue,
  EngineTestStepValue,
  RecordStepValue,
  RuleCardStepValue,
  RuleTimeframeStepValue,
} from './engine-tests-schemas.ts';
import type { EngineTestDef } from './engine-tests-catalog.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const PATIENT_NAME = 'Engine test patient';

function plusDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Everything a scenario step needs: the evaluator's own lab clinic, its clock and the current patient. */
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

function freshPatient(): { readonly id: PatientId; readonly name: string } {
  return { id: toPatientId(`et-${randomUUID()}`), name: PATIENT_NAME };
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

/**
 * One parameter of a {@link CheckMessage}, JSON-safe and typed by kind: the
 * inbox resolves each into locale-correct text (a status label, a date
 * formatted for the active locale, a pluralized count, ...) before
 * interpolating it into the catalog's own sentence. `text` is the one kind
 * already resolved here, from the same catalogs the rest of the inbox
 * reads (`loincLabel`, `icd10Label`, `InboxPresenter.reasonLabel`): never a
 * second translation table, in this file, for names the API already knows
 * how to say.
 */
export type CheckParam =
  | { readonly kind: 'status'; readonly value: ExpectationStatus | 'missing' }
  | { readonly kind: 'eventType'; readonly value: string }
  | { readonly kind: 'source'; readonly value: 'rules' | 'ai' | 'none' }
  | { readonly kind: 'date'; readonly value: string }
  | { readonly kind: 'days'; readonly value: number }
  | {
      readonly kind: 'plural';
      readonly unit: 'calls' | 'findings' | 'ways' | 'items';
      readonly value: number;
    }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'category'; readonly value: ServiceCategory }
  | { readonly kind: 'interpretation'; readonly value: ResultInterpretation }
  | { readonly kind: 'verification'; readonly value: ConditionVerification }
  | { readonly kind: 'text'; readonly value: string };

/**
 * A sentence the inbox's own i18n catalog writes out (`engineTests.checks`,
 * keyed by `code`), never literal text from the API: the physician reads
 * the page in English or Spanish, and every automatic check's
 * `expected`/`observed`, and every timeline entry's `detail`, must too
 * (docs/deploy.md#engine-tests).
 */
export interface CheckMessage {
  readonly code: string;
  readonly params?: Readonly<Record<string, CheckParam>>;
}

const NONE_EVENT_TYPE = '__none__';

function checkMsg(code: string, params?: Readonly<Record<string, CheckParam>>): CheckMessage {
  return params === undefined ? { code } : { code, params };
}
function textParam(value: string): CheckParam {
  return { kind: 'text', value };
}
function statusParam(value: ExpectationStatus | undefined): CheckParam {
  return { kind: 'status', value: value ?? 'missing' };
}
function eventTypeParam(value: string | undefined): CheckParam {
  return { kind: 'eventType', value: value ?? NONE_EVENT_TYPE };
}
function sourceParam(value: 'rules' | 'ai' | undefined): CheckParam {
  return { kind: 'source', value: value ?? 'none' };
}
function dateParam(value: Date): CheckParam {
  return { kind: 'date', value: value.toISOString() };
}
function daysParam(value: number): CheckParam {
  return { kind: 'days', value };
}
function pluralParam(unit: 'calls' | 'findings' | 'ways' | 'items', value: number): CheckParam {
  return { kind: 'plural', unit, value };
}
function boolParam(value: boolean): CheckParam {
  return { kind: 'bool', value };
}
function categoryParam(value: ServiceCategory): CheckParam {
  return { kind: 'category', value };
}
function interpretationParam(value: ResultInterpretation): CheckParam {
  return { kind: 'interpretation', value };
}
function verificationParam(value: ConditionVerification): CheckParam {
  return { kind: 'verification', value };
}

export interface TimelineEntryView {
  readonly type: string;
  readonly occurredAt: string;
  readonly source: 'rules' | 'ai';
  readonly detail: CheckMessage;
  readonly llm?: { readonly provider: string; readonly model: string };
}

export interface AutoCheckView {
  readonly expected: CheckMessage;
  readonly observed: CheckMessage;
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

/** What one step's [Load]/[Save]/[Confirm] produces: enough for the card to redraw itself. */
export interface EngineTestStepOutcome {
  readonly timeline: readonly TimelineEntryView[];
  readonly expectations: readonly ExpectationRowView[];
  readonly autoCheck: AutoCheckView;
  readonly ruleCard?: RuleCardView;
}

// ---------------------------------------------------------------- helpers

async function ingestRecordEntry(ctx: ScenarioContext, value: RecordStepValue) {
  const bundle = buildRecordBundle({
    recordId: `et-${randomUUID()}`,
    patient: { id: ctx.patientId, name: PATIENT_NAME },
    occurredAt: dayAsDate(value.recordDate),
    entry: recordEntry(value.entry),
  });
  return labIngestion(ctx.runtime, ctx.clock).accept(ctx.clinicId, bundle, 'sync');
}

interface DocumentApplyResult {
  readonly acceptance: Awaited<ReturnType<ReturnType<typeof labIngestion>['accept']>>;
  readonly newNoteExtractionCalls: number;
}

async function noteExtractionCalls(ctx: ScenarioContext): Promise<number> {
  const summary = await ctx.runtime.storage.llmUsage.summary(ctx.clinicId, new Date(0), {
    task: NOTE_EXTRACTION_TASK,
  });
  return summary.calls;
}

/** Reads the physician's text or file into note text, exactly like the Lab page's own upload. */
async function readStepDocumentText(
  ctx: ScenarioContext,
  value: DocumentStepValue,
): Promise<string> {
  if (value.file !== undefined) {
    const data = new Uint8Array(Buffer.from(value.file.dataBase64, 'base64'));
    const extracted = await extractDocumentText({
      filename: value.file.filename,
      contentType: value.file.contentType,
      data,
    });
    if ('error' in extracted) {
      throw new HttpError(
        422,
        `lab_document_${extracted.error}`,
        ctx.t.errors.labDocumentErrors[extracted.error],
      );
    }
    return extracted.text;
  }
  return value.text?.trim() ?? '';
}

/** Applies a document (upload or pasted text) through the same FHIR + LLM ingestion path the Lab page uses. */
async function applyDocumentValue(
  ctx: ScenarioContext,
  value: DocumentStepValue,
): Promise<DocumentApplyResult> {
  const text = await readStepDocumentText(ctx, value);
  const callsBefore = await noteExtractionCalls(ctx);
  const diagnoses: readonly ConsultationDiagnosisInput[] | undefined =
    value.diagnoses === undefined
      ? undefined
      : value.diagnoses.map((diagnosis) => ({
          icd10: diagnosis.icd10,
          ...(diagnosis.display === undefined ? {} : { display: diagnosis.display }),
          ...(diagnosis.verification === undefined ? {} : { verification: diagnosis.verification }),
        }));
  const bundle = buildConsultationBundle({
    consultationId: `et-${randomUUID()}`,
    patient: { id: ctx.patientId, name: PATIENT_NAME },
    specialty: value.specialty ?? 'internal_medicine',
    occurredAt: dayAsDate(value.documentDate),
    noteText: text,
    documentType: value.documentType,
    ...(diagnoses === undefined ? {} : { diagnoses }),
  });
  const acceptance = await labIngestion(ctx.runtime, ctx.clock).accept(
    ctx.clinicId,
    bundle,
    'sync',
  );
  const callsAfter = await noteExtractionCalls(ctx);
  return { acceptance, newNoteExtractionCalls: callsAfter - callsBefore };
}

async function applyClockValue(ctx: ScenarioContext, value: ClockStepValue): Promise<void> {
  await ctx.advanceTo(dayAsDate(value.targetDate));
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

/** Terminology URI the extractor codes a named test against (mirrors `demo-routes.ts`'s own constant). */
const LOINC_SYSTEM = 'http://loinc.org';

/**
 * A plan item's own name, in the request's language — the same table
 * `extractionView` and the expectations list read (`loincLabel`), never the
 * model's internal English `description`.
 */
function planItemDisplay(t: ApiMessages, item: PlanItem): string {
  const testName = item.code?.system === LOINC_SYSTEM ? loincLabel(t, item.code.code) : undefined;
  return testName ?? t.planItemKinds[item.kind];
}

function eventDetail(t: ApiMessages, event: ClinicalEvent): CheckMessage {
  switch (event.type) {
    case 'service_request.created':
      return checkMsg('detailServiceRequestCreated', {
        testName: textParam(
          loincLabel(t, event.code.code) ?? event.code.display ?? event.code.code,
        ),
        code: textParam(event.code.code),
        category: categoryParam(event.category),
      });
    case 'result.received': {
      const valueSuffix =
        event.value === undefined ? '' : ` ${String(event.value.value)}${event.value.unit ?? ''}`;
      return checkMsg('detailResultReceived', {
        testName: textParam(
          loincLabel(t, event.code.code) ?? event.code.display ?? event.code.code,
        ),
        code: textParam(event.code.code),
        interpretation: interpretationParam(event.interpretation),
        value: textParam(valueSuffix),
      });
    }
    case 'medication.prescribed':
      return event.durationDays === undefined
        ? checkMsg('detailMedicationPrescribed', { medication: textParam(event.medication.text) })
        : checkMsg('detailMedicationPrescribedWithDuration', {
            medication: textParam(event.medication.text),
            duration: daysParam(event.durationDays),
          });
    case 'condition.recorded':
      return checkMsg('detailConditionRecorded', {
        diagnosis: textParam(icd10Label(t, event.code.code, event.code.display)),
        code: textParam(event.code.code),
        verification: verificationParam(event.verification),
      });
    case 'encounter.finished':
      return checkMsg('detailVisitCompleted');
    case 'appointment.booked':
      return checkMsg('detailAppointmentBooked', { date: dateParam(event.scheduledFor) });
    case 'appointment.cancelled':
      return checkMsg('detailAppointmentCancelled');
    case 'note.received':
      return checkMsg('detailNoteSaved');
    case 'plan.extracted': {
      if (event.items.length === 0) return checkMsg('detailPlanNone');
      const items = event.items.map((item) => planItemDisplay(t, item)).join(', ');
      return checkMsg('detailPlanItems', { items: textParam(items) });
    }
    case 'allergy.recorded':
      return checkMsg('detailAllergyRecorded');
    case 'patient.language_recorded':
      return checkMsg('detailLanguageRecorded');
    case 'patient.opted_out':
      return checkMsg('detailOptedOut');
    case 'record.withdrawn':
      return checkMsg('detailRecordWithdrawn');
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

async function timelineOf(ctx: ScenarioContext): Promise<readonly TimelineEntryView[]> {
  const events = await ctx.runtime.storage.stores.clinicalRecords.listEventsForPatient(
    ctx.clinicId,
    ctx.patientId,
  );
  const llm = { provider: ctx.runtime.extractor.provider, model: ctx.runtime.extractor.model };
  return events.map((event) => {
    const source = eventSource(event);
    return {
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      source,
      detail: eventDetail(ctx.t, event),
      ...(source === 'ai' ? { llm } : {}),
    };
  });
}

// ---------------------------------------------------------------- step runner infrastructure

/** One numbered step: how to suggest its input, and how to apply + check the physician's own (possibly edited) input. */
export interface EngineTestStep {
  readonly action: EngineTestStepValue['action'];
  /** Pure: the pre-filled suggestion shown before the physician edits it. */
  readonly buildSuggestion: (day0: Date) => EngineTestStepValue;
  /** Applies the (possibly edited) value through the real engine and returns this step's outcome. */
  readonly run: (
    ctx: ScenarioContext,
    day0: Date,
    value: EngineTestStepValue,
  ) => Promise<EngineTestStepOutcome>;
}

function wrongAction(expected: string, value: EngineTestStepValue): never {
  throw new HttpError(
    422,
    'engine_test_wrong_step_action',
    `Expected a "${expected}" step input, got "${value.action}"`,
  );
}

/** A step whose action is a structured record (order/result/prescription/visit/diagnosis/appointment). */
function recordStep(
  buildSuggestion: (day0: Date) => RecordStepValue,
  check: (args: {
    readonly ctx: ScenarioContext;
    readonly day0: Date;
    readonly before: readonly Expectation[];
    readonly after: readonly Expectation[];
    readonly value: RecordStepValue;
  }) => AutoCheckView | Promise<AutoCheckView>,
): EngineTestStep {
  return {
    action: 'record',
    buildSuggestion,
    async run(ctx, day0, value) {
      if (value.action !== 'record') return wrongAction('record', value);
      const before = await snapshot(ctx);
      await ingestRecordEntry(ctx, value);
      const { raw, view } = await finalize(ctx, before);
      const timeline = await timelineOf(ctx);
      return {
        timeline,
        expectations: view,
        autoCheck: await check({ ctx, day0, before, after: raw, value }),
      };
    },
  };
}

/** A step whose action is "Upload a report or paste a note". */
function documentStep(
  buildSuggestion: (day0: Date) => DocumentStepValue,
  check: (args: {
    readonly ctx: ScenarioContext;
    readonly day0: Date;
    readonly before: readonly Expectation[];
    readonly after: readonly Expectation[];
    readonly value: DocumentStepValue;
    readonly result: DocumentApplyResult;
  }) => AutoCheckView | Promise<AutoCheckView>,
): EngineTestStep {
  return {
    action: 'document',
    buildSuggestion,
    async run(ctx, day0, value) {
      if (value.action !== 'document') return wrongAction('document', value);
      const before = await snapshot(ctx);
      const result = await applyDocumentValue(ctx, value);
      if (!result.acceptance.ok) {
        throw new HttpError(422, 'invalid_record', ctx.t.errors.invalidConsultation);
      }
      const { raw, view } = await finalize(ctx, before);
      const timeline = await timelineOf(ctx);
      return {
        timeline,
        expectations: view,
        autoCheck: await check({ ctx, day0, before, after: raw, value, result }),
      };
    },
  };
}

/** A step that moves the lab clinic's own clock forward. */
function clockStep(
  buildSuggestion: (day0: Date) => ClockStepValue,
  check: (args: {
    readonly ctx: ScenarioContext;
    readonly day0: Date;
    readonly before: readonly Expectation[];
    readonly after: readonly Expectation[];
    readonly value: ClockStepValue;
  }) => AutoCheckView | Promise<AutoCheckView>,
): EngineTestStep {
  return {
    action: 'clock',
    buildSuggestion,
    async run(ctx, day0, value) {
      if (value.action !== 'clock') return wrongAction('clock', value);
      const before = await snapshot(ctx);
      await applyClockValue(ctx, value);
      const { raw, view } = await finalize(ctx, before);
      const timeline = await timelineOf(ctx);
      return {
        timeline,
        expectations: view,
        autoCheck: await check({ ctx, day0, before, after: raw, value }),
      };
    },
  };
}

interface RuleTimeframeResult {
  readonly beforeDueInDays: number;
  readonly afterDueInDays: number;
}

/**
 * The per-clinic timeframe step: sets the scenario's own rule override.
 * `resetAfter` (default `true`) resets it in the same call, for a scenario
 * that only needs the override for its own check; pass `false` when a
 * later step in the same scenario still needs it (that later step must
 * then reset it itself — see `perClinicOverrideSteps`'s final step).
 */
function ruleTimeframeStep(
  ruleId: string,
  buildSuggestion: (day0: Date) => RuleTimeframeStepValue,
  check: (args: {
    readonly ctx: ScenarioContext;
    readonly day0: Date;
    readonly before: readonly Expectation[];
    readonly after: readonly Expectation[];
    readonly value: RuleTimeframeStepValue;
    readonly result: RuleTimeframeResult;
  }) => AutoCheckView | Promise<AutoCheckView>,
  options: { readonly resetAfter?: boolean } = {},
): EngineTestStep {
  const resetAfter = options.resetAfter ?? true;
  return {
    action: 'rule_timeframe',
    buildSuggestion,
    async run(ctx, day0, value) {
      if (value.action !== 'rule_timeframe') return wrongAction('rule_timeframe', value);
      const before = await snapshot(ctx);
      const views = await ctx.runtime.engine.ruleOverrides.list(ctx.clinicId);
      const beforeDueInDays =
        views.find((candidate) => candidate.ruleId === ruleId)?.effective.dueInDays ??
        ruleConfigOf(ruleId)?.dueInDays ??
        0;
      await ctx.runtime.engine.ruleOverrides.set(
        ctx.clinicId,
        ruleId,
        { dueInDays: value.dueInDays },
        { actor: ctx.evaluatorEmail, reason: 'Engine test: per-clinic timeframe' },
      );
      try {
        const { raw, view } = await finalize(ctx, before);
        const timeline = await timelineOf(ctx);
        const result: RuleTimeframeResult = { beforeDueInDays, afterDueInDays: value.dueInDays };
        return {
          timeline,
          expectations: view,
          autoCheck: await check({ ctx, day0, before, after: raw, value, result }),
        };
      } finally {
        if (resetAfter) {
          await ctx.runtime.engine.ruleOverrides.reset(ctx.clinicId, ruleId, {
            actor: ctx.evaluatorEmail,
            reason: 'Engine test cleanup',
          });
        }
      }
    },
  };
}

/** Resets a rule override back to the clinic's own default, swallowing a "nothing to reset" miss. */
async function resetRuleOverride(ctx: ScenarioContext, ruleId: string): Promise<void> {
  await ctx.runtime.engine.ruleOverrides.reset(ctx.clinicId, ruleId, {
    actor: ctx.evaluatorEmail,
    reason: 'Engine test cleanup',
  });
}

/** The doctor confirms a plan item read from a note, with one action. */
function confirmPlanStep(
  check: (args: {
    readonly ctx: ScenarioContext;
    readonly before: readonly Expectation[];
    readonly confirmedBy: string | undefined;
  }) => AutoCheckView | Promise<AutoCheckView>,
): EngineTestStep {
  return {
    action: 'confirm_plan',
    buildSuggestion: (): ConfirmPlanStepValue => ({ action: 'confirm_plan' }),
    async run(ctx, _day0, value) {
      if (value.action !== 'confirm_plan') return wrongAction('confirm_plan', value);
      const before = await snapshot(ctx);
      const planExpectation = before.find((expectation) => expectation.layer === 'doctor_plan');
      let confirmedBy: string | undefined;
      if (planExpectation !== undefined) {
        const result = await ctx.runtime.engine.planItems.confirm(
          ctx.clinicId,
          planExpectation.id,
          ctx.evaluatorEmail,
        );
        confirmedBy = result.expectation.confirmedBy;
      }
      const { view } = await finalize(ctx, before);
      const timeline = await timelineOf(ctx);
      return { timeline, expectations: view, autoCheck: await check({ ctx, before, confirmedBy }) };
    },
  };
}

/** Reads the scenario's rule card straight from configuration: no mutation. */
function ruleCardStep(ruleId: string): EngineTestStep {
  return {
    action: 'rule_card',
    buildSuggestion: (): RuleCardStepValue => ({ action: 'rule_card' }),
    async run(ctx, _day0, value) {
      if (value.action !== 'rule_card') return wrongAction('rule_card', value);
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
        ...(ruleCard === undefined ? {} : { ruleCard }),
        autoCheck: {
          expected: checkMsg('ricExpected'),
          observed:
            ruleCard === undefined
              ? checkMsg('ricNotFound')
              : checkMsg('ricFound', {
                  trigger: textParam(ruleCard.trigger),
                  fulfilledByCount: pluralParam('ways', ruleCard.fulfilledBy.length),
                  supersededByCount: pluralParam('ways', ruleCard.supersededBy.length),
                  escalationPolicy: textParam(ruleCard.escalationPolicy),
                  version: textParam(ruleCard.version),
                }),
          passed: ruleCard !== undefined,
        },
      };
    },
  };
}

// ---------------------------------------------------------------- shared entry builders

function orderEntry(loinc: string, display: string): RecordStepValue['entry'] {
  return { kind: 'order', loinc, display };
}

function resultEntry(
  loinc: string,
  display: string,
  value: number,
  interpretation: 'normal' | 'abnormal',
): RecordStepValue['entry'] {
  return { kind: 'result', loinc, display, value, interpretation };
}

function prescriptionEntry(text: string, durationDays: number): RecordStepValue['entry'] {
  return { kind: 'prescription', text, durationDays };
}

const VISIT_ENTRY: RecordStepValue['entry'] = { kind: 'visit' };

function findExpectation(list: readonly Expectation[], ruleId: string): Expectation | undefined {
  return list.find((expectation) => expectation.ruleId === ruleId);
}

// ---------------------------------------------------------------- scenarios: data intake

const structuredNoLlm: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ after }) => {
      const order = findExpectation(after, 'lab_order_result_pending');
      return {
        expected: checkMsg('snOrderExpected'),
        observed: checkMsg('obsStatus', { status: statusParam(order?.status) }),
        passed: order?.status === 'open',
      };
    },
  ),
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(day0),
      entry: prescriptionEntry('Metformina 850mg', 90),
    }),
    async ({ ctx }) => {
      const timeline = await timelineOf(ctx);
      const latest = timeline.at(-1);
      return {
        expected: checkMsg('snRxExpected'),
        observed: checkMsg('snRxObserved', {
          eventType: eventTypeParam(latest?.type),
          source: sourceParam(latest?.source),
        }),
        passed: latest?.type === 'medication.prescribed' && latest.source === 'rules',
      };
    },
  ),
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(plusDays(day0, 1)),
      entry: resultEntry('4548-4', 'HbA1c', 7.2, 'abnormal'),
    }),
    ({ after }) => {
      const order = findExpectation(after, 'lab_order_result_pending');
      return {
        expected: checkMsg('snResultExpected'),
        observed: checkMsg('obsStatus', { status: statusParam(order?.status) }),
        passed: order?.status === 'fulfilled',
      };
    },
  ),
];

const noteAiOncePerSave: readonly EngineTestStep[] = [
  documentStep(
    (day0) => ({
      action: 'document',
      documentDate: iso(day0),
      documentType: 'consultation_note',
      text: 'Paciente con diabetes tipo 2. Control en 1 mes.',
    }),
    ({ result }) => ({
      expected: checkMsg('naoSaveExpected'),
      observed: checkMsg('naoSaveObserved', {
        calls: pluralParam('calls', result.newNoteExtractionCalls),
      }),
      passed: result.newNoteExtractionCalls === 1,
    }),
  ),
  clockStep(
    (day0) => ({ action: 'clock', targetDate: iso(plusDays(day0, 5)) }),
    () => ({
      expected: checkMsg('naoClockExpected'),
      observed: checkMsg('naoClockObserved'),
      passed: true,
    }),
  ),
];

const noteExtractionQuotes: readonly EngineTestStep[] = [
  documentStep(
    (day0) => ({
      action: 'document',
      documentDate: iso(day0),
      documentType: 'consultation_note',
      text: 'Paciente con diabetes tipo 2. Se indica Metformina 850mg por 90 dias. Control en 1 mes.',
    }),
    ({ result }) => {
      const note = (result.acceptance.reports ?? []).flatMap((report) => report.notes)[0];
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
      return {
        expected: checkMsg('neqExpected'),
        observed:
          extraction === undefined
            ? checkMsg('neqMissing')
            : checkMsg('neqObserved', {
                diagnosisOk: boolParam(hasCondition),
                medicationOk: boolParam(hasMedication),
                planOk: boolParam(hasPlan),
              }),
        passed: hasCondition && hasMedication && hasPlan,
      };
    },
  ),
];

const planItemConfirm: readonly EngineTestStep[] = [
  documentStep(
    (day0) => ({
      action: 'document',
      documentDate: iso(day0),
      documentType: 'consultation_note',
      text: 'Paciente estable. Control en 1 mes.',
    }),
    ({ after }) => {
      const plan = after.find((expectation) => expectation.layer === 'doctor_plan');
      return {
        expected: checkMsg('picNoteExpected'),
        observed:
          plan === undefined
            ? checkMsg('picNoPlan')
            : checkMsg('obsStatus', { status: statusParam(plan.status) }),
        passed: plan !== undefined,
      };
    },
  ),
  confirmPlanStep(({ ctx, confirmedBy }) => ({
    expected: checkMsg('picConfirmExpected'),
    observed:
      confirmedBy === undefined
        ? checkMsg('picNotConfirmed')
        : checkMsg('picConfirmedBy', { who: textParam(confirmedBy) }),
    passed: confirmedBy === ctx.evaluatorEmail,
  })),
];

function conditionInferredSteps(): readonly EngineTestStep[] {
  return [
    recordStep(
      (day0) => ({
        action: 'record',
        recordDate: iso(day0),
        entry: prescriptionEntry('Metformina 850mg', 90),
      }),
      async ({ ctx }) => {
        const conditions = await ctx.runtime.storage.stores.conditions.listByPatient(
          ctx.clinicId,
          ctx.patientId,
        );
        const fromMedication = conditions.some(
          (condition) =>
            condition.sourceType === 'inferred_from_medication' &&
            condition.code.code.startsWith('E1'),
        );
        return {
          expected: checkMsg('ciMedExpected'),
          observed: checkMsg(fromMedication ? 'ciMedFound' : 'ciNotFound'),
          passed: fromMedication,
        };
      },
    ),
    recordStep(
      (day0) => ({
        action: 'record',
        recordDate: iso(day0),
        entry: resultEntry('4548-4', 'HbA1c', 7.0, 'abnormal'),
      }),
      async ({ ctx, value }) => {
        // Your own patient already carries a diabetes condition from step 1 (inferred from the
        // prescription), so the engine correctly does not open a second one for the same result —
        // that's `plan-beats-protocol`'s point, not this one. To show the *result* path on its own,
        // the same check applies the identical result to a second, clean patient of your lab clinic.
        const clean = freshPatient();
        await ingestRecordEntry({ ...ctx, patientId: clean.id }, value);
        const conditions = await ctx.runtime.storage.stores.conditions.listByPatient(
          ctx.clinicId,
          clean.id,
        );
        const fromResult = conditions.some(
          (condition) =>
            condition.sourceType === 'inferred_from_result' && condition.code.code.startsWith('E1'),
        );
        return {
          expected: checkMsg('ciResultExpected'),
          observed: checkMsg(fromResult ? 'ciResultFound' : 'ciNotFound'),
          passed: fromResult,
        };
      },
    ),
  ];
}

// ---------------------------------------------------------------- scenarios: expectations

const expectationHasDueDate: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ after }) => {
      const created = after.find(
        (expectation) => expectation.ruleId === 'lab_order_result_pending',
      );
      return {
        expected: checkMsg('ehdExpected'),
        observed:
          created === undefined
            ? checkMsg('obsNone')
            : checkMsg('obsDueAt', { date: dateParam(created.dueAt) }),
        passed: created !== undefined,
      };
    },
  ),
];

const universalLayer: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ after }) => {
      const order = findExpectation(after, 'lab_order_result_pending');
      return {
        expected: checkMsg('ulOrderExpected'),
        observed: checkMsg('obsStatus', { status: statusParam(order?.status) }),
        passed: order?.status === 'open',
      };
    },
  ),
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(day0),
      entry: prescriptionEntry('Amoxicilina 500mg', 7),
    }),
    ({ after }) => {
      const order = findExpectation(after, 'lab_order_result_pending');
      const treatment = findExpectation(after, 'short_treatment_followup');
      return {
        expected: checkMsg('ulRxExpected'),
        observed: checkMsg('ulRxObserved', {
          orderStatus: statusParam(order?.status),
          treatmentStatus: statusParam(treatment?.status),
        }),
        passed: order?.status === 'open' && treatment?.status === 'open',
      };
    },
  ),
];

const doctorPlanLayer: readonly EngineTestStep[] = [
  documentStep(
    (day0) => ({
      action: 'document',
      documentDate: iso(day0),
      documentType: 'consultation_note',
      text: 'Paciente estable. Control en 1 mes.',
    }),
    ({ day0, after }) => {
      const plan = after.find((expectation) => expectation.layer === 'doctor_plan');
      const days = plan === undefined ? undefined : daysBetween(day0, plan.dueAt);
      return {
        expected: checkMsg('dplExpected'),
        observed:
          days === undefined
            ? checkMsg('obsNone')
            : checkMsg('obsDueInDays', { days: daysParam(days) }),
        passed: days !== undefined && days >= 25 && days <= 35,
      };
    },
  ),
];

const CADENCE_RULE_ID = 'cadence_break';

function cadenceBreakSteps(): readonly EngineTestStep[] {
  return [
    recordStep(
      (day0) => ({ action: 'record', recordDate: iso(day0), entry: VISIT_ENTRY }),
      ({ after }) => ({
        expected: checkMsg('cbVisit1Expected'),
        observed: checkMsg('obsStatus', {
          status: statusParam(findExpectation(after, CADENCE_RULE_ID)?.status),
        }),
        passed: findExpectation(after, CADENCE_RULE_ID) === undefined,
      }),
    ),
    clockStep(
      (day0) => ({ action: 'clock', targetDate: iso(plusDays(day0, 30)) }),
      () => ({
        expected: checkMsg('cbClockExpected'),
        observed: checkMsg('cbClockObserved'),
        passed: true,
      }),
    ),
    recordStep(
      (day0) => ({ action: 'record', recordDate: iso(plusDays(day0, 30)), entry: VISIT_ENTRY }),
      ({ after }) => {
        const cadence = findExpectation(after, CADENCE_RULE_ID);
        return {
          expected: checkMsg('cbVisit2Expected'),
          observed: checkMsg('obsStatus', { status: statusParam(cadence?.status) }),
          passed: cadence?.status === 'open',
        };
      },
    ),
    clockStep(
      (day0) => {
        const dueInDays = ruleConfigOf(CADENCE_RULE_ID)?.dueInDays ?? 14;
        return { action: 'clock', targetDate: iso(plusDays(day0, 30 + dueInDays + 1)) };
      },
      ({ after }) => {
        const cadence = findExpectation(after, CADENCE_RULE_ID);
        const caseOpened = cadence?.caseId !== undefined;
        const becameCase = cadence?.status === 'expired' && caseOpened;
        return {
          expected: checkMsg('cbExpireExpected'),
          observed: checkMsg(caseOpened ? 'obsExpiredCaseOpened' : 'obsExpiredNoCase', {
            status: statusParam(cadence?.status),
          }),
          passed: becameCase,
        };
      },
    ),
  ];
}

const DIABETES_NOTE_TEXT = 'Paciente con diabetes tipo 2. Control de HbA1c en 2 meses.';
const DIABETES_DIAGNOSIS = {
  icd10: 'E11',
  display: 'Type 2 diabetes mellitus',
  verification: 'confirmed' as const,
};

function enrollmentSteps(
  checkEnroll: (args: {
    readonly after: readonly Expectation[];
  }) => AutoCheckView | Promise<AutoCheckView>,
  checkVisit: (args: {
    readonly after: readonly Expectation[];
  }) => AutoCheckView | Promise<AutoCheckView>,
): readonly EngineTestStep[] {
  return [
    documentStep(
      (day0) => ({
        action: 'document',
        documentDate: iso(day0),
        documentType: 'consultation_note',
        text: DIABETES_NOTE_TEXT,
        diagnoses: [DIABETES_DIAGNOSIS],
      }),
      ({ after }) => checkEnroll({ after }),
    ),
    recordStep(
      (day0) => ({ action: 'record', recordDate: iso(plusDays(day0, 2)), entry: VISIT_ENTRY }),
      ({ after }) => checkVisit({ after }),
    ),
  ];
}

const protocolFillsGaps: readonly EngineTestStep[] = enrollmentSteps(
  ({ after }) => {
    const plan = after.find((expectation) => expectation.layer === 'doctor_plan');
    return {
      expected: checkMsg('pfgEnrollExpected'),
      observed:
        plan === undefined
          ? checkMsg('obsNone')
          : checkMsg('obsStatus', { status: statusParam(plan.status) }),
      passed: plan !== undefined,
    };
  },
  ({ after }) => {
    const protocolLayer = after.filter((expectation) => expectation.layer === 'protocol');
    return {
      expected: checkMsg('pfgVisitExpected'),
      observed:
        protocolLayer.length > 0
          ? checkMsg('pfgVisitFound', { count: pluralParam('items', protocolLayer.length) })
          : checkMsg('pfgVisitNone'),
      passed: protocolLayer.length > 0,
    };
  },
);

const planBeatsProtocol: readonly EngineTestStep[] = enrollmentSteps(
  ({ after }) => {
    const plan = after.find((expectation) => expectation.layer === 'doctor_plan');
    return {
      expected: checkMsg('pbpEnrollExpected'),
      observed:
        plan === undefined
          ? checkMsg('obsNone')
          : checkMsg('obsStatus', { status: statusParam(plan.status) }),
      passed: plan !== undefined,
    };
  },
  ({ after }) => {
    const plan = after.find((expectation) => expectation.layer === 'doctor_plan');
    const protocolHba1c = after.find(
      (expectation) => expectation.layer === 'protocol' && expectation.ruleId.includes('hba1c'),
    );
    return {
      expected: checkMsg('pbpVisitExpected'),
      observed: checkMsg('pbpVisitObserved', {
        planFound: boolParam(plan !== undefined),
        protocolFound: boolParam(protocolHba1c !== undefined),
      }),
      passed: plan !== undefined && protocolHba1c === undefined,
    };
  },
);

const autoCloseFulfilled: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ after }) => {
      const order = findExpectation(after, 'lab_order_result_pending');
      return {
        expected: checkMsg('acfOrderExpected'),
        observed: checkMsg('obsStatus', { status: statusParam(order?.status) }),
        passed: order?.status === 'open',
      };
    },
  ),
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(plusDays(day0, 3)),
      entry: resultEntry('4548-4', 'HbA1c', 6.0, 'normal'),
    }),
    ({ after }) => {
      const order = findExpectation(after, 'lab_order_result_pending');
      return {
        expected: checkMsg('acfResultExpected'),
        observed: checkMsg('obsStatus', { status: statusParam(order?.status) }),
        passed: order?.status === 'fulfilled',
      };
    },
  ),
];

const supersession: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(plusDays(day0, -20)),
      entry: orderEntry('4548-4', 'HbA1c'),
    }),
    ({ after }) => {
      const created = after.find(
        (expectation) =>
          expectation.ruleId === 'lab_order_result_pending' && expectation.status === 'open',
      );
      return {
        expected: checkMsg('supOrderExpected'),
        observed:
          created === undefined
            ? checkMsg('obsNone')
            : checkMsg('obsDueAt', { date: dateParam(created.dueAt) }),
        passed: created !== undefined,
      };
    },
  ),
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ day0, before, after }) => {
      const oldOne = before.find(
        (expectation) => expectation.ruleId === 'lab_order_result_pending',
      );
      const oldAfter = after.find((expectation) => expectation.id === oldOne?.id);
      const newOne = after.find(
        (expectation) =>
          expectation.ruleId === 'lab_order_result_pending' && expectation.id !== oldOne?.id,
      );
      const dueDays = newOne === undefined ? undefined : daysBetween(day0, newOne.dueAt);
      return {
        expected: checkMsg('supSupersedeExpected'),
        observed:
          dueDays === undefined
            ? checkMsg('supSupersedeObservedUnknown', { oldStatus: statusParam(oldAfter?.status) })
            : checkMsg('supSupersedeObserved', {
                oldStatus: statusParam(oldAfter?.status),
                dueDays: daysParam(dueDays),
              }),
        passed: oldAfter?.status === 'superseded' && dueDays === 15,
      };
    },
  ),
];

const independentClocks: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ day0, after }) => {
      const first = after.find((expectation) => expectation.ruleId === 'lab_order_result_pending');
      const days = first === undefined ? undefined : daysBetween(day0, first.dueAt);
      return {
        expected: checkMsg('icFirstExpected'),
        observed:
          days === undefined
            ? checkMsg('obsNone')
            : checkMsg('obsDueInDays', { days: daysParam(days) }),
        passed: days === 15,
      };
    },
  ),
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(plusDays(day0, 5)),
      entry: orderEntry('24331-1', 'Lipid panel'),
    }),
    ({ day0, after }) => {
      const first = after.find((expectation) => expectation.matchKey.includes('4548-4'));
      const second = after.find((expectation) => expectation.matchKey.includes('24331-1'));
      const firstDue = first === undefined ? undefined : daysBetween(day0, first.dueAt);
      const secondDue =
        second === undefined ? undefined : daysBetween(plusDays(day0, 5), second.dueAt);
      return {
        expected: checkMsg('icSecondExpected'),
        observed:
          first === undefined ||
          second === undefined ||
          firstDue === undefined ||
          secondDue === undefined
            ? checkMsg('icMissing')
            : checkMsg('icBothDue', {
                firstDue: daysParam(firstDue),
                secondDue: daysParam(secondDue),
              }),
        passed: firstDue === 15 && secondDue === 15 && first?.status === 'open',
      };
    },
  ),
];

const visitClosesControlsNotTests: readonly EngineTestStep[] = [
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
    ({ after }) => ({
      expected: checkMsg('vccOrderExpected'),
      observed: checkMsg('obsStatus', {
        status: statusParam(findExpectation(after, 'lab_order_result_pending')?.status),
      }),
      passed: findExpectation(after, 'lab_order_result_pending')?.status === 'open',
    }),
  ),
  recordStep(
    (day0) => ({
      action: 'record',
      recordDate: iso(day0),
      entry: prescriptionEntry('Amoxicilina 500mg', 7),
    }),
    ({ after }) => ({
      expected: checkMsg('vccRxExpected'),
      observed: checkMsg('obsStatus', {
        status: statusParam(findExpectation(after, 'short_treatment_followup')?.status),
      }),
      passed: findExpectation(after, 'short_treatment_followup')?.status === 'open',
    }),
  ),
  recordStep(
    (day0) => ({ action: 'record', recordDate: iso(plusDays(day0, 8)), entry: VISIT_ENTRY }),
    ({ after }) => {
      const treatment = findExpectation(after, 'short_treatment_followup');
      const order = findExpectation(after, 'lab_order_result_pending');
      return {
        expected: checkMsg('vccVisitExpected'),
        observed: checkMsg('vccVisitObserved', {
          controlStatus: statusParam(treatment?.status),
          orderStatus: statusParam(order?.status),
        }),
        passed: treatment?.status === 'fulfilled' && order?.status === 'open',
      };
    },
  ),
];

const noteWithoutPlanFinding: readonly EngineTestStep[] = [
  documentStep(
    (day0) => ({
      action: 'document',
      documentDate: iso(day0),
      documentType: 'consultation_note',
      text: 'Paciente refiere mejoria. Signos vitales estables. Sin hallazgos relevantes.',
    }),
    async ({ ctx }) => {
      const findings = await ctx.runtime.storage.stores.qualityFindings.listByPatient(
        ctx.clinicId,
        ctx.patientId,
      );
      return {
        expected: checkMsg('nwpExpected'),
        observed: checkMsg('nwpObserved', { count: pluralParam('findings', findings.length) }),
        passed: findings.length > 0,
      };
    },
  ),
];

// ---------------------------------------------------------------- scenarios: rules

function ruleIsConfigurationSteps(ruleId: string): readonly EngineTestStep[] {
  return [ruleCardStep(ruleId)];
}

function caseKeepsRuleVersionSteps(ruleId: string): readonly EngineTestStep[] {
  return [
    recordStep(
      (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
      ({ after }) => {
        const created = findExpectation(after, ruleId);
        return {
          expected: checkMsg('ckrvOrderExpected'),
          observed:
            created === undefined
              ? checkMsg('obsNone')
              : checkMsg('ckrvVersion', { version: textParam(created.ruleVersion) }),
          passed: created !== undefined,
        };
      },
    ),
    clockStep(
      (day0) => {
        const dueInDays = ruleConfigOf(ruleId)?.dueInDays ?? 15;
        return { action: 'clock', targetDate: iso(plusDays(day0, dueInDays + 5)) };
      },
      ({ after }) => {
        const expired = findExpectation(after, ruleId);
        const caseOpened = expired?.caseId !== undefined;
        return {
          expected: checkMsg('ckrvExpireExpected'),
          observed: checkMsg(caseOpened ? 'obsExpiredCaseOpened' : 'obsExpiredNoCase', {
            status: statusParam(expired?.status),
          }),
          passed: expired?.status === 'expired' && caseOpened,
        };
      },
    ),
    ruleTimeframeStep(
      ruleId,
      () => ({ action: 'rule_timeframe', dueInDays: 10 }),
      ({ after }) => {
        const config = ruleConfigOf(ruleId);
        const expectation = findExpectation(after, ruleId);
        const unchanged = config !== undefined && expectation?.ruleVersion === config.version;
        return {
          expected: checkMsg('ckrvVersionKeptExpected'),
          observed: checkMsg('ckrvVersionKeptObserved', {
            expectationVersion: textParam(expectation?.ruleVersion ?? ''),
            configVersion: textParam(config?.version ?? ''),
          }),
          passed: unchanged,
        };
      },
    ),
  ];
}

function perClinicOverrideSteps(ruleId: string): readonly EngineTestStep[] {
  return [
    recordStep(
      (day0) => ({ action: 'record', recordDate: iso(day0), entry: orderEntry('4548-4', 'HbA1c') }),
      ({ day0, after }) => {
        const config = ruleConfigOf(ruleId);
        const created = findExpectation(after, ruleId);
        const days = created === undefined ? undefined : daysBetween(day0, created.dueAt);
        return {
          expected: checkMsg('pcoDefaultExpected', { days: daysParam(config?.dueInDays ?? 0) }),
          observed:
            days === undefined
              ? checkMsg('obsNone')
              : checkMsg('obsDueInDays', { days: daysParam(days) }),
          passed: days === (config?.dueInDays ?? -1),
        };
      },
    ),
    ruleTimeframeStep(
      ruleId,
      () => ({ action: 'rule_timeframe', dueInDays: 10 }),
      ({ result }) => ({
        expected: checkMsg('pcoOverrideExpected'),
        observed: checkMsg('pcoOverrideObserved', {
          afterDays: daysParam(result.afterDueInDays),
          beforeDays: daysParam(result.beforeDueInDays),
        }),
        passed: result.afterDueInDays === 10,
      }),
      // The next step still needs this override in effect; it resets it once it's done.
      { resetAfter: false },
    ),
    {
      action: 'record',
      buildSuggestion: (day0) => ({
        action: 'record',
        recordDate: iso(day0),
        entry: orderEntry('4548-4', 'HbA1c'),
      }),
      async run(ctx, day0, value) {
        if (value.action !== 'record') return wrongAction('record', value);
        const before = await snapshot(ctx);
        await ingestRecordEntry(ctx, value);
        try {
          const { raw, view } = await finalize(ctx, before);
          const timeline = await timelineOf(ctx);
          const newest = [...raw]
            .filter((expectation) => expectation.ruleId === ruleId && expectation.status === 'open')
            .sort((left, right) => right.dueAt.getTime() - left.dueAt.getTime())[0];
          const days = newest === undefined ? undefined : daysBetween(day0, newest.dueAt);
          return {
            timeline,
            expectations: view,
            autoCheck: {
              expected: checkMsg('pcoSecondOrderExpected'),
              observed:
                days === undefined
                  ? checkMsg('obsNone')
                  : checkMsg('obsDueInDays', { days: daysParam(days) }),
              passed: days === 10,
            },
          };
        } finally {
          await resetRuleOverride(ctx, ruleId);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------- dispatch

const SCENARIOS: Readonly<Record<string, (def: EngineTestDef) => readonly EngineTestStep[]>> = {
  'structured-no-llm': () => structuredNoLlm,
  'note-ai-once-per-save': () => noteAiOncePerSave,
  'note-extraction-quotes': () => noteExtractionQuotes,
  'plan-item-confirm': () => planItemConfirm,
  'condition-inferred': () => conditionInferredSteps(),
  'expectation-has-due-date': () => expectationHasDueDate,
  'universal-layer': () => universalLayer,
  'doctor-plan-layer': () => doctorPlanLayer,
  'cadence-break': () => cadenceBreakSteps(),
  'protocol-fills-gaps': () => protocolFillsGaps,
  'plan-beats-protocol': () => planBeatsProtocol,
  'auto-close-fulfilled': () => autoCloseFulfilled,
  supersession: () => supersession,
  'independent-clocks': () => independentClocks,
  'visit-closes-controls-not-tests': () => visitClosesControlsNotTests,
  'note-without-plan-finding': () => noteWithoutPlanFinding,
  'rule-is-configuration': (def) =>
    ruleIsConfigurationSteps(def.ruleId ?? 'lab_order_result_pending'),
  'case-keeps-rule-version': (def) =>
    caseKeepsRuleVersionSteps(def.ruleId ?? 'lab_order_result_pending'),
  'per-clinic-override': (def) => perClinicOverrideSteps(def.ruleId ?? 'lab_order_result_pending'),
};

/** The ordered steps a scenario is made of — the one declarative source every endpoint reads. */
export function stepsOf(def: EngineTestDef): readonly EngineTestStep[] {
  return SCENARIOS[def.id]?.(def) ?? [];
}

export function freshEngineTestPatient(): { readonly id: PatientId; readonly name: string } {
  return freshPatient();
}

/** Applies a free-form record or document action ("Try anything else"), outside any numbered step. */
export async function applyFreeform(
  ctx: ScenarioContext,
  value: RecordStepValue | DocumentStepValue,
): Promise<EngineTestStepOutcome> {
  const before = await snapshot(ctx);
  if (value.action === 'record') {
    await ingestRecordEntry(ctx, value);
  } else {
    const result = await applyDocumentValue(ctx, value);
    if (!result.acceptance.ok) {
      throw new HttpError(422, 'invalid_record', ctx.t.errors.invalidConsultation);
    }
  }
  const { view } = await finalize(ctx, before);
  const timeline = await timelineOf(ctx);
  return {
    timeline,
    expectations: view,
    autoCheck: {
      expected: checkMsg('ffExpected'),
      observed: checkMsg('ffObserved'),
      passed: true,
    },
  };
}
