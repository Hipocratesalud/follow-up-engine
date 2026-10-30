import { ListChecks, Sparkles, UserPlus, Wand2 } from 'lucide-react';
import { type ChangeEvent, type SubmitEvent, type ReactNode, useState } from 'react';
import type {
  AuthoredRuleView,
  RuleAuthoringMode,
  RuleDraftResponse,
  RulesPageView,
} from '../../api/rules-contract.ts';
import { useAddLabRuleSamples, useDraftLabRule, useLabRules } from '../../api/rules-queries.ts';
import { AgentTraceTimeline } from '../../components/agent-trace/agent-trace-timeline.tsx';
import { ErrorState, InlineError } from '../../components/states.tsx';
import {
  Badge,
  Button,
  Card,
  Field,
  INPUT_CLASS,
  SectionTitle,
  Skeleton,
} from '../../components/ui.tsx';
import { useLocale, useT } from '../../i18n/index.ts';
import { RuleCard, traceFacts, traceSteps } from './rule-card.tsx';

const SELECT_CLASS =
  'h-10 rounded-lg border border-border-strong bg-surface px-2.5 text-sm text-fg shadow-card';

function ExampleButton({
  text,
  onPick,
}: {
  readonly text: string;
  readonly onPick: (text: string) => void;
}): ReactNode {
  function handleClick(): void {
    onPick(text);
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded-full border border-border-strong bg-surface px-3 py-1 text-left text-xs text-fg shadow-card hover:bg-surface-2"
    >
      {text}
    </button>
  );
}

function SamplesBar({ page }: { readonly page: RulesPageView }): ReactNode {
  const t = useT();
  const samples = useAddLabRuleSamples();
  function handleAdd(): void {
    samples.mutate();
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 text-muted">{t.rules.sandboxPatients(page.patients)}</span>
      <Button
        size="sm"
        onClick={handleAdd}
        loading={samples.isPending}
        icon={<UserPlus className="size-4" aria-hidden="true" />}
      >
        {t.rules.addSamples}
      </Button>
      {samples.isSuccess ? (
        <span className="text-xs text-success">{t.rules.samplesAdded}</span>
      ) : null}
      {samples.isError ? <InlineError error={samples.error} /> : null}
    </div>
  );
}

function Composer({
  page,
  onDrafted,
}: {
  readonly page: RulesPageView;
  readonly onDrafted: (response: RuleDraftResponse) => void;
}): ReactNode {
  const t = useT();
  const [request, setRequest] = useState('');
  const [mode, setMode] = useState<RuleAuthoringMode>('scripted');
  const [missing, setMissing] = useState(false);
  const draft = useDraftLabRule();

  function handleRequest(event: ChangeEvent<HTMLTextAreaElement>): void {
    setRequest(event.target.value);
    setMissing(false);
  }
  function handleMode(event: ChangeEvent<HTMLSelectElement>): void {
    setMode(event.target.value === 'live' ? 'live' : 'scripted');
  }
  function handlePick(text: string): void {
    setRequest(text);
    setMissing(false);
  }
  function handleSuccess(response: RuleDraftResponse): void {
    onDrafted(response);
  }
  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (request.trim() === '') {
      setMissing(true);
      return;
    }
    draft.mutate({ request: request.trim(), mode }, { onSuccess: handleSuccess });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Field
          label={t.rules.requestLabel}
          htmlFor="rule-request"
          error={missing ? t.rules.requestRequired : undefined}
        >
          <textarea
            id="rule-request"
            rows={3}
            value={request}
            onChange={handleRequest}
            placeholder={t.rules.requestPlaceholder}
            aria-invalid={missing || undefined}
            className={INPUT_CLASS}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted">{t.rules.examplesLabel}</p>
          <div className="flex flex-wrap gap-2">
            {t.rules.examples.map((example) => (
              <ExampleButton key={example} text={example} onPick={handlePick} />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            {t.rules.modeLabel}
            <select value={mode} onChange={handleMode} className={SELECT_CLASS}>
              <option value="scripted">{t.rules.modes['scripted']}</option>
              <option value="live" disabled={!page.liveAvailable}>
                {t.rules.modes['live']}
              </option>
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={draft.isPending}
            icon={<Wand2 className="size-4" aria-hidden="true" />}
          >
            {t.rules.draft}
          </Button>
          <p className="min-w-0 flex-1 text-xs text-muted">
            {page.liveAvailable ? t.rules.modeHints[mode] : t.rules.liveUnavailable}
          </p>
        </div>
        {draft.isPending ? <p className="text-sm text-muted">{t.rules.drafting}</p> : null}
        {draft.isError ? <InlineError error={draft.error} /> : null}
      </form>
      <SamplesBar page={page} />
    </Card>
  );
}

function FailedDraft({
  response,
}: {
  readonly response: Extract<RuleDraftResponse, { status: 'failed' }>;
}): ReactNode {
  const t = useT();
  const said = response.reason === 'abstained' ? response.issues[0] : undefined;
  const issues = response.reason === 'invalid_submission' ? response.issues : [];
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-fg">{t.rules.failed.title}</h2>
        <Badge tone="warning">{t.rules.failed.reasons[response.reason] ?? response.reason}</Badge>
      </div>
      {said !== undefined ? (
        <p className="text-sm text-fg">
          <span className="font-medium text-muted">{t.rules.failed.agentSaid}: </span>
          {said}
        </p>
      ) : null}
      {issues.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted">{t.rules.failed.issues}</p>
          <ul className="list-disc pl-5 font-mono text-xs text-fg">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <AgentTraceTimeline
        title={t.rules.trace.title}
        toggleLabel={t.rules.trace.toggle}
        emptyLabel={t.rules.trace.empty}
        steps={traceSteps(t, response.run.trace)}
        facts={traceFacts(t, response.run)}
        defaultOpen
      />
    </Card>
  );
}

function RuleRow({
  rule,
  selected,
  onSelect,
}: {
  readonly rule: AuthoredRuleView;
  readonly selected: boolean;
  readonly onSelect: (ruleId: string) => void;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  function handleClick(): void {
    onSelect(rule.ruleId);
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{rule.labels[locale]}</p>
        <p className="truncate text-xs text-muted">{rule.request}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          tone={
            rule.status === 'enabled' ? 'success' : rule.status === 'draft' ? 'warning' : 'neutral'
          }
        >
          {t.rules.status[rule.status] ?? rule.status}
        </Badge>
        <Button size="sm" variant={selected ? 'primary' : 'secondary'} onClick={handleClick}>
          {t.rules.show}
        </Button>
      </div>
    </li>
  );
}

/**
 * Rules (docs/agent/rule-authoring.md): the clinician describes a follow-up
 * rule in plain words, the rule-authoring agent drafts it in the engine's
 * config format through tools (existing rules, terminology, validator, dry
 * run), and the result shows the rule in sentences, the dry run on the
 * evaluator's sandbox records, the codes it cites, the JSON diff and the
 * trace. Nothing runs until a clinician enables it.
 */
export function RulesPage(): ReactNode {
  const t = useT();
  const page = useLabRules();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<Extract<RuleDraftResponse, { status: 'failed' }>>();

  function handleRetry(): void {
    void page.refetch();
  }
  function handleDrafted(response: RuleDraftResponse): void {
    if (response.status === 'drafted') {
      setFailure(undefined);
      setSelectedId(response.rule.ruleId);
    } else {
      setFailure(response);
    }
  }
  function handleSelect(ruleId: string): void {
    setFailure(undefined);
    setSelectedId(ruleId);
  }

  if (page.isError) return <ErrorState error={page.error} onRetry={handleRetry} />;
  const items = page.data?.items ?? [];
  const selected = items.find((rule) => rule.ruleId === selectedId) ?? items[0];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-fg">
          <Sparkles className="size-5 text-primary" aria-hidden="true" />
          {t.rules.title}
        </h1>
        <p className="max-w-3xl text-sm text-muted">{t.rules.subtitle}</p>
      </header>
      {page.data === undefined ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <>
          <Composer page={page.data} onDrafted={handleDrafted} />
          {failure !== undefined ? <FailedDraft response={failure} /> : null}
          {failure === undefined && selected !== undefined ? <RuleCard rule={selected} /> : null}
          <Card className="flex flex-col gap-2 p-5">
            <SectionTitle count={items.length}>
              <ListChecks className="size-4 text-muted" aria-hidden="true" />
              {t.rules.listTitle}
            </SectionTitle>
            {items.length === 0 ? (
              <p className="text-sm text-muted">{t.rules.empty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((rule) => (
                  <RuleRow
                    key={rule.ruleId}
                    rule={rule}
                    selected={rule.ruleId === selected?.ruleId}
                    onSelect={handleSelect}
                  />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
