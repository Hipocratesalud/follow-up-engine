import { Quote, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ReasonEvidence } from '../api/contract.ts';
import { useNoteReader } from '../api/queries.ts';
import { useT } from '../i18n/index.ts';
import { formatDate } from '../lib/format.ts';
import { findQuote } from '../lib/highlight.ts';

/**
 * The note excerpt with the model's verbatim quote marked inside it: the
 * clinician sees exactly where the doctor wrote what the engine relies on.
 */
export function EvidenceExcerpt({ evidence }: { readonly evidence: ReasonEvidence }): ReactNode {
  const t = useT();
  const reader = useNoteReader();
  const excerpt = evidence.noteExcerpt;
  const match = excerpt ? findQuote(excerpt, evidence.quote) : undefined;
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
          <Quote className="size-3.5 text-layer-plan" aria-hidden="true" />
          {t.evidence.title}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-layer-plan" aria-hidden="true" />
          {reader.simulated ? reader.label : t.evidence.readBy(reader.name)}
          {t.common.separator}
          {t.evidence.noteOf(formatDate(evidence.authoredAt))}
        </span>
      </figcaption>
      <blockquote className="px-3 py-3 text-sm leading-relaxed text-fg">
        {match ? (
          <>
            <span className="text-muted">{match.before}</span>
            <mark className="evidence-mark" data-testid="evidence-quote">
              {match.match}
            </mark>
            <span className="text-muted">{match.after}</span>
          </>
        ) : (
          <>
            {excerpt ? <p className="mb-2 text-muted">{excerpt}</p> : null}
            <mark className="evidence-mark" data-testid="evidence-quote">
              {evidence.quote}
            </mark>
          </>
        )}
      </blockquote>
    </figure>
  );
}

/** A short quote on its own (conditions, expectations), styled like the evidence mark. */
export function InlineQuote({ quote }: { readonly quote: string }): ReactNode {
  return (
    // `<q>` takes the quotation marks of the page language (“…” in English, «…» in Spanish).
    <q className="text-sm text-muted">
      <mark className="evidence-mark">{quote}</mark>
    </q>
  );
}
