import type { ReactNode } from 'react';
import type { EngineTestStepValue } from '../../api/engine-tests-contract.ts';
import { useT } from '../../i18n/index.ts';
import { DocumentStepFields } from './step-document-fields.tsx';
import { RecordStepFields } from './step-record-fields.tsx';
import { ClockStepField, RuleTimeframeStepField } from './step-simple-fields.tsx';

export interface EngineTestStepFormProps {
  readonly value: EngineTestStepValue;
  readonly onChange: (next: EngineTestStepValue) => void;
  readonly maxDate: string | undefined;
}

/** Dispatches one step's form to the field set its action needs — the pre-filled, fully editable input. */
export function EngineTestStepForm({
  value,
  onChange,
  maxDate,
}: EngineTestStepFormProps): ReactNode {
  const t = useT();
  switch (value.action) {
    case 'record':
      return <RecordStepFields value={value} onChange={onChange} maxDate={maxDate} />;
    case 'document':
      return <DocumentStepFields value={value} onChange={onChange} maxDate={maxDate} />;
    case 'clock':
      return <ClockStepField value={value} onChange={onChange} />;
    case 'rule_timeframe':
      return <RuleTimeframeStepField value={value} onChange={onChange} />;
    case 'confirm_plan':
      return <p className="text-sm text-muted">{t.engineTests.confirmPlanStepHint}</p>;
    case 'rule_card':
      return <p className="text-sm text-muted">{t.engineTests.ruleCardStepHint}</p>;
  }
}
