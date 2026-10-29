import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Beaker,
  CalendarClock,
  CheckCircle2,
  FastForward,
  FlaskConical,
  Send,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useState } from 'react';
import { useSessionState } from '../../lib/session-state.ts';
import { Link } from 'react-router';
import type {
  DemoConsultationResponse,
  InboxStats,
  RecoveryPage,
  WebhookDelivery,
} from '../../api/contract.ts';
import {
  DEMO_CONSULTATION_MUTATION_KEY,
  queryKeys,
  useAdvanceClock,
  useDemoClock,
  useEvaluator,
  useNoteReader,
  useRecovery,
  useStats,
  useWebhooks,
} from '../../api/queries.ts';
import { EmptyState, ErrorState, InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, INPUT_CLASS, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { type Messages, useT } from '../../i18n/index.ts';
import { formatDateTime, formatLongDate } from '../../lib/format.ts';
import { ConsultationForm } from './consultation-form.tsx';
import { ExtractionPlaceholder, ExtractionResult } from './extraction-result.tsx';

/** One day shows the next batch of patients to recover entering the inbox. */
const ADVANCE_OPTIONS = [1, 7, 15, 30, 90] as const;

interface AdvanceSummary {
  readonly days: number;
  readonly before: number | undefined;
  readonly after: number | undefined;
  /** Held backfill cases ("Por recuperar") before and after the jump. */
  readonly heldBefore: number | undefined;
  readonly heldAfter: number | undefined;
}

/** "5 patients from “To recover” entered the inbox (28 left)." */
function releasedSentence(t: Messages, summary: AdvanceSummary): string | undefined {
  const { heldBefore, heldAfter } = summary;
  if (heldBefore === undefined || heldAfter === undefined) return undefined;
  const released = heldBefore - heldAfter;
  if (released <= 0) {
    return heldAfter > 0 ? t.demo.releasedNone(heldAfter) : undefined;
  }
  return t.demo.released(released, heldAfter);
}

function ClockPanel({
  now,
  onAdvanced,
}: {
  readonly now: string;
  readonly onAdvanced: (previousNow: string) => void;
}): ReactNode {
  const t = useT();
  const queryClient = useQueryClient();
  const stats = useStats();
  const recovery = useRecovery();
  const advance = useAdvanceClock();
  const evaluator = useEvaluator();
  // Every evaluator moves their own lab's clock (the Lab page) instead:
  // the shared demo's clock is one process, so an evaluator moving it
  // forward would change what every other evaluator sees too.
  const evaluatorLocked = evaluator.data?.email !== undefined;
  const [summary, setSummary] = useState<AdvanceSummary>();
  const [pendingDays, setPendingDays] = useState<number>();

  function handleAdvance(event: MouseEvent<HTMLButtonElement>): void {
    // One jump at a time: the dates move by exactly what was asked.
    if (advance.isPending) return;
    const days = Number(event.currentTarget.value);
    const before = stats.data?.activeCases;
    const heldBefore = recovery.data?.total;
    setPendingDays(days);
    advance.mutate(days, {
      onSuccess: () => {
        const after = queryClient.getQueryData<InboxStats>(queryKeys.stats)?.activeCases;
        const heldAfter = queryClient.getQueryData<RecoveryPage>(queryKeys.recovery)?.total;
        setSummary({ days, before, after, heldBefore, heldAfter });
        onAdvanced(now);
      },
      onSettled: () => {
        setPendingDays(undefined);
      },
    });
  }

  const delta =
    summary?.before !== undefined && summary.after !== undefined
      ? summary.after - summary.before
      : undefined;

  return (
    <Card className="flex flex-col gap-4 overflow-hidden p-0">
      <div className="flex flex-col gap-4 bg-gradient-to-br from-warning-soft to-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-warning uppercase">
            <CalendarClock className="size-3.5" aria-hidden="true" />
            {t.demo.simulatedDate}
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-fg first-letter:uppercase sm:text-3xl">
            <time dateTime={now}>{formatLongDate(now)}</time>
          </p>
        </div>
        {evaluatorLocked ? (
          <Link
            to="/lab"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm font-medium text-primary hover:bg-surface-2"
          >
            <Beaker className="size-3.5" aria-hidden="true" />
            {t.demo.goToLab}
          </Link>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted" id="advance-label">
              {t.demo.advance}
            </p>
            <div role="group" aria-labelledby="advance-label" className="flex flex-wrap gap-2">
              {ADVANCE_OPTIONS.map((days) => (
                <Button
                  key={days}
                  value={days}
                  size="sm"
                  variant="secondary"
                  loading={pendingDays === days}
                  disabled={advance.isPending}
                  onClick={handleAdvance}
                  icon={<FastForward className="size-3.5" aria-hidden="true" />}
                >
                  {t.demo.daysButton(days)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 px-5 pb-4">
        <p aria-live="polite" className="text-sm text-muted">
          {evaluatorLocked ? (
            t.demo.evaluatorAdvanceDisabled
          ) : summary ? (
            <>
              {t.demo.passed(summary.days)}
              {t.demo.engineRan}
              {delta === undefined ? (
                '.'
              ) : (
                <>
                  {t.demo.activeCases} {summary.before}{' '}
                  <ArrowRight className="inline size-3.5" aria-hidden="true" />{' '}
                  <strong className="font-semibold text-fg">{summary.after}</strong>
                  {delta > 0 ? ` (+${String(delta)})` : ''}.
                </>
              )}{' '}
              {releasedSentence(t, summary) ? (
                <strong className="font-medium text-fg">{releasedSentence(t, summary)} </strong>
              ) : null}
              <Link to="/inbox" className="font-medium text-primary hover:underline">
                {t.demo.viewInbox}
              </Link>
            </>
          ) : (
            t.demo.clockHint
          )}
        </p>
        <InlineError error={advance.error} />
      </div>
    </Card>
  );
}

function WebhookItem({
  item,
  isNew,
}: {
  readonly item: WebhookDelivery;
  readonly isNew: boolean;
}): ReactNode {
  const t = useT();
  return (
    <li className={cx('flex flex-col gap-1.5 px-4 py-2.5', isNew && 'bg-primary-soft/40')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
          <Send className="size-3.5 text-primary" aria-hidden="true" />
          {t.labels.webhooks[item.type] ?? item.type}
          <code className="font-mono text-[11px] font-normal text-muted">{item.type}</code>
          {isNew ? <Badge tone="primary">{t.common.newBadge}</Badge> : null}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {item.signatureValid ? (
            <Badge tone="success" icon={<ShieldCheck className="size-3" aria-hidden="true" />}>
              {t.demo.signatureValid}
            </Badge>
          ) : (
            <Badge tone="danger" icon={<XCircle className="size-3" aria-hidden="true" />}>
              {t.demo.signatureInvalid}
            </Badge>
          )}
          {item.delivered ? (
            <Badge tone="success" icon={<CheckCircle2 className="size-3" aria-hidden="true" />}>
              {t.demo.delivered}
            </Badge>
          ) : (
            <Badge tone="warning">{t.demo.pendingDelivery}</Badge>
          )}
          <time dateTime={item.at}>{formatDateTime(item.at)}</time>
        </span>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted hover:text-fg">{t.demo.viewContent}</summary>
        {/* Focusable and named so a keyboard user can scroll it (axe scrollable-region-focusable). */}
        <pre
          role="region"
          aria-label={t.demo.webhookContent(item.type)}
          tabIndex={0}
          className="mt-2 max-h-56 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-fg"
        >
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      </details>
    </li>
  );
}

/** Event types a demo viewer filters by (escalations of the backfill cases outnumber the rest). */
const WEBHOOK_FILTERS = [
  { value: '', key: 'all' },
  { value: 'case.opened', key: 'opened' },
  { value: 'case.escalated', key: 'escalated' },
  { value: 'patient_contact.requested', key: 'contact' },
  { value: 'case.resolved', key: 'resolved' },
  { value: 'backfill.completed', key: 'backfill' },
] as const;

function WebhookFeed({ newSince }: { readonly newSince: string | undefined }): ReactNode {
  const t = useT();
  const [type, setType] = useState('');
  const webhooks = useWebhooks(true, type === '' ? undefined : type);
  function handleRetry(): void {
    void webhooks.refetch();
  }
  function handleTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    setType(event.target.value);
  }
  return (
    <Card className="flex flex-col" aria-labelledby="webhooks-title">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <SectionTitle id="webhooks-title" count={webhooks.data?.items.length}>
            {t.demo.webhooksTitle}
          </SectionTitle>
          <p className="mt-1 text-xs text-muted">{t.demo.webhooksIntro}</p>
        </div>
        <label className="sr-only" htmlFor="webhook-type">
          {t.demo.eventType}
        </label>
        <select
          id="webhook-type"
          value={type}
          onChange={handleTypeChange}
          className={cx(INPUT_CLASS, 'h-9 shrink-0 py-0 sm:w-56')}
        >
          {WEBHOOK_FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {t.demo.webhookFilters[filter.key]}
            </option>
          ))}
        </select>
      </div>
      {webhooks.isPending ? (
        <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label={t.demo.loadingEvents}>
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : webhooks.isError ? (
        <ErrorState
          error={webhooks.error}
          onRetry={handleRetry}
          className="m-4"
          title={t.demo.eventsError}
        />
      ) : webhooks.data.items.length === 0 ? (
        <EmptyState icon={<Send className="size-5" aria-hidden="true" />} title={t.demo.noEvents}>
          {t.demo.noEventsBody}
        </EmptyState>
      ) : (
        <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
          {webhooks.data.items.map((item, index) => (
            <WebhookItem
              key={`${item.at}-${item.type}-${String(index)}`}
              item={item}
              isNew={newSince !== undefined && item.at > newSince}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

interface DemoResult {
  readonly response: DemoConsultationResponse;
  readonly noteText: string;
}

export function DemoPage(): ReactNode {
  const t = useT();
  const clock = useDemoClock();
  const reader = useNoteReader();
  const consulting = useIsMutating({ mutationKey: DEMO_CONSULTATION_MUTATION_KEY }) > 0;
  // The last reading stays when the judge goes to the inbox and comes back.
  const [result, setResult] = useSessionState<DemoResult>('demo-result');
  const [newSince, setNewSince] = useSessionState<string>('demo-new-since');

  function handleResult(response: DemoConsultationResponse, noteText: string): void {
    setResult({ response, noteText });
  }

  function handleAdvanced(previousNow: string): void {
    setNewSince(previousNow);
  }

  function handleRetry(): void {
    void clock.refetch();
  }

  if (clock.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t.demo.loading}>
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (clock.isError) {
    return <ErrorState error={clock.error} onRetry={handleRetry} title={t.demo.clockError} />;
  }
  if (!clock.data) {
    return (
      <EmptyState
        icon={<FlaskConical className="size-5" aria-hidden="true" />}
        title={t.demo.unavailableTitle}
      >
        {t.demo.unavailableBody}{' '}
        <Link to="/inbox" className="font-medium text-primary hover:underline">
          {t.common.goToInbox}
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.demo.title}</h1>
        <p className="text-sm text-muted">
          {reader.simulated ? t.demo.introSimulated : t.demo.introModel(reader.name)}
        </p>
      </header>
      <ClockPanel now={clock.data.now} onAdvanced={handleAdvanced} />
      {/* minmax(0, 1fr) columns and min-w-0 items: a wide JSON block scrolls in its box, never the page. */}
      <div className="grid grid-cols-1 items-start gap-5 *:min-w-0 xl:grid-cols-2">
        <ConsultationForm onResult={handleResult} />
        {result && !consulting ? (
          <ExtractionResult result={result.response} noteText={result.noteText} />
        ) : (
          <ExtractionPlaceholder pending={consulting} />
        )}
      </div>
      <WebhookFeed newSince={newSince} />
    </div>
  );
}
