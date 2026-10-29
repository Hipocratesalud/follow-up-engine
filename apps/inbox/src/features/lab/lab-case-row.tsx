import type { ReactNode } from 'react';
import type { CaseView } from '../../api/contract.ts';
import { PriorityBadge, StatusBadge } from '../../components/case-badges.tsx';

/**
 * One row of the lab's own cases (docs/deploy.md#hosted-demo): read-only,
 * with no link into `/inbox/:caseId` (that route reads the shared clinic
 * through the inbox's API key; a lab clinic's case lives only here).
 */
export function CaseRow({ item }: { readonly item: CaseView }): ReactNode {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg">
        <StatusBadge status={item.status} />
        <span className="min-w-0 truncate font-medium">{item.patient.name}</span>
        <span className="min-w-0 truncate text-muted">{item.reasons[0]?.label}</span>
      </span>
      <PriorityBadge band={item.priorityBand} priority={item.priority} />
    </li>
  );
}
