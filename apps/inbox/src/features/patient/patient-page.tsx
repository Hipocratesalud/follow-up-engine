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
import { cx } from '../../lib/cx.ts';
import { SUPPRESSIONS_COPY } from '../../lib/copy.ts';
import { ContactFlagNotice } from '../case/contact-panel.tsx';
import { formatDate, formatPercent, formatRelative, initials } from '../../lib/format.ts';
import {
  CONDITION_SOURCE_LABELS,
  CONDITION_STATUS_LABELS,
  EXPECTATION_STATUS_LABELS,
  SEX_LABELS,
} from '../../lib/labels.ts';

const CONDITION_TONES: Record<ConditionView['status'], Tone> = {
  confirmed: 'success',
  probable: 'warning',
  resolved: 'neutral',
  rejected: 'neutral',
  entered_in_error: 'neutral',
};

/** Who ruled the condition out: the clinic's own system (its FHIR record) or the team here. */
const REJECTED_BY_LABELS: Record<NonNullable<ConditionView['rejectedBy']>, string> = {
  host: 'Descartada por el sistema del consultorio',
  clinician: 'Descartada por el equipo',
};

function ConfidenceBar({ value }: { readonly value: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label="Confianza"
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${String(value * 100)}%` }}
        />
      </span>
      {formatPercent(value)} de confianza
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
            <code className="font-mono">CIE-10 {condition.code}</code>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              {fromAi ? <Sparkles className="size-3 text-layer-plan" aria-hidden="true" /> : null}
              {fromAi && reader.simulated
                ? 'Leída de la nota (lectura simulada)'
                : (CONDITION_SOURCE_LABELS[condition.sourceType] ?? condition.sourceType)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {condition.status === 'rejected' ? null : <ConfidenceBar value={condition.confidence} />}
          <Badge tone={CONDITION_TONES[condition.status]}>
            {CONDITION_STATUS_LABELS[condition.status]}
          </Badge>
        </div>
      </div>
      {condition.status === 'rejected' && condition.rejectedBy ? (
        <p className="text-xs text-muted">{REJECTED_BY_LABELS[condition.rejectedBy]}</p>
      ) : null}
      {condition.evidence ? (
        <p className="text-sm">
          <span className="mr-1.5 text-xs font-medium text-muted">Evidencia:</span>
          <InlineQuote quote={condition.evidence.quote} />
        </p>
      ) : null}
      {probable ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            ¿Es correcta? Si la confirmas, sus controles de protocolo quedan firmes; si la
            descartas, se cancelan.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="success"
              value="confirm"
              onClick={handleReview}
              loading={review.isPending && decision === 'confirm'}
              icon={<Check className="size-3.5" aria-hidden="true" />}
            >
              Confirmar
            </Button>
            <Button
              size="sm"
              variant="danger"
              value="reject"
              onClick={handleReview}
              loading={review.isPending && decision === 'reject'}
              icon={<X className="size-3.5" aria-hidden="true" />}
            >
              Descartar
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
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <LayerChip layer={expectation.layer} />
          <span className="text-sm font-medium text-fg">{expectation.label}</span>
        </div>
        <Badge tone={EXPECTATION_TONES[expectation.status]}>
          {EXPECTATION_STATUS_LABELS[expectation.status]}
        </Badge>
      </div>
      <ReasonProtocol
        protocol={expectation.protocol}
        withDraftBadge={expectation.status === 'open' || expectation.status === 'expired'}
      />
      <p className="text-xs text-muted">Fecha límite: {formatDate(expectation.dueAt)}</p>
      {expectation.closedReason ? (
        <p className="text-xs text-muted">Motivo del cierre: {expectation.closedReason}</p>
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
            {suppression.dismissReasonLabel} ·{' '}
            {suppression.createdBy ? `${suppression.createdBy}, ` : ''}
            {formatDate(suppression.createdAt)}
            {suppression.caseId ? (
              <>
                {' · '}
                <Link
                  to={`/casos/${suppression.caseId}`}
                  className="font-medium text-primary underline underline-offset-2"
                >
                  {SUPPRESSIONS_COPY.caseLink}
                </Link>
              </>
            ) : null}
          </p>
          {!suppression.active && suppression.revokedAt ? (
            <p className="mt-0.5 text-xs text-muted">
              {SUPPRESSIONS_COPY.reactivatedBy(
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
            {SUPPRESSIONS_COPY.reactivate}
          </Button>
        ) : (
          <Badge tone="neutral">{SUPPRESSIONS_COPY.reactivatedBadge}</Badge>
        )}
      </div>
      {suppression.note ? (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg">{suppression.note}</p>
      ) : null}
      <InlineError error={reactivate.error} />
      <p aria-live="polite" className={cx('text-xs text-success', !done && 'sr-only')}>
        {done ? SUPPRESSIONS_COPY.reactivatedDone : ''}
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
  const active = suppressions.filter((suppression) => suppression.active);
  const history = suppressions.filter((suppression) => !suppression.active);
  return (
    <Card className="flex flex-col p-5" aria-labelledby="suppressions-title">
      <SectionTitle id="suppressions-title" count={active.length}>
        {SUPPRESSIONS_COPY.title}
      </SectionTitle>
      <p className="mt-1 text-xs text-muted">{SUPPRESSIONS_COPY.intro}</p>
      {active.length === 0 ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
          <ShieldOff className="size-4" aria-hidden="true" />
          {SUPPRESSIONS_COPY.empty}
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
            {SUPPRESSIONS_COPY.history(history.length)}
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
        to="/bandeja"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Bandeja
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
              patient.age === undefined ? undefined : `${String(patient.age)} años`,
              patient.sex === undefined || patient.sex === 'unknown'
                ? undefined
                : SEX_LABELS[patient.sex],
            ]
              .filter((part) => part !== undefined)
              .join(' · ') || 'Sin edad ni sexo registrados'}
          </p>
        </div>
        {contact ? (
          <div className="flex flex-col items-start gap-1 text-xs sm:items-end">
            {contact.optedOut || !contact.allowed ? (
              <Badge
                tone="warning"
                icon={<MessageSquareOff className="size-3" aria-hidden="true" />}
              >
                No acepta mensajes
              </Badge>
            ) : (
              <Badge
                tone="success"
                icon={<MessageSquareText className="size-3" aria-hidden="true" />}
              >
                Contacto permitido
              </Badge>
            )}
            <span className="text-muted">
              {contact.lastContactAt
                ? `Último contacto ${formatRelative(contact.lastContactAt, now)}`
                : 'Sin contactos registrados'}
            </span>
          </div>
        ) : null}
      </Card>

      {contact?.contactFlag ? <ContactFlagNotice flag={contact.contactFlag} now={now} /> : null}

      <section aria-labelledby="conditions-title" className="flex flex-col gap-3">
        <SectionTitle id="conditions-title" count={current.length}>
          Condiciones
        </SectionTitle>
        {probable > 0 ? (
          <p className="text-sm text-muted">
            {probable === 1
              ? 'Hay una condición probable leída de las notas. Revísala: mientras no la confirmes, nadie contacta al paciente por ella.'
              : `Hay ${String(probable)} condiciones probables leídas de las notas. Revísalas: mientras no las confirmes, nadie contacta al paciente por ellas.`}
          </p>
        ) : null}
        {current.length === 0 ? (
          <Card className="p-4 text-sm text-muted">Sin condiciones registradas.</Card>
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
              Descartadas ({rejected.length})
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
            Expectativas abiertas
          </SectionTitle>
          {open.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nada pendiente.</p>
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
            Expectativas cerradas
          </SectionTitle>
          {closed.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Aún no hay expectativas cerradas.</p>
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
          Calidad de la documentación
        </SectionTitle>
        {detail.qualityFindings.length === 0 ? (
          <Card className="p-4 text-sm text-muted">
            Las notas de este paciente tienen plan de seguimiento.
          </Card>
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
                    {finding.code === 'note_truncated' ? (
                      <>
                        La nota del {formatDate(finding.at)} es más larga de lo que se lee: se
                        leyeron su inicio y su final, no la parte del medio. Revisa la nota por si
                        el plan pide algo más.
                      </>
                    ) : (
                      <>
                        La nota del {formatDate(finding.at)} no indica cuándo debe volver el
                        paciente. Sin plan, el seguimiento depende de la frecuencia habitual de la
                        especialidad.
                      </>
                    )}
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
  const { patientId = '' } = useParams();
  const query = usePatient(patientId);
  function handleRetry(): void {
    void query.refetch();
  }
  if (query.isPending) {
    return (
      <div
        aria-busy="true"
        aria-label="Cargando paciente"
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
          title="No pudimos cargar el paciente"
          notFoundTitle="No encontramos ese paciente"
          notFoundHeading="h1"
        />
      </div>
    );
  }
  return <PatientView detail={query.data} />;
}

export function NotFoundPage(): ReactNode {
  return (
    <div className="mx-auto max-w-4xl">
      <NotFoundState title="Esta página no existe" heading="h1">
        Revisa la dirección o vuelve a la bandeja.
      </NotFoundState>
    </div>
  );
}
