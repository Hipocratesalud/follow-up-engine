import type { ReactNode } from 'react';
import type { CreatedExpectation } from '../../api/contract.ts';
import { Badge } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';

/**
 * "What the engine expects now", in plain language: one chip per
 * expectation the action just created, "label — due <date>". A reader
 * unfamiliar with the engine's layers or rule ids reads these at a glance.
 */
export function ExpectationChips({
  items,
}: {
  readonly items: readonly CreatedExpectation[];
}): ReactNode {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg">{t.lab.resultTitle}</h3>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Badge key={item.id} tone="primary" wrap>
            {item.label} — {t.lab.due(formatDate(item.dueAt))}
          </Badge>
        ))}
      </div>
    </div>
  );
}
