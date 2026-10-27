import {
  CalendarClock,
  CheckCircle2,
  Circle,
  ClipboardList,
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
import type { CaseStatus, Layer, PriorityLabel } from '../api/contract.ts';
import { cx } from '../lib/cx.ts';
import {
  ESCALATION_STEP_LABELS,
  LAYER_DESCRIPTIONS,
  LAYER_LABELS,
  MAX_ESCALATION_STEP,
  PRIORITY_LABELS,
  STATUS_LABELS,
  escalationLabel,
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

/** Three-step meter: how far the case has escalated. */
export function EscalationMeter({
  step,
  showLabel = false,
}: {
  readonly step: number;
  readonly showLabel?: boolean;
}): ReactNode {
  const clamped = Math.min(step, MAX_ESCALATION_STEP);
  const label = `Escalamiento ${String(clamped)} de ${String(MAX_ESCALATION_STEP)}: ${escalationLabel(clamped)}`;
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="flex items-center gap-0.5">
        {ESCALATION_STEP_LABELS.slice(1).map((stepLabel, index) => (
          <span
            key={stepLabel}
            className={cx(
              'h-1.5 w-3 rounded-full',
              index < clamped ? (clamped >= 2 ? 'bg-warning' : 'bg-primary') : 'bg-surface-3',
            )}
          />
        ))}
      </span>
      {showLabel ? (
        <span aria-hidden="true" className="text-xs text-muted">
          {escalationLabel(clamped)}
        </span>
      ) : null}
    </span>
  );
}

export function overdueTone(days: number): string {
  if (days >= 30) return 'text-danger';
  if (days >= 7) return 'text-warning';
  return 'text-muted';
}
