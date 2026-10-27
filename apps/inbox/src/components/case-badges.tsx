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
import type { CaseStatus, EscalationView, Layer, PriorityLabel } from '../api/contract.ts';
import { cx } from '../lib/cx.ts';
import { formatDate } from '../lib/format.ts';
import {
  LAYER_DESCRIPTIONS,
  LAYER_LABELS,
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

export function overdueTone(days: number): string {
  if (days >= 30) return 'text-danger';
  if (days >= 7) return 'text-warning';
  return 'text-muted';
}
