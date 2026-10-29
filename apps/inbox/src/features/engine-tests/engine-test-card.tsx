import { CheckCircle2, ChevronDown, ChevronUp, PlayCircle, XCircle } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useState } from 'react';
import { useRunEngineTest, useSubmitEngineTestVerdict } from '../../api/engine-tests-queries.ts';
import type {
  EngineTestRunResult,
  EngineTestVerdict,
  ExpectationDiffTag,
  TimelineEntryView,
} from '../../api/engine-tests-contract.ts';
import { Badge, Button, Card, INPUT_CLASS, type Tone } from '../../components/ui.tsx';
import { InlineError } from '../../components/states.tsx';
import { useT } from '../../i18n/index.ts';
import type { Messages } from '../../i18n/index.ts';
import { noteReader } from '../../lib/labels.ts';
import { formatDateTime } from '../../lib/format.ts';

const DIFF_TONES: Record<ExpectationDiffTag, Tone> = {
  new: 'primary',
  fulfilled: 'success',
  superseded: 'warning',
  expired: 'danger',
  cancelled: 'neutral',
  still_open: 'neutral',
};

function TimelineRow({
  entry,
  t,
}: {
  readonly entry: TimelineEntryView;
  readonly t: Messages;
}): ReactNode {
  const reader = entry.source === 'ai' ? noteReader(t, entry.llm) : undefined;
  return (
    <li className="flex flex-col gap-0.5 border-b border-border py-2 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">
          {t.engineTests.eventTypes[entry.type] ?? entry.type}
        </span>
        <span className="flex items-center gap-1.5">
          {entry.source === 'rules' || reader === undefined ? (
            <Badge tone="neutral">{t.engineTests.readByRules}</Badge>
          ) : (
            <Badge tone="info">{reader.label}</Badge>
          )}
          <time dateTime={entry.occurredAt} className="text-xs text-muted">
            {formatDateTime(entry.occurredAt)}
          </time>
        </span>
      </div>
      <p className="text-xs text-muted">{entry.detail}</p>
    </li>
  );
}

function ExpectationsTable({
  result,
  t,
}: {
  readonly result: EngineTestRunResult;
  readonly t: Messages;
}): ReactNode {
  if (result.expectations.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted">{t.engineTests.expectationsEmpty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.rule}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.layer}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.version}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.due}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.status}</th>
          </tr>
        </thead>
        <tbody>
          {result.expectations.map((expectation) => (
            <tr key={expectation.id} className="border-t border-border">
              <td className="py-1.5 pr-3 font-medium text-fg">{expectation.label}</td>
              <td className="py-1.5 pr-3 text-muted">{expectation.layer}</td>
              <td className="py-1.5 pr-3 font-mono text-xs text-muted">
                {expectation.ruleVersion}
              </td>
              <td className="py-1.5 pr-3 text-muted">
                <time dateTime={expectation.dueAt}>{formatDateTime(expectation.dueAt)}</time>
              </td>
              <td className="py-1.5 pr-3">
                <Badge tone={DIFF_TONES[expectation.diff]}>
                  {t.engineTests.diffTags[expectation.diff]}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleCard({
  result,
  t,
}: {
  readonly result: EngineTestRunResult;
  readonly t: Messages;
}): ReactNode {
  const card = result.ruleCard;
  if (card === undefined) return null;
  return (
    <dl className="grid grid-cols-1 gap-2 rounded-lg bg-surface-2 p-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs font-medium text-muted">{t.engineTests.ruleCard.trigger}</dt>
        <dd className="text-fg">{card.trigger}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium text-muted">{t.engineTests.ruleCard.fulfilledBy}</dt>
        <dd className="text-fg">{card.fulfilledBy.join(', ')}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium text-muted">{t.engineTests.ruleCard.supersededBy}</dt>
        <dd className="text-fg">{card.supersededBy.join(', ') || '—'}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium text-muted">
          {t.engineTests.ruleCard.escalationPolicy}
        </dt>
        <dd className="text-fg">{card.escalationPolicy}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium text-muted">{t.engineTests.ruleCard.version}</dt>
        <dd className="font-mono text-xs text-fg">{card.version}</dd>
      </div>
      <div>
        <dt className="text-xs font-medium text-muted">{t.engineTests.columns.due}</dt>
        <dd className="text-fg">{t.engineTests.ruleCard.dueInDays(card.dueInDays)}</dd>
      </div>
    </dl>
  );
}

export interface EngineTestCardProps {
  readonly id: string;
  readonly reviewed: boolean;
}

/** One guided engine-test card: statement, "Run the test", the real run's result, and the verdict. */
export function EngineTestCard({ id, reviewed }: EngineTestCardProps): ReactNode {
  const t = useT();
  const copy = t.engineTests.scenarios[id] ?? { title: id, statement: '' };
  const run = useRunEngineTest();
  const submitVerdict = useSubmitEngineTestVerdict();
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const [verdictGiven, setVerdictGiven] = useState<EngineTestVerdict>();

  function handleRun(): void {
    setExpanded(true);
    run.mutate(id);
  }

  function handleToggle(): void {
    setExpanded((value) => !value);
  }

  function handleCommentChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setComment(event.target.value);
  }

  function submit(verdict: EngineTestVerdict): void {
    const result = run.data;
    submitVerdict.mutate(
      {
        id,
        body: {
          verdict,
          autoCheckPassed: result?.autoCheck.passed ?? false,
          ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
          ...(result === undefined ? {} : { patientId: result.patientId }),
        },
      },
      {
        onSuccess: () => {
          setVerdictGiven(verdict);
        },
      },
    );
  }

  function handleWorksAsExpected(): void {
    submit('works_as_expected');
  }

  function handleDoesNotWork(): void {
    submit('does_not_work');
  }

  const result = run.data;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">{copy.title}</h3>
          <p className="mt-0.5 text-sm text-muted">{copy.statement}</p>
        </div>
        {reviewed ? (
          <Badge tone="success" icon={<CheckCircle2 className="size-3" aria-hidden="true" />}>
            {t.engineTests.reviewed}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          loading={run.isPending}
          onClick={handleRun}
          icon={<PlayCircle className="size-3.5" aria-hidden="true" />}
        >
          {result ? t.engineTests.runAgain : t.engineTests.runTest}
        </Button>
        {result ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggle}
            icon={
              expanded ? (
                <ChevronUp className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              )
            }
          >
            {expanded ? t.common.close : t.common.retry}
          </Button>
        ) : null}
      </div>
      <InlineError error={run.error} />
      {result && expanded ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {result.supported ? null : (
            <Badge tone="warning">{t.engineTests.autoCheck.notSupported}</Badge>
          )}
          <RuleCard result={result} t={t} />
          <div>
            <p className="text-xs font-semibold text-muted uppercase">
              {t.engineTests.timelineTitle}
            </p>
            {result.timeline.length === 0 ? (
              <p className="py-2 text-sm text-muted">{t.engineTests.timelineEmpty}</p>
            ) : (
              <ul>
                {result.timeline.map((entry, index) => (
                  <TimelineRow key={`${entry.type}-${String(index)}`} entry={entry} t={t} />
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold text-muted uppercase">
              {t.engineTests.expectationsTitle}
            </p>
            <ExpectationsTable result={result} t={t} />
          </div>
          <p
            className={
              result.autoCheck.passed
                ? 'rounded-lg bg-success-soft px-3 py-2 text-sm text-success'
                : 'rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger'
            }
          >
            <strong className="font-semibold">{t.engineTests.autoCheck.expected}:</strong>{' '}
            {result.autoCheck.expected} ·{' '}
            <strong className="font-semibold">{t.engineTests.autoCheck.observed}:</strong>{' '}
            {result.autoCheck.observed}
          </p>
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <label htmlFor={`comment-${id}`} className="text-xs font-medium text-muted">
              {t.engineTests.commentLabel}
            </label>
            <textarea
              id={`comment-${id}`}
              value={comment}
              onChange={handleCommentChange}
              placeholder={t.engineTests.commentPlaceholder}
              rows={2}
              className={INPUT_CLASS}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="success"
                size="sm"
                loading={submitVerdict.isPending}
                onClick={handleWorksAsExpected}
                icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}
              >
                {t.engineTests.worksAsExpected}
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={submitVerdict.isPending}
                onClick={handleDoesNotWork}
                icon={<XCircle className="size-3.5" aria-hidden="true" />}
              >
                {t.engineTests.doesNotWork}
              </Button>
              {verdictGiven ? <Badge tone="success">{t.engineTests.verdictSaved}</Badge> : null}
            </div>
            <InlineError error={submitVerdict.error} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}
