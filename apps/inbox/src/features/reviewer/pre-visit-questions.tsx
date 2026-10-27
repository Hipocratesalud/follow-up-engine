import { MessageCircleQuestion } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFindings } from '../../api/queries.ts';
import { SectionTitle } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';

/**
 * "To ask at the next visit": the patient's open questions of
 * a category the clinical team validated (live). Shadow findings never
 * reach here; nothing is shown when there is no question.
 */
export function PreVisitQuestions({ patientId }: { readonly patientId: string }): ReactNode {
  const t = useT();
  const questions = useFindings({
    mode: 'live',
    status: 'open',
    category: 'pre_visit_question',
    patientId,
    limit: 10,
  });
  const items = (questions.data?.items ?? []).filter(
    (item) => item.mode === 'live' && item.category === 'pre_visit_question',
  );
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="pre-visit-title" className="flex flex-col gap-3">
      <SectionTitle id="pre-visit-title" count={items.length}>
        {t.review.preVisit.title}
      </SectionTitle>
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex gap-3 rounded-xl border border-primary/30 bg-primary-soft/40 p-4"
          >
            <MessageCircleQuestion
              className="mt-0.5 size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">{item.summary}</p>
              <p className="mt-0.5 text-sm text-muted">{item.rationale}</p>
              <p className="mt-1 text-xs text-muted">
                {t.review.preVisit.suggestedOn(formatDate(item.createdAt))}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
