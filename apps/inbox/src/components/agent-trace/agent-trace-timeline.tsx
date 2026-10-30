import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatDateTime, formatUsd } from '../../lib/format.ts';

/**
 * One step of an agent's run: a tool call, a read, its submission, or
 * anything else worth showing in order. Generic on purpose (PRD V3,
 * "visible reviewer trace"): any agent that keeps a step-by-step audit
 * trail can render it through {@link AgentTraceTimeline}, not only the
 * clinical reviewer.
 */
export interface AgentTraceStep {
  /** Stable key (the step's index, or a run-scoped id). */
  readonly id: string;
  /** Free-form kind of step ('tool_call', 'read', 'submission', ...); callers style their own icon or label by it if they want one. */
  readonly kind: string;
  /** Plain-language title ("Looked up the creatinine trend"). */
  readonly title: string;
  /** Secondary line: tool name, its sanitized arguments, the outcome, what it read. */
  readonly detail?: string;
  /** Model that answered this step, when it can differ step to step. */
  readonly model?: string;
  /** Cost of this step in USD, when it is tracked per step. */
  readonly cost?: number;
  /** When the step happened (ISO 8601). */
  readonly timestamp?: string;
}

/** A label/value pair shown above the timeline (steps, tool calls, total cost, model, stop reason...). */
export interface AgentTraceFact {
  readonly label: string;
  readonly value: string;
}

export interface AgentTraceTimelineProps {
  /** Heading of the collapsible panel ("How the reviewer got here"). */
  readonly title: string;
  /** Text shown next to the heading while collapsed ("See the steps"). */
  readonly toggleLabel: string;
  readonly steps: readonly AgentTraceStep[];
  /** Shown instead of the step list when `steps` is empty. */
  readonly emptyLabel?: string;
  readonly facts?: readonly AgentTraceFact[];
  /** Anything to show after the steps: what was discarded, which quote validated the result. */
  readonly footer?: ReactNode;
  /** Expanded on first render; collapsed (the default) otherwise. */
  readonly defaultOpen?: boolean;
}

function stepMeta(step: AgentTraceStep): string | undefined {
  const parts = [
    step.model,
    step.cost === undefined ? undefined : formatUsd(step.cost),
    step.timestamp === undefined ? undefined : formatDateTime(step.timestamp),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

function AgentTraceStepRow({
  index,
  step,
}: {
  readonly index: number;
  readonly step: AgentTraceStep;
}): ReactNode {
  const meta = stepMeta(step);
  return (
    <li className="flex gap-2.5 text-sm">
      <span
        className="grid size-5 shrink-0 place-items-center rounded-full bg-layer-plan-soft text-[11px] font-semibold text-layer-plan tabular-nums"
        data-kind={step.kind}
      >
        {index}
      </span>
      <span className="min-w-0">
        <span className="text-fg">{step.title}</span>
        {step.detail ? <span className="block text-xs text-muted">{step.detail}</span> : null}
        {meta ? <span className="block text-xs text-muted">{meta}</span> : null}
      </span>
    </li>
  );
}

/**
 * A reusable "how the agent got here" timeline: a collapsible panel with
 * optional summary facts, the ordered steps and an optional footer. Built
 * for the clinical reviewer's finding detail; kept generic (props carry
 * plain strings and numbers, nothing reviewer-specific) so another agent's
 * console can render its own run the same way.
 */
export function AgentTraceTimeline({
  title,
  toggleLabel,
  steps,
  emptyLabel,
  facts,
  footer,
  defaultOpen = false,
}: AgentTraceTimelineProps): ReactNode {
  return (
    <details
      open={defaultOpen || undefined}
      className="group rounded-xl border border-border bg-surface shadow-card"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-fg">
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4 text-layer-plan" aria-hidden="true" />
          {title}
        </span>
        <span className="text-xs font-normal text-muted group-open:hidden">{toggleLabel}</span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
        {facts && facts.length > 0 ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-muted">{fact.label}</dt>
                <dd className="truncate font-medium text-fg">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {steps.length === 0 ? (
          emptyLabel ? (
            <p className="text-sm text-muted">{emptyLabel}</p>
          ) : null
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <AgentTraceStepRow key={step.id} index={index + 1} step={step} />
            ))}
          </ol>
        )}
        {footer}
      </div>
    </details>
  );
}
