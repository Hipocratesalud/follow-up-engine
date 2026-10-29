import { CalendarClock, FlaskConical } from 'lucide-react';
import { type ChangeEvent, type ReactNode, type SubmitEvent, useId, useState } from 'react';
import type { LabDateImpact } from '../../api/contract.ts';
import { useAdvanceLabDate, useLabCases, useLabClock } from '../../api/queries.ts';
import { EmptyState, ErrorState, InlineError } from '../../components/states.tsx';
import { Button, Card, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { formatLongDate } from '../../lib/format.ts';
import { CaseRow } from './lab-case-row.tsx';

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

/**
 * "See the impact on a date" (docs/deploy.md#hosted-demo): moves the lab
 * clinic's own clock forward, one simulated day at a time, and shows what
 * the engine did (expectations expired, cases opened or escalated) — never
 * the shared demo's clock.
 */
export function ImpactPanel(): ReactNode {
  const t = useT();
  const ids = useId();
  const clock = useLabClock();
  const advance = useAdvanceLabDate();
  const cases = useLabCases();
  const today = clock.data?.now.slice(0, 10) ?? '';
  const [date, setDate] = useState(today);
  const [dateError, setDateError] = useState<string>();
  const [result, setResult] = useState<LabDateImpact>();

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    setDate(event.target.value);
    setDateError(undefined);
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (advance.isPending) return;
    const target = date || today;
    if (!isCalendarDay(target)) {
      setDateError(t.validation.labDateRequired);
      return;
    }
    if (target < today) {
      setDateError(t.validation.labDateInPast);
      return;
    }
    advance.mutate(target, {
      onSuccess: (impact) => {
        setResult(impact);
      },
    });
  }

  function handleRetryCases(): void {
    void cases.refetch();
  }

  const items = cases.data?.items ?? [];

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
          <CalendarClock className="size-4 text-warning" aria-hidden="true" />
          {t.lab.impactTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{t.lab.impactIntro}</p>
      </div>
      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex flex-wrap items-end gap-3"
        aria-label={t.lab.impactTitle}
      >
        <Field label={t.lab.impactDate} htmlFor={`${ids}-impact-date`} error={dateError}>
          <input
            id={`${ids}-impact-date`}
            type="date"
            min={today}
            value={date}
            onChange={handleDateChange}
            className={INPUT_CLASS}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          loading={advance.isPending}
          icon={<CalendarClock className="size-4" aria-hidden="true" />}
        >
          {advance.isPending ? t.lab.impactSeeing : t.lab.impactButton}
        </Button>
      </form>
      <InlineError error={advance.error} />
      {result ? (
        <div
          aria-live="polite"
          className="flex flex-col gap-1 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2.5 text-sm text-fg"
        >
          <p>{formatLongDate(result.to)}.</p>
          <p className="font-medium">
            {result.expectationsExpired + result.casesOpened + result.casesEscalated > 0
              ? t.lab.impactSummary(
                  result.expectationsExpired,
                  result.casesOpened,
                  result.casesEscalated,
                )
              : t.lab.impactNone}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-fg">{t.lab.labCasesTitle}</h3>
        {cases.isPending ? (
          <p className="text-sm text-muted">{t.lab.impactSeeing}</p>
        ) : cases.isError ? (
          <ErrorState error={cases.error} onRetry={handleRetryCases} className="py-4" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="size-5" aria-hidden="true" />}
            title={t.lab.labCasesEmpty}
            className="py-6"
          >
            {t.lab.labCasesEmptyBody}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {items.map((item) => (
              <CaseRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
