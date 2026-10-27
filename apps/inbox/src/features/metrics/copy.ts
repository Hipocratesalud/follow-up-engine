/**
 * Every user-facing string of the "Metrics" view and of the rule-version
 * line on a case reason (HIP-141), in English (default) and Spanish, keyed
 * the same way so the i18n catalog loader can plug both in. Components never
 * hold copy literals.
 */
import type { MetricsDismissReason, OriginKey } from './contract.ts';

export const METRICS_LOCALES = ['en', 'es'] as const;
export type MetricsLocale = (typeof METRICS_LOCALES)[number];
export const DEFAULT_METRICS_LOCALE: MetricsLocale = 'en';

export const METRICS_PRESETS = [7, 30, 90, 365] as const;
export type MetricsPreset = (typeof METRICS_PRESETS)[number];

export interface MetricsCopy {
  readonly nav: { readonly label: string };
  readonly title: string;
  readonly subtitle: string;
  readonly periodLegend: string;
  readonly preset: (days: MetricsPreset) => string;
  readonly periodRange: (from: string, to: string) => string;
  readonly loading: string;
  readonly errorTitle: string;
  readonly empty: { readonly title: string; readonly body: string };
  readonly tiles: {
    readonly opened: string;
    readonly openedHint: (live: number, backfill: number) => string;
    readonly booked: string;
    readonly bookedHint: (rate: string) => string;
    readonly attended: string;
    readonly attendedHint: (rate: string) => string;
    readonly firstAction: string;
    readonly firstActionHint: (measured: number, pending: number) => string;
    readonly useful: string;
    readonly usefulHint: (count: number) => string;
    readonly costPerCase: string;
    readonly costPerCaseHint: (total: string) => string;
    readonly lost: string;
    readonly lostHint: (dismissed: number) => string;
    readonly recovered: string;
    readonly recoveredHint: (cases: number) => string;
    readonly none: string;
  };
  readonly funnel: {
    readonly title: string;
    readonly description: string;
    readonly opened: string;
    readonly booked: string;
    readonly attended: string;
    readonly resolvedByBooking: string;
    readonly origin: Readonly<Record<OriginKey, string>>;
    readonly summary: (stage: string, total: number, parts: string) => string;
  };
  readonly timing: {
    readonly title: string;
    readonly description: string;
    readonly median: string;
    readonly p75: string;
    readonly p90: string;
    readonly none: string;
    readonly summary: (median: string, p75: string, p90: string) => string;
  };
  readonly dismissals: {
    readonly title: string;
    readonly description: (total: number) => string;
    readonly none: string;
    readonly reasons: Readonly<Record<MetricsDismissReason, string>>;
  };
  readonly extraction: {
    readonly title: string;
    readonly description: string;
    readonly conditions: string;
    readonly confirmed: string;
    readonly rejected: string;
    readonly pending: string;
    readonly corrections: (rate: string) => string;
    readonly planItems: string;
    readonly planItemsNone: string;
    readonly planItemsCounts: (confirmed: number, corrected: number, rejected: number) => string;
  };
  readonly ai: {
    readonly title: string;
    readonly description: string;
    readonly tasks: Readonly<Record<string, string>>;
    readonly calls: (count: number) => string;
    readonly tokens: (count: string) => string;
    readonly perReviewRun: (cost: string, runs: number) => string;
    readonly attributed: (cost: string, cases: number) => string;
    readonly none: string;
  };
  readonly ruleVersion: {
    readonly rule: string;
    readonly protocol: string;
    readonly version: (version: string) => string;
  };
  readonly hours: (hours: number) => string;
}

const EN: MetricsCopy = {
  nav: { label: 'Metrics' },
  title: 'Metrics',
  subtitle:
    'What happened to the cases that reached the inbox in the period: how many ended in a visit, how fast the team acted, and what the AI cost.',
  periodLegend: 'Period',
  preset: (days) => (days === 365 ? 'Last year' : `Last ${String(days)} days`),
  periodRange: (from, to) => `${from} – ${to}`,
  loading: 'Loading metrics',
  errorTitle: 'We could not load the metrics',
  empty: {
    title: 'No cases in this period',
    body: 'Pick a longer period, or come back once cases reach the inbox.',
  },
  tiles: {
    opened: 'Cases opened',
    openedHint: (live, backfill) => `${String(live)} live · ${String(backfill)} from history`,
    booked: 'Ended in a booking',
    bookedHint: (rate) => `${rate} of cases`,
    attended: 'Visit attended',
    attendedHint: (rate) => `${rate} of bookings`,
    firstAction: 'Median time to first action',
    firstActionHint: (measured, pending) =>
      `${String(measured)} acted on · ${String(pending)} still waiting`,
    useful: 'Useful, per the team',
    usefulHint: (count) => `of ${String(count)} ${count === 1 ? 'rated case' : 'rated cases'}`,
    costPerCase: 'AI cost per case',
    costPerCaseHint: (total) => `${total} in the period`,
    lost: 'Lost to follow-up',
    lostHint: (dismissed) => `${String(dismissed)} dismissed by the team`,
    recovered: 'Patients recovered from history',
    recoveredHint: (cases) => `${String(cases)} ${cases === 1 ? 'case' : 'cases'} resolved`,
    none: '—',
  },
  funnel: {
    title: 'From case to visit',
    description:
      'Cases opened in the period, the ones that got a booking and the ones whose visit took place. Attributed bookings came from working the case or from a contact request; organic ones did not.',
    opened: 'Opened',
    booked: 'Booked',
    attended: 'Attended',
    resolvedByBooking: 'Resolved by the booking',
    origin: {
      followUpCase: 'From the case',
      patientContact: 'After a contact request',
      organic: 'Organic',
    },
    summary: (stage, total, parts) => `${stage}: ${String(total)}${parts ? ` (${parts})` : ''}`,
  },
  timing: {
    title: 'Time to first action',
    description:
      'From the case reaching the inbox to the first thing the team did or the first contact request.',
    median: 'Median',
    p75: '75th percentile',
    p90: '90th percentile',
    none: 'No case was acted on in this period yet.',
    summary: (median, p75, p90) =>
      `Median ${median}, 75th percentile ${p75}, 90th percentile ${p90}`,
  },
  dismissals: {
    title: 'Dismissals by reason',
    description: (total) =>
      `${String(total)} ${total === 1 ? 'case' : 'cases'} dismissed by the team. A reason that repeats points at the rule to tune.`,
    none: 'No case of the period was dismissed.',
    reasons: {
      handled_elsewhere: 'Handled elsewhere',
      already_done: 'Already done',
      not_applicable_to_patient: 'Not for this patient',
      wrong_diagnosis: 'Wrong diagnosis',
      wrong_interval: 'Wrong interval',
      other: 'Other',
    },
  },
  extraction: {
    title: 'What the doctors corrected',
    description:
      'Conditions read from notes that a clinician confirmed or rejected in the period, and corrections to plan items.',
    conditions: 'Conditions read from notes',
    confirmed: 'Confirmed',
    rejected: 'Rejected',
    pending: 'Waiting for review',
    corrections: (rate) => `${rate} rejected`,
    planItems: 'Plan items',
    planItemsNone: 'No plan item was reviewed in this period.',
    planItemsCounts: (confirmed, corrected, rejected) =>
      `${String(confirmed)} confirmed · ${String(corrected)} corrected · ${String(rejected)} rejected`,
  },
  ai: {
    title: 'AI cost',
    description:
      'Every model call of the clinic in the period, by task. Reading a note is charged to the cases its plan opened.',
    tasks: {
      note_extraction: 'Reading notes',
      clinical_review: 'Clinical review',
    },
    calls: (count) => `${String(count)} ${count === 1 ? 'call' : 'calls'}`,
    tokens: (count) => `${count} tokens`,
    perReviewRun: (cost, runs) =>
      `${cost} per review (${String(runs)} ${runs === 1 ? 'review' : 'reviews'})`,
    attributed: (cost, cases) =>
      `${cost} of note reading behind ${String(cases)} ${cases === 1 ? 'case' : 'cases'}`,
    none: 'No model call in this period.',
  },
  ruleVersion: {
    rule: 'Rule',
    protocol: 'Protocol',
    version: (version) => `version ${version}`,
  },
  hours: (hours) =>
    hours < 1
      ? `${String(Math.round(hours * 60))} min`
      : hours < 48
        ? `${hours.toFixed(1)} h`
        : `${(hours / 24).toFixed(1)} d`,
};

const ES: MetricsCopy = {
  nav: { label: 'Métricas' },
  title: 'Métricas',
  subtitle:
    'Qué pasó con los casos que llegaron a la bandeja en el período: cuántos terminaron en una consulta, qué tan rápido actuó el equipo y cuánto costó la IA.',
  periodLegend: 'Período',
  preset: (days) => (days === 365 ? 'Último año' : `Últimos ${String(days)} días`),
  periodRange: (from, to) => `${from} – ${to}`,
  loading: 'Cargando métricas',
  errorTitle: 'No pudimos cargar las métricas',
  empty: {
    title: 'No hay casos en este período',
    body: 'Elige un período más largo, o vuelve cuando lleguen casos a la bandeja.',
  },
  tiles: {
    opened: 'Casos abiertos',
    openedHint: (live, backfill) => `${String(live)} en vivo · ${String(backfill)} del historial`,
    booked: 'Terminaron en una cita',
    bookedHint: (rate) => `${rate} de los casos`,
    attended: 'Consulta realizada',
    attendedHint: (rate) => `${rate} de las citas`,
    firstAction: 'Mediana hasta la primera acción',
    firstActionHint: (measured, pending) =>
      `${String(measured)} atendidos · ${String(pending)} en espera`,
    useful: 'Útiles según el equipo',
    usefulHint: (count) =>
      `de ${String(count)} ${count === 1 ? 'caso calificado' : 'casos calificados'}`,
    costPerCase: 'Costo de IA por caso',
    costPerCaseHint: (total) => `${total} en el período`,
    lost: 'Perdidos en seguimiento',
    lostHint: (dismissed) => `${String(dismissed)} descartados por el equipo`,
    recovered: 'Pacientes recuperados del historial',
    recoveredHint: (cases) =>
      `${String(cases)} ${cases === 1 ? 'caso resuelto' : 'casos resueltos'}`,
    none: '—',
  },
  funnel: {
    title: 'Del caso a la consulta',
    description:
      'Casos abiertos en el período, los que consiguieron una cita y aquellos cuya consulta se realizó. Las citas atribuidas salieron de trabajar el caso o de un pedido de contacto; las orgánicas, no.',
    opened: 'Abiertos',
    booked: 'Con cita',
    attended: 'Con consulta',
    resolvedByBooking: 'Resueltos por la cita',
    origin: {
      followUpCase: 'Desde el caso',
      patientContact: 'Tras un pedido de contacto',
      organic: 'Orgánica',
    },
    summary: (stage, total, parts) => `${stage}: ${String(total)}${parts ? ` (${parts})` : ''}`,
  },
  timing: {
    title: 'Tiempo hasta la primera acción',
    description:
      'Desde que el caso llega a la bandeja hasta lo primero que hizo el equipo o el primer pedido de contacto.',
    median: 'Mediana',
    p75: 'Percentil 75',
    p90: 'Percentil 90',
    none: 'Todavía no se actuó sobre ningún caso del período.',
    summary: (median, p75, p90) => `Mediana ${median}, percentil 75 ${p75}, percentil 90 ${p90}`,
  },
  dismissals: {
    title: 'Descartes por motivo',
    description: (total) =>
      `${String(total)} ${total === 1 ? 'caso descartado' : 'casos descartados'} por el equipo. Un motivo que se repite señala la regla a ajustar.`,
    none: 'No se descartó ningún caso del período.',
    reasons: {
      handled_elsewhere: 'Atendido en otro lugar',
      already_done: 'Ya se hizo',
      not_applicable_to_patient: 'No aplica a este paciente',
      wrong_diagnosis: 'Diagnóstico equivocado',
      wrong_interval: 'Plazo equivocado',
      other: 'Otro',
    },
  },
  extraction: {
    title: 'Lo que corrigieron los médicos',
    description:
      'Condiciones leídas de las notas que un clínico confirmó o rechazó en el período, y correcciones a ítems del plan.',
    conditions: 'Condiciones leídas de notas',
    confirmed: 'Confirmadas',
    rejected: 'Rechazadas',
    pending: 'Por revisar',
    corrections: (rate) => `${rate} rechazadas`,
    planItems: 'Ítems del plan',
    planItemsNone: 'No se revisó ningún ítem del plan en este período.',
    planItemsCounts: (confirmed, corrected, rejected) =>
      `${String(confirmed)} confirmados · ${String(corrected)} corregidos · ${String(rejected)} rechazados`,
  },
  ai: {
    title: 'Costo de IA',
    description:
      'Cada llamada a un modelo del consultorio en el período, por tarea. Leer una nota se carga a los casos que abrió su plan.',
    tasks: {
      note_extraction: 'Lectura de notas',
      clinical_review: 'Revisión clínica',
    },
    calls: (count) => `${String(count)} ${count === 1 ? 'llamada' : 'llamadas'}`,
    tokens: (count) => `${count} tokens`,
    perReviewRun: (cost, runs) =>
      `${cost} por revisión (${String(runs)} ${runs === 1 ? 'revisión' : 'revisiones'})`,
    attributed: (cost, cases) =>
      `${cost} de lectura de notas detrás de ${String(cases)} ${cases === 1 ? 'caso' : 'casos'}`,
    none: 'Ninguna llamada a un modelo en este período.',
  },
  ruleVersion: {
    rule: 'Regla',
    protocol: 'Protocolo',
    version: (version) => `versión ${version}`,
  },
  hours: (hours) =>
    hours < 1
      ? `${String(Math.round(hours * 60))} min`
      : hours < 48
        ? `${hours.toFixed(1).replace('.', ',')} h`
        : `${(hours / 24).toFixed(1).replace('.', ',')} d`,
};

export const METRICS_COPY: Readonly<Record<MetricsLocale, MetricsCopy>> = { en: EN, es: ES };

/** The copy of a locale (English by default). */
export function metricsCopy(locale: MetricsLocale = DEFAULT_METRICS_LOCALE): MetricsCopy {
  return METRICS_COPY[locale];
}

const NUMBER_LOCALES: Readonly<Record<MetricsLocale, string>> = { en: 'en-US', es: 'es' };

/** Number formatters of a locale. */
export function metricsFormat(locale: MetricsLocale = DEFAULT_METRICS_LOCALE): {
  readonly percent: (ratio: number | undefined) => string;
  readonly usd: (amount: number | undefined) => string;
  readonly integer: (value: number) => string;
  readonly date: (iso: string) => string;
} {
  const tag = NUMBER_LOCALES[locale];
  const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
  const usd = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const integer = new Intl.NumberFormat(tag);
  const date = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const none = METRICS_COPY[locale].tiles.none;
  return {
    percent: (ratio) => (ratio === undefined ? none : percent.format(ratio)),
    usd: (amount) => (amount === undefined ? none : usd.format(amount)),
    integer: (value) => integer.format(value),
    date: (iso) => date.format(new Date(iso)),
  };
}
