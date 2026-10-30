import { Lightbulb, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import type {
  FindingView,
  InboxFindingFilters,
  ReviewerScope,
} from '../../api/reviewer-contract.ts';
import { useInboxFindings } from '../../api/queries.ts';
import { ErrorState } from '../../components/states.tsx';
import { Badge, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatDate } from '../../lib/format.ts';
import { patientMeta } from '../inbox/case-row.tsx';
import { SeverityBadge, UntranslatedBadge } from './finding-row.tsx';
import { VerdictPanel } from './verdict-panel.tsx';

const SEVERITY_BAR: Record<FindingView['severity'], string> = {
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-border-strong',
};

/**
 * One finding card of the doctor's inbox (PRD V3): what the reviewer saw,
 * for whom, what it suggests reviewing, the verbatim evidence it cites
 * (source document and date) and the three ratings. A rated card leaves
 * the queue.
 */
export function InboxFindingCard({
  finding,
  scope,
  onReviewed,
}: {
  readonly finding: FindingView;
  readonly scope: ReviewerScope;
  readonly onReviewed: (view: FindingView) => void;
}): ReactNode {
  const t = useT();
  const COPY = t.liveFindings;
  const titleId = useId();
  const meta = patientMeta(finding.patient, t);
  return (
    <article
      aria-labelledby={titleId}
      data-testid="inbox-finding-card"
      className="flex gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 shadow-card"
    >
      <span
        aria-hidden="true"
        className={cx('w-1 shrink-0 rounded-full', SEVERITY_BAR[finding.severity])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <SeverityBadge severity={finding.severity} />
          <span className="text-xs font-medium text-muted">{finding.categoryLabel}</span>
          <Badge tone="info" icon={<ShieldCheck className="size-3" aria-hidden="true" />}>
            {COPY.validatedBadge}
          </Badge>
          {finding.untranslated ? <UntranslatedBadge /> : null}
        </div>
        <h3 id={titleId} className="text-[15px] font-semibold break-words text-fg">
          {finding.summary}
        </h3>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium text-fg">{finding.patient.name}</span>
          {meta ? <span>{meta}</span> : null}
          {scope === 'clinic' ? (
            <Link
              to={`/patients/${encodeURIComponent(finding.patient.id)}`}
              className="text-xs font-medium text-primary hover:underline"
            >
              {COPY.openPatient}
            </Link>
          ) : null}
        </p>
        <div className="flex items-start gap-2 rounded-lg bg-primary-soft/50 px-3 py-2 text-sm text-fg">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <p>
            <span className="font-medium">{COPY.suggestionTitle}: </span>
            {finding.suggestion}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {COPY.evidenceTitle}
          </p>
          <ul className="flex flex-col gap-1.5">
            {finding.citations.map((citation) => (
              <li
                key={`${citation.docId}-${citation.quote}`}
                className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface-2 px-3 py-2"
              >
                <q className="text-sm text-fg">
                  <mark className="evidence-mark" data-testid="inbox-evidence-quote">
                    {citation.quote}
                  </mark>
                </q>
                <span className="text-xs text-muted">
                  {t.review.beforeVisit.citationCaption(citation.title, formatDate(citation.date))}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {finding.alreadyCovered && finding.coveredBy.length > 0 ? (
          <p className="text-xs text-muted">
            {COPY.coveredBy(finding.coveredBy.map((item) => item.label).join(', '))}
          </p>
        ) : null}
        <VerdictPanel
          findingId={finding.id}
          review={finding.review}
          scope={scope}
          onReviewed={onReviewed}
        />
      </div>
    </article>
  );
}

/**
 * The clinical findings of the doctor's inbox: one card per finding, apart
 * from the follow-up cards (a finding is a suggestion to rate, not a
 * follow-up to chase, and its patient may have no case at all). Only live,
 * signed-off categories reach it: the API filters shadow ones. Hidden while
 * there is nothing to rate, unless `emptyText` says what to show instead.
 */
export function InboxFindings({
  scope = 'clinic',
  emptyText,
  filters = {},
}: {
  readonly scope?: ReviewerScope;
  readonly emptyText?: string;
  /** The patient list's filters: only the findings of the patients it shows. */
  readonly filters?: InboxFindingFilters;
}): ReactNode {
  const t = useT();
  const COPY = t.liveFindings;
  const titleId = useId();
  const findings = useInboxFindings(scope, filters);
  const [rated, setRated] = useState<string>();

  function handleReviewed(view: FindingView): void {
    if (view.review === undefined) return;
    setRated(COPY.rated(t.review.verdicts[view.review.verdict].toLowerCase()));
  }

  function handleRetry(): void {
    void findings.refetch();
  }

  if (findings.isPending) {
    return emptyText === undefined ? null : (
      <div aria-busy="true" aria-label={COPY.loading} className="flex flex-col gap-2">
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }
  if (findings.isError) {
    return <ErrorState error={findings.error} onRetry={handleRetry} title={COPY.error} />;
  }
  const { items, queued, dailyCap } = findings.data;
  if (items.length === 0 && queued === 0 && rated === undefined && emptyText === undefined) {
    return null;
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionTitle id={titleId} count={findings.data.total}>
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          {COPY.title}
        </SectionTitle>
        <p className="text-sm text-muted">{COPY.intro}</p>
        {queued > 0 ? (
          <p className="text-sm font-medium text-fg" data-testid="inbox-findings-queued">
            {COPY.queued(queued, dailyCap)}
          </p>
        ) : null}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cx('text-sm text-success', !rated && 'sr-only')}
      >
        {rated}
      </p>
      {items.length === 0 ? (
        emptyText === undefined ? null : (
          <p className="text-sm text-muted">{emptyText}</p>
        )
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {items.map((finding) => (
            <li key={finding.id} className="min-w-0">
              <InboxFindingCard finding={finding} scope={scope} onReviewed={handleReviewed} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
