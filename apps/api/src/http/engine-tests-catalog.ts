/**
 * The guided "Engine tests" page (docs/deploy.md#engine-tests): one card per
 * MVP behavior, grouped the way a non-technical physician reads them. The
 * server only knows the id, its group and (when the behavior centers on one
 * rule) which rule; the title and the one-sentence statement shown to the
 * physician live in the inbox's own i18n catalog, keyed by this id
 * (`engineTests.scenarios.<id>`), never sent from here as literal text.
 */

export const ENGINE_TEST_GROUPS = ['data_intake', 'expectations', 'rules'] as const;
export type EngineTestGroup = (typeof ENGINE_TEST_GROUPS)[number];

export interface EngineTestDef {
  readonly id: string;
  readonly group: EngineTestGroup;
  /** The rule the card is about, when it centers on one. */
  readonly ruleId?: string;
}

export const ENGINE_TESTS: readonly EngineTestDef[] = [
  // Data intake
  { id: 'structured-no-llm', group: 'data_intake' },
  { id: 'note-ai-once-per-save', group: 'data_intake' },
  { id: 'note-extraction-quotes', group: 'data_intake' },
  { id: 'plan-item-confirm', group: 'data_intake' },
  { id: 'condition-inferred', group: 'data_intake' },
  // Expectations
  { id: 'expectation-has-due-date', group: 'expectations', ruleId: 'lab_order_result_pending' },
  { id: 'universal-layer', group: 'expectations', ruleId: 'lab_order_result_pending' },
  { id: 'doctor-plan-layer', group: 'expectations', ruleId: 'doctor_plan_followup' },
  { id: 'cadence-break', group: 'expectations', ruleId: 'cadence_break' },
  { id: 'protocol-fills-gaps', group: 'expectations' },
  { id: 'plan-beats-protocol', group: 'expectations' },
  { id: 'auto-close-fulfilled', group: 'expectations', ruleId: 'lab_order_result_pending' },
  { id: 'supersession', group: 'expectations', ruleId: 'lab_order_result_pending' },
  { id: 'independent-clocks', group: 'expectations', ruleId: 'lab_order_result_pending' },
  {
    id: 'visit-closes-controls-not-tests',
    group: 'expectations',
    ruleId: 'short_treatment_followup',
  },
  { id: 'note-without-plan-finding', group: 'expectations' },
  // Rules
  { id: 'rule-is-configuration', group: 'rules', ruleId: 'lab_order_result_pending' },
  { id: 'case-keeps-rule-version', group: 'rules', ruleId: 'lab_order_result_pending' },
  { id: 'per-clinic-override', group: 'rules', ruleId: 'lab_order_result_pending' },
] as const;

export function engineTestDef(id: string): EngineTestDef | undefined {
  return ENGINE_TESTS.find((test) => test.id === id);
}
