import {
  ArrowRight,
  FileWarning,
  Hourglass,
  Pill,
  Sparkles,
  Stethoscope,
  Timer,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ACTIVE_CASE_STATUSES, type DemoConsultationResponse } from '../../api/contract.ts';
import { useCases } from '../../api/queries.ts';
import { LayerChip, StatusBadge } from '../../components/case-badges.tsx';
import { Badge, Card, SectionTitle } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDate, formatMs, formatPercent, formatUsd } from '../../lib/format.ts';
import { segmentByQuotes } from '../../lib/highlight.ts';
import { modelDisplayName, PLAN_KIND_LABELS, SIMULATED_READER_LABEL } from '../../lib/labels.ts';

type QuoteKind = 'plan' | 'condition' | 'medication';

const QUOTE_STYLES: Record<QuoteKind, string> = {
  plan: 'evidence-mark',
  condition:
    'rounded-sm bg-layer-plan-soft px-0.5 text-layer-plan underline decoration-2 underline-offset-2',
  medication:
    'rounded-sm bg-info-soft px-0.5 text-info underline decoration-dotted decoration-2 underline-offset-2',
};

const QUOTE_SWATCHES: Record<QuoteKind, string> = {
  plan: 'bg-mark ring-1 ring-mark-ring',
  condition: 'bg-layer-plan',
  medication: 'bg-info',
};

const QUOTE_LEGEND: Record<QuoteKind, string> = {
  plan: 'Plan del médico',
  condition: 'Condición',
  medication: 'Medicamento',
};

/** The note with every quote the model cited marked in place. */
function AnnotatedNote({
  noteText,
  extraction,
}: {
  readonly noteText: string;
  readonly extraction: DemoConsultationResponse['extraction'];
}): ReactNode {
  const quotes: { text: string; kind: QuoteKind }[] = [
    ...extraction.planItems.map((item) => ({ text: item.evidenceQuote, kind: 'plan' as const })),
    ...extraction.conditions.map((item) => ({
      text: item.evidenceQuote,
      kind: 'condition' as const,
    })),
    ...extraction.medications.map((item) => ({
      text: item.evidenceQuote,
      kind: 'medication' as const,
    })),
  ];
  const segments = segmentByQuotes(
    noteText,
    quotes.map((quote) => quote.text),
  );
  return (
    <figure className="rounded-lg border border-border bg-surface-2">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted">
        <span className="font-medium text-fg">Nota con las citas marcadas</span>
        {(Object.keys(QUOTE_LEGEND) as QuoteKind[]).map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span
              className={cx('inline-block size-2.5 rounded-sm', QUOTE_SWATCHES[kind])}
              aria-hidden="true"
            />
            {QUOTE_LEGEND[kind]}
          </span>
        ))}
      </figcaption>
      <p className="px-3 py-3 text-sm leading-relaxed text-fg">
        {segments.map((segment, index) => {
          const kind =
            segment.quoteIndex === undefined ? undefined : quotes[segment.quoteIndex]?.kind;
          return kind ? (
            <mark key={index} className={QUOTE_STYLES[kind]} data-quote-kind={kind}>
              {segment.text}
            </mark>
          ) : (
            <span key={index} className="text-muted">
              {segment.text}
            </span>
          );
        })}
      </p>
    </figure>
  );
}

/** The patient the consultation was for: the Bundle's `Patient` entry. */
export function consultationPatientId(bundle: unknown): string | undefined {
  if (typeof bundle !== 'object' || bundle === null || !('entry' in bundle)) return undefined;
  const { entry } = bundle;
  if (!Array.isArray(entry)) return undefined;
  for (const item of entry as unknown[]) {
    if (typeof item !== 'object' || item === null || !('resource' in item)) continue;
    const { resource } = item;
    if (
      typeof resource === 'object' &&
      resource !== null &&
      'resourceType' in resource &&
      resource.resourceType === 'Patient' &&
      'id' in resource &&
      typeof resource.id === 'string'
    ) {
      return resource.id;
    }
  }
  return undefined;
}

/**
 * Where the consultation's case is, once the engine opened it: a direct
 * link (in a busy inbox it may sit far down the list). Before that, what
 * makes it open.
 */
function PatientCases({ patientId }: { readonly patientId: string }): ReactNode {
  const cases = useCases({ view: 'all', patient: patientId, limit: 10 });
  const items = (cases.data?.items ?? []).filter((item) =>
    (ACTIVE_CASE_STATUSES as readonly string[]).includes(item.status),
  );
  if (cases.isPending) return null;
  if (items.length === 0) {
    return (
      <p className="flex gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-muted">
        <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Aún no hay un caso abierto para este paciente: se abre cuando una expectativa vence sin
        cumplirse. Adelanta el reloj para verlo.
      </p>
    );
  }
  return (
    <section
      aria-labelledby="patient-cases-title"
      className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary-soft/40 p-3"
    >
      <h3 id="patient-cases-title" className="text-sm font-semibold text-fg">
        {items.length === 1
          ? 'El motor abrió un caso para este paciente'
          : `El motor abrió ${String(items.length)} casos para este paciente`}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg">
              <StatusBadge status={item.status} />
              {item.reasons[0]?.label ?? item.patient.name}
            </span>
            <Link
              to={`/bandeja/${item.id}?buscar=${encodeURIComponent(item.patient.name)}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              Ver caso
              <span className="sr-only"> de {item.patient.name}</span>
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ExtractionResult({
  result,
  noteText,
}: {
  readonly result: DemoConsultationResponse;
  readonly noteText: string;
}): ReactNode {
  const { extraction, expectationsCreated } = result;
  const patientId = consultationPatientId(result.bundle);
  // The fake provider (`fake-*` models) reads with rules, not with a model.
  const simulated = /^fake/i.test(extraction.model);
  return (
    <Card className="flex flex-col gap-5 p-5" aria-labelledby="extraction-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="extraction-title"
            className="flex items-center gap-2 text-base font-semibold text-fg"
          >
            <Sparkles className="size-4 text-layer-plan" aria-hidden="true" />
            {simulated
              ? SIMULATED_READER_LABEL
              : `Lectura de ${modelDisplayName(extraction.model)}`}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {simulated
              ? 'Lo que las reglas de la demostración entendieron de la nota (ningún modelo de IA la leyó), con la cita exacta de cada dato.'
              : 'Lo que el modelo entendió de la nota, con la cita exacta de cada dato.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="neutral" icon={<Sparkles className="size-3" aria-hidden="true" />}>
            <code className="font-mono">{extraction.model}</code>
          </Badge>
          <Badge tone="neutral" icon={<Timer className="size-3" aria-hidden="true" />}>
            {formatMs(extraction.latencyMs)}
          </Badge>
          <Badge tone="neutral" icon={<Wallet className="size-3" aria-hidden="true" />}>
            {formatUsd(extraction.costUsd)}
          </Badge>
        </div>
      </div>

      {extraction.hasPlan ? null : (
        <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft/50 px-3 py-2.5 text-sm text-fg">
          <FileWarning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            <strong className="font-semibold">Nota sin plan de seguimiento.</strong>{' '}
            <span className="text-muted">
              Se registró como hallazgo de calidad. El seguimiento queda a cargo de la frecuencia
              habitual y del protocolo.
            </span>
          </span>
        </p>
      )}

      <AnnotatedNote noteText={noteText} extraction={extraction} />

      <section aria-labelledby="plan-items-title" className="flex flex-col gap-2">
        <SectionTitle id="plan-items-title" count={extraction.planItems.length}>
          Plan del médico
        </SectionTitle>
        {extraction.planItems.length === 0 ? (
          <p className="text-sm text-muted">La nota no indica próximos pasos.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {extraction.planItems.map((item) => (
              <li
                key={`${item.kind}-${item.evidenceQuote}`}
                className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <Stethoscope className="size-4 text-layer-plan" aria-hidden="true" />
                    {/* The model's own description is a short English phrase (prompt): the kind reads in Spanish. */}
                    {PLAN_KIND_LABELS[item.kind]}
                  </span>
                  <span className="text-xs text-muted">
                    Antes del {formatDate(item.dueAt)} · {formatPercent(item.confidence)} de
                    confianza
                  </span>
                </div>
                <q className="text-sm text-muted">
                  <mark className="evidence-mark">{item.evidenceQuote}</mark>
                </q>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="conditions-found-title" className="flex flex-col gap-2">
          <SectionTitle id="conditions-found-title" count={extraction.conditions.length}>
            Condiciones
          </SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {extraction.conditions.map((condition) => (
              <li
                key={condition.code.code}
                className="rounded-lg border border-border p-2.5 text-sm"
              >
                <p className="font-medium text-fg">
                  {condition.code.display ?? condition.code.code}{' '}
                  <code className="font-mono text-xs text-muted">{condition.code.code}</code>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  Probable · {formatPercent(condition.confidence)} · «{condition.evidenceQuote}»
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="medications-found-title" className="flex flex-col gap-2">
          <SectionTitle id="medications-found-title" count={extraction.medications.length}>
            Medicamentos
          </SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {extraction.medications.map((medication) => (
              <li
                key={medication.text}
                className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-sm text-fg"
              >
                <Pill className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden="true" />
                <span>
                  {medication.text}
                  {medication.durationDays ? (
                    <span className="text-xs text-muted"> · {medication.durationDays} días</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {patientId ? <PatientCases patientId={patientId} /> : null}

      <section aria-labelledby="expectations-created-title" className="flex flex-col gap-2">
        <SectionTitle id="expectations-created-title" count={expectationsCreated.length}>
          Expectativas creadas
        </SectionTitle>
        <p className="text-xs text-muted">
          Lo que el motor espera que ocurra. Si una fecha pasa sin que ocurra, se abre un caso en la
          bandeja.
        </p>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {expectationsCreated.map((expectation) => (
            <li
              key={expectation.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
            >
              <span className="flex flex-wrap items-center gap-2 text-sm text-fg">
                <LayerChip layer={expectation.layer} />
                {expectation.label}
              </span>
              <span className="text-xs text-muted">Antes del {formatDate(expectation.dueAt)}</span>
            </li>
          ))}
        </ul>
      </section>

      <details className="rounded-lg border border-border text-sm">
        <summary className="cursor-pointer px-3 py-2 font-medium text-muted hover:text-fg">
          Ver el Bundle FHIR que recibió el motor
        </summary>
        {/* Focusable and named so a keyboard user can scroll it (axe scrollable-region-focusable). */}
        <pre
          role="region"
          aria-label="Bundle FHIR en JSON"
          tabIndex={0}
          className="max-h-72 overflow-auto border-t border-border bg-surface-2 p-3 font-mono text-xs text-fg"
        >
          {JSON.stringify(result.bundle, null, 2)}
        </pre>
      </details>
    </Card>
  );
}

export function ExtractionPlaceholder({ pending }: { readonly pending: boolean }): ReactNode {
  return (
    <Card className="flex flex-col gap-4 p-5" aria-busy={pending || undefined}>
      <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
        <Sparkles className="size-4 text-layer-plan" aria-hidden="true" />
        Lectura de la nota
      </h2>
      {pending ? (
        <div className="flex flex-col gap-3" aria-label="Leyendo la nota">
          <div className="skeleton h-28 w-full" />
          <div className="skeleton h-14 w-full" />
          <div className="skeleton h-14 w-4/5" />
        </div>
      ) : (
        <p className="text-sm text-muted">
          Guarda una consulta para ver qué se entiende de la nota: el plan del médico con su cita
          textual, las condiciones probables y las expectativas que crea el motor.
        </p>
      )}
    </Card>
  );
}
