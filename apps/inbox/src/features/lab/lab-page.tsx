import type { ReactNode } from 'react';
import { useState } from 'react';
import type {
  CreatedExpectation,
  DemoConsultationResponse,
  ExpectationStatus,
  LabDocumentResponse,
  LabRecordResponse,
} from '../../api/contract.ts';
import { useLabPatientExpectations } from '../../api/queries.ts';
import { ErrorState } from '../../components/states.tsx';
import { Card, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { useSessionState } from '../../lib/session-state.ts';
import { AddWithoutDocument } from './add-without-document.tsx';
import { ExpectationChips } from './expectation-chips.tsx';
import { ExpectationsTable } from './expectations-table.tsx';
import { LabFindingsPanel } from './lab-findings-panel.tsx';
import { ImpactPanel } from './impact-panel.tsx';
import { DocumentReadback } from './readback.tsx';
import { type TimelineEntry, TimelinePanel } from './timeline-panel.tsx';
import { UploadCard } from './upload-card.tsx';

interface LastResult {
  readonly patientId: string;
  readonly expectationsCreated: readonly CreatedExpectation[];
  readonly readback?: {
    readonly text: string;
    readonly extraction: DemoConsultationResponse['extraction'];
  };
}

function randomId(): string {
  return `${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * The evaluator lab (docs/deploy.md#hosted-demo): a per-evaluator sandbox
 * clinic, isolated from the shared demo and from every other evaluator.
 * "Upload a report or document" is the obvious first action; a collapsed
 * block below adds a structured record with no document; the timeline and
 * the expectations table show what the patient's record looks like now;
 * "What happens on a date?" moves the lab's own clock.
 */
export function LabPage(): ReactNode {
  const t = useT();
  const [patientId, setPatientId] = useSessionState<string>('lab-selected-patient');
  const [timelineByPatient, setTimelineByPatient] =
    useSessionState<Record<string, TimelineEntry[]>>('lab-timeline');
  const [lastResult, setLastResult] = useState<LastResult>();
  const [previousStatuses, setPreviousStatuses] = useState<Map<string, ExpectationStatus>>();
  const expectations = useLabPatientExpectations(patientId);

  // Switching patients starts a fresh diff baseline: what changed compares
  // only against actions taken for the patient now selected. Adjusted
  // during render (React's documented pattern), not in an effect: no extra
  // render, and no risk of a stale baseline flashing first.
  const [diffPatientId, setDiffPatientId] = useState(patientId);
  if (diffPatientId !== patientId) {
    setDiffPatientId(patientId);
    setPreviousStatuses(undefined);
  }

  function addTimelineEntry(forPatientId: string, date: string, summary: string): void {
    setTimelineByPatient((previous) => ({
      ...previous,
      [forPatientId]: [...(previous?.[forPatientId] ?? []), { id: randomId(), date, summary }],
    }));
  }

  function captureSnapshot(): void {
    const current = expectations.data?.items ?? [];
    setPreviousStatuses(new Map(current.map((item) => [item.id, item.status])));
  }

  function handlePatientSelected(id: string): void {
    setPatientId(id);
  }

  function handleUploaded(response: LabDocumentResponse): void {
    captureSnapshot();
    setLastResult({
      patientId: response.patientId,
      expectationsCreated: response.expectationsCreated,
      readback: { text: response.text, extraction: response.extraction },
    });
    addTimelineEntry(
      response.patientId,
      response.documentDate,
      t.lab.documentUploadedTitle(t.lab.documentTypes[response.documentType]),
    );
  }

  function handleRecordSaved(response: LabRecordResponse): void {
    captureSnapshot();
    setLastResult({
      patientId: response.patientId,
      expectationsCreated: response.expectationsCreated,
    });
    addTimelineEntry(response.patientId, new Date().toISOString().slice(0, 10), t.lab.savedTitle);
  }

  function handleRetry(): void {
    void expectations.refetch();
  }

  const showResult = lastResult !== undefined && lastResult.patientId === patientId;
  const entries = patientId === undefined ? [] : (timelineByPatient?.[patientId] ?? []);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.lab.title}</h1>
        <p className="text-sm text-muted">{t.lab.intro}</p>
      </header>

      <UploadCard
        patientId={patientId}
        onPatientSelected={handlePatientSelected}
        onUploaded={handleUploaded}
      />

      {showResult ? (
        <div className="flex flex-col gap-5">
          {lastResult.readback ? (
            <DocumentReadback
              text={lastResult.readback.text}
              extraction={lastResult.readback.extraction}
            />
          ) : null}
          <ExpectationChips items={lastResult.expectationsCreated} />
        </div>
      ) : null}

      {patientId ? (
        <>
          <AddWithoutDocument patientId={patientId} onRecordSaved={handleRecordSaved} />
          <TimelinePanel entries={entries} />
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
              <ExpectationsTable
                items={expectations.data.items}
                previousStatuses={previousStatuses}
              />
            )}
          </Card>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center text-sm text-muted">
          {t.lab.noPatientSelected}
        </p>
      )}

      <LabFindingsPanel patientId={patientId} />

      <ImpactPanel />
    </div>
  );
}
