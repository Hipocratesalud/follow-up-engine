import { Download, UsersRound } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useState } from 'react';
import { useApi, useEvaluatorEvents, useEvaluators } from '../../api/queries.ts';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { Badge, Button, Card, INPUT_CLASS, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatDateTime } from '../../lib/format.ts';

function EvaluatorsTable(): ReactNode {
  const t = useT();
  const evaluators = useEvaluators();

  function handleRetry(): void {
    void evaluators.refetch();
  }

  if (evaluators.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label={t.evaluators.loading}>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (evaluators.isError) {
    return <ErrorState error={evaluators.error} onRetry={handleRetry} title={t.evaluators.error} />;
  }
  const items = evaluators.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<UsersRound className="size-5" aria-hidden="true" />}
        title={t.evaluators.empty}
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-2 text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t.evaluators.email}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t.evaluators.lastSeen}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t.evaluators.totalActions}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t.evaluators.actionsByType}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((evaluator) => (
            <tr key={evaluator.evaluatorEmail}>
              <td className="px-3 py-2 font-medium text-fg">{evaluator.evaluatorEmail}</td>
              <td className="px-3 py-2 text-muted">{formatDateTime(evaluator.lastSeenAt)}</td>
              <td className="px-3 py-2 tabular-nums text-fg">{evaluator.total}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {Object.entries(evaluator.byAction)
                    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                    .map(([action, actionCount]) => (
                      <Badge
                        key={action}
                        tone="neutral"
                        title={t.evaluators.action[action] ?? action}
                      >
                        {t.evaluators.action[action] ?? action} · {actionCount}
                      </Badge>
                    ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityLog({
  evaluatorEmail,
}: {
  readonly evaluatorEmail: string | undefined;
}): ReactNode {
  const t = useT();
  const events = useEvaluatorEvents(evaluatorEmail);

  function handleRetry(): void {
    void events.refetch();
  }

  if (events.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (events.isError) {
    return (
      <ErrorState
        error={events.error}
        onRetry={handleRetry}
        title={t.evaluators.activityLogError}
      />
    );
  }
  if (events.data.items.length === 0) {
    return <p className="text-sm text-muted">{t.evaluators.activityLogEmpty}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {events.data.items.map((event) => (
        <li
          key={event.id}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
        >
          <span className="flex flex-wrap items-center gap-2 text-fg">
            <span className="font-medium">{event.evaluatorEmail}</span>
            {event.isTestEvaluator === true ? (
              <Badge tone="neutral">{t.evaluators.testAccountBadge}</Badge>
            ) : null}
            <span className="text-muted">{t.evaluators.action[event.action] ?? event.action}</span>
            {event.entityId ? (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
                {event.entityId}
              </code>
            ) : null}
          </span>
          <time dateTime={event.occurredAt} className="shrink-0 text-xs text-muted">
            {formatDateTime(event.occurredAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}

function TestAccounts(): ReactNode {
  const t = useT();
  const evaluators = useEvaluators();
  const accounts = evaluators.data?.testEvaluators ?? [];
  if (accounts.length === 0) return null;
  return (
    <Card className="flex flex-col gap-2 p-5">
      <SectionTitle count={accounts.length}>{t.evaluators.testAccountsTitle}</SectionTitle>
      <p className="text-sm text-muted">{t.evaluators.testAccountsHint}</p>
      <ul className="flex flex-wrap gap-1.5">
        {accounts.map((account) => (
          <li key={account.evaluatorEmail}>
            <Badge tone="neutral">
              {account.evaluatorEmail} · {t.evaluators.testAccountActions(account.total)}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The hosted demo's admin page (docs/deploy.md#hosted-demo): per evaluator,
 * last seen and counts by action, and the chronological activity log,
 * exportable as CSV.
 */
export function EvaluatorsPage(): ReactNode {
  const t = useT();
  const api = useApi();
  const evaluators = useEvaluators();
  const [filter, setFilter] = useState('');
  const [downloading, setDownloading] = useState(false);

  function handleFilterChange(event: ChangeEvent<HTMLSelectElement>): void {
    setFilter(event.target.value);
  }

  function handleDownload(): void {
    if (downloading) return;
    setDownloading(true);
    void api
      .downloadEvaluatorEventsCsv()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'evaluator-events.csv';
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      })
      .finally(() => {
        setDownloading(false);
      });
  }

  // The log can be filtered to a test account too: its rows are still there.
  const emails = [
    ...(evaluators.data?.items ?? []),
    ...(evaluators.data?.testEvaluators ?? []),
  ].map((item) => item.evaluatorEmail);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.evaluators.title}</h1>
        <p className="text-sm text-muted">{t.evaluators.intro}</p>
      </header>
      <Card className="flex flex-col gap-3 p-5">
        <SectionTitle count={evaluators.data?.items.length ?? 0}>{t.evaluators.title}</SectionTitle>
        <EvaluatorsTable />
      </Card>
      <TestAccounts />
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>{t.evaluators.activityLogTitle}</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="evaluator-filter">
              {t.evaluators.filterByEvaluator}
            </label>
            <select
              id="evaluator-filter"
              value={filter}
              onChange={handleFilterChange}
              className={cx(INPUT_CLASS, 'h-9 w-56 py-0')}
            >
              <option value="">{t.evaluators.allEvaluators}</option>
              {emails.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              loading={downloading}
              onClick={handleDownload}
              icon={<Download className="size-3.5" aria-hidden="true" />}
            >
              {t.evaluators.downloadCsv}
            </Button>
          </div>
        </div>
        <ActivityLog evaluatorEmail={filter === '' ? undefined : filter} />
      </Card>
    </div>
  );
}
