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
  PriorityLabel,
  ProtocolRef,
} from '../api/contract.ts';
import { cx } from '../lib/cx.ts';
import { formatDate } from '../lib/format.ts';
import {
  DRAFT_PROTOCOL_HINT,
  DRAFT_PROTOCOL_LABEL,
  LAYER_DESCRIPTIONS,
  LAYER_LABELS,
  PROTOCOL_NAME_PREFIX,
  PRIORITY_LABELS,
  STATUS_LABELS,
  escalationNext,
  escalationSummary,
} from '../lib/labels.ts';
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
  const Icon = LAYER_ICONS[layer];
  return (
    <span
      title={LAYER_DESCRIPTIONS[layer]}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        LAYER_STYLES[layer],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {LAYER_LABELS[layer]}
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
  const Icon = STATUS_ICONS[status];
  return (
    <Badge tone={STATUS_TONES[status]} icon={<Icon className="size-3" aria-hidden="true" />}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const PRIORITY_TONES: Record<PriorityLabel, Tone> = {
  urgente: 'danger',
  alta: 'warning',
  media: 'info',
  baja: 'neutral',
};

export function PriorityBadge({
  label,
  priority,
}: {
  readonly label: PriorityLabel;
  readonly priority: number;
}): ReactNode {
  return (
    <Badge tone={PRIORITY_TONES[label]} title={`Prioridad ${String(priority)} de 100`}>
      <span className="sr-only">Prioridad </span>
      {PRIORITY_LABELS[label]}
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
  const summary = escalationSummary(escalation);
  const next = escalationNext(escalation, formatDate);
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
          {summary.replace(/^Escalamiento: /, '')}
        </span>
      ) : null}
    </span>
  );
}

export function isDraftProtocol(protocol: ProtocolRef | undefined): boolean {
  return protocol?.status === 'draft';
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
  return (
    <Badge
      tone="warning"
      wrap
      title={DRAFT_PROTOCOL_HINT}
      icon={<FilePen className="mt-0.5 size-3 shrink-0" aria-hidden="true" />}
    >
      <span>
        {DRAFT_PROTOCOL_LABEL}
        {describe ? <span className="sr-only">. {DRAFT_PROTOCOL_HINT}</span> : null}
      </span>
    </Badge>
  );
}

/**
 * Where a reason comes from when a protocol asks for it: the protocol's
 * Spanish name and, for a draft, the draft badge. Nothing for other reasons.
 */
export function ReasonProtocol({
  protocol,
  withDraftBadge = true,
}: {
  readonly protocol: ProtocolRef | undefined;
  /** Closed expectations of a patient's history keep the protocol name, without the badge. */
  readonly withDraftBadge?: boolean;
}): ReactNode {
  const draft = withDraftBadge && isDraftProtocol(protocol);
  if (protocol?.name === undefined && !draft) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {protocol?.name === undefined ? null : (
        <span className="text-xs text-muted">
          {PROTOCOL_NAME_PREFIX} <span className="font-medium text-fg">{protocol.name}</span>
        </span>
      )}
      {draft ? <DraftProtocolBadge /> : null}
    </div>
  );
}

export function overdueTone(days: number): string {
  if (days >= 30) return 'text-danger';
  if (days >= 7) return 'text-warning';
  return 'text-muted';
}
