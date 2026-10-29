import { History } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { ExpectationStatus, LabDocumentResponse } from '../../api/contract.ts';
import { useLabPatientExpectations } from '../../api/queries.ts';
import { ErrorState } from '../../components/states.tsx';
import { Card, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';
import { useSessionState } from '../../lib/session-state.ts';
import { ExpectationsTable } from './expectations-table.tsx';
import { DocumentReadback } from './readback.tsx';
import { RecordForm } from './record-form.tsx';

interface TimelineEntry {
  readonly id: string;
  /** `YYYY-MM-DD`: the record's own date, not the wall clock. */
  readonly date: string;
  readonly summary: string;
}

function TimelinePanel({ entries }: { readonly entries: readonly TimelineEntry[] }): ReactNode {
  const t = useT();
  return (
    <Card className="flex flex-col gap-3 p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
        <History className="size-4 text-muted" aria-hidden="true" />
        {t.lab.timelineTitle}
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">{t.lab.timelineEmpty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border">
          {[...entries]
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
            .map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2 text-sm">
                <time dateTime={entry.date} className="w-24 shrink-0 text-xs text-muted">
                  {formatDate(`${entry.date}T12:00:00Z`)}
                </time>
                <span className="text-fg">{entry.summary}</span>
              </li>
            ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * One lab patient's workspace (docs/deploy.md#hosted-demo): "Add to the
 * record", what the AI read, the patient's timeline and the expectations
 * table with changes since the last action highlighted. Remounted (`key`)
 * on every patient switch, so its session-stored timeline and its diff
 * baseline both start fresh for the newly selected patient.
 */
export function LabWorkspace({ patientId }: { readonly patientId: string }): ReactNode {
  const t = useT();
  const expectations = useLabPatientExpectations(patientId);
  const [entries, setEntries] = useSessionState<TimelineEntry[]>(`lab-timeline:${patientId}`);
  const [previousStatuses, setPreviousStatuses] = useState<Map<string, ExpectationStatus>>();
  const [readback, setReadback] = useState<LabDocumentResponse>();

  function captureSnapshot(): void {
    const current = expectations.data?.items ?? [];
    setPreviousStatuses(new Map(current.map((item) => [item.id, item.status])));
  }

  function addEntry(date: string, summary: string): void {
    setEntries((previous) => [
      ...(previous ?? []),
      { id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`, date, summary },
    ]);
  }

  function handleDocumentSaved(response: LabDocumentResponse): void {
    captureSnapshot();
    setReadback(response);
    addEntry(
      response.extraction.planItems[0]?.dueAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      t.lab.savedTitle,
    );
  }

  function handleRecordSaved(): void {
    captureSnapshot();
    setReadback(undefined);
    addEntry(new Date().toISOString().slice(0, 10), t.lab.savedTitle);
  }

  function handleRetry(): void {
    void expectations.refetch();
  }

  return (
    <div className="flex flex-col gap-5">
      <RecordForm
        patientId={patientId}
        onDocumentSaved={handleDocumentSaved}
        onRecordSaved={handleRecordSaved}
      />
      {readback ? <DocumentReadback text={readback.text} extraction={readback.extraction} /> : null}
      <TimelinePanel entries={entries ?? []} />
      <Card className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="text-base font-semibold text-fg">{t.lab.expectationsTitle}</h2>
          <p className="mt-1 text-sm text-muted">{t.lab.expectationsIntro}</p>
        </div>
        {expectations.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : expectations.isError ? (
          <ErrorState error={expectations.error} onRetry={handleRetry} />
        ) : (
          <ExpectationsTable items={expectations.data.items} previousStatuses={previousStatuses} />
        )}
      </Card>
    </div>
  );
}
