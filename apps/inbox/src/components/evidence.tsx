import { Quote, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ReasonEvidence } from '../api/contract.ts';
import { formatDate } from '../lib/format.ts';
import { findQuote } from '../lib/highlight.ts';

/**
 * The note excerpt with the model's verbatim quote marked inside it: the
 * clinician sees exactly where the doctor wrote what the engine relies on.
 */
export function EvidenceExcerpt({ evidence }: { readonly evidence: ReasonEvidence }): ReactNode {
  const excerpt = evidence.noteExcerpt;
  const match = excerpt ? findQuote(excerpt, evidence.quote) : undefined;
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
          <Quote className="size-3.5 text-layer-plan" aria-hidden="true" />
          Cita textual de la nota
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-layer-plan" aria-hidden="true" />
          Leída por Muse Spark · nota del {formatDate(evidence.authoredAt)}
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
    <q className="text-sm text-muted before:content-['«'] after:content-['»']">
      <mark className="evidence-mark">{quote}</mark>
    </q>
  );
}
