import { CheckCircle2, FileJson, Power, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  AuthoredRuleView,
  AuthoringStepView,
  DryRunExampleView,
  TerminologyCitationView,
} from '../../api/rules-contract.ts';
import { useDecideLabRule } from '../../api/rules-queries.ts';
import {
  type AgentTraceFact,
  type AgentTraceStep,
  AgentTraceTimeline,
} from '../../components/agent-trace/agent-trace-timeline.tsx';
import { InlineError } from '../../components/states.tsx';
import { Badge, Button, Card } from '../../components/ui.tsx';
import { type Locale, type Messages, useLocale, useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatDate, formatNumber, formatUsd } from '../../lib/format.ts';
import { describeDefinition } from './describe.ts';
import { jsonDiff } from './json-diff.ts';

/** A tool argument shown in the trace: ids, codes and short strings only. */
function argumentText(args: Readonly<Record<string, unknown>>): string {
  return Object.entries(args)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

export function traceSteps(t: Messages, steps: readonly AuthoringStepView[]): AgentTraceStep[] {
  return steps.map((step) => {
    const title = t.rules.trace.tools[step.tool] ?? t.rules.trace.otherTool(step.tool);
    const args = argumentText(step.arguments);
    // Only the lookup's summary (the codes it found) is language-neutral; the
    // other tools' machine summaries are English and the title says enough.
    const outcome =
      step.outcome !== 'ok'
        ? t.rules.trace.rejected(step.outcome)
        : step.tool === 'lookup_terminology'
          ? step.summary
          : '';
    return {
      id: String(step.index),
      kind: step.tool,
      title,
      detail: [step.tool, args, outcome].filter((part) => part !== '').join(' — '),
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.costUsd === undefined ? {} : { cost: step.costUsd }),
    };
  });
}

export function traceFacts(
  t: Messages,
  run: {
    readonly modelId: string;
    readonly steps: number;
    readonly costUsd: number;
    readonly promptVersion: string;
  },
  firstValidationPassed?: boolean,
): AgentTraceFact[] {
  const facts: AgentTraceFact[] = [
    { label: t.rules.trace.model, value: run.modelId },
    { label: t.rules.trace.steps, value: formatNumber(run.steps) },
    { label: t.rules.trace.cost, value: formatUsd(run.costUsd) },
    { label: t.rules.trace.prompt, value: run.promptVersion },
  ];
  if (firstValidationPassed !== undefined) {
    facts.push({
      label: t.rules.trace.firstValidation,
      value: firstValidationPassed ? t.rules.trace.passed : t.rules.trace.neededFixes,
    });
  }
  return facts;
}

function citationName(citation: TerminologyCitationView, locale: Locale): string {
  return locale === 'es' && citation.displayEs !== undefined
    ? citation.displayEs
    : citation.display;
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }): ReactNode {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold text-fg tabular-nums">{formatNumber(value)}</dd>
    </div>
  );
}

function exampleWhen(t: Messages, example: DryRunExampleView): string {
  if (example.status === 'closed') return t.rules.dryRun.closedExample;
  return example.dueInDays < 0
    ? t.rules.dryRun.overdueBy(-example.dueInDays)
    : t.rules.dryRun.dueIn(example.dueInDays);
}

function DryRunSection({ rule }: { readonly rule: AuthoredRuleView }): ReactNode {
  const t = useT();
  const report = rule.provenance.dryRun;
  const labelOf = (ruleId: string): string => rule.ruleLabels[ruleId] ?? ruleId;
  return (
    <Section title={t.rules.dryRun.title}>
      <p className="text-sm text-muted">
        {t.rules.dryRun.subtitle(report.patientsScanned)}
        {report.truncated ? ` ${t.rules.dryRun.truncated}` : null}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label={t.rules.dryRun.patients} value={report.patientsMatched} />
        <Stat label={t.rules.dryRun.overdue} value={report.expectations.overdue} />
        <Stat label={t.rules.dryRun.open} value={report.expectations.open} />
        <Stat label={t.rules.dryRun.closed} value={report.expectations.closed} />
        <Stat label={t.rules.dryRun.overlaps} value={report.overlaps.expectations} />
      </dl>
      {report.overlaps.byRule.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-fg">
          {report.overlaps.byRule.map((item) => (
            <li key={item.ruleId}>
              {t.rules.dryRun.overlapLine(labelOf(item.ruleId), item.count)}
            </li>
          ))}
        </ul>
      ) : null}
      {report.examples.length === 0 ? (
        <p className="text-sm text-muted">{t.rules.dryRun.none}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted">{t.rules.dryRun.examples}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {report.examples.map((example) => (
              <li key={example.patientRef} className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                  {example.patientRef}
                </code>
                <Badge
                  tone={
                    example.status === 'overdue'
                      ? 'warning'
                      : example.status === 'open'
                        ? 'info'
                        : 'success'
                  }
                >
                  {exampleWhen(t, example)}
                </Badge>
                {example.overlapsWith.length > 0 ? (
                  <span className="text-xs text-muted">
                    {t.rules.dryRun.alsoAsked(example.overlapsWith.map(labelOf).join(', '))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function CodesSection({ rule }: { readonly rule: AuthoredRuleView }): ReactNode {
  const t = useT();
  const locale = useLocale();
  const sources = rule.kind === 'protocol' ? rule.definition['sources'] : undefined;
  const sourceList = Array.isArray(sources)
    ? sources.filter(
        (source): source is { title: string; organization: string; year: number; url: string } =>
          typeof source === 'object' && source !== null,
      )
    : [];
  return (
    <Section title={t.rules.codes.title}>
      <ul className="flex flex-wrap gap-1.5">
        {rule.provenance.terminology.map((citation) => (
          <li key={`${citation.system}:${citation.code}`}>
            <Badge tone="neutral" wrap>
              {`${t.rules.codes.systems[citation.system] ?? citation.system} ${citation.code} · ${citationName(citation, locale)} · ${t.rules.codes.catalogs[citation.catalog] ?? citation.catalog}`}
            </Badge>
          </li>
        ))}
      </ul>
      {sourceList.length > 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-xs font-medium text-muted">{t.rules.codes.sources}</p>
          <ul className="flex flex-col gap-1">
            {sourceList.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {`${source.organization} (${String(source.year)}): ${source.title}`}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}

function JsonSection({ rule }: { readonly rule: AuthoredRuleView }): ReactNode {
  const t = useT();
  const lines = jsonDiff(rule.baseline, rule.definition);
  return (
    <details className="group border-t border-border pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
        <FileJson className="size-4" aria-hidden="true" />
        {t.rules.json.title}
      </summary>
      <p className="mt-2 text-xs text-muted">
        {rule.baseline === undefined
          ? t.rules.json.newDefinition
          : t.rules.json.against(rule.provenance.basedOn ?? '')}
      </p>
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-5">
        {lines.map((line, index) => (
          <span
            key={index}
            title={
              line.kind === 'added'
                ? t.rules.json.added
                : line.kind === 'removed'
                  ? t.rules.json.removed
                  : undefined
            }
            className={cx(
              'block whitespace-pre',
              line.kind === 'added' && 'bg-success-soft text-success',
              line.kind === 'removed' && 'bg-danger-soft text-danger',
            )}
          >
            {`${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}`}
          </span>
        ))}
      </pre>
    </details>
  );
}

function Decisions({ rule }: { readonly rule: AuthoredRuleView }): ReactNode {
  const t = useT();
  const decide = useDecideLabRule();
  function handleEnable(): void {
    decide.mutate({ ruleId: rule.ruleId, decision: 'enable' });
  }
  function handleDiscard(): void {
    decide.mutate({ ruleId: rule.ruleId, decision: 'discard' });
  }
  if (rule.status === 'disabled') return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {rule.status === 'draft' ? (
          <>
            <Button
              variant="primary"
              onClick={handleEnable}
              loading={decide.isPending && decide.variables.decision === 'enable'}
              icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
            >
              {t.rules.enable}
            </Button>
            <Button
              variant="danger"
              onClick={handleDiscard}
              loading={decide.isPending && decide.variables.decision === 'discard'}
              icon={<Trash2 className="size-4" aria-hidden="true" />}
            >
              {t.rules.discard}
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            onClick={handleDiscard}
            loading={decide.isPending}
            icon={<Power className="size-4" aria-hidden="true" />}
          >
            {t.rules.switchOff}
          </Button>
        )}
      </div>
      {rule.status === 'draft' ? <p className="text-xs text-muted">{t.rules.enableHint}</p> : null}
      {decide.isError ? <InlineError error={decide.error} /> : null}
    </div>
  );
}

/**
 * One clinic-authored rule: its label and status, the clinician's request,
 * the rule in sentences (written by code from the structured fields), the
 * engine's dry run, the codes and sources it cites, the JSON (a diff
 * against the rule it adapts), the agent's trace, and Enable / Discard.
 */
export function RuleCard({ rule }: { readonly rule: AuthoredRuleView }): ReactNode {
  const t = useT();
  const locale = useLocale();
  const described = describeDefinition(
    t,
    locale,
    rule.kind,
    rule.definition,
    rule.provenance.terminology,
  );
  const rationale = rule.provenance.rationale;
  return (
    <Card className="flex flex-col gap-4 p-5" aria-label={rule.labels[locale]}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg">{rule.labels[locale]}</h2>
          <p className="mt-0.5 font-mono text-xs text-muted">{rule.ruleId}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="neutral">{t.rules.kinds[rule.kind] ?? rule.kind}</Badge>
          <Badge
            tone={
              rule.status === 'enabled'
                ? 'success'
                : rule.status === 'draft'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {t.rules.status[rule.status] ?? rule.status}
          </Badge>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted">{t.rules.yourRequest}</p>
        <blockquote className="border-l-2 border-border-strong pl-3 text-sm text-fg italic">
          {rule.request}
        </blockquote>
        <p className="text-xs text-muted">
          {rule.validatedBy !== undefined && rule.validatedAt !== undefined
            ? t.rules.enabledBy(rule.validatedBy, formatDate(rule.validatedAt))
            : t.rules.draftedFor(rule.provenance.draftedBy, formatDate(rule.provenance.draftedAt))}
        </p>
      </div>
      <Section title={t.rules.whatItDoes}>
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[8rem_1fr]">
          {described.lines.map((line, index) => (
            <div key={index} className="contents">
              <dt className="text-muted">{line.label}</dt>
              <dd className="text-fg">{line.text}</dd>
            </div>
          ))}
        </dl>
        {described.notes.map((note) => (
          <p key={note} className="text-xs text-muted">
            {note}
          </p>
        ))}
        {rule.provenance.basedOn !== undefined ? (
          <p className="text-xs text-muted">{t.rules.basedOn(rule.provenance.basedOn)}</p>
        ) : null}
        {rationale !== undefined ? (
          <p className="text-sm text-fg">
            <span className="font-medium text-muted">{t.rules.agentNote}: </span>
            {rationale[locale]}
          </p>
        ) : null}
      </Section>
      <DryRunSection rule={rule} />
      <CodesSection rule={rule} />
      <JsonSection rule={rule} />
      <AgentTraceTimeline
        title={t.rules.trace.title}
        toggleLabel={t.rules.trace.toggle}
        emptyLabel={t.rules.trace.empty}
        steps={traceSteps(t, rule.provenance.trace)}
        facts={traceFacts(t, rule.provenance, rule.provenance.firstValidationPassed)}
      />
      <Decisions rule={rule} />
    </Card>
  );
}
