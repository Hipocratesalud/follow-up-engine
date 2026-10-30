import { FlaskConical, TrendingUp } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useId, useState } from 'react';
import { useDemoClock, useNow } from '../../api/queries.ts';
import { ErrorState } from '../../components/states.tsx';
import { Card, Field, INPUT_CLASS, Skeleton } from '../../components/ui.tsx';
import { useLocale, useT } from '../../i18n/index.ts';
import type { ValueCopy } from '../../i18n/value-copy.ts';
import { cx } from '../../lib/cx.ts';
import { BarChart, type BarRow } from '../metrics/charts.tsx';
import { useMetrics } from '../metrics/queries.ts';
import {
  type Interval,
  isRunning,
  SIMULATION_ORDER_KINDS,
  SIMULATION_PERSONA_IDS,
  SIMULATION_TASK_KINDS,
  type SimulationReportView,
} from './contract.ts';
import { type ValueFormat, valueFormat } from './format.ts';
import { ArmLegend, PairedBars, type PairedRow } from './paired-bars.tsx';
import { useValueSimulation } from './queries.ts';

const DAY_MS = 86_400_000;
const TITLE_ID = 'value-title';
/** The demo clinic's own numbers: the same window as the simulation. */
const CLINIC_WINDOW_DAYS = 90;

function scale(interval: Interval, factor: number): Interval {
  return { mean: interval.mean * factor, low: interval.low * factor, high: interval.high * factor };
}

function Panel({
  title,
  description,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <Card className={cx('flex flex-col gap-4 p-4 lg:p-5', className)}>
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description === undefined ? null : <p className="text-xs text-muted">{description}</p>}
      </header>
      {children}
    </Card>
  );
}

function Tile({
  label,
  value,
  hint,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly emphasis?: boolean;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd
        className={cx(
          'text-xl font-semibold tracking-tight tabular-nums',
          emphasis ? 'text-primary' : 'text-fg',
        )}
      >
        {value}
      </dd>
      <dd className="text-xs text-muted">{hint}</dd>
    </div>
  );
}

function Headline({
  report,
  copy,
  format,
}: {
  readonly report: SimulationReportView;
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
}): ReactNode {
  const { control, agent } = report.arms;
  const difference = report.difference.fulfilledShare;
  const rows: readonly PairedRow[] = [
    {
      key: 'all',
      label: copy.headline.title,
      control: control.fulfilledShare,
      agent: agent.fulfilledShare,
      display: `${format.percent(control.fulfilledShare.mean)} → ${format.percent(agent.fulfilledShare.mean)}`,
      delta: copy.points(format.points(difference.mean)),
    },
  ];
  return (
    <Card className="flex flex-col gap-5 p-5 lg:p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-fg">{copy.headline.title}</h2>
        <p className="text-xs text-muted">
          {copy.headline.scope(
            format.integer(report.cohort.patientsPerArm),
            report.seeds.length,
            report.cohort.horizonDays,
          )}
        </p>
      </header>
      <dl
        className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center"
        aria-label={copy.headline.summary(
          format.percent(control.fulfilledShare.mean),
          format.percent(agent.fulfilledShare.mean),
          format.points(difference.mean),
        )}
      >
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted">{copy.headline.control}</dt>
          <dd className="text-4xl font-semibold tracking-tight text-fg tabular-nums">
            {format.percent(control.fulfilledShare.mean)}
          </dd>
          <dd className="text-xs text-muted tabular-nums">
            {copy.headline.interval(
              format.percent(control.fulfilledShare.low),
              format.percent(control.fulfilledShare.high),
            )}
          </dd>
        </div>
        <TrendingUp className="size-6 text-primary max-sm:hidden" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted">{copy.headline.agent}</dt>
          <dd className="text-4xl font-semibold tracking-tight text-primary tabular-nums">
            {format.percent(agent.fulfilledShare.mean)}
          </dd>
          <dd className="text-xs text-muted tabular-nums">
            {copy.headline.interval(
              format.percent(agent.fulfilledShare.low),
              format.percent(agent.fulfilledShare.high),
            )}
          </dd>
        </div>
      </dl>
      <p className="text-sm font-medium text-fg tabular-nums">
        {copy.headline.difference(
          format.points(difference.mean),
          format.points(difference.low),
          format.points(difference.high),
        )}
      </p>
      <PairedBars
        rows={rows}
        caption={copy.headline.title}
        labels={copy.arms}
        format={formatShare(format)}
      />
      <ArmLegend labels={copy.arms} intervalLabel={copy.intervalLegend} />
    </Card>
  );
}

function formatShare(format: ValueFormat): (interval: Interval) => string {
  return (interval) =>
    `${format.percent(interval.mean)} (${format.percent(interval.low)}–${format.percent(interval.high)})`;
}

/** A whole number of zero or more, or `undefined` when the field does not hold one. */
function parseAmount(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ForYourClinic({
  report,
  copy,
  format,
  patients,
  price,
  onPatientsChange,
  onPriceChange,
}: {
  readonly report: SimulationReportView;
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
  readonly patients: string;
  readonly price: string;
  readonly onPatientsChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onPriceChange: (event: ChangeEvent<HTMLInputElement>) => void;
}): ReactNode {
  const ids = useId();
  const patientsValue = parseAmount(patients);
  const priceValue = parseAmount(price);
  const perMonth = patientsValue ?? 0;
  const consultations = scale(report.economics.recoveredConsultationsPerPatient, perMonth);
  const revenue = scale(consultations, priceValue ?? 0);
  // Orders per patient (both arms are the same size), times the difference in fulfilled share.
  const ordersPerPatient = report.arms.agent.orders.mean / report.cohort.patientsPerArm;
  const orders = scale(report.difference.fulfilledShare, ordersPerPatient * perMonth);
  return (
    <Panel title={copy.clinic.title} description={copy.clinic.description}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={copy.clinic.patientsPerMonth}
          htmlFor={`${ids}-patients`}
          hint={copy.clinic.patientsHint}
          error={patientsValue === undefined ? copy.clinic.invalid : undefined}
        >
          <input
            id={`${ids}-patients`}
            type="number"
            min={0}
            step={10}
            inputMode="numeric"
            value={patients}
            onChange={onPatientsChange}
            aria-invalid={patientsValue === undefined}
            className={INPUT_CLASS}
          />
        </Field>
        <Field
          label={copy.clinic.price(report.economics.currency)}
          htmlFor={`${ids}-price`}
          hint={copy.clinic.priceHint}
          error={priceValue === undefined ? copy.clinic.invalid : undefined}
        >
          <input
            id={`${ids}-price`}
            type="number"
            min={0}
            step={5}
            inputMode="decimal"
            value={price}
            onChange={onPriceChange}
            aria-invalid={priceValue === undefined}
            className={INPUT_CLASS}
          />
        </Field>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3" aria-live="polite">
        <Tile
          label={copy.clinic.consultations}
          value={format.decimal(consultations.mean)}
          hint={copy.clinic.consultationsHint(
            format.decimal(consultations.low),
            format.decimal(consultations.high),
          )}
          emphasis
        />
        <Tile
          label={copy.clinic.revenue}
          value={format.money(revenue.mean)}
          hint={copy.clinic.revenueHint(format.money(revenue.low), format.money(revenue.high))}
          emphasis
        />
        <Tile
          label={copy.clinic.orders}
          value={format.decimal(orders.mean)}
          hint={copy.clinic.ordersHint(format.decimal(orders.low), format.decimal(orders.high))}
        />
      </dl>
    </Panel>
  );
}

function OutcomeTiles({
  report,
  copy,
  format,
}: {
  readonly report: SimulationReportView;
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
}): ReactNode {
  const { control, agent } = report.arms;
  const tasks = agent.tasksPer100;
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <Tile
        label={copy.tiles.urgent7}
        value={format.percent(agent.urgentWithin7Share.mean)}
        hint={`${copy.tiles.versus(format.percent(control.urgentWithin7Share.mean))} · ${copy.tiles.urgent14(
          format.percent(agent.urgentWithin14Share.mean),
          format.percent(control.urgentWithin14Share.mean),
        )}`}
        emphasis
      />
      <Tile
        label={copy.tiles.median}
        value={copy.tiles.days(format.decimal(agent.medianDaysToFulfilment.mean))}
        hint={copy.tiles.versus(
          copy.tiles.days(format.decimal(control.medianDaysToFulfilment.mean)),
        )}
      />
      <Tile
        label={copy.tiles.unreachable}
        value={format.percent(agent.unreachableShare.mean)}
        hint={copy.tiles.versus(format.percent(control.unreachableShare.mean))}
      />
      <Tile
        label={copy.tiles.messages}
        value={format.decimal(agent.messagesPerPatient.mean)}
        hint={`${copy.tiles.versus(format.decimal(control.messagesPerPatient.mean))} · ${copy.tiles.messagesHint(report.invariants.maxProactiveIn7Days)}`}
      />
      <Tile
        label={copy.tiles.attended}
        value={format.decimal(agent.consultationsAttendedPer100.mean)}
        hint={copy.tiles.versus(format.decimal(control.consultationsAttendedPer100.mean))}
      />
      <Tile
        label={copy.tiles.staff}
        value={format.decimal(tasks.total.mean)}
        hint={copy.tiles.staffHint(
          format.decimal(tasks.call_patient.mean),
          format.decimal(tasks.doctor_notice.mean),
          format.decimal(tasks.update_phone.mean),
        )}
      />
    </dl>
  );
}

function Personas({
  report,
  copy,
  format,
}: {
  readonly report: SimulationReportView;
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
}): ReactNode {
  const rows = SIMULATION_PERSONA_IDS.flatMap((id): PairedRow[] => {
    const row = report.personas.find((persona) => persona.persona === id);
    if (row === undefined) return [];
    const total = report.personas.reduce((sum, persona) => sum + persona.weight, 0);
    return [
      {
        key: id,
        label: copy.personas.names[id],
        hint: copy.personas.share(format.percent(total === 0 ? 0 : row.weight / total)),
        control: row.control,
        agent: row.agent,
        display: `${format.percent(row.control.mean)} → ${format.percent(row.agent.mean)}`,
        delta: copy.points(format.points(row.difference.mean)),
      },
    ];
  });
  return (
    <Panel title={copy.personas.title} description={copy.personas.description}>
      <PairedBars
        rows={rows}
        caption={copy.personas.caption}
        labels={copy.arms}
        format={formatShare(format)}
      />
      <ArmLegend labels={copy.arms} intervalLabel={copy.intervalLegend} />
      <ul className="grid gap-x-6 gap-y-1.5 text-xs text-muted sm:grid-cols-2">
        {SIMULATION_PERSONA_IDS.map((id) => (
          <li key={id}>
            <span className="font-medium text-fg">{copy.personas.names[id]}</span>
            {' · '}
            {copy.personas.summaries[id]}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function OrderKinds({
  report,
  copy,
  format,
}: {
  readonly report: SimulationReportView;
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
}): ReactNode {
  const { control, agent } = report.arms;
  const rows = SIMULATION_ORDER_KINDS.map((kind): PairedRow => ({
    key: kind,
    label: copy.kinds.names[kind],
    control: control.byKind[kind].fulfilledShare,
    agent: agent.byKind[kind].fulfilledShare,
    display: `${format.percent(control.byKind[kind].fulfilledShare.mean)} → ${format.percent(agent.byKind[kind].fulfilledShare.mean)}`,
    delta: copy.points(
      format.points(
        agent.byKind[kind].fulfilledShare.mean - control.byKind[kind].fulfilledShare.mean,
      ),
    ),
  }));
  return (
    <Panel title={copy.kinds.title} description={copy.kinds.description}>
      <PairedBars
        rows={rows}
        caption={copy.kinds.caption}
        labels={copy.arms}
        format={formatShare(format)}
      />
    </Panel>
  );
}

function Workload({
  report,
  copy,
  format,
}: {
  readonly report: SimulationReportView;
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
}): ReactNode {
  const tasks = report.arms.agent.tasksPer100;
  const rows: BarRow[] = SIMULATION_TASK_KINDS.map((kind) => ({
    key: kind,
    label: copy.workload.tasks[kind],
    segments: [
      {
        key: kind,
        label: copy.workload.perHundred,
        value: Math.round(tasks[kind].mean * 10) / 10,
        tone: 'primary',
      },
    ],
    display: format.decimal(tasks[kind].mean),
  }));
  return (
    <Panel title={copy.workload.title} description={copy.workload.description}>
      <BarChart rows={rows} caption={copy.workload.caption} />
    </Panel>
  );
}

function DemoClinic({
  copy,
  format,
  price,
}: {
  readonly copy: ValueCopy;
  readonly format: ValueFormat;
  readonly price: number;
}): ReactNode {
  const now = useNow();
  // Wait for the demo clock (if any): the window counts back from the clinic's own "today".
  const clock = useDemoClock();
  const anchor = Math.floor(now.getTime() / 60_000) * 60_000;
  const from = new Date(anchor - CLINIC_WINDOW_DAYS * DAY_MS).toISOString();
  const metrics = useMetrics({ from }, { enabled: !clock.isPending });
  return (
    <Panel title={copy.demoClinic.title} description={copy.demoClinic.description}>
      {metrics.isPending ? (
        <Skeleton className="h-[86px] rounded-xl" />
      ) : metrics.isError ? (
        <p className="text-sm text-muted">{copy.demoClinic.unavailable}</p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Tile
              label={copy.demoClinic.booked}
              value={format.integer(metrics.data.bookings.booked.followUpCase)}
              hint={copy.demoClinic.bookedHint(metrics.data.bookings.booked.total)}
            />
            <Tile
              label={copy.demoClinic.attended}
              value={format.integer(metrics.data.bookings.attended.followUpCase)}
              hint={copy.demoClinic.attendedHint(metrics.data.bookings.attended.total)}
            />
            <Tile
              label={copy.demoClinic.revenue}
              value={format.money(metrics.data.bookings.attended.followUpCase * price)}
              hint={copy.demoClinic.revenueHint(format.money(price))}
            />
          </dl>
          {metrics.data.bookings.booked.followUpCase === 0 ? (
            <p className="text-xs text-muted">{copy.demoClinic.empty}</p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function Assumptions({ copy }: { readonly copy: ValueCopy }): ReactNode {
  return (
    <Panel title={copy.assumptions.title} description={copy.assumptions.description}>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-xs text-muted">
        {copy.assumptions.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="text-xs text-muted">{copy.method}</p>
    </Panel>
  );
}

function ValueSkeleton({ label }: { readonly label: string }): ReactNode {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-4">
      <Skeleton className="h-64 rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((key) => (
          <Skeleton key={key} className="h-[86px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function ValueContent({ report }: { readonly report: SimulationReportView }): ReactNode {
  const copy = useT().value;
  const format = valueFormat(useLocale(), report.economics.currency);
  const [patients, setPatients] = useState(String(report.economics.patientsPerMonth));
  const [price, setPrice] = useState(String(report.economics.consultationPrice));

  function handlePatientsChange(event: ChangeEvent<HTMLInputElement>): void {
    setPatients(event.currentTarget.value);
  }
  function handlePriceChange(event: ChangeEvent<HTMLInputElement>): void {
    setPrice(event.currentTarget.value);
  }

  return (
    <div className="flex flex-col gap-4">
      <Headline report={report} copy={copy} format={format} />
      <ForYourClinic
        report={report}
        copy={copy}
        format={format}
        patients={patients}
        price={price}
        onPatientsChange={handlePatientsChange}
        onPriceChange={handlePriceChange}
      />
      <OutcomeTiles report={report} copy={copy} format={format} />
      <Personas report={report} copy={copy} format={format} />
      <div className="grid gap-4 lg:grid-cols-2">
        <OrderKinds report={report} copy={copy} format={format} />
        <Workload report={report} copy={copy} format={format} />
      </div>
      <DemoClinic
        copy={copy}
        format={format}
        price={parseAmount(price) ?? report.economics.consultationPrice}
      />
      <Assumptions copy={copy} />
    </div>
  );
}

/**
 * "Value" (V1 PRD workstream B, V2 PRD outcomes): the impact headline of
 * the order agent from a seeded 90-day simulation with a control arm
 * (docs/simulation.md), scaled to the clinic's own volume and price, next
 * to this demo clinic's real attributed bookings.
 */
export function ValuePage(): ReactNode {
  const copy = useT().value;
  const simulation = useValueSimulation();

  function handleRetry(): void {
    void simulation.refetch();
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex max-w-3xl flex-col gap-1">
        <h1 id={TITLE_ID} className="text-xl font-semibold tracking-tight text-fg">
          {copy.title}
        </h1>
        <p className="text-sm text-muted">{copy.subtitle}</p>
      </header>
      <p className="flex items-start gap-2 rounded-lg border border-border bg-info-soft px-3 py-2 text-sm text-info">
        <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{copy.notice}</span>
      </p>
      {simulation.isPending ? (
        <ValueSkeleton label={copy.loading} />
      ) : simulation.isError ? (
        <ErrorState error={simulation.error} onRetry={handleRetry} title={copy.errorTitle} />
      ) : isRunning(simulation.data) ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-muted">
            {copy.running(simulation.data.seedsDone, simulation.data.seeds)}
          </p>
          <ValueSkeleton label={copy.loading} />
        </div>
      ) : (
        <ValueContent report={simulation.data} />
      )}
    </div>
  );
}
