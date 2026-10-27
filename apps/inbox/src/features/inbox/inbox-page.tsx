import { MousePointerClick } from 'lucide-react';
import type { ReactNode } from 'react';
import { Outlet, useParams } from 'react-router';
import { EmptyState } from '../../components/states.tsx';
import { StatsBar } from '../../components/stats-bar.tsx';
import { useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { PatientQueueList } from '../patient-queue/patient-queue-list.tsx';

/**
 * The follow-up inbox: one card per patient (HIP-141) on the left, the
 * patient's cases on the right (or on their own screen on a phone).
 */
export function InboxPage(): ReactNode {
  const t = useT();
  const { caseId } = useParams();
  const hasSelection = caseId !== undefined;
  return (
    <div className="flex flex-col gap-4">
      {/* With a case open on a phone the header is visually hidden, but the page keeps its h1. */}
      <header className={cx('flex flex-col gap-0.5', hasSelection && 'sr-only lg:not-sr-only')}>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.inbox.title}</h1>
        <p className="text-sm text-muted">{t.inbox.intro}</p>
      </header>
      <div className={cx(hasSelection && 'hidden lg:block')}>
        <StatsBar />
      </div>
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <div className={cx('min-w-0', hasSelection && 'hidden lg:block')}>
          <PatientQueueList />
        </div>
        <div
          className={cx(
            'min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:rounded-xl',
            !hasSelection && 'hidden lg:block',
          )}
        >
          {hasSelection ? (
            <Outlet />
          ) : (
            <div className="rounded-xl border border-dashed border-border-strong">
              <EmptyState
                icon={<MousePointerClick className="size-5" aria-hidden="true" />}
                title={t.inbox.selectTitle}
              >
                {t.inbox.selectBody}
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
