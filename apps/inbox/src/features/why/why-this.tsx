import {
  CalendarClock,
  Check,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  Minus,
  Quote,
  Route,
  Stethoscope,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { DocumentRefView, ReasonWhyView } from '../../api/why-contract.ts';
import { Badge } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { formatDate } from '../../lib/format.ts';
import { findQuote } from '../../lib/highlight.ts';
import { DocumentFacts, documentKey, KindIcon } from './document-facts.tsx';
import { useDocumentsDrawer } from './documents-drawer.tsx';

/*
 * "Why this?" (HIP-142): one click shows the evidence behind a reason, all
 * of it from the patient's own records: the due date math in plain words,
 * the doctor's words in the note, the protocol and what enrolled the
 * patient, the visit pattern, what would close it. Every cited document
 * opens in the patient's documents drawer.
 */

/** Heading level of the panel's sections: one below the reason's own title. */
type Level = 3 | 4;

function Section({
  icon,
  title,
  level,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly level: Level;
  readonly children: ReactNode;
}): ReactNode {
  const Heading = level === 3 ? 'h3' : 'h4';
  return (
    <section className="flex flex-col gap-1.5">
      <Heading className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        {icon}
        {title}
      </Heading>
      {children}
    </section>
  );
}

/** A cited record, with "Show in documents" when the drawer is available. */
export function CitedDocument({
  doc,
  quote,
}: {
  readonly doc: DocumentRefView;
  readonly quote?: string;
}): ReactNode {
  const t = useT();
  const drawer = useDocumentsDrawer();
  function handleShow(): void {
    drawer?.open({ key: documentKey(doc), ...(quote === undefined ? {} : { quote }) });
  }
  return (
    <li className="flex flex-wrap items-start gap-x-2.5 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2">
      <KindIcon kind={doc.kind} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-xs text-muted">
          <span className="font-medium text-fg">{doc.kindLabel}</span>
          {t.common.separator}
          <time dateTime={doc.at}>{formatDate(doc.at)}</time>
        </p>
        <DocumentFacts doc={doc} />
      </div>
      {drawer === undefined ? null : (
        <button
          type="button"
          onClick={handleShow}
          className="shrink-0 rounded-md px-1.5 py-1 text-xs font-medium text-primary hover:bg-primary-soft max-sm:ml-8"
        >
          {t.why.showInDocuments}
        </button>
      )}
    </li>
  );
}

function PlanSection({
  plan,
  level,
}: {
  readonly plan: NonNullable<ReasonWhyView['plan']>;
  readonly level: Level;
}): ReactNode {
  const t = useT();
  const excerpt = plan.noteExcerpt;
  const match = excerpt === undefined ? undefined : findQuote(excerpt, plan.quote);
  const meta = [
    plan.authoredAt === undefined ? undefined : t.why.noteOf(formatDate(plan.authoredAt)),
    plan.author === undefined ? undefined : t.why.by(plan.author),
    plan.specialty === undefined
      ? undefined
      : ((t.labels.specialties as Record<string, string>)[plan.specialty] ?? plan.specialty),
  ].filter((part): part is string => part !== undefined);
  return (
    <Section
      level={level}
      icon={<Quote className="size-3.5 text-layer-plan" aria-hidden="true" />}
      title={t.why.doctorsPlan}
    >
      <p className="text-xs text-muted">{meta.join(t.common.separator)}</p>
      <blockquote className="rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed">
        {match ? (
          <>
            <span className="text-muted">{match.before}</span>
            <mark className="evidence-mark">{match.match}</mark>
            <span className="text-muted">{match.after}</span>
          </>
        ) : (
          <mark className="evidence-mark">{plan.quote}</mark>
        )}
      </blockquote>
      {plan.itemDescription === undefined ? null : (
        <p className="text-xs text-muted">{t.why.aiRead(plan.itemDescription)}</p>
      )}
      {plan.note === undefined ? null : (
        <ul className="flex flex-col gap-2">
          <CitedDocument doc={plan.note} quote={plan.quote} />
        </ul>
      )}
    </Section>
  );
}

function ProtocolSection({
  protocol,
  level,
}: {
  readonly protocol: NonNullable<ReasonWhyView['protocol']>;
  readonly level: Level;
}): ReactNode {
  const t = useT();
  const { enrollment } = protocol;
  return (
    <Section
      level={level}
      icon={<Route className="size-3.5 text-layer-protocol" aria-hidden="true" />}
      title={t.why.protocol}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
        {protocol.title}
        {protocol.statusText === undefined ? null : (
          <Badge tone={protocol.status === 'draft' ? 'warning' : 'success'}>
            {protocol.statusText}
          </Badge>
        )}
      </p>
      {protocol.scheduleText === undefined ? null : (
        <p className="text-sm text-muted">
          <span className="font-medium text-fg">{t.why.interval}: </span>
          {protocol.scheduleText}
        </p>
      )}
      <p className="mt-1 text-xs font-semibold text-muted">{t.why.enrolledBecause}</p>
      <p className="text-sm text-fg">{enrollment.text}</p>
      {enrollment.condition?.quote === undefined ? null : (
        <q className="text-sm text-muted">
          <mark className="evidence-mark">{enrollment.condition.quote}</mark>
        </q>
      )}
      {enrollment.evidence.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {enrollment.evidence.map((doc) => (
            <CitedDocument key={documentKey(doc)} doc={doc} />
          ))}
        </ul>
      )}
      {enrollment.activeTreatmentText === undefined ? null : (
        <p className="text-sm text-fg">{enrollment.activeTreatmentText}</p>
      )}
    </Section>
  );
}

function CadenceSection({
  cadence,
  level,
}: {
  readonly cadence: NonNullable<ReasonWhyView['cadence']>;
  readonly level: Level;
}): ReactNode {
  const t = useT();
  return (
    <Section
      level={level}
      icon={<Stethoscope className="size-3.5 text-layer-cadence" aria-hidden="true" />}
      title={t.why.pattern}
    >
      <p className="text-sm text-fg">{cadence.text}</p>
      <ol className="flex flex-wrap gap-1.5">
        {cadence.visits.map((visit) => (
          <li
            key={visit.encounterId}
            title={visit.inPattern ? t.why.inPattern : t.why.outOfPattern}
            className={cx(
              'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs tabular-nums',
              visit.inPattern
                ? 'border-border-strong bg-surface text-fg'
                : 'border-dashed border-border text-muted line-through',
            )}
          >
            {visit.inPattern ? (
              <Check className="size-3" aria-hidden="true" />
            ) : (
              <Minus className="size-3" aria-hidden="true" />
            )}
            <time dateTime={visit.at}>{formatDate(visit.at)}</time>
            <span className="sr-only">
              {visit.inPattern ? t.why.inPattern : t.why.outOfPattern}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function WhyPanel({
  why,
  level,
}: {
  readonly why: ReasonWhyView;
  readonly level: Level;
}): ReactNode {
  const t = useT();
  const records = [why.due.anchor, why.due.tooEarly].filter(
    (doc): doc is DocumentRefView =>
      doc !== undefined &&
      // The note behind a plan item is shown with the doctor's words.
      documentKey(doc) !== (why.plan?.note === undefined ? '' : documentKey(why.plan.note)),
  );
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-2 p-3 sm:p-4">
      <Section
        level={level}
        icon={<CalendarClock className="size-3.5" aria-hidden="true" />}
        title={t.why.dueDate}
      >
        <p className="text-sm font-medium text-fg" data-testid="why-due">
          {why.due.text}
        </p>
        <p className="text-sm text-muted">{why.due.basisText}</p>
        {why.due.toleranceText === undefined ? null : (
          <p className="text-xs text-muted">{why.due.toleranceText}</p>
        )}
        {why.due.tooEarlyText === undefined ? null : (
          <p className="text-xs text-warning">{why.due.tooEarlyText}</p>
        )}
        {records.length === 0 ? null : (
          <ul className="mt-1 flex flex-col gap-2" aria-label={t.why.records}>
            {records.map((doc) => (
              <CitedDocument key={documentKey(doc)} doc={doc} />
            ))}
          </ul>
        )}
      </Section>
      {why.plan === undefined ? null : <PlanSection plan={why.plan} level={level} />}
      {why.protocol === undefined ? null : (
        <ProtocolSection protocol={why.protocol} level={level} />
      )}
      {why.cadence === undefined ? null : <CadenceSection cadence={why.cadence} level={level} />}
      <Section
        level={level}
        icon={<ClipboardCheck className="size-3.5" aria-hidden="true" />}
        title={t.why.fulfilledBy}
      >
        <p className="text-sm text-fg">{why.fulfilledBy.text}</p>
        {why.fulfilledBy.equivalentCodes.length === 0 ? null : (
          <p className="text-xs text-muted">
            {t.why.equivalents(why.fulfilledBy.equivalentCodes.join(', '))}
          </p>
        )}
      </Section>
      {why.closedBy === undefined ? null : (
        <Section
          level={level}
          icon={<CircleCheck className="size-3.5 text-success" aria-hidden="true" />}
          title={t.why.closedBy}
        >
          <ul className="flex flex-col gap-2">
            <CitedDocument doc={why.closedBy} />
          </ul>
        </Section>
      )}
    </div>
  );
}

/** The "Why this?" toggle of a reason or expectation, and its evidence. */
export function WhyThis({
  why,
  label,
  headingLevel = 4,
}: {
  readonly why: ReasonWhyView | undefined;
  /** The reason's label, to name the region for screen readers. */
  readonly label: string;
  /** Level of the panel's section headings: one below the reason's own heading (default 4). */
  readonly headingLevel?: Level;
}): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (why === undefined) return null;
  function handleToggle(): void {
    setOpen((current) => !current);
  }
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={handleToggle}
        className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-[13px] font-medium text-primary hover:bg-primary-soft"
      >
        <CircleHelp className="size-3.5" aria-hidden="true" />
        {open ? t.why.hide : t.why.button}
        <ChevronDown
          className={cx('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div id={panelId} role="region" aria-label={t.why.regionLabel(label)}>
          <WhyPanel why={why} level={headingLevel} />
        </div>
      ) : null}
    </div>
  );
}
