import { ArrowLeft, Lock, ShieldCheck } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import type { FindingFlagView } from '../../api/reviewer-contract.ts';
import { useFindingFlagUpdate, useFindingFlags } from '../../api/queries.ts';
import { ErrorState, fieldError, InlineError } from '../../components/states.tsx';
import { Badge, Button, INPUT_CLASS, Skeleton } from '../../components/ui.tsx';
import { formatDate, formatPercent } from '../../lib/format.ts';
import { REVIEW_COPY } from './copy.ts';
import { ShadowBanner } from './review-page.tsx';

const COPY = REVIEW_COPY.flags;

function ReviewStats({ flag }: { readonly flag: FindingFlagView }): ReactNode {
  const { review } = flag;
  return (
    <p className="text-xs text-muted">
      {review.reviewed === 0
        ? COPY.noReviews
        : COPY.reviewStats(
            review.reviewed,
            review.relevant,
            review.precision === undefined ? '—' : formatPercent(review.precision),
          )}
    </p>
  );
}

function EnabledSwitch({
  flag,
  pending,
  onToggle,
}: {
  readonly flag: FindingFlagView;
  readonly pending: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const id = useId();
  function handleChange(): void {
    onToggle();
  }
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <span className="relative inline-flex">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={flag.enabled}
          onChange={handleChange}
          aria-busy={pending || undefined}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="h-5 w-9 rounded-full bg-border-strong transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
        />
        <span
          aria-hidden="true"
          className="absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow-card transition-transform peer-checked:translate-x-4"
        />
      </span>
      {flag.enabled ? COPY.enabled : COPY.disabled}
    </label>
  );
}

function FlagRow({ flag }: { readonly flag: FindingFlagView }): ReactNode {
  const ids = useId();
  const mutation = useFindingFlagUpdate();
  const [promoting, setPromoting] = useState(false);
  const [validator, setValidator] = useState('');
  const [validatorError, setValidatorError] = useState<string>();
  const validatorMessage = validatorError ?? fieldError(mutation.error, 'validatedBy');

  function handleToggle(): void {
    if (mutation.isPending) return;
    mutation.mutate({
      category: flag.category,
      enabled: !flag.enabled,
      mode: flag.mode,
      ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
    });
  }

  function handleStartPromotion(): void {
    mutation.reset();
    setPromoting(true);
  }

  function handleCancelPromotion(): void {
    setPromoting(false);
    setValidator('');
    setValidatorError(undefined);
  }

  function handleValidatorChange(event: ChangeEvent<HTMLInputElement>): void {
    setValidator(event.target.value);
    setValidatorError(undefined);
  }

  function handleConfirmPromotion(): void {
    if (mutation.isPending) return;
    const validatedBy = validator.trim();
    if (validatedBy === '') {
      setValidatorError(COPY.validatorRequired);
      return;
    }
    mutation.mutate(
      {
        category: flag.category,
        enabled: true,
        mode: 'live',
        validatedBy,
        ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
      },
      { onSuccess: handleCancelPromotion },
    );
  }

  function handleBackToShadow(): void {
    if (mutation.isPending) return;
    mutation.mutate({
      category: flag.category,
      enabled: flag.enabled,
      mode: 'shadow',
      ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
    });
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-fg">
            {flag.label}
            {flag.specialty ? <Badge tone="neutral">{flag.specialty}</Badge> : null}
            {flag.mode === 'live' ? (
              <Badge tone="info" icon={<ShieldCheck className="size-3" aria-hidden="true" />}>
                {COPY.live}
              </Badge>
            ) : (
              <Badge tone="warning">{COPY.shadow}</Badge>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted">{flag.description}</p>
        </div>
        <EnabledSwitch flag={flag} pending={mutation.isPending} onToggle={handleToggle} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <ReviewStats flag={flag} />
          {flag.validatedBy ? (
            <p className="text-xs text-muted">
              {COPY.validatedBy(
                flag.validatedBy,
                flag.validatedAt === undefined ? undefined : formatDate(flag.validatedAt),
              )}
            </p>
          ) : null}
        </div>
        {flag.mode === 'live' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleBackToShadow}
            loading={mutation.isPending}
          >
            {COPY.demote}
          </Button>
        ) : promoting ? null : (
          <Button size="sm" onClick={handleStartPromotion}>
            {COPY.promote}
          </Button>
        )}
      </div>
      {promoting ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-validator`} className="text-sm font-medium text-fg">
              {COPY.validatorLabel}
            </label>
            <input
              id={`${ids}-validator`}
              type="text"
              value={validator}
              maxLength={200}
              onChange={handleValidatorChange}
              autoComplete="off"
              placeholder={COPY.validatorPlaceholder}
              aria-invalid={validatorMessage ? true : undefined}
              aria-describedby={
                validatorMessage ? `${ids}-validator-error` : `${ids}-validator-hint`
              }
              className={INPUT_CLASS}
            />
            {validatorMessage ? (
              <p id={`${ids}-validator-error`} role="alert" className="text-sm text-danger">
                {validatorMessage}
              </p>
            ) : (
              <p id={`${ids}-validator-hint`} className="text-xs text-muted">
                {COPY.validatorHint}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={handleConfirmPromotion}
              loading={mutation.isPending}
              disabled={mutation.isPending}
            >
              {COPY.confirm}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancelPromotion}>
              {COPY.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      <InlineError error={mutation.error} inlineFields={['validatedBy']} />
    </li>
  );
}

function ReservedRow({ flag }: { readonly flag: FindingFlagView }): ReactNode {
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-dashed border-border-strong p-4">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-muted">
        <Lock className="size-3.5" aria-hidden="true" />
        {flag.label}
      </h2>
      <p className="text-sm text-muted">{COPY.reservedBody}</p>
    </li>
  );
}

export function FlagsPage(): ReactNode {
  const flags = useFindingFlags();
  function handleRetry(): void {
    void flags.refetch();
  }
  const items = flags.data?.items ?? [];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link
        to="/revision-clinica"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {COPY.back}
      </Link>
      <header className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{COPY.title}</h1>
        <p className="text-sm text-muted">{COPY.intro}</p>
      </header>
      <ShadowBanner />
      {flags.isPending ? (
        <div aria-busy="true" aria-label={COPY.loading} className="flex flex-col gap-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : flags.isError ? (
        <ErrorState error={flags.error} onRetry={handleRetry} title={COPY.error} />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((flag) =>
            flag.implemented ? (
              <FlagRow key={`${flag.category}-${flag.specialty ?? ''}`} flag={flag} />
            ) : (
              <ReservedRow key={flag.category} flag={flag} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}
