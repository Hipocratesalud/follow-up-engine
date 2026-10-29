import { FileWarning, Pill, Sparkles, Stethoscope, Timer, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DemoConsultationResponse } from '../../api/contract.ts';
import { Badge, Card, SectionTitle } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { formatDate, formatMs, formatPercent, formatUsd } from '../../lib/format.ts';
import { segmentByQuotes } from '../../lib/highlight.ts';
import { modelDisplayName } from '../../lib/labels.ts';

type QuoteKind = 'plan' | 'condition' | 'medication';

const QUOTE_STYLES: Record<QuoteKind, string> = {
  plan: 'evidence-mark',
  condition:
    'rounded-sm bg-layer-plan-soft px-0.5 text-layer-plan underline decoration-2 underline-offset-2',
  medication:
    'rounded-sm bg-info-soft px-0.5 text-info underline decoration-dotted decoration-2 underline-offset-2',
};

const QUOTE_SWATCHES: Record<QuoteKind, string> = {
  plan: 'bg-mark ring-1 ring-mark-ring',
  condition: 'bg-layer-plan',
  medication: 'bg-info',
};

const QUOTE_KINDS: readonly QuoteKind[] = ['plan', 'condition', 'medication'];

/** The document's text with every quote the reader cited marked in place. */
function AnnotatedNote({
  text,
  extraction,
}: {
  readonly text: string;
  readonly extraction: DemoConsultationResponse['extraction'];
}): ReactNode {
  const t = useT();
  const quotes: { text: string; kind: QuoteKind }[] = [
    ...extraction.planItems.map((item) => ({ text: item.evidenceQuote, kind: 'plan' as const })),
    ...extraction.conditions.map((item) => ({
      text: item.evidenceQuote,
      kind: 'condition' as const,
    })),
    ...extraction.medications.map((item) => ({
      text: item.evidenceQuote,
      kind: 'medication' as const,
    })),
  ];
  const segments = segmentByQuotes(
    text,
    quotes.map((quote) => quote.text),
  );
  return (
    <figure className="rounded-lg border border-border bg-surface-2">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted">
        <span className="font-medium text-fg">{t.extraction.annotatedNote}</span>
        {QUOTE_KINDS.map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span
              className={cx('inline-block size-2.5 rounded-sm', QUOTE_SWATCHES[kind])}
              aria-hidden="true"
            />
            {t.extraction.legend[kind]}
          </span>
        ))}
      </figcaption>
      <p className="px-3 py-3 text-sm leading-relaxed text-fg">
        {segments.map((segment, index) => {
          const kind =
            segment.quoteIndex === undefined ? undefined : quotes[segment.quoteIndex]?.kind;
          return kind ? (
            <mark key={index} className={QUOTE_STYLES[kind]} data-quote-kind={kind}>
              {segment.text}
            </mark>
          ) : (
            <span key={index} className="text-muted">
              {segment.text}
            </span>
          );
        })}
      </p>
    </figure>
  );
}

/**
 * What the lab read from a document (docs/deploy.md#hosted-demo): who read
 * it (Muse Spark or the simulated reader), the annotated text, the doctor's
 * plan, the conditions and medications found, each with its verbatim quote.
 * Trimmed from `features/demo/extraction-result.tsx` (no FHIR Bundle view,
 * no shared-clinic case link: a lab patient's cases live in the lab's own
 * cases panel instead).
 */
export function DocumentReadback({
  text,
  extraction,
}: {
  readonly text: string;
  readonly extraction: DemoConsultationResponse['extraction'];
}): ReactNode {
  const t = useT();
  const simulated = /^fake/i.test(extraction.model);
  return (
    <Card className="flex flex-col gap-5 p-5" aria-labelledby="lab-readback-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="lab-readback-title"
            className="flex items-center gap-2 text-base font-semibold text-fg"
          >
            <Sparkles className="size-4 text-layer-plan" aria-hidden="true" />
            {simulated
              ? t.labels.reader.simulated
              : t.lab.readByTitle(modelDisplayName(extraction.model))}
          </h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="neutral" icon={<Sparkles className="size-3" aria-hidden="true" />}>
            <code className="font-mono">{extraction.model}</code>
          </Badge>
          <Badge tone="neutral" icon={<Timer className="size-3" aria-hidden="true" />}>
            {formatMs(extraction.latencyMs)}
          </Badge>
          <Badge tone="neutral" icon={<Wallet className="size-3" aria-hidden="true" />}>
            {formatUsd(extraction.costUsd)}
          </Badge>
        </div>
      </div>

      {extraction.hasPlan ? null : (
        <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft/50 px-3 py-2.5 text-sm text-fg">
          <FileWarning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            <strong className="font-semibold">{t.extraction.noPlanTitle}</strong>{' '}
            <span className="text-muted">{t.extraction.noPlanBody}</span>
          </span>
        </p>
      )}

      <AnnotatedNote text={text} extraction={extraction} />

      <section aria-labelledby="lab-plan-items-title" className="flex flex-col gap-2">
        <SectionTitle id="lab-plan-items-title" count={extraction.planItems.length}>
          {t.extraction.plan}
        </SectionTitle>
        {extraction.planItems.length === 0 ? (
          <p className="text-sm text-muted">{t.extraction.noPlanItems}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {extraction.planItems.map((item, index) => (
              <li
                key={`${item.kind}-${item.testName ?? item.description}-${String(index)}`}
                className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Stethoscope className="size-4 text-layer-plan" aria-hidden="true" />
                    {item.testName === undefined
                      ? t.labels.planKinds[item.kind]
                      : t.extraction.planItemNamed(t.labels.planKinds[item.kind], item.testName)}
                  </span>
                  <span className="text-xs text-muted">
                    {t.extraction.dueConfidence(
                      formatDate(item.dueAt),
                      formatPercent(item.confidence),
                    )}
                  </span>
                </div>
                <q className="text-sm text-muted">
                  <mark className="evidence-mark">{item.evidenceQuote}</mark>
                </q>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="lab-conditions-title" className="flex flex-col gap-2">
          <SectionTitle id="lab-conditions-title" count={extraction.conditions.length}>
            {t.extraction.conditions}
          </SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {extraction.conditions.map((condition) => (
              <li
                key={condition.code.code}
                className="rounded-lg border border-border p-2.5 text-sm"
              >
                <p className="font-medium text-fg">
                  {condition.code.display ?? condition.code.code}{' '}
                  <code className="font-mono text-xs text-muted">{condition.code.code}</code>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {t.extraction.probable(formatPercent(condition.confidence))}
                  {t.common.separator}
                  {t.common.quoted(condition.evidenceQuote)}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="lab-medications-title" className="flex flex-col gap-2">
          <SectionTitle id="lab-medications-title" count={extraction.medications.length}>
            {t.extraction.medications}
          </SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {extraction.medications.map((medication) => (
              <li
                key={medication.text}
                className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-sm text-fg"
              >
                <Pill className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden="true" />
                <span>
                  {medication.text}
                  {medication.durationDays ? (
                    <span className="text-xs text-muted">
                      {t.common.separator}
                      {t.time.days(medication.durationDays)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Card>
  );
}
