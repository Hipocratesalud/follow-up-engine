import { ChevronRight, Languages, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { FindingSeverity, FindingView } from '../../api/reviewer-contract.ts';
import { Badge } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { SEVERITY_TONES } from './describe.ts';

export function SeverityBadge({ severity }: { readonly severity: FindingSeverity }): ReactNode {
  const t = useT();
  return (
    <Badge tone={SEVERITY_TONES[severity]}>
      <span className="sr-only">{t.review.row.severityPrefix}</span>
      {t.review.severities[severity]}
    </Badge>
  );
}

/** The finding's words are in another language until its translation arrives. */
export function UntranslatedBadge(): ReactNode {
  const t = useT();
  return (
    <Badge
      tone="warning"
      title={t.review.untranslatedHint}
      icon={<Languages className="size-3" aria-hidden="true" />}
    >
      {t.review.untranslated}
    </Badge>
  );
}

export function CoveredBadge(): ReactNode {
  const t = useT();
  return (
    <Badge tone="info" icon={<ShieldCheck className="size-3" aria-hidden="true" />}>
      {t.review.row.covered}
    </Badge>
  );
}

const SEVERITY_BAR: Record<FindingSeverity, string> = {
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-border-strong',
};

export function FindingRow({
  item,
  to,
  selected,
}: {
  readonly item: FindingView;
  readonly to: string;
  readonly selected: boolean;
}): ReactNode {
  const t = useT();
  return (
    <Link
      to={to}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'group relative flex gap-3 rounded-xl border px-3.5 py-3 transition-colors',
        selected
          ? 'border-primary/50 bg-primary-soft/60 shadow-card'
          : 'border-transparent hover:border-border hover:bg-surface',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('w-1 shrink-0 rounded-full', SEVERITY_BAR[item.severity])}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <SeverityBadge severity={item.severity} />
          <span className="text-xs font-medium text-muted">{item.categoryLabel}</span>
        </span>
        <span className="text-sm font-medium break-words text-fg">{item.summary}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="truncate">{item.patient.name}</span>
          {item.alreadyCovered ? <CoveredBadge /> : null}
          {item.untranslated ? <UntranslatedBadge /> : null}
          {item.review ? (
            <Badge tone={item.review.verdict === 'relevant' ? 'success' : 'neutral'}>
              {t.review.verdicts[item.review.verdict]}
            </Badge>
          ) : null}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="mt-1 size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 lg:hidden"
      />
    </Link>
  );
}

export function FindingRowSkeleton(): ReactNode {
  return (
    <div className="flex gap-3 px-3.5 py-3" aria-hidden="true">
      <div className="skeleton w-1 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <div className="skeleton h-4 w-1/3" />
        <div className="skeleton h-4 w-4/5" />
        <div className="skeleton h-4 w-2/5" />
      </div>
    </div>
  );
}
