import { Check, ShieldAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HeldLabReportView } from '../../api/contract.ts';
import { useDecideLabHeldReport, useLabHeldReports } from '../../api/queries.ts';
import { ErrorState, InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { formatDate, formatNumber } from '../../lib/format.ts';

/** `YYYY-MM-DD` as a readable date (never shown as ISO). */
function dayLabel(day: string): string {
  return formatDate(`${day}T12:00:00Z`);
}

/** One held report: whose name it prints, what it read, and the two decisions. */
function HeldReportItem({ report }: { readonly report: HeldLabReportView }): ReactNode {
  const t = useT();
  const COPY = t.lab.history.held;
  const decide = useDecideLabHeldReport();

  function handleConfirm(): void {
    decide.mutate({ id: report.id, decision: 'confirm' });
  }

  function handleDiscard(): void {
    decide.mutate({ id: report.id, decision: 'discard' });
  }

  // A photo (or a scan) the clinic does not send to a model was never read: the team enters it by hand.
  const unread = report.reason === 'photo_not_allowed' || report.reason === 'scan_not_allowed';
  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg">
          <span className="font-medium">{report.recordName ?? report.patientId}</span>
          <span className="truncate text-muted">{report.filename}</span>
        </span>
        <Badge tone="danger">{t.lab.history.statuses['needs_review']}</Badge>
      </div>
      <p className="text-xs font-medium text-danger">
        {report.reason === 'photo_not_allowed'
          ? COPY.photoNotAllowed
          : report.reason === 'scan_not_allowed'
            ? COPY.scanNotAllowed
            : COPY.names(report.printedName ?? COPY.noName, report.recordName ?? report.patientId)}
      </p>
      <p className="text-xs text-muted">
        {COPY.dates(
          dayLabel(report.printedDate ?? report.documentDate),
          dayLabel(report.documentDate),
        )}
        {report.model ? ` · ${t.lab.history.readBy(report.model)}` : ''}
      </p>
      {report.results.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {report.results.map((result) => (
            <li key={result.loinc}>
              <Badge tone={result.interpretation === 'N' ? 'neutral' : 'warning'}>
                {`${result.name}: ${formatNumber(result.value)}${result.unit ? ` ${result.unit}` : ''}${
                  result.interpretation
                    ? ` (${t.lab.history.interpretations[result.interpretation] ?? ''})`
                    : ''
                }`}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {unread ? null : (
          <Button
            size="sm"
            variant="primary"
            icon={<Check className="size-3.5" aria-hidden="true" />}
            loading={decide.isPending && decide.variables.decision === 'confirm'}
            disabled={decide.isPending}
            onClick={handleConfirm}
          >
            {COPY.confirm}
          </Button>
        )}
        <Button
          size="sm"
          icon={<X className="size-3.5" aria-hidden="true" />}
          loading={decide.isPending && decide.variables.decision === 'discard'}
          disabled={decide.isPending}
          onClick={handleDiscard}
        >
          {unread ? COPY.markReviewed : COPY.discard}
        </Button>
      </div>
      <InlineError error={decide.error} />
    </li>
  );
}

function HeldReportList({ items }: { readonly items: readonly HeldLabReportView[] }): ReactNode {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {items.map((report) => (
        <HeldReportItem key={report.id} report={report} />
      ))}
    </ul>
  );
}

/**
 * The lab's "Needs review" list: every imported lab report held because the
 * name printed on it is not the patient's. Nothing from it is recorded until
 * someone decides: "It's this patient" records it (the engine may then
 * close an order); "Not this patient" discards it. Stored, so it survives a
 * reload.
 */
export function HeldReportsPanel(): ReactNode {
  const t = useT();
  const COPY = t.lab.history.held;
  const held = useLabHeldReports();

  function handleRetry(): void {
    void held.refetch();
  }

  return (
    <Card className="flex flex-col gap-3 p-5" aria-labelledby="lab-held-title">
      <div>
        <h2 id="lab-held-title" className="flex items-center gap-2 text-base font-semibold text-fg">
          <ShieldAlert className="size-4 text-danger" aria-hidden="true" />
          {COPY.listTitle}
          {held.data && held.data.items.length > 0 ? (
            <Badge tone="danger">{COPY.count(held.data.items.length)}</Badge>
          ) : null}
        </h2>
        <p className="mt-1 text-sm text-muted">{COPY.listIntro}</p>
      </div>
      {held.isPending ? (
        <Skeleton className="h-12" />
      ) : held.isError ? (
        <ErrorState error={held.error} onRetry={handleRetry} className="py-4" />
      ) : held.data.items.length === 0 ? (
        <p className="text-sm text-muted">{COPY.empty}</p>
      ) : (
        <HeldReportList items={held.data.items} />
      )}
    </Card>
  );
}

/** The selected patient's held reports, as a small card (shown only when there is one). */
export function PatientHeldReportsCard({ patientId }: { readonly patientId: string }): ReactNode {
  const t = useT();
  const COPY = t.lab.history.held;
  const held = useLabHeldReports(patientId);
  const items = held.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card className="flex flex-col gap-3 border-danger/30 p-5" aria-labelledby="patient-held-title">
      <div>
        <h2
          id="patient-held-title"
          className="flex items-center gap-2 text-base font-semibold text-fg"
        >
          <ShieldAlert className="size-4 text-danger" aria-hidden="true" />
          {COPY.cardTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{COPY.cardIntro}</p>
      </div>
      <HeldReportList items={items} />
    </Card>
  );
}
