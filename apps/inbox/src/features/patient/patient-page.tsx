import {
  ArrowLeft,
  BellRing,
  Check,
  FileWarning,
  MessageSquareOff,
  MessageSquareText,
  ShieldOff,
  Sparkles,
  X,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import type {
  ConditionView,
  PatientDetail,
  PatientExpectationView,
  SuppressionView,
} from '../../api/contract.ts';
import {
  useConditionReview,
  useNoteReader,
  useNow,
  usePatient,
  useReactivateSuppression,
} from '../../api/queries.ts';
import { LayerChip, ReasonProtocol } from '../../components/case-badges.tsx';
import { InlineQuote } from '../../components/evidence.tsx';
import { ErrorState, InlineError, NotFoundState } from '../../components/states.tsx';
import { Badge, Button, Card, SectionTitle, Skeleton, type Tone } from '../../components/ui.tsx';
import { PreVisitQuestions } from '../reviewer/pre-visit-questions.tsx';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { ContactFlagNotice } from '../case/contact-panel.tsx';
import {
  formatDate,
  formatLanguage,
  formatPercent,
  formatRelative,
  initials,
} from '../../lib/format.ts';

const CONDITION_TONES: Record<ConditionView['status'], Tone> = {
  confirmed: 'success',
  probable: 'warning',
  resolved: 'neutral',
  rejected: 'neutral',
  entered_in_error: 'neutral',
};

function ConfidenceBar({ value }: { readonly value: number }): ReactNode {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label={t.patient.confidence}
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${String(value * 100)}%` }}
        />
      </span>
      {t.patient.confidenceValue(formatPercent(value))}
    </span>
  );
}

function ConditionItem({
  condition,
  patientId,
}: {
  readonly condition: ConditionView;
  readonly patientId: string;
}): ReactNode {
  const t = useT();
  const review = useConditionReview(patientId);
  const reader = useNoteReader();
  const [decision, setDecision] = useState<'confirm' | 'reject'>();

  function handleReview(event: MouseEvent<HTMLButtonElement>): void {
    const next = event.currentTarget.value === 'confirm' ? 'confirm' : 'reject';
    setDecision(next);
    review.mutate({ id: condition.id, decision: next });
  }

  const probable = condition.status === 'probable';
  const fromAi = condition.sourceType === 'extracted_from_note';
  return (
    <li
      className={cx(
        'flex flex-col gap-3 rounded-xl border p-4',
        probable ? 'border-warning/40 bg-warning-soft/30' : 'border-border bg-surface',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-fg">{condition.display}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <code className="font-mono">{t.patient.icd10(condition.code)}</code>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              {fromAi ? <Sparkles className="size-3 text-layer-plan" aria-hidden="true" /> : null}
              {fromAi && reader.simulated
                ? t.patient.readFromNoteSimulated
                : (t.labels.conditionSources[condition.sourceType] ?? condition.sourceType)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {condition.status === 'rejected' ? null : <ConfidenceBar value={condition.confidence} />}
          <Badge tone={CONDITION_TONES[condition.status]}>
            {t.labels.conditionStatuses[condition.status]}
          </Badge>
        </div>
      </div>
      {condition.status === 'rejected' && condition.rejectedBy ? (
        <p className="text-xs text-muted">{t.patient.rejectedBy[condition.rejectedBy]}</p>
      ) : null}
      {condition.evidence ? (
        <p className="text-sm">
          <span className="mr-1.5 text-xs font-medium text-muted">{t.patient.evidence}</span>
          <InlineQuote quote={condition.evidence.quote} />
        </p>
      ) : null}
      {probable ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">{t.patient.reviewPrompt}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="success"
              value="confirm"
              onClick={handleReview}
              loading={review.isPending && decision === 'confirm'}
              icon={<Check className="size-3.5" aria-hidden="true" />}
            >
              {t.patient.confirm}
            </Button>
            <Button
              size="sm"
              variant="danger"
              value="reject"
              onClick={handleReview}
              loading={review.isPending && decision === 'reject'}
              icon={<X className="size-3.5" aria-hidden="true" />}
            >
              {t.patient.reject}
            </Button>
          </div>
          <InlineError error={review.error} />
        </div>
      ) : null}
    </li>
  );
}

const EXPECTATION_TONES: Record<PatientExpectationView['status'], Tone> = {
  open: 'info',
  expired: 'danger',
  fulfilled: 'success',
  superseded: 'neutral',
  cancelled: 'neutral',
};

function ExpectationItem({
  expectation,
}: {
  readonly expectation: PatientExpectationView;
}): ReactNode {
  const t = useT();
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <LayerChip layer={expectation.layer} />
          <span className="text-sm font-medium text-fg">{expectation.label}</span>
        </div>
        <Badge tone={EXPECTATION_TONES[expectation.status]}>
          {t.labels.expectationStatuses[expectation.status]}
        </Badge>
      </div>
      <ReasonProtocol
        protocol={expectation.protocol}
        withDraftBadge={expectation.status === 'open' || expectation.status === 'expired'}
      />
      <p className="text-xs text-muted">{t.patient.deadline(formatDate(expectation.dueAt))}</p>
      {expectation.closedReason ? (
        <p className="text-xs text-muted">{t.patient.closedReason(expectation.closedReason)}</p>
      ) : null}
      {expectation.evidence ? <InlineQuote quote={expectation.evidence.quote} /> : null}
    </li>
  );
}

function SuppressionItem({
  suppression,
  patientId,
}: {
  readonly suppression: SuppressionView;
  readonly patientId: string;
}): ReactNode {
  const t = useT();
  const reactivate = useReactivateSuppression(patientId);
  const [done, setDone] = useState(false);

  function handleReactivate(): void {
    if (reactivate.isPending) return;
    reactivate.mutate(suppression.id, {
      onSuccess: () => {
        setDone(true);
      },
    });
  }

  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{suppression.label}</p>
          <p className="mt-0.5 text-xs text-muted">
            {suppression.dismissReasonLabel}
            {t.common.separator}
            {suppression.createdBy ? `${suppression.createdBy}, ` : ''}
            {formatDate(suppression.createdAt)}
            {suppression.caseId ? (
              <>
                {t.common.separator}
                <Link
                  to={`/cases/${suppression.caseId}`}
                  className="font-medium text-primary underline underline-offset-2"
                >
                  {t.suppressions.caseLink}
                </Link>
              </>
            ) : null}
          </p>
          {!suppression.active && suppression.revokedAt ? (
            <p className="mt-0.5 text-xs text-muted">
              {t.suppressions.reactivatedBy(
                suppression.revokedBy,
                formatDate(suppression.revokedAt),
              )}
            </p>
          ) : null}
        </div>
        {suppression.active ? (
          <Button
            size="sm"
            loading={reactivate.isPending}
            onClick={handleReactivate}
            icon={<BellRing className="size-3.5" aria-hidden="true" />}
          >
            {t.suppressions.reactivate}
          </Button>
        ) : (
          <Badge tone="neutral">{t.suppressions.reactivatedBadge}</Badge>
        )}
      </div>
      {suppression.note ? (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg">{suppression.note}</p>
      ) : null}
      <InlineError error={reactivate.error} />
      <p aria-live="polite" className={cx('text-xs text-success', !done && 'sr-only')}>
        {done ? t.suppressions.reactivatedDone : ''}
      </p>
    </li>
  );
}

function SuppressionsSection({
  suppressions,
  patientId,
}: {
  readonly suppressions: readonly SuppressionView[];
  readonly patientId: string;
}): ReactNode {
  const t = useT();
  const active = suppressions.filter((suppression) => suppression.active);
  const history = suppressions.filter((suppression) => !suppression.active);
  return (
    <Card className="flex flex-col p-5" aria-labelledby="suppressions-title">
      <SectionTitle id="suppressions-title" count={active.length}>
        {t.suppressions.title}
      </SectionTitle>
      <p className="mt-1 text-xs text-muted">{t.suppressions.intro}</p>
      {active.length === 0 ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
          <ShieldOff className="size-4" aria-hidden="true" />
          {t.suppressions.empty}
        </p>
      ) : (
        <ul className="mt-1">
          {active.map((suppression) => (
            <SuppressionItem key={suppression.id} suppression={suppression} patientId={patientId} />
          ))}
        </ul>
      )}
      {history.length > 0 ? (
        <details className="mt-2 rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-muted hover:text-fg">
            {t.suppressions.history(history.length)}
          </summary>
          <ul className="px-3">
            {history.map((suppression) => (
              <SuppressionItem
                key={suppression.id}
                suppression={suppression}
                patientId={patientId}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

function PatientView({ detail }: { readonly detail: PatientDetail }): ReactNode {
  const t = useT();
  const now = useNow();
  const { patient } = detail;
  const open = detail.expectations.filter(
    (item) => item.status === 'open' || item.status === 'expired',
  );
  const closed = detail.expectations.filter(
    (item) => item.status !== 'open' && item.status !== 'expired',
  );
  const contact = patient.contact;
  // A record entered in error (or moved to another patient) was never this
  // patient's: never shown, even if an API sends it.
  const conditions = detail.conditions.filter(
    (condition) => condition.status !== 'entered_in_error',
  );
  const probable = conditions.filter((condition) => condition.status === 'probable').length;
  // Rejected readings stay on record but out of the way: a collapsed group.
  const current = conditions.filter((condition) => condition.status !== 'rejected');
  const rejected = conditions.filter((condition) => condition.status === 'rejected');

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <Link
        to="/inbox"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t.patient.back}
      </Link>

      <Card className="flex flex-wrap items-center gap-4 p-5">
        <span
          className="grid size-12 place-items-center rounded-full bg-primary-soft text-base font-semibold text-primary"
          aria-hidden="true"
        >
          {initials(patient.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{patient.name}</h1>
          <p className="text-sm text-muted">
            {[
              patient.age === undefined ? undefined : t.patient.age(patient.age),
              patient.sex === undefined || patient.sex === 'unknown'
                ? undefined
                : t.labels.sexes[patient.sex],
            ]
              .filter((part) => part !== undefined)
              .join(t.common.separator) || t.patient.noDemographics}
          </p>
          {detail.language ? (
            <p className="mt-0.5 text-xs text-muted">
              {t.common.preferredLanguage(formatLanguage(detail.language))}
            </p>
          ) : null}
        </div>
        {contact ? (
          <div className="flex flex-col items-start gap-1 text-xs sm:items-end">
            {contact.optedOut || !contact.allowed ? (
              <Badge
                tone="warning"
                icon={<MessageSquareOff className="size-3" aria-hidden="true" />}
              >
                {t.patient.noMessages}
              </Badge>
            ) : (
              <Badge
                tone="success"
                icon={<MessageSquareText className="size-3" aria-hidden="true" />}
              >
                {t.patient.contactAllowed}
              </Badge>
            )}
            <span className="text-muted">
              {contact.lastContactAt
                ? t.patient.lastContact(formatRelative(contact.lastContactAt, now))
                : t.patient.noContacts}
            </span>
          </div>
        ) : null}
      </Card>

      {contact?.contactFlag ? <ContactFlagNotice flag={contact.contactFlag} now={now} /> : null}

      <PreVisitQuestions patientId={detail.patient.id} />

      <section aria-labelledby="conditions-title" className="flex flex-col gap-3">
        <SectionTitle id="conditions-title" count={current.length}>
          {t.patient.conditions}
        </SectionTitle>
        {probable > 0 ? (
          <p className="text-sm text-muted">
            {probable === 1 ? t.patient.probableOne : t.patient.probableMany(probable)}
          </p>
        ) : null}
        {current.length === 0 ? (
          <Card className="p-4 text-sm text-muted">{t.patient.noConditions}</Card>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {current.map((condition) => (
              <ConditionItem key={condition.id} condition={condition} patientId={patient.id} />
            ))}
          </ul>
        )}
        {rejected.length > 0 ? (
          <details className="group rounded-xl border border-border bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted hover:text-fg">
              {t.patient.ruledOut(rejected.length)}
            </summary>
            <ul className="flex flex-col gap-2.5 px-4 pb-4">
              {rejected.map((condition) => (
                <ConditionItem key={condition.id} condition={condition} patientId={patient.id} />
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="flex flex-col p-5" aria-labelledby="open-expectations-title">
          <SectionTitle id="open-expectations-title" count={open.length}>
            {t.patient.openExpectations}
          </SectionTitle>
          {open.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{t.patient.nothingPending}</p>
          ) : (
            <ul className="mt-1">
              {open.map((expectation) => (
                <ExpectationItem key={expectation.id} expectation={expectation} />
              ))}
            </ul>
          )}
        </Card>
        <Card className="flex flex-col p-5" aria-labelledby="closed-expectations-title">
          <SectionTitle id="closed-expectations-title" count={closed.length}>
            {t.patient.closedExpectations}
          </SectionTitle>
          {closed.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{t.patient.noClosed}</p>
          ) : (
            <ul className="mt-1">
              {closed.map((expectation) => (
                <ExpectationItem key={expectation.id} expectation={expectation} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <SuppressionsSection suppressions={detail.suppressions} patientId={patient.id} />

      <section aria-labelledby="quality-title" className="flex flex-col gap-3">
        <SectionTitle id="quality-title" count={detail.qualityFindings.length}>
          {t.patient.quality}
        </SectionTitle>
        {detail.qualityFindings.length === 0 ? (
          <Card className="p-4 text-sm text-muted">{t.patient.qualityOk}</Card>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {detail.qualityFindings.map((finding) => (
              <li
                key={finding.id}
                className="flex gap-3 rounded-xl border border-warning/40 bg-warning-soft/30 p-4"
              >
                <FileWarning className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-fg">{finding.label}</p>
                  <p className="mt-0.5 text-sm text-muted">
                    {finding.code === 'note_truncated'
                      ? t.patient.truncated(formatDate(finding.at))
                      : t.patient.noPlan(formatDate(finding.at))}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function PatientPage(): ReactNode {
  const t = useT();
  const { patientId = '' } = useParams();
  const query = usePatient(patientId);
  function handleRetry(): void {
    void query.refetch();
  }
  if (query.isPending) {
    return (
      <div
        aria-busy="true"
        aria-label={t.patient.loading}
        className="mx-auto flex max-w-4xl flex-col gap-4"
      >
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          error={query.error}
          onRetry={handleRetry}
          title={t.patient.error}
          notFoundTitle={t.patient.notFound}
          notFoundHeading="h1"
        />
      </div>
    );
  }
  return <PatientView detail={query.data} />;
}

export function NotFoundPage(): ReactNode {
  const t = useT();
  return (
    <div className="mx-auto max-w-4xl">
      <NotFoundState title={t.errors.pageNotFound} heading="h1">
        {t.errors.pageNotFoundBody}
      </NotFoundState>
    </div>
  );
}
