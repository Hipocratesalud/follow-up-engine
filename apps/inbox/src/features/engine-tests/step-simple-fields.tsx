import { type ChangeEvent, type ReactNode, useId } from 'react';
import type { ClockStepValue, RuleTimeframeStepValue } from '../../api/engine-tests-contract.ts';
import { Field, INPUT_CLASS } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';

/** "Move your lab's date to …": the same clock the Lab page's date-impact preview moves. */
export function ClockStepField({
  value,
  onChange,
}: {
  readonly value: ClockStepValue;
  readonly onChange: (next: ClockStepValue) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange({ ...value, targetDate: event.target.value });
  }

  return (
    <Field label={t.engineTests.moveLabDateLabel} htmlFor={ids}>
      <input
        id={ids}
        type="date"
        value={value.targetDate}
        onChange={handleChange}
        className={INPUT_CLASS}
      />
    </Field>
  );
}

/** The per-clinic timeframe step: a new `dueInDays` for the scenario's own rule. */
export function RuleTimeframeStepField({
  value,
  onChange,
}: {
  readonly value: RuleTimeframeStepValue;
  readonly onChange: (next: RuleTimeframeStepValue) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const raw = event.target.value;
    onChange({ ...value, dueInDays: raw === '' ? 0 : Number(raw) });
  }

  return (
    <Field label={t.engineTests.ruleTimeframeLabel} htmlFor={ids}>
      <input
        id={ids}
        type="number"
        min={1}
        max={365}
        value={value.dueInDays}
        onChange={handleChange}
        className={INPUT_CLASS}
      />
    </Field>
  );
}
