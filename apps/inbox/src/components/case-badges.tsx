import {
  CalendarClock,
  CheckCircle2,
  Circle,
  ClipboardList,
  FilePen,
  MessageCircle,
  PauseCircle,
  ShieldCheck,
  Stethoscope,
  TrendingUp,
  UserX,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  CaseStatus,
  EscalationView,
  Layer,
  PriorityBand,
  ProtocolRef,
} from '../api/contract.ts';
import { cx } from '../lib/cx.ts';
import { useT } from '../i18n/index.ts';
import { formatDate } from '../lib/format.ts';
import { escalationNext, escalationSummary } from '../lib/labels.ts';
import { Badge, type Tone } from './ui.tsx';

const LAYER_STYLES: Record<Layer, string> = {
  universal: 'bg-layer-universal-soft text-layer-universal',
  doctor_plan: 'bg-layer-plan-soft text-layer-plan',
  cadence: 'bg-layer-cadence-soft text-layer-cadence',
  protocol: 'bg-layer-protocol-soft text-layer-protocol',
};

export const LAYER_DOT: Record<Layer, string> = {
  universal: 'bg-layer-universal',
  doctor_plan: 'bg-layer-plan',
  cadence: 'bg-layer-cadence',
  protocol: 'bg-layer-protocol',
};

const LAYER_ICONS: Record<Layer, LucideIcon> = {
  universal: ClipboardList,
  doctor_plan: Stethoscope,
  cadence: CalendarClock,
  protocol: ShieldCheck,
};

export function LayerChip({
  layer,
  className,
}: {
  readonly layer: Layer;
  readonly className?: string;
}): ReactNode {
  const t = useT();
  const Icon = LAYER_ICONS[layer];
  return (
    <span
      title={t.labels.layerDescriptions[layer]}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        LAYER_STYLES[layer],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {t.labels.layers[layer]}
    </span>
  );
}

const STATUS_TONES: Record<CaseStatus, Tone> = {
  open: 'info',
  notified: 'primary',
  snoozed: 'neutral',
  escalated: 'warning',
  resolved: 'success',
  dismissed: 'neutral',
  lost_to_follow_up: 'danger',
};

const STATUS_ICONS: Record<CaseStatus, LucideIcon> = {
  open: Circle,
  notified: MessageCircle,
  snoozed: PauseCircle,
  escalated: TrendingUp,
  resolved: CheckCircle2,
  dismissed: XCircle,
  lost_to_follow_up: UserX,
};

export function StatusBadge({ status }: { readonly status: CaseStatus }): ReactNode {
  const t = useT();
  const Icon = STATUS_ICONS[status];
  return (
    <Badge tone={STATUS_TONES[status]} icon={<Icon className="size-3" aria-hidden="true" />}>
      {t.labels.statuses[status]}
    </Badge>
  );
}

const PRIORITY_TONES: Record<PriorityBand, Tone> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

export function PriorityBadge({
  band,
  priority,
}: {
  readonly band: PriorityBand;
  readonly priority: number;
}): ReactNode {
  const t = useT();
  return (
    <Badge tone={PRIORITY_TONES[band]} title={t.labels.priorityTitle(priority)}>
      <span className="sr-only">{t.labels.priorityPrefix}</span>
      {t.labels.priorities[band]}
    </Badge>
  );
}

/**
 * How far the case went along its escalation policy: one bar per policy step
 * (from the API), filled for the steps already passed, faded when a passed
 * step could not happen (detail only). The label names the last step and the
 * next one with its date.
 */
export function EscalationMeter({
  escalation,
  showLabel = false,
}: {
  readonly escalation: EscalationView;
  readonly showLabel?: boolean;
}): ReactNode {
  const t = useT();
  const summary = escalationSummary(t, escalation);
  const next = escalationNext(t, escalation, formatDate);
  const label = next ? `${summary}. ${next}.` : `${summary}.`;
  const late = escalation.currentStep >= Math.max(2, escalation.steps.length - 2);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={label}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
        {escalation.steps.map((step, index) => (
          <span
            key={`${step.action}-${String(index)}`}
            className={cx(
              'h-1.5 w-3 rounded-full',
              index >= escalation.currentStep
                ? 'bg-surface-3'
                : step.outcome === 'skipped'
                  ? 'bg-border-strong'
                  : late
                    ? 'bg-warning'
                    : 'bg-primary',
            )}
          />
        ))}
      </span>
      {showLabel ? (
        <span aria-hidden="true" className="min-w-0 text-xs text-muted">
          {summary.startsWith(t.labels.escalationPrefix)
            ? summary.slice(t.labels.escalationPrefix.length)
            : summary}
        </span>
      ) : null}
    </span>
  );
}

/** A protocol the clinical team has not validated yet: `draft` or `ready_for_signoff`. */
export function isUnvalidatedProtocol(protocol: ProtocolRef | undefined): boolean {
  return protocol?.status === 'draft' || protocol?.status === 'ready_for_signoff';
}

/**
 * Marks a reason that comes from a protocol the clinical team has not
 * validated yet. The text says it (not color only); the hint is the
 * tooltip and, with `describe`, is also read by screen readers. Inside a
 * link (the case row) pass `describe={false}` to keep the link name short.
 */
export function DraftProtocolBadge({
  describe = true,
}: {
  readonly describe?: boolean;
}): ReactNode {
  const t = useT();
  return (
    <Badge
      tone="warning"
      wrap
      title={t.labels.draftProtocolHint}
      icon={<FilePen className="mt-0.5 size-3 shrink-0" aria-hidden="true" />}
    >
      <span>
        {t.labels.draftProtocol}
        {describe ? <span className="sr-only">. {t.labels.draftProtocolHint}</span> : null}
      </span>
    </Badge>
  );
}

/**
 * Marks a reason that comes from a protocol with a sign-off package
 * (docs/protocols/signoff) nobody has approved yet: still unvalidated, but
 * further along than a plain draft.
 */
export function ReadyForSignoffBadge({
  describe = true,
}: {
  readonly describe?: boolean;
}): ReactNode {
  const t = useT();
  return (
    <Badge
      tone="warning"
      wrap
      title={t.labels.readyForSignoffHint}
      icon={<FilePen className="mt-0.5 size-3 shrink-0" aria-hidden="true" />}
    >
      <span>
        {t.labels.readyForSignoff}
        {describe ? <span className="sr-only">. {t.labels.readyForSignoffHint}</span> : null}
      </span>
    </Badge>
  );
}

/** The right unvalidated badge for a protocol's status, or nothing for a validated one. */
export function ProtocolValidationBadge({
  status,
  describe = true,
}: {
  readonly status: ProtocolRef['status'];
  readonly describe?: boolean;
}): ReactNode {
  if (status === 'ready_for_signoff') {
    return <ReadyForSignoffBadge describe={describe} />;
  }
  if (status === 'draft') {
    return <DraftProtocolBadge describe={describe} />;
  }
  return null;
}

/**
 * Where a reason comes from when a protocol asks for it: the protocol's
 * name (in the request's language) and, when it is not validated yet, its
 * badge (draft or ready for sign-off). Nothing for other reasons.
 */
export function ReasonProtocol({
  protocol,
  withDraftBadge = true,
}: {
  readonly protocol: ProtocolRef | undefined;
  /** Closed expectations of a patient's history keep the protocol name, without the badge. */
  readonly withDraftBadge?: boolean;
}): ReactNode {
  const t = useT();
  const unvalidated = withDraftBadge && isUnvalidatedProtocol(protocol);
  if (protocol?.name === undefined && !unvalidated) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {protocol?.name === undefined ? null : (
        <span className="text-xs text-muted">
          {t.labels.protocolPrefix} <span className="font-medium text-fg">{protocol.name}</span>
        </span>
      )}
      {unvalidated ? <ProtocolValidationBadge status={protocol?.status} /> : null}
    </div>
  );
}

export function overdueTone(days: number): string {
  if (days >= 30) return 'text-danger';
  if (days >= 7) return 'text-warning';
  return 'text-muted';
}
