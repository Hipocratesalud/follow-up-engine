/** The guided "Engine tests" page (docs/deploy.md#engine-tests): mirrors `apps/api/src/http/engine-tests-*`. */

import type { Layer } from './contract.ts';

export type EngineTestGroup = 'data_intake' | 'expectations' | 'rules';

export interface EngineTestListItem {
  readonly id: string;
  readonly group: EngineTestGroup;
  readonly ruleId?: string;
  readonly stepCount: number;
  readonly reviewed: boolean;
}

export interface EngineTestCatalog {
  readonly items: readonly EngineTestListItem[];
  readonly progress: { readonly reviewed: number; readonly total: number };
}

export type ExpectationDiffTag =
  'new' | 'fulfilled' | 'superseded' | 'expired' | 'cancelled' | 'still_open';

export type ExpectationStatus = 'open' | 'fulfilled' | 'superseded' | 'expired' | 'cancelled';

export interface ExpectationRowView {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly layer: Layer;
  readonly label: string;
  readonly status: string;
  readonly dueAt: string;
  readonly diff: ExpectationDiffTag;
}

/**
 * One parameter of a {@link CheckMessage}, JSON-safe and already typed by
 * kind: the inbox resolves each into locale-correct text (a status label,
 * a formatted date, a pluralized count, ...) before interpolating it into
 * the catalog's own sentence. `text` is the one kind the API has already
 * resolved itself, from the same catalogs the rest of the inbox reads
 * (rule, test and diagnosis names): never a second translation table for
 * those here.
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
  | { readonly kind: 'category'; readonly value: 'laboratory' | 'imaging' | 'other' }
  | { readonly kind: 'interpretation'; readonly value: 'normal' | 'abnormal' | 'unknown' }
  | { readonly kind: 'verification'; readonly value: 'confirmed' | 'provisional' }
  | { readonly kind: 'text'; readonly value: string };

/**
 * A sentence the inbox's own i18n catalog writes out, never literal text
 * from the API: a code (`engineTests.checks.<code>`) plus the params it
 * needs. Used for every automatic check's `expected`/`observed` and every
 * timeline entry's `detail` (docs/deploy.md#engine-tests).
 */
export interface CheckMessage {
  readonly code: string;
  readonly params?: Readonly<Record<string, CheckParam>>;
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

// -------------------------------------------------------------- step values, mirroring the API

export type RecordStepEntry =
  | {
      readonly kind: 'order';
      readonly loinc: string;
      readonly display: string;
      readonly category?: 'laboratory' | 'imaging';
    }
  | {
      readonly kind: 'result';
      readonly loinc: string;
      readonly display: string;
      readonly value?: number | undefined;
      readonly unit?: string;
      readonly interpretation?: 'normal' | 'abnormal' | undefined;
      readonly basedOnOrderId?: string;
    }
  | {
      readonly kind: 'prescription';
      readonly text: string;
      readonly durationDays?: number | undefined;
    }
  | { readonly kind: 'visit' }
  | { readonly kind: 'diagnosis'; readonly icd10: string; readonly display?: string }
  | {
      readonly kind: 'appointment_booked';
      readonly scheduledFor: string;
      readonly specialty?: string;
    }
  | {
      readonly kind: 'appointment_cancelled';
      readonly appointmentId: string;
      readonly scheduledFor: string;
    };

export interface RecordStepValue {
  readonly action: 'record';
  readonly recordDate: string;
  readonly entry: RecordStepEntry;
}

export interface DocumentStepValue {
  readonly action: 'document';
  readonly documentDate: string;
  readonly documentType:
    'consultation_note' | 'lab_result' | 'imaging_report' | 'prescription' | 'other';
  readonly specialty?: string;
  readonly text?: string;
  readonly file?:
    | { readonly filename: string; readonly contentType: string; readonly dataBase64: string }
    | undefined;
  readonly diagnoses?: readonly {
    readonly icd10: string;
    readonly display?: string;
    readonly verification?: 'confirmed' | 'provisional';
  }[];
}

export interface ClockStepValue {
  readonly action: 'clock';
  readonly targetDate: string;
}

export interface RuleTimeframeStepValue {
  readonly action: 'rule_timeframe';
  readonly dueInDays: number;
}

export interface ConfirmPlanStepValue {
  readonly action: 'confirm_plan';
}

export interface RuleCardStepValue {
  readonly action: 'rule_card';
}

export type EngineTestStepValue =
  | RecordStepValue
  | DocumentStepValue
  | ClockStepValue
  | RuleTimeframeStepValue
  | ConfirmPlanStepValue
  | RuleCardStepValue;

export interface EngineTestStepPreview {
  readonly step: number;
  readonly action: EngineTestStepValue['action'];
  readonly suggestion: EngineTestStepValue;
}

export interface EngineTestStartResponse {
  readonly id: string;
  readonly patientId: string;
  /** ISO instant: the scenario's own start date, echoed back on every step call. */
  readonly day0: string;
  readonly steps: readonly EngineTestStepPreview[];
}

export interface EngineTestStepOutcome {
  readonly id: string;
  readonly patientId: string;
  readonly step: number | 'freeform';
  readonly timeline: readonly TimelineEntryView[];
  readonly expectations: readonly ExpectationRowView[];
  readonly autoCheck: AutoCheckView;
  readonly ruleCard?: RuleCardView;
}

export interface EngineTestStepRequest {
  readonly day0: string;
  readonly patientId: string;
  readonly value: EngineTestStepValue;
}

export interface EngineTestFreeformRequest {
  readonly patientId: string;
  readonly value: RecordStepValue | DocumentStepValue;
}

export type EngineTestVerdict = 'works_as_expected' | 'does_not_work';

export interface EngineTestVerdictRequest {
  readonly verdict: EngineTestVerdict;
  readonly comment?: string;
  readonly autoCheckPassed: boolean;
  readonly patientId?: string;
}
