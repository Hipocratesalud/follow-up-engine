import {
  ArrowLeft,
  Bot,
  CalendarX,
  CircleUser,
  Cog,
  Lightbulb,
  MessageSquareOff,
  MessageSquareText,
  ScrollText,
  UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { CaseDetail, CaseReasonView, CaseTimelineEntry } from '../../api/contract.ts';
import { ACTIVE_CASE_STATUSES } from '../../api/contract.ts';
import { useCase, useNow } from '../../api/queries.ts';
import {
  EscalationMeter,
  LayerChip,
  PriorityBadge,
  StatusBadge,
  overdueTone,
} from '../../components/case-badges.tsx';
import { EvidenceExcerpt } from '../../components/evidence.tsx';
import { ErrorState } from '../../components/states.tsx';
import { Badge, Card, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDate, formatDateTime, formatOverdue, formatRelative } from '../../lib/format.ts';
import { STATUS_LABELS, actorLabel, escalationLabel } from '../../lib/labels.ts';
import { patientMeta } from '../inbox/case-row.tsx';
import { CaseActions } from './case-actions.tsx';
import { FeedbackPanel } from './feedback-panel.tsx';

const SOURCE_TYPE_LABELS: Record<string, string> = {
  ServiceRequest: 'Orden',
  DocumentReference: 'Nota clínica',
  PlanDefinition: 'Protocolo',
  Encounter: 'Consulta',
  MedicationRequest: 'Receta',
};

function ReasonCard({ reason }: { readonly reason: CaseReasonView }): ReactNode {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <LayerChip layer={reason.layer} />
        <span className={cx('text-xs font-medium', overdueTone(reason.overdueDays))}>
          {formatOverdue(reason.overdueDays)}
        </span>
      </div>
      <div>
        <h3 className="text-[15px] font-semibold text-fg">{reason.label}</h3>
        <p className="mt-1 text-xs text-muted">
          Debía ocurrir antes del {formatDate(reason.dueAt)} · Origen:{' '}
          {SOURCE_TYPE_LABELS[reason.source.resourceType] ?? reason.source.resourceType} —{' '}
          {reason.source.display}
        </p>
      </div>
      {reason.evidence ? <EvidenceExcerpt evidence={reason.evidence} /> : null}
    </li>
  );
}

const ACTOR_ICONS = {
  rule: ScrollText,
  user: UserRound,
  patient: CircleUser,
  system: Cog,
} as const;

function Timeline({
  entries,
  now,
}: {
  readonly entries: readonly CaseTimelineEntry[];
  readonly now: Date;
}): ReactNode {
  return (
    <ol className="relative flex flex-col gap-4 pl-1">
      {entries.map((entry, index) => {
        const Icon = ACTOR_ICONS[entry.actor.type];
        return (
          <li key={`${entry.at}-${entry.type}-${String(index)}`} className="relative flex gap-3">
            {index < entries.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-8 bottom-[-12px] left-[13px] w-px bg-border"
              />
            ) : null}
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-muted">
              <Icon className="size-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-sm text-fg">{entry.label}</p>
              <p className="mt-0.5 text-xs text-muted">
                {actorLabel(entry.actor)}
                {entry.actor.type === 'rule' && entry.actor.id ? (
                  <code className="ml-1 font-mono text-[11px] text-subtle">{entry.actor.id}</code>
                ) : null}{' '}
                · <time dateTime={entry.at}>{formatDateTime(entry.at)}</time> (
                {formatRelative(entry.at, now)})
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ContactStatus({
  detail,
  now,
}: {
  readonly detail: CaseDetail;
  readonly now: Date;
}): ReactNode {
  const { patientContact } = detail;
  const blocked = !patientContact.allowed || patientContact.optedOut;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {blocked ? (
        <Badge tone="warning" icon={<MessageSquareOff className="size-3" aria-hidden="true" />}>
          {patientContact.optedOut ? 'No acepta mensajes' : 'Contacto no permitido'}
        </Badge>
      ) : (
        <Badge tone="success" icon={<MessageSquareText className="size-3" aria-hidden="true" />}>
          Contacto permitido
        </Badge>
      )}
      <span className="text-muted">
        {patientContact.lastContactAt
          ? `Último contacto ${formatRelative(patientContact.lastContactAt, now)}`
          : 'Sin contactos registrados'}
      </span>
    </div>
  );
}

function CaseDetailView({
  detail,
  backTo,
}: {
  readonly detail: CaseDetail;
  readonly backTo?: string;
}): ReactNode {
  const now = useNow();
  const active = (ACTIVE_CASE_STATUSES as readonly string[]).includes(detail.status);
  const planReasons = detail.reasons.filter((reason) => reason.evidence).length;

  return (
    <article aria-labelledby="case-title" className="flex flex-col gap-4">
      {backTo ? (
        <Link
          to={backTo}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg lg:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Volver a la bandeja
        </Link>
      ) : null}

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="case-title" className="text-lg font-semibold tracking-tight text-fg">
              {detail.patient.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              {[
                patientMeta(detail.patient),
                detail.assignee ? `Responsable: ${detail.assignee}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Link
            to={`/pacientes/${detail.patient.id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
          >
            <UserRound className="size-3.5" aria-hidden="true" />
            Ver paciente
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={detail.status} />
          <PriorityBadge label={detail.priorityLabel} priority={detail.priority} />
          <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted">
            <EscalationMeter step={detail.escalationStep} />
            {escalationLabel(detail.escalationStep)}
          </span>
          {detail.origin === 'backfill' ? (
            <Badge tone="info">Recuperado del historial</Badge>
          ) : null}
          <span className="text-xs text-muted">Abierto {formatRelative(detail.openedAt, now)}</span>
        </div>
        <ContactStatus detail={detail} now={now} />
      </Card>

      {active ? (
        <Card className="flex flex-col gap-4 border-primary/30 p-5">
          <div className="flex gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
              <Lightbulb className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-fg">Siguiente paso sugerido</h3>
              <p className="mt-1 text-sm text-muted">{detail.suggestedAction}</p>
              {detail.status === 'snoozed' && detail.snoozedUntil ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <CalendarX className="size-3.5" aria-hidden="true" />
                  Pospuesto hasta el {formatDate(detail.snoozedUntil)}
                </p>
              ) : null}
            </div>
          </div>
          <CaseActions detail={detail} />
        </Card>
      ) : (
        <Card className="flex items-center gap-3 p-4 text-sm text-muted">
          <StatusBadge status={detail.status} />
          Este caso está cerrado ({STATUS_LABELS[detail.status].toLowerCase()}). Si el paciente
          vuelve a tener algo pendiente, el motor abrirá un caso nuevo.
        </Card>
      )}

      <section aria-labelledby="reasons-title" className="flex flex-col gap-3">
        <SectionTitle id="reasons-title" count={detail.reasons.length}>
          Motivos
        </SectionTitle>
        {planReasons > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Bot className="size-3.5 text-layer-plan" aria-hidden="true" />
            Las citas resaltadas son texto literal de la nota del médico, no una paráfrasis.
          </p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {detail.reasons.map((reason) => (
            <ReasonCard key={reason.expectationId} reason={reason} />
          ))}
        </ul>
      </section>

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-sm font-semibold text-fg">¿Te sirvió este caso?</h3>
        <FeedbackPanel caseId={detail.id} feedback={detail.feedback} />
      </Card>

      <Card className="flex flex-col gap-4 p-5" aria-labelledby="timeline-title">
        <SectionTitle id="timeline-title">Historial del caso</SectionTitle>
        <Timeline entries={detail.timeline} now={now} />
      </Card>
    </article>
  );
}

function CaseDetailSkeleton(): ReactNode {
  return (
    <div aria-busy="true" aria-label="Cargando caso" className="flex flex-col gap-4">
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-32 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
}

export function CaseDetailPanel({
  caseId,
  backTo,
}: {
  readonly caseId: string;
  readonly backTo?: string;
}): ReactNode {
  const query = useCase(caseId);
  function handleRetry(): void {
    void query.refetch();
  }
  if (query.isPending) return <CaseDetailSkeleton />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} onRetry={handleRetry} title="No pudimos cargar el caso" />
    );
  }
  return <CaseDetailView detail={query.data} {...(backTo ? { backTo } : {})} />;
}
