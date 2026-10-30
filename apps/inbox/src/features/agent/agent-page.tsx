import { Bot, Play, RotateCcw } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useState } from 'react';
import type {
  AgentLanguage,
  AgentMode,
  AgentPageView,
  AgentStoryRequest,
} from '../../api/agent-contract.ts';
import { useAgentPage, useStartAgentStory } from '../../api/agent-queries.ts';
import { useTrackEvaluatorEvent } from '../../api/evaluator-tracking.ts';
import { ErrorState, InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, Skeleton } from '../../components/ui.tsx';
import { useLocale, useT } from '../../i18n/index.ts';
import { AgentConsole } from './agent-console.tsx';
import { PhonePanel } from './phone-panel.tsx';
import { ClockPanel, DoctorPanel, OrdersPanel, TasksPanel } from './side-panels.tsx';

const SELECT_CLASS =
  'h-9 rounded-lg border border-border-strong bg-surface px-2.5 text-sm text-fg shadow-card';

function StoryCard({
  page,
  hasStory,
}: {
  readonly page: AgentPageView;
  readonly hasStory: boolean;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const [mode, setMode] = useState<AgentMode>(page.liveAvailable ? 'live' : 'scripted');
  const [language, setLanguage] = useState<AgentLanguage>(locale);
  const [story, setStory] = useState<AgentStoryRequest['story']>('maria');
  const start = useStartAgentStory();
  const track = useTrackEvaluatorEvent();

  function handleMode(event: ChangeEvent<HTMLSelectElement>): void {
    const next = event.target.value === 'live' ? 'live' : 'scripted';
    setMode(next);
    track({ action: 'agent_model_switched', mode: next });
  }
  function handleLanguage(event: ChangeEvent<HTMLSelectElement>): void {
    const next = event.target.value === 'es' ? 'es' : 'en';
    setLanguage(next);
    track({ action: 'agent_language_switched', language: next });
  }
  function handleStory(event: ChangeEvent<HTMLSelectElement>): void {
    setStory(event.target.value === 'maria_urgent' ? 'maria_urgent' : 'maria');
  }
  function handleStart(): void {
    start.mutate({ story, mode, language });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">{t.agent.storyTitle}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t.agent.storyBodies[story]}</p>
        </div>
        <Badge tone={mode === 'live' ? 'primary' : 'neutral'}>
          {t.agent.modelBadge(mode === 'live' ? page.model : t.agent.scriptedModel)}
        </Badge>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          {t.agent.storyLabel}
          <select value={story} onChange={handleStory} className={SELECT_CLASS}>
            <option value="maria">{t.agent.stories['maria']}</option>
            <option value="maria_urgent">{t.agent.stories['maria_urgent']}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          {t.agent.modeLabel}
          <select value={mode} onChange={handleMode} className={SELECT_CLASS}>
            <option value="live" disabled={!page.liveAvailable}>
              {t.agent.modes['live']}
            </option>
            <option value="scripted">{t.agent.modes['scripted']}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          {t.agent.languageLabel}
          <select value={language} onChange={handleLanguage} className={SELECT_CLASS}>
            <option value="en">{t.common.languageNames.en}</option>
            <option value="es">{t.common.languageNames.es}</option>
          </select>
        </label>
        <Button
          variant={hasStory ? 'secondary' : 'primary'}
          loading={start.isPending}
          onClick={handleStart}
          icon={
            hasStory ? (
              <RotateCcw className="size-4" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )
          }
        >
          {hasStory ? t.agent.restart : t.agent.start}
        </Button>
        <p className="min-w-0 flex-1 text-xs text-muted">
          {page.liveAvailable ? t.agent.modeHints[mode] : t.agent.liveUnavailable}
        </p>
      </div>
      {start.isPending ? <p className="text-xs text-muted">{t.agent.starting}</p> : null}
      {start.isError ? <InlineError error={start.error} /> : null}
    </Card>
  );
}

/**
 * The order-to-completion agent (docs/agent/order-to-completion.md), in the
 * evaluator's own lab clinic: María's story on a simulated WhatsApp phone,
 * the live console of what the agent does and why, the doctor's orders as
 * the engine sees them, the clinic clock and the no-response ladder, staff
 * tasks and what reached the doctor.
 */
export function AgentPage(): ReactNode {
  const t = useT();
  const page = useAgentPage(undefined);
  function handleRetry(): void {
    void page.refetch();
  }

  if (page.isError) return <ErrorState error={page.error} onRetry={handleRetry} />;
  const data = page.data;
  const conversation = data?.conversation ?? null;
  const totalCost = (data?.runs ?? []).reduce((sum, run) => sum + run.costUsd, 0);
  const modelCalls = (data?.runs ?? []).reduce((sum, run) => sum + run.modelCalls, 0);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
          <Bot className="size-5 text-primary" aria-hidden="true" />
          {t.agent.title}
        </h1>
        <p className="max-w-4xl text-sm text-muted">{t.agent.subtitle}</p>
      </header>

      {data === undefined ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : (
        <StoryCard page={data} hasStory={conversation !== null} />
      )}

      {data === undefined || conversation === null ? null : (
        <>
          <div className="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
            <PhonePanel
              conversation={conversation}
              messages={data.messages ?? []}
              timeZone={data.timeZone}
            />
            <AgentConsole
              steps={data.steps ?? []}
              timeZone={data.timeZone}
              totalCost={totalCost}
              modelCalls={modelCalls}
            />
          </div>
          <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-4">
            <OrdersPanel
              orders={data.orders ?? []}
              ignored={data.ignoredEngineItems ?? 0}
              timeZone={data.timeZone}
            />
            <ClockPanel
              now={data.now}
              ladder={conversation.ladder}
              stopped={conversation.status === 'done'}
              timeZone={data.timeZone}
            />
            <DoctorPanel
              findings={data.findings ?? []}
              orders={data.orders ?? []}
              patientId={conversation.patientId}
              timeZone={data.timeZone}
            />
            <TasksPanel tasks={data.tasks ?? []} timeZone={data.timeZone} />
          </div>
        </>
      )}
    </div>
  );
}
