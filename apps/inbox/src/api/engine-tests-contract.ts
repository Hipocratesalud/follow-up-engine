/** The guided "Engine tests" page (docs/deploy.md#engine-tests): mirrors `apps/api/src/http/engine-tests-*`. */

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
