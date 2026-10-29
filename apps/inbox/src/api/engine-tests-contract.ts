/** The guided "Engine tests" page (docs/deploy.md#engine-tests): mirrors `apps/api/src/http/engine-tests-*`. */

export type EngineTestGroup = 'data_intake' | 'expectations' | 'rules';

export interface EngineTestListItem {
  readonly id: string;
  readonly group: EngineTestGroup;
  readonly ruleId?: string;
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

export interface EngineTestRunResult {
  readonly id: string;
  readonly patientId: string;
  readonly timeline: readonly TimelineEntryView[];
  readonly expectations: readonly ExpectationRowView[];
  readonly autoCheck: AutoCheckView;
  readonly supported: boolean;
  readonly ruleCard?: RuleCardView;
}

export type EngineTestVerdict = 'works_as_expected' | 'does_not_work';

export interface EngineTestVerdictRequest {
  readonly verdict: EngineTestVerdict;
  readonly comment?: string;
  readonly autoCheckPassed: boolean;
  readonly patientId?: string;
}
