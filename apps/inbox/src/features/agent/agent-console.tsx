import { Bot, CalendarClock, Cog, Eye, Mic, ShieldAlert, ShieldCheck, Wrench } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import type { AgentStepKind, AgentStepView, TraceValue } from '../../api/agent-contract.ts';
import { Badge, Card, type Tone } from '../../components/ui.tsx';
import { useLocale, useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clinicDateTime, formatCost } from './format.ts';

const KIND_ICONS: Readonly<Record<AgentStepKind, typeof Bot>> = {
  model: Bot,
  tool: Wrench,
  engine: Cog,
  transcription: Mic,
  vision: Eye,
  guardrail: ShieldAlert,
  ladder: CalendarClock,
  policy: ShieldCheck,
};

const KIND_TONES: Readonly<Record<AgentStepKind, Tone>> = {
  model: 'primary',
  tool: 'info',
  engine: 'success',
  transcription: 'neutral',
  vision: 'neutral',
  guardrail: 'danger',
  ladder: 'warning',
  policy: 'warning',
};

function argText(value: TraceValue): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

function StepRow({
  step,
  timeZone,
}: {
  readonly step: AgentStepView;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const Icon = KIND_ICONS[step.kind];
  // The scripted player's reasons and summaries are codes: read in the reader's language.
  function words(value: TraceValue): TraceValue {
    return typeof value === 'string' ? (t.agent.reasons[value] ?? value) : value;
  }
  const params = Object.fromEntries(
    Object.entries(step.params ?? {}).map(([key, value]) => [key, words(value)]),
  );
  const describe = t.agent.events[step.event];
  const sentence = describe === undefined ? t.agent.unknownEvent(step.event) : describe(params);
  const args = Object.entries(step.arguments ?? {}).map(([key, value]): [string, TraceValue] => [
    key,
    words(value),
  ]);
  const reason = step.reason === undefined ? undefined : words(step.reason);
  const refused = step.outcome === 'rejected' || step.outcome === 'error';
  return (
    <li
      className={cx(
        'flex gap-3 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0',
        refused && 'bg-danger-soft/40',
        step.kind === 'engine' && 'bg-success-soft/40',
      )}
    >
      <Icon
        className={cx('mt-0.5 size-4 shrink-0', refused ? 'text-danger' : 'text-muted')}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={refused ? 'danger' : KIND_TONES[step.kind]}>
            {t.agent.console.kinds[step.kind] ?? step.kind}
          </Badge>
          {step.tool === undefined ? null : (
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-fg">
              {step.tool}
            </code>
          )}
          {refused ? (
            <Badge tone="danger">{t.agent.console.outcomes[step.outcome] ?? step.outcome}</Badge>
          ) : null}
          <span className="ml-auto text-[11px] text-subtle tabular-nums">
            #{step.seq} · {clinicDateTime(step.at, timeZone, locale)}
          </span>
        </div>
        <p className="text-fg">{sentence}</p>
        {reason === undefined || reason === '' || step.kind === 'model' ? null : (
          <p className="text-muted">
            <span className="font-medium">{t.agent.console.reason}: </span>
            <span className="italic">{String(reason)}</span>
          </p>
        )}
        {args.length === 0 ? null : (
          <p className="break-words font-mono text-[11.5px] text-muted">
            <span className="font-sans font-medium">{t.agent.console.args}: </span>
            {args.map(([key, value]) => `${key}=${argText(value)}`).join('  ')}
          </p>
        )}
        {step.read === undefined || step.read.length === 0 ? null : (
          <p className="text-[11.5px] text-muted">
            <span className="font-medium">{t.agent.console.read}: </span>
            {step.read.join(', ')}
          </p>
        )}
        {step.model === undefined ? null : (
          <p className="text-[11px] text-subtle tabular-nums">
            {step.model}
            {step.costUsd === undefined ? '' : ` · ${formatCost(step.costUsd)}`}
            {step.latencyMs === undefined ? '' : ` · ${String(step.latencyMs)} ms`}
            {step.inputTokens === undefined || step.outputTokens === undefined
              ? ''
              : ` · ${t.agent.console.tokens(step.inputTokens, step.outputTokens)}`}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * The live agent console: every step of every run (model calls with their
 * stated reason, tool calls with their sanitized arguments and what they
 * read, guardrail refusals, engine events), streamed as the API records it.
 */
export function AgentConsole({
  steps,
  timeZone,
  totalCost,
  modelCalls,
}: {
  readonly steps: readonly AgentStepView[];
  readonly timeZone: string | undefined;
  readonly totalCost: number;
  readonly modelCalls: number;
}): ReactNode {
  const t = useT();
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [steps.length]);
  return (
    <Card className="flex h-[720px] flex-col overflow-hidden">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t.agent.console.title}</h2>
          <p className="text-xs text-muted">{t.agent.console.subtitle}</p>
        </div>
        <span className="text-xs text-muted tabular-nums">
          {t.agent.console.runTotal(formatCost(totalCost), modelCalls)}
        </span>
      </header>
      <ol ref={list} className="flex-1 overflow-y-auto" aria-live="polite">
        {steps.length === 0 ? (
          <li className="p-6 text-center text-sm text-muted">{t.agent.console.empty}</li>
        ) : (
          steps.map((step) => <StepRow key={step.seq} step={step} timeZone={timeZone} />)
        )}
      </ol>
    </Card>
  );
}
