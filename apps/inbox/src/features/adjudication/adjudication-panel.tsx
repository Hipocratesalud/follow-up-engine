import { Bot, Check, EyeOff, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import type { AdjudicationDecision, AdjudicationView } from '../../api/adjudication-contract.ts';
import { useAdjudicationOverride } from '../../api/adjudication-queries.ts';
import { Dialog } from '../../components/dialog.tsx';
import { InlineQuote } from '../../components/evidence.tsx';
import { InlineError } from '../../components/states.tsx';
import { Badge, Button, type Tone } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDate, formatPercent } from '../../lib/format.ts';
import { useT } from '../../i18n/index.ts';

const DECISION_TONES: Record<AdjudicationDecision, Tone> = {
  open: 'success',
  discard: 'danger',
  needs_human: 'warning',
};

/**
 * The adjudicator's decision on an ambiguous plan item (PRD V2): the
 * decision, its probability, the reasons, the rationale and the verbatim
 * quotes the engine checked, plus the doctor's override (keep or discard).
 * Shown under the item, next to its plan item review.
 */
export function AdjudicationPanel({
  adjudication,
}: {
  readonly adjudication: AdjudicationView;
}): ReactNode {
  const t = useT();
  const copy = t.adjudication;
  const mutation = useAdjudicationOverride(adjudication.id);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { override } = adjudication;

  function handleKeep(): void {
    if (mutation.isPending) return;
    setDone(undefined);
    mutation.mutate(
      { decision: 'open' },
      {
        onSuccess: () => {
          setDone(copy.keptDone);
        },
      },
    );
  }

  function handleAskDiscard(event: MouseEvent<HTMLButtonElement>): void {
    trigger.current = event.currentTarget;
    mutation.reset();
    setDone(undefined);
    setConfirming(true);
  }

  function handleDiscard(): void {
    if (mutation.isPending) return;
    mutation.mutate(
      { decision: 'discard' },
      {
        onSuccess: () => {
          setConfirming(false);
          setDone(copy.discardedDone);
        },
      },
    );
  }

  function handleOpenChange(open: boolean): void {
    if (!open) setConfirming(false);
  }

  function handleCancel(): void {
    setConfirming(false);
  }

  function returnFocus(): HTMLElement | null {
    return trigger.current?.isConnected === true ? trigger.current : null;
  }

  const needsReview = adjudication.decision === 'needs_human' && override === undefined;
  return (
    <section
      aria-label={copy.title}
      className={cx(
        'flex flex-col gap-2 rounded-lg border px-3 py-2.5',
        needsReview ? 'border-warning/40 bg-warning-soft/30' : 'border-border bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-xs text-muted" title={copy.hint}>
          <Bot className="size-3.5 text-primary" aria-hidden="true" />
          <span className="font-medium text-fg">{copy.title}</span>
          <span aria-hidden="true">{t.common.separator.trim()}</span>
          <span>{copy.probability(formatPercent(adjudication.probability))}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {adjudication.mode === 'shadow' ? (
            <Badge tone="info" title={copy.shadowHint}>
              {copy.shadow}
            </Badge>
          ) : null}
          {adjudication.applied ? (
            <Badge tone="neutral" icon={<EyeOff className="size-3" aria-hidden="true" />}>
              {copy.applied}
            </Badge>
          ) : null}
          <Badge tone={DECISION_TONES[adjudication.decision]}>
            {copy.decisions[adjudication.decision]}
          </Badge>
        </div>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label={copy.rationaleLabel}>
        {adjudication.reasons.map((reason) => (
          <li
            key={reason.code}
            className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted"
          >
            {copy.reasons[reason.code]}
          </li>
        ))}
      </ul>
      {adjudication.rationale === '' ? null : (
        <p className="text-sm text-fg">{adjudication.rationale}</p>
      )}
      {adjudication.quotes.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted">{copy.quotesLabel}</p>
          {adjudication.quotes.map((quote) => (
            <InlineQuote key={quote.quote} quote={quote.quote} />
          ))}
        </div>
      ) : null}
      {override === undefined ? (
        <div className="flex flex-wrap gap-2">
          {adjudication.decision === 'open' ? null : (
            <Button
              size="sm"
              variant={needsReview ? 'success' : 'secondary'}
              onClick={handleKeep}
              loading={mutation.isPending && mutation.variables.decision === 'open'}
              icon={<Check className="size-3.5" aria-hidden="true" />}
            >
              {copy.keep}
            </Button>
          )}
          {adjudication.decision === 'discard' && adjudication.applied ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleAskDiscard}
              icon={<X className="size-3.5" aria-hidden="true" />}
            >
              {copy.discard}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">
          {override.decision === 'open'
            ? copy.overriddenKeep(formatDate(override.at))
            : copy.overriddenDiscard(formatDate(override.at))}
        </p>
      )}
      <p className="text-[11px] text-muted">{copy.model(adjudication.model)}</p>
      <p aria-live="polite" className={cx('text-xs text-success', !done && 'sr-only')}>
        {done}
      </p>
      {confirming ? null : <InlineError error={mutation.error} />}
      <Dialog
        open={confirming}
        onOpenChange={handleOpenChange}
        returnFocus={returnFocus}
        title={copy.discardTitle}
        description={copy.discardBody}
        footer={
          <>
            <Button variant="secondary" onClick={handleCancel}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              loading={mutation.isPending}
              // Pending, not validation: one click sends one request.
              disabled={mutation.isPending}
              onClick={handleDiscard}
            >
              {copy.discardConfirm}
            </Button>
          </>
        }
      >
        {confirming ? <InlineError error={mutation.error} /> : null}
      </Dialog>
    </section>
  );
}
