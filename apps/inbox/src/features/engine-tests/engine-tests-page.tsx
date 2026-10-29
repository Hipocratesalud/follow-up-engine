import { ClipboardCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useEngineTests } from '../../api/engine-tests-queries.ts';
import type { EngineTestGroup, EngineTestListItem } from '../../api/engine-tests-contract.ts';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { EngineTestCard } from './engine-test-card.tsx';

const GROUP_ORDER: readonly EngineTestGroup[] = ['data_intake', 'expectations', 'rules'];

function groupItems(
  items: readonly EngineTestListItem[],
): ReadonlyMap<EngineTestGroup, readonly EngineTestListItem[]> {
  const byGroup = new Map<EngineTestGroup, EngineTestListItem[]>();
  for (const item of items) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }
  return byGroup;
}

export function EngineTestsPage(): ReactNode {
  const t = useT();
  const engineTests = useEngineTests();

  function handleRetry(): void {
    void engineTests.refetch();
  }

  if (engineTests.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label={t.engineTests.loading}>
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  if (engineTests.isError) {
    return (
      <ErrorState error={engineTests.error} onRetry={handleRetry} title={t.engineTests.loadError} />
    );
  }
  if (!engineTests.data) {
    return (
      <EmptyState
        icon={<ClipboardCheck className="size-5" aria-hidden="true" />}
        title={t.engineTests.loadError}
      >
        <Link to="/inbox" className="font-medium text-primary hover:underline">
          {t.common.goToInbox}
        </Link>
      </EmptyState>
    );
  }

  const { items, progress } = engineTests.data;
  const byGroup = groupItems(items);
  const percent = progress.total === 0 ? 0 : Math.round((progress.reviewed / progress.total) * 100);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.engineTests.title}</h1>
        <p className="text-sm text-muted">{t.engineTests.intro}</p>
        <div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.reviewed}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${String(percent)}%` }}
            />
          </div>
          <p className="mt-1 text-xs font-medium text-muted">
            {t.engineTests.progress(progress.reviewed, progress.total)}
          </p>
        </div>
        <Link to="/lab" className="text-sm font-medium text-primary hover:underline">
          {t.engineTests.tryOwnData}
        </Link>
      </header>
      {GROUP_ORDER.map((group) => {
        const groupTests = byGroup.get(group) ?? [];
        if (groupTests.length === 0) return null;
        return (
          <section key={group} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-fg">{t.engineTests.groups[group]}</h2>
            <div className="flex flex-col gap-3">
              {groupTests.map((item) => (
                <EngineTestCard key={item.id} id={item.id} reviewed={item.reviewed} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
