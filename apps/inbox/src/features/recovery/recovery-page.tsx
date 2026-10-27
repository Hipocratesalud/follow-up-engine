import { ArrowLeft, Info, PartyPopper } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useRecovery } from '../../api/queries.ts';
import { useT } from '../../i18n/index.ts';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { CaseDetailPanel } from '../case/case-detail.tsx';
import { CaseRow, CaseRowSkeleton } from '../inbox/case-row.tsx';

export function RecoveryPage(): ReactNode {
  const t = useT();
  const recovery = useRecovery();
  function handleRetry(): void {
    void recovery.refetch();
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.recovery.title}</h1>
        <p className="text-sm text-muted">{t.recovery.intro}</p>
      </header>

      <div
        role="note"
        className="flex gap-3 rounded-xl border border-info/30 bg-info-soft p-4 text-sm text-fg"
      >
        <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t.recovery.noticeTitle}</p>
          <p className="text-muted">{t.recovery.noticeBody}</p>
        </div>
      </div>

      {recovery.isPending ? (
        <div aria-busy="true" aria-label={t.recovery.loading} className="flex flex-col gap-1">
          {[0, 1, 2, 3].map((key) => (
            <CaseRowSkeleton key={key} />
          ))}
        </div>
      ) : recovery.isError ? (
        <ErrorState error={recovery.error} onRetry={handleRetry} title={t.recovery.error} />
      ) : recovery.data.items.length === 0 ? (
        <EmptyState
          icon={<PartyPopper className="size-5" aria-hidden="true" />}
          title={t.recovery.emptyTitle}
        >
          {t.recovery.emptyBody}
        </EmptyState>
      ) : (
        <section aria-labelledby="recovery-list-title" className="flex flex-col gap-2">
          <h2 id="recovery-list-title" className="text-sm font-semibold text-fg">
            {t.recovery.waiting(recovery.data.total)}
          </h2>
          <ul className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-card">
            {recovery.data.items.map((item) => (
              <li key={item.id}>
                <CaseRow item={item} to={`/cases/${item.id}`} showRelease />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A case outside the inbox split view (for example, one still waiting to be released). */
export function StandaloneCasePage(): ReactNode {
  const t = useT();
  const { caseId = '' } = useParams();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="sr-only">{t.caseDetail.standaloneTitle}</h1>
      <Link
        to="/recovery"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t.recovery.title}
      </Link>
      <CaseDetailPanel key={caseId} caseId={caseId} />
    </div>
  );
}
