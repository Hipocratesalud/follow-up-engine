import { CheckCircle2, PlayCircle, RotateCcw, XCircle } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useState } from 'react';
import {
  useStartEngineTest,
  useSubmitEngineTestFreeform,
  useSubmitEngineTestStep,
  useSubmitEngineTestVerdict,
} from '../../api/engine-tests-queries.ts';
import type {
  DocumentStepValue,
  EngineTestStartResponse,
  EngineTestStepOutcome,
  EngineTestStepValue,
  EngineTestVerdict,
  ExpectationDiffTag,
  RecordStepValue,
  TimelineEntryView,
} from '../../api/engine-tests-contract.ts';
import { Badge, Button, Card, INPUT_CLASS, type Tone } from '../../components/ui.tsx';
import { InlineError } from '../../components/states.tsx';
import { useT } from '../../i18n/index.ts';
import type { Messages } from '../../i18n/index.ts';
import { noteReader } from '../../lib/labels.ts';
import { formatDateTime } from '../../lib/format.ts';
import { EngineTestStepForm } from './engine-test-step-form.tsx';

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

function StepExpectationsTable({
  outcome,
  t,
}: {
  readonly outcome: EngineTestStepOutcome;
  readonly t: Messages;
}): ReactNode {
  if (outcome.expectations.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted">{t.engineTests.expectationsEmpty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.rule}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.layer}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.due}</th>
            <th className="py-1 pr-3 font-medium">{t.engineTests.columns.status}</th>
          </tr>
        </thead>
        <tbody>
          {outcome.expectations.map((expectation) => (
            <tr key={expectation.id} className="border-t border-border">
              <td className="py-1.5 pr-3 font-medium text-fg">{expectation.label}</td>
              <td className="py-1.5 pr-3 text-muted">{expectation.layer}</td>
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

function RuleCardPanel({
  outcome,
  t,
}: {
  readonly outcome: EngineTestStepOutcome;
  readonly t: Messages;
}): ReactNode {
  const card = outcome.ruleCard;
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

function AutoCheckLine({
  outcome,
  t,
}: {
  readonly outcome: EngineTestStepOutcome;
  readonly t: Messages;
}): ReactNode {
  return (
    <p
      className={
        outcome.autoCheck.passed
          ? 'rounded-lg bg-success-soft px-3 py-2 text-sm text-success'
          : 'rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger'
      }
    >
      <strong className="font-semibold">{t.engineTests.autoCheck.expected}:</strong>{' '}
      {outcome.autoCheck.expected} ·{' '}
      <strong className="font-semibold">{t.engineTests.autoCheck.observed}:</strong>{' '}
      {outcome.autoCheck.observed}
    </p>
  );
}

function stepActionLabel(t: Messages, action: EngineTestStepValue['action']): string {
  switch (action) {
    case 'record':
    case 'document':
    case 'clock':
      return t.engineTests.loadButton;
    case 'rule_timeframe':
      return t.engineTests.saveButton;
    case 'confirm_plan':
      return t.engineTests.confirmButton;
    case 'rule_card':
      return t.engineTests.viewRuleButton;
  }
}

function defaultFreeformValue(
  session: EngineTestStartResponse,
): RecordStepValue | DocumentStepValue {
  const today = session.day0.slice(0, 10);
  return { action: 'record', recordDate: today, entry: { kind: 'visit' } };
}

export interface EngineTestCardProps {
  readonly id: string;
  readonly reviewed: boolean;
}

/**
 * One guided engine-test card (docs/deploy.md#engine-tests): the physician
 * starts the scenario on a fresh patient, then performs each numbered step
 * themselves — a pre-filled but editable form, loaded through the real
 * engine — before giving their own verdict.
 */
export function EngineTestCard({ id, reviewed }: EngineTestCardProps): ReactNode {
  const t = useT();
  const copy = t.engineTests.scenarios[id] ?? { title: id, statement: '', steps: [] };
  const start = useStartEngineTest();
  const submitStep = useSubmitEngineTestStep();
  const submitFreeform = useSubmitEngineTestFreeform();
  const submitVerdict = useSubmitEngineTestVerdict();

  const [session, setSession] = useState<EngineTestStartResponse>();
  const [outcomes, setOutcomes] = useState<readonly EngineTestStepOutcome[]>([]);
  const [draft, setDraft] = useState<EngineTestStepValue>();
  const [comment, setComment] = useState('');
  const [verdictGiven, setVerdictGiven] = useState<EngineTestVerdict>();
  const [freeformOpen, setFreeformOpen] = useState(false);
  const [freeformDraft, setFreeformDraft] = useState<RecordStepValue | DocumentStepValue>();
  const [freeformOutcome, setFreeformOutcome] = useState<EngineTestStepOutcome>();

  const total = copy.steps.length;
  const latest = outcomes.at(-1);

  function resetWizard(): void {
    setSession(undefined);
    setOutcomes([]);
    setDraft(undefined);
    setComment('');
    setVerdictGiven(undefined);
    setFreeformOpen(false);
    setFreeformDraft(undefined);
    setFreeformOutcome(undefined);
    start.reset();
    submitStep.reset();
    submitFreeform.reset();
  }

  function handleStart(): void {
    start.mutate(id, {
      onSuccess: (data) => {
        setSession(data);
        setOutcomes([]);
        setDraft(data.steps[0]?.suggestion);
        setFreeformOpen(false);
        setFreeformDraft(undefined);
        setFreeformOutcome(undefined);
        setVerdictGiven(undefined);
      },
    });
  }

  function handleStartOver(): void {
    resetWizard();
  }

  function handleDraftChange(next: EngineTestStepValue): void {
    setDraft(next);
  }

  function handleRunStep(): void {
    if (session === undefined || draft === undefined) return;
    const stepNumber = outcomes.length + 1;
    submitStep.mutate(
      { id, step: stepNumber, day0: session.day0, patientId: session.patientId, value: draft },
      {
        onSuccess: (outcome) => {
          setOutcomes((previous) => [...previous, outcome]);
          setDraft(session.steps[stepNumber]?.suggestion);
        },
      },
    );
  }

  function handleToggleFreeform(): void {
    if (!freeformOpen && freeformDraft === undefined && session !== undefined) {
      setFreeformDraft(defaultFreeformValue(session));
    }
    setFreeformOpen((previous) => !previous);
  }

  function handleFreeformDraftChange(next: EngineTestStepValue): void {
    if (next.action === 'record' || next.action === 'document') {
      setFreeformDraft(next);
    }
  }

  function handleRunFreeform(): void {
    if (session === undefined || freeformDraft === undefined) return;
    submitFreeform.mutate(
      { id, body: { patientId: session.patientId, value: freeformDraft } },
      {
        onSuccess: (outcome) => {
          setFreeformOutcome(outcome);
        },
      },
    );
  }

  function handleCommentChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setComment(event.target.value);
  }

  function submitVerdictWith(verdict: EngineTestVerdict): void {
    if (session === undefined) return;
    const autoCheckPassed =
      outcomes.length > 0 && outcomes.every((outcome) => outcome.autoCheck.passed);
    submitVerdict.mutate(
      {
        id,
        body: {
          verdict,
          autoCheckPassed,
          patientId: session.patientId,
          ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
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
    submitVerdictWith('works_as_expected');
  }

  function handleDoesNotWork(): void {
    submitVerdictWith('does_not_work');
  }

  const allStepsDone = session !== undefined && outcomes.length >= total;
  const currentStepIndex = outcomes.length; // 0-based index into copy.steps / session.steps
  const currentStepCopy = copy.steps[currentStepIndex];

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

      {session === undefined ? (
        <div>
          <Button
            variant="primary"
            size="sm"
            loading={start.isPending}
            onClick={handleStart}
            icon={<PlayCircle className="size-3.5" aria-hidden="true" />}
          >
            {t.engineTests.startTest}
          </Button>
          <InlineError error={start.error} />
        </div>
      ) : (
        <div className="flex flex-col gap-4 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted uppercase">
              {t.engineTests.stepOf(Math.min(currentStepIndex + 1, total), total)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleStartOver}
              icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
            >
              {t.engineTests.startOver}
            </Button>
          </div>

          {outcomes.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-muted uppercase">
                {t.engineTests.stepChecksTitle}
              </p>
              <ul className="flex flex-col gap-1.5">
                {outcomes.map((outcome, index) => (
                  <li
                    key={`${id}-check-${String(index)}`}
                    className="flex items-start gap-2 text-sm"
                  >
                    {outcome.autoCheck.passed ? (
                      <CheckCircle2
                        className="mt-0.5 size-3.5 shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <XCircle
                        className="mt-0.5 size-3.5 shrink-0 text-danger"
                        aria-hidden="true"
                      />
                    )}
                    <span className="text-muted">
                      <span className="font-medium text-fg">
                        {copy.steps[index]?.title ?? `Step ${String(index + 1)}`}
                      </span>
                      {' — '}
                      {outcome.autoCheck.observed}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!allStepsDone && currentStepCopy !== undefined && draft !== undefined ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border-strong p-3">
              <div>
                <h4 className="text-sm font-semibold text-fg">{currentStepCopy.title}</h4>
                <p className="mt-0.5 text-xs text-muted">
                  <strong className="font-medium">{t.engineTests.whatShouldHappen}:</strong>{' '}
                  {currentStepCopy.whatShouldHappen}
                </p>
              </div>
              <EngineTestStepForm value={draft} onChange={handleDraftChange} maxDate={undefined} />
              <div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={submitStep.isPending}
                  onClick={handleRunStep}
                >
                  {stepActionLabel(t, draft.action)}
                </Button>
              </div>
              <InlineError error={submitStep.error} />
            </div>
          ) : null}

          {latest !== undefined ? (
            <div className="flex flex-col gap-3">
              <RuleCardPanel
                outcome={outcomes.findLast((outcome) => outcome.ruleCard !== undefined) ?? latest}
                t={t}
              />
              <div>
                <p className="text-xs font-semibold text-muted uppercase">
                  {t.engineTests.timelineTitle}
                </p>
                {latest.timeline.length === 0 ? (
                  <p className="py-2 text-sm text-muted">{t.engineTests.timelineEmpty}</p>
                ) : (
                  <ul>
                    {latest.timeline.map((entry, index) => (
                      <TimelineRow key={`${entry.type}-${String(index)}`} entry={entry} t={t} />
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-muted uppercase">
                  {t.engineTests.expectationsTitle}
                </p>
                <StepExpectationsTable outcome={latest} t={t} />
              </div>
              <AutoCheckLine outcome={latest} t={t} />
            </div>
          ) : null}

          {allStepsDone ? (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleFreeform}
                className="self-start"
              >
                {t.engineTests.tryAnythingElse.title}
              </Button>
              {freeformOpen && freeformDraft !== undefined ? (
                <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong p-3">
                  <p className="text-xs text-muted">{t.engineTests.tryAnythingElse.intro}</p>
                  <EngineTestStepForm
                    value={freeformDraft}
                    onChange={handleFreeformDraftChange}
                    maxDate={undefined}
                  />
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={submitFreeform.isPending}
                      onClick={handleRunFreeform}
                    >
                      {t.engineTests.tryAnythingElse.loadButton}
                    </Button>
                  </div>
                  <InlineError error={submitFreeform.error} />
                  {freeformOutcome === undefined ? null : (
                    <div className="flex flex-col gap-2">
                      <ul>
                        {freeformOutcome.timeline.map((entry, index) => (
                          <TimelineRow
                            key={`freeform-${entry.type}-${String(index)}`}
                            entry={entry}
                            t={t}
                          />
                        ))}
                      </ul>
                      <StepExpectationsTable outcome={freeformOutcome} t={t} />
                    </div>
                  )}
                </div>
              ) : null}

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
        </div>
      )}
    </Card>
  );
}
