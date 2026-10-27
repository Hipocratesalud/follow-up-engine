import {
  ArrowLeft,
  Bot,
  FileText,
  FlaskConical,
  Lightbulb,
  Pill,
  ShieldCheck,
  Stethoscope,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { FindingCitation, FindingDetail, ReviewRunView } from '../../api/reviewer-contract.ts';
import { useFinding } from '../../api/queries.ts';
import { ErrorState } from '../../components/states.tsx';
import { Badge, Card, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { formatDate, formatUsd } from '../../lib/format.ts';
import { segmentByQuotes } from '../../lib/highlight.ts';
import {
  CITATION_KIND_LABELS,
  describeStep,
  discardLabel,
  ORIGIN_LABELS,
  outcomeLabel,
  stopReasonLabel,
  REVIEW_COPY,
  summaryLabel,
} from './copy.ts';

const COPY = REVIEW_COPY.detail;
import { patientMeta } from '../inbox/case-row.tsx';
import { CoveredBadge, SeverityBadge } from './finding-row.tsx';
import { TrendChart } from './trend-chart.tsx';
import { VerdictPanel } from './verdict-panel.tsx';

const KIND_ICONS = {
  note: FileText,
  result: FlaskConical,
  medication: Pill,
  condition: Stethoscope,
} as const;

/** The note with every quote of this finding marked where it appears. */
function NoteWithQuotes({
  text,
  quotes,
}: {
  readonly text: string;
  readonly quotes: readonly string[];
}): ReactNode {
  const segments = segmentByQuotes(text, quotes);
  return (
    <blockquote className="max-h-64 overflow-y-auto px-3 py-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
      {segments.map((segment, index) =>
        segment.quoteIndex === undefined ? (
          <span key={`${String(index)}-plain`}>{segment.text}</span>
        ) : (
          <mark
            key={`${String(index)}-quote`}
            className="evidence-mark"
            data-testid="evidence-quote"
          >
            {segment.text}
          </mark>
        ),
      )}
    </blockquote>
  );
}

function CitationCard({
  citation,
  quotes,
}: {
  readonly citation: FindingCitation;
  readonly quotes: readonly string[];
}): ReactNode {
  const Icon = KIND_ICONS[citation.kind];
  return (
    <li>
      <figure className="overflow-hidden rounded-lg border border-border bg-surface-2">
        <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-fg">
            <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{citation.title}</span>
          </span>
          <span>
            {COPY.citationCaption(CITATION_KIND_LABELS[citation.kind], formatDate(citation.date))}
          </span>
        </figcaption>
        {citation.kind === 'note' && citation.text ? (
          <NoteWithQuotes text={citation.text} quotes={quotes} />
        ) : (
          <p className="px-3 py-3 text-sm">
            <mark className="evidence-mark" data-testid="evidence-quote">
              {citation.quote}
            </mark>
          </p>
        )}
      </figure>
    </li>
  );
}

function Evidence({ finding }: { readonly finding: FindingDetail }): ReactNode {
  // A note cited twice is shown once, with every quote marked inside it.
  const seen = new Set<string>();
  const unique = finding.citations.filter((citation) => {
    if (citation.kind !== 'note') return true;
    if (seen.has(citation.docId)) return false;
    seen.add(citation.docId);
    return true;
  });
  return (
    <section aria-labelledby="evidence-title" className="flex flex-col gap-3">
      <SectionTitle id="evidence-title" count={finding.citations.length}>
        {COPY.evidenceTitle}
      </SectionTitle>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Bot className="size-3.5 text-layer-plan" aria-hidden="true" />
        {COPY.evidenceNote}
      </p>
      {finding.trend ? <TrendChart trend={finding.trend} /> : null}
      <ul className="flex flex-col gap-3">
        {unique.map((citation) => (
          <CitationCard
            key={`${citation.docId}-${citation.quote}`}
            citation={citation}
            quotes={finding.citations
              .filter((item) => item.docId === citation.docId)
              .map((item) => item.quote)}
          />
        ))}
      </ul>
    </section>
  );
}

function RunFacts({ run }: { readonly run: ReviewRunView }): ReactNode {
  const facts: [string, string][] = [
    [COPY.traceFacts.steps, String(run.steps)],
    [COPY.traceFacts.toolCalls, String(run.toolCalls)],
    [COPY.traceFacts.cost, formatUsd(run.costUsd)],
    [COPY.traceFacts.model, run.modelId],
    [COPY.traceFacts.stop, stopReasonLabel(run.stopReason)],
    [COPY.traceFacts.signals, String(run.signalsCount)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-muted">{label}</dt>
          <dd className="truncate font-medium text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How the agent got there: each tool call it made, in order, and what the engine discarded. */
function AgentTrace({
  run,
  finding,
}: {
  readonly run: ReviewRunView;
  readonly finding: FindingDetail;
}): ReactNode {
  return (
    <details className="group rounded-xl border border-border bg-surface shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-fg">
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4 text-layer-plan" aria-hidden="true" />
          {COPY.traceTitle}
        </span>
        <span className="text-xs font-normal text-muted group-open:hidden">{COPY.traceToggle}</span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
        <p className="text-xs text-muted">{ORIGIN_LABELS[finding.origin]}.</p>
        <RunFacts run={run} />
        <ol className="flex flex-col gap-2">
          {run.trace.map((step) => (
            <li key={step.index} className="flex gap-2.5 text-sm">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-layer-plan-soft text-[11px] font-semibold text-layer-plan tabular-nums">
                {step.index}
              </span>
              <span className="min-w-0">
                <span className="text-fg">{describeStep(step)}</span>
                <span className="block text-xs text-muted">
                  <code className="font-mono">{step.tool}</code> · {outcomeLabel(step.outcome)}
                  {step.outcome === 'ok' && step.summary ? ` · ${summaryLabel(step.summary)}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>
        {run.discarded.length > 0 ? (
          <p className="text-xs text-muted">
            {COPY.discardedPrefix}
            {run.discarded
              .map((item) => COPY.discardedItem(item.count, discardLabel(item.reason)))
              .join(', ')}
            .
          </p>
        ) : null}
      </div>
    </details>
  );
}

function FindingDetailView({
  finding,
  backTo,
}: {
  readonly finding: FindingDetail;
  readonly backTo: string;
}): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = heading.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    const { top, bottom } = element.getBoundingClientRect();
    if (top < 0 || bottom > globalThis.innerHeight) element.scrollIntoView({ block: 'nearest' });
  }, [finding.id]);

  return (
    <article aria-labelledby="finding-title" className="flex flex-col gap-4">
      <Link
        to={backTo}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg lg:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {COPY.back}
      </Link>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <Badge tone="primary">{finding.categoryLabel}</Badge>
          {finding.mode === 'shadow' ? (
            <Badge tone="warning">{COPY.shadowBadge}</Badge>
          ) : (
            <Badge tone="info">{COPY.liveBadge}</Badge>
          )}
          {finding.alreadyCovered ? <CoveredBadge /> : null}
        </div>
        <h2
          id="finding-title"
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold tracking-tight text-fg outline-none"
        >
          {finding.summary}
        </h2>
        <p className="text-sm text-muted">{finding.rationale}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{finding.patient.name}</p>
            <p className="text-xs text-muted">
              {[patientMeta(finding.patient), COPY.detectedOn(formatDate(finding.createdAt))]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Link
            to={`/pacientes/${finding.patient.id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
          >
            <UserRound className="size-3.5" aria-hidden="true" />
            {COPY.viewPatient}
          </Link>
        </div>
      </Card>

      <Card className="flex gap-3 border-primary/30 p-5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
          <Lightbulb className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{COPY.suggestionTitle}</h3>
          <p className="mt-1 text-sm text-muted">{finding.suggestion}</p>
          <p className="mt-2 text-xs text-muted">{COPY.suggestionNote}</p>
        </div>
      </Card>

      {finding.alreadyCovered && finding.coveredBy.length > 0 ? (
        <Card className="flex gap-3 p-5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">{COPY.coveredTitle}</h3>
            <ul className="mt-1 list-disc pl-4 text-sm text-muted">
              {finding.coveredBy.map((coverage) => (
                <li key={`${coverage.kind}-${coverage.id}`}>{coverage.label}</li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      <Evidence finding={finding} />

      {finding.run ? <AgentTrace run={finding.run} finding={finding} /> : null}

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-sm font-semibold text-fg">{COPY.verdictTitle}</h3>
        <VerdictPanel findingId={finding.id} review={finding.review} />
      </Card>
    </article>
  );
}

function FindingDetailSkeleton(): ReactNode {
  return (
    <div aria-busy="true" aria-label={COPY.loading} className="flex flex-col gap-4">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
}

export function FindingDetailPanel({
  findingId,
  backTo,
}: {
  readonly findingId: string;
  readonly backTo: string;
}): ReactNode {
  const query = useFinding(findingId);
  function handleRetry(): void {
    void query.refetch();
  }
  if (query.isPending) return <FindingDetailSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={handleRetry}
        title={COPY.error}
        notFoundTitle={COPY.notFound}
      />
    );
  }
  return <FindingDetailView finding={query.data} backTo={backTo} />;
}
