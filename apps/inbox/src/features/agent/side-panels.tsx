import { CircleCheck, CircleDashed, ClipboardList, FlaskConical, Stethoscope } from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  AgentFindingView,
  AgentLadderView,
  AgentOrderView,
  AgentTaskView,
} from '../../api/agent-contract.ts';
import { useAdvanceAgentClock, useConfirmAgentOrder } from '../../api/agent-queries.ts';
import { CitationQuote } from '../../components/evidence.tsx';
import { InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, SectionTitle, type Tone } from '../../components/ui.tsx';
import { INTL_LOCALES, useLocale, useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clinicDate, clinicDateTime } from './format.ts';

const STAGE_TONES: Readonly<Record<AgentOrderView['stage'], Tone>> = {
  awaiting_doctor: 'warning',
  open: 'neutral',
  contacted: 'info',
  booked: 'primary',
  result_received: 'warning',
  fulfilled: 'success',
  unreachable: 'danger',
};

function ClosedBy({
  order,
  timeZone,
}: {
  readonly order: AgentOrderView;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const detail = order.closedByDetail;
  let text = t.agent.orders.closedBy(order.closedBy ?? '');
  if (detail?.kind === 'appointment') {
    text = t.agent.orders.closedByVisit(clinicDateTime(detail.at, timeZone, locale));
  } else if (detail?.kind === 'result') {
    const value =
      detail.value === undefined
        ? ''
        : `${detail.test ?? ''} ${new Intl.NumberFormat(INTL_LOCALES[locale]).format(detail.value)}${
            detail.unit === undefined ? '' : ` ${detail.unit}`
          }`.trim();
    text = t.agent.orders.closedByResult(clinicDate(detail.at, timeZone, locale), value);
  }
  return (
    <div className="mt-1 flex flex-col">
      <p className="text-xs font-medium text-success">{text}</p>
      <p className="font-mono text-[10.5px] text-subtle" title={order.closedBy}>
        {order.closedBy}
      </p>
    </div>
  );
}

export function OrdersPanel({
  orders,
  ignored,
  timeZone,
}: {
  readonly orders: readonly AgentOrderView[];
  readonly ignored: number;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle count={orders.length}>{t.agent.orders.title}</SectionTitle>
      {orders.length === 0 ? <p className="text-sm text-muted">{t.agent.orders.empty}</p> : null}
      <ul className="flex flex-col gap-2">
        {orders.map((order) => (
          <li key={order.orderId} className="rounded-lg border border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">
                {order.kind === 'visit'
                  ? t.agent.orders.visit
                  : order.test === undefined
                    ? t.agent.orders.unknownTest
                    : t.agent.orders.test(order.test)}
              </span>
              {order.urgent ? <Badge tone="danger">{t.agent.orders.urgent}</Badge> : null}
              <Badge tone={STAGE_TONES[order.stage]} className="ml-auto">
                {t.agent.orders.stages[order.stage] ?? order.stage}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted">
              {t.agent.orders.sources[order.source] ?? order.source} ·{' '}
              {t.agent.orders.due(clinicDate(order.dueAt, timeZone, locale))}
            </p>
            {order.closedBy === undefined ? null : <ClosedBy order={order} timeZone={timeZone} />}
          </li>
        ))}
      </ul>
      {ignored > 0 ? <p className="text-xs text-muted">{t.agent.orders.ignored(ignored)}</p> : null}
    </Card>
  );
}

const JUMPS = [1, 4, 5, 7] as const;

function JumpButton({
  days,
  onJump,
  disabled,
}: {
  readonly days: number;
  readonly onJump: (days: number) => void;
  readonly disabled: boolean;
}): ReactNode {
  const t = useT();
  function handleClick(): void {
    onJump(days);
  }
  return (
    <Button size="sm" onClick={handleClick} disabled={disabled}>
      {t.agent.clock.jump(days)}
    </Button>
  );
}

export function ClockPanel({
  now,
  ladder,
  stopped,
  timeZone,
}: {
  readonly now: string;
  readonly ladder: AgentLadderView | undefined;
  /** Every order is covered: the ladder no longer runs. */
  readonly stopped: boolean;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const advance = useAdvanceAgentClock();
  function handleJump(days: number): void {
    advance.mutate(days);
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle>{t.agent.clock.title}</SectionTitle>
      <p className="text-sm font-medium text-fg">
        {t.agent.clock.today(clinicDateTime(now, timeZone, locale))}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {JUMPS.map((days) => (
          <JumpButton key={days} days={days} onJump={handleJump} disabled={advance.isPending} />
        ))}
      </div>
      <p className="text-xs text-muted">{t.agent.clock.hint}</p>
      {advance.isError ? <InlineError error={advance.error} /> : null}
      {ladder === undefined ? null : (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs font-semibold text-fg">
            {t.agent.clock.ladder} · {t.agent.clock.tracks[ladder.track] ?? ladder.track}
          </p>
          {stopped ? <p className="text-xs text-success">{t.agent.clock.stopped}</p> : null}
          <ol className={cx('flex flex-col gap-1.5', stopped && 'opacity-50')}>
            {ladder.rungs.map((rung) => (
              <li key={rung.id} className="flex items-start gap-2 text-xs">
                {rung.done ? (
                  <CircleCheck
                    className="mt-0.5 size-3.5 shrink-0 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleDashed
                    className="mt-0.5 size-3.5 shrink-0 text-subtle"
                    aria-hidden="true"
                  />
                )}
                <span className={cx('flex-1', rung.done ? 'text-muted' : 'text-fg')}>
                  {t.agent.clock.actions[rung.action] ?? rung.action}
                </span>
                <span className="text-subtle tabular-nums">
                  {rung.done ? t.agent.clock.rungDone : clinicDate(rung.dueAt, timeZone, locale)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

function TaskItem({
  task,
  timeZone,
}: {
  readonly task: AgentTaskView;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const orders = task.summary.orders.map((order) =>
    order === 'visit' ? t.agent.orders.visit : t.agent.orders.test(order),
  );
  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardList className="size-4 text-muted" aria-hidden="true" />
        <span className="text-sm font-medium text-fg">
          {t.agent.tasks.kinds[task.kind] ?? task.kind}
        </span>
        {task.priority === 'high' ? <Badge tone="danger">{t.agent.tasks.high}</Badge> : null}
        <span className="ml-auto text-[11px] text-subtle">
          {t.agent.tasks.due(clinicDate(task.dueAt, timeZone, locale))}
        </span>
      </div>
      <ol className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
        <li>
          {orders.length === 0
            ? t.agent.tasks.noOrders
            : t.agent.tasks.ordersLine(orders.join(', '))}
        </li>
        <li>
          {t.agent.tasks.outreachLine(
            task.summary.outboundCount,
            task.summary.lastOutboundAt === undefined
              ? undefined
              : clinicDate(task.summary.lastOutboundAt, timeZone, locale),
            task.summary.lastStatus === undefined
              ? undefined
              : t.agent.phone.statuses[task.summary.lastStatus],
            task.summary.replied,
          )}
        </li>
        <li className="text-fg">{t.agent.tasks.asks[task.summary.ask] ?? task.summary.ask}</li>
      </ol>
    </li>
  );
}

export function TasksPanel({
  tasks,
  timeZone,
}: {
  readonly tasks: readonly AgentTaskView[];
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle count={tasks.length}>{t.agent.tasks.title}</SectionTitle>
      {tasks.length === 0 ? <p className="text-sm text-muted">{t.agent.tasks.empty}</p> : null}
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} timeZone={timeZone} />
        ))}
      </ul>
    </Card>
  );
}

function FindingItem({ finding }: { readonly finding: AgentFindingView }): ReactNode {
  const t = useT();
  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Stethoscope className="size-4 text-muted" aria-hidden="true" />
        <Badge
          tone={
            finding.category === 'pre_visit_question'
              ? 'info'
              : finding.routine
                ? 'neutral'
                : 'warning'
          }
        >
          {(t.review.categories as Readonly<Record<string, string | undefined>>)[
            finding.category
          ] ?? finding.category}
        </Badge>
        {finding.mode === 'shadow' ? (
          <span className="ml-auto text-[11px] text-subtle">{t.agent.doctor.shadow}</span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-fg">{finding.summary}</p>
      <p className="mt-0.5 text-xs text-muted">{finding.suggestion}</p>
      {finding.citations.length === 0 ? (
        <p className="mt-2 text-xs text-subtle">{t.agent.doctor.noCitation}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {finding.citations.map((citation) => (
            <CitationQuote key={`${citation.docId}:${citation.quote}`} citation={citation} />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * An order the engine created from a result (an abnormal value asks for a
 * visit), waiting for the doctor: the agent contacts nobody about it until
 * the doctor confirms, and the confirmation is recorded with who and when.
 */
function ConfirmationItem({
  order,
  patientId,
  timeZone,
}: {
  readonly order: AgentOrderView;
  readonly patientId: string;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirmAgentOrder(patientId);
  function handleConfirm(): void {
    confirm.mutate(order.orderId);
  }
  const confirmed = order.doctorConfirmation;
  return (
    <li
      className="rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2"
      data-testid="doctor-confirmation"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-warning" aria-hidden="true" />
        <span className="text-sm font-medium text-fg">
          {order.kind === 'visit'
            ? t.agent.doctor.confirmVisit
            : t.agent.doctor.confirmTest(order.test ?? t.agent.orders.unknownTest)}
        </span>
        {order.urgent ? <Badge tone="danger">{t.agent.orders.urgent}</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-muted">{t.agent.doctor.confirmHint}</p>
      {confirmed === undefined ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="success"
            onClick={handleConfirm}
            loading={confirm.isPending}
            disabled={confirm.isPending}
          >
            {t.agent.doctor.confirmAction}
          </Button>
          {confirm.isError ? <InlineError error={confirm.error} /> : null}
        </div>
      ) : (
        <p className="mt-2 text-xs font-medium text-success">
          {t.agent.doctor.confirmedBy(confirmed.by, clinicDateTime(confirmed.at, timeZone, locale))}
        </p>
      )}
    </li>
  );
}

export function DoctorPanel({
  findings,
  orders = [],
  patientId,
  timeZone,
}: {
  readonly findings: readonly AgentFindingView[];
  readonly orders?: readonly AgentOrderView[];
  readonly patientId?: string;
  readonly timeZone?: string | undefined;
}): ReactNode {
  const t = useT();
  const main = findings.filter((finding) => !finding.routine);
  const routine = findings.filter((finding) => finding.routine);
  const confirmations = orders.filter((order) => order.needsConfirmation === true);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle count={findings.length + confirmations.length}>
        {t.agent.doctor.title}
      </SectionTitle>
      <p className="text-xs text-muted">{t.agent.doctor.subtitle}</p>
      {confirmations.length === 0 || patientId === undefined ? null : (
        <ul className="flex flex-col gap-2">
          {confirmations.map((order) => (
            <ConfirmationItem
              key={order.orderId}
              order={order}
              patientId={patientId}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}
      {findings.length === 0 && confirmations.length === 0 ? (
        <p className="text-sm text-muted">{t.agent.doctor.empty}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {main.map((finding) => (
          <FindingItem key={finding.id} finding={finding} />
        ))}
      </ul>
      {routine.length === 0 ? null : (
        <details className="group rounded-lg border border-dashed border-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted">
            {t.agent.doctor.routine(routine.length)}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {routine.map((finding) => (
              <FindingItem key={finding.id} finding={finding} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
