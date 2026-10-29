import { History } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';

export interface TimelineEntry {
  readonly id: string;
  /** `YYYY-MM-DD`: the record's own date, not the wall clock. */
  readonly date: string;
  readonly summary: string;
}

/** A lab patient's timeline (docs/deploy.md#hosted-demo): every action added, newest first. */
export function TimelinePanel({
  entries,
}: {
  readonly entries: readonly TimelineEntry[];
}): ReactNode {
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
