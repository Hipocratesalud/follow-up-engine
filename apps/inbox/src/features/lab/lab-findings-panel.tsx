import { ScanSearch, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useLabPatientReview } from '../../api/queries.ts';
import { InlineError } from '../../components/states.tsx';
import { Button, Card } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { InboxFindings } from '../reviewer/inbox-findings.tsx';

/**
 * The clinical reviewer in the evaluator's own lab (docs/deploy.md#hosted-demo):
 * a link to the lab's categories (switch one live, signed off with the
 * evaluator's email), "review this patient now", and the lab's inbox
 * finding cards, the same cards a doctor gets once a category is live.
 */
export function LabFindingsPanel({
  patientId,
}: {
  readonly patientId: string | undefined;
}): ReactNode {
  const t = useT();
  const COPY = t.liveFindings.lab;
  const review = useLabPatientReview();
  const [reviewed, setReviewed] = useState<string>();

  function handleReview(): void {
    if (patientId === undefined || review.isPending) return;
    setReviewed(undefined);
    review.mutate(patientId, {
      onSuccess: (result) => {
        setReviewed(COPY.reviewed(result.findings.length));
      },
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
          <ScanSearch className="size-4 text-primary" aria-hidden="true" />
          {COPY.title}
        </h2>
        <p className="mt-1 text-sm text-muted">{COPY.intro}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/lab/categories"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {COPY.categoriesLink}
        </Link>
        {patientId === undefined ? null : (
          <Button
            size="sm"
            onClick={handleReview}
            loading={review.isPending}
            disabled={review.isPending}
          >
            {COPY.reviewNow}
          </Button>
        )}
        <p role="status" aria-live="polite" className="text-sm text-muted">
          {reviewed}
        </p>
      </div>
      <InlineError error={review.error} />
      <InboxFindings scope="lab" emptyText={COPY.empty} />
    </Card>
  );
}
