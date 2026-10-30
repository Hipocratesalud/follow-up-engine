import {
  buildDossier,
  type ClinicalEvent,
  type ClinicalFinding,
  type ClinicalReviewRun,
  type ClinicId,
  detectSignals,
  type FindingCategory,
  findingDedupKey,
  type FindingText,
  findingTextIn,
  observationComponents,
  type PatientId,
  REVIEWER_COPY,
  type ReviewDossier,
  reviewerCopy,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type {
  CitationView,
  FindingView,
  ReviewRunView,
  TrendView,
} from '../http/reviewer-schemas.ts';
import { patientSummary } from './fhir-display.ts';
import type { ApiMessages } from '../i18n/index.ts';
import { icd10Label } from './terminology.ts';

const TREND_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  'lab_trend',
  'vital_trend',
  'abnormal_result_no_followup',
  'drug_condition_conflict',
]);

/**
 * A result's canonical line in the reader's language: "Creatinine: 1.75
 * mg/dL" reads "Creatinina: 1.75 mg/dL" in Spanish. The line is the engine's
 * own rendering of a structured value (the label of any locale, then the
 * value as recorded), not a document's words; a note's quote never changes.
 */
export function localizedResultLine(quote: string, locale: string): string {
  const labels = Object.values(REVIEWER_COPY)
    .flatMap((copy) => Object.entries(copy.measurements))
    .sort((left, right) => right[1].length - left[1].length);
  const match = labels.find(([, label]) => quote.startsWith(`${label}: `));
  if (match === undefined) return quote;
  const [key, label] = match;
  const target = reviewerCopy(locale).measurements[key] ?? label;
  return `${target}${quote.slice(label.length)}`;
}

function stringField(resource: Record<string, unknown> | undefined, field: string) {
  const value = resource?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

interface PatientContext {
  readonly summary: FindingView['patient'];
  readonly dossier: ReviewDossier;
  readonly labels: ReadonlyMap<string, string>;
}

/**
 * Turns findings into the inbox's views: the patient's name (from the
 * stored Patient resource; findings themselves carry ids only), each
 * citation with its document's title and, for a note, its full text (the
 * UI highlights the quote inside it), the series a trend cites, and what
 * covers it. One instance per request: patient context is cached.
 */
export class FindingPresenter {
  readonly #runtime: EngineRuntime;
  readonly #clinicId: ClinicId;
  readonly #patients = new Map<string, Promise<PatientContext>>();
  readonly #rendered = new Map<string, Promise<ReadonlyMap<string, FindingText>>>();
  readonly #t: ApiMessages;

  constructor(runtime: EngineRuntime, clinicId: ClinicId, t: ApiMessages) {
    this.#runtime = runtime;
    this.#clinicId = clinicId;
    this.#t = t;
  }

  #context(patientId: PatientId): Promise<PatientContext> {
    const cached = this.#patients.get(patientId);
    if (cached !== undefined) return cached;
    const loading = this.#load(patientId);
    this.#patients.set(patientId, loading);
    return loading;
  }

  /** Numeric components of the panels among the events (a blood pressure's systolic and diastolic). */
  async #components(
    events: readonly ClinicalEvent[],
  ): Promise<Map<string, ReturnType<typeof observationComponents>>> {
    const components = new Map<string, ReturnType<typeof observationComponents>>();
    for (const event of events) {
      if (event.type === 'result.received' && event.value === undefined) {
        const stored = await this.#runtime.storage.stores.clinicalRecords.getResource(
          this.#clinicId,
          event.source,
        );
        if (stored !== undefined) {
          components.set(
            `${event.source.resourceType}/${event.source.id}`,
            observationComponents(stored.resource),
          );
        }
      }
    }
    return components;
  }

  async #load(patientId: PatientId): Promise<PatientContext> {
    const { stores } = this.#runtime.storage;
    const clinicId = this.#clinicId;
    const now = this.#runtime.clock.now();
    const [patient, events, expectations] = await Promise.all([
      stores.clinicalRecords.getResource(clinicId, { resourceType: 'Patient', id: patientId }),
      stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
        types: [
          'note.received',
          'result.received',
          'medication.prescribed',
          'condition.recorded',
          // "Before the visit": the next booked appointment (nextAppointmentAt).
          'appointment.booked',
          'appointment.cancelled',
        ],
      }),
      stores.expectations.listByPatient(clinicId, patientId),
    ]);
    const components = await this.#components(events);
    const dossier = buildDossier(
      {
        clinicId,
        patientId,
        now,
        events,
        conditions: [],
        liveExpectations: [],
        activeCases: [],
        components,
      },
      // Document titles and result lines in the request's language.
      this.#t.locale,
    );
    const summary = patientSummary(this.#t, patientId, patient?.resource, now);
    return {
      summary: {
        id: summary.id,
        name: summary.name,
        ...(summary.age === undefined ? {} : { age: summary.age }),
        ...(summary.sex === undefined ? {} : { sex: summary.sex }),
      },
      dossier,
      labels: new Map(
        expectations.map((expectation) => [
          expectation.id,
          this.#t.rules[expectation.reason.code]?.reason ?? expectation.reason.label,
        ]),
      ),
    };
  }

  /**
   * A finding's words in the reader's language. Findings store every locale
   * (`texts`); one stored before that, from a detector, is rendered again
   * from the same templates over the patient's record and matched by its
   * dedup key. Else (a model's own finding, a record that changed) the
   * stored text.
   */
  async #text(finding: ClinicalFinding): Promise<FindingText> {
    const locale = this.#t.locale;
    if (finding.texts?.[locale] !== undefined || finding.origin === 'added') {
      return findingTextIn(finding, locale);
    }
    const rendered = await this.#renderedSignals(finding.patientId);
    return rendered.get(finding.dedupKey) ?? findingTextIn(finding, locale);
  }

  /** The detectors over the patient's whole record, in the reader's language, by dedup key. */
  #renderedSignals(patientId: PatientId): Promise<ReadonlyMap<string, FindingText>> {
    const cached = this.#rendered.get(patientId);
    if (cached !== undefined) return cached;
    const loading = (async () => {
      const { stores } = this.#runtime.storage;
      const clinicId = this.#clinicId;
      const [patient, events, conditions] = await Promise.all([
        stores.clinicalRecords.getResource(clinicId, { resourceType: 'Patient', id: patientId }),
        stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
        stores.conditions.listByPatient(clinicId, patientId),
      ]);
      const birthDate = stringField(patient?.resource, 'birthDate');
      const gender = stringField(patient?.resource, 'gender');
      const dossier = buildDossier(
        {
          clinicId,
          patientId,
          now: this.#runtime.clock.now(),
          ...(birthDate === undefined ? {} : { birthDate }),
          ...(gender === undefined ? {} : { gender }),
          events,
          conditions,
          liveExpectations: [],
          activeCases: [],
          components: await this.#components(events),
        },
        this.#t.locale,
      );
      const byKey = new Map<string, FindingText>();
      for (const signal of detectSignals(dossier, () => true)) {
        const citations = signal.evidence.flatMap((item) => {
          const document = dossier.documents.get(item.handle);
          return document === undefined
            ? []
            : [
                {
                  source: document.source,
                  kind: document.kind,
                  quote: item.quote,
                  occurredAt: document.occurredAt,
                },
              ];
        });
        const key = findingDedupKey(signal.category, citations, signal.rule);
        byKey.set(key, {
          summary: signal.summary,
          rationale: signal.rationale,
          suggestion: signal.suggestion,
        });
      }
      return byKey;
    })();
    this.#rendered.set(patientId, loading);
    return loading;
  }

  async view(finding: ClinicalFinding): Promise<FindingView> {
    const context = await this.#context(finding.patientId);
    const text = await this.#text(finding);
    const citations: CitationView[] = finding.citations.map((citation) => {
      const document = context.dossier.documents.get(
        context.dossier.handleOf(citation.source) ?? '',
      );
      return {
        docId: `${citation.source.resourceType}/${citation.source.id}`,
        kind: citation.kind,
        quote:
          citation.kind === 'result'
            ? localizedResultLine(citation.quote, this.#t.locale)
            : citation.quote,
        date: citation.occurredAt.toISOString(),
        title:
          citation.kind === 'condition'
            ? // The clinic's name of the diagnosis; the quote stays the host's own text.
              icd10Label(this.#t, citation.quote.split(' ')[0] ?? '', document?.title)
            : (document?.title ??
              (citation.kind === 'note'
                ? this.#t.reviewer.noteFallbackTitle
                : this.#t.reviewer.recordFallbackTitle)),
        ...(document?.specialty === undefined ? {} : { specialty: document.specialty }),
        ...(citation.kind === 'note' && document !== undefined ? { text: document.text } : {}),
      };
    });
    const trend = TREND_CATEGORIES.has(finding.category)
      ? this.#trend(finding, context)
      : undefined;
    const copy = this.#t.reviewer.categories[finding.category];
    return {
      id: finding.id,
      patient: context.summary,
      category: finding.category,
      categoryLabel: copy.label,
      severity: finding.severity,
      mode: finding.mode,
      status: finding.status,
      summary: text.summary,
      rationale: text.rationale,
      suggestion: text.suggestion,
      alreadyCovered: finding.alreadyCovered,
      coveredBy: finding.coveredBy.map((coverage) => ({
        ...coverage,
        label:
          coverage.kind === 'expectation'
            ? (context.labels.get(coverage.id) ?? coverage.code)
            : this.#t.reviewer.activeCase,
      })),
      citations,
      ...(trend === undefined ? {} : { trend }),
      ...(finding.specialty === undefined ? {} : { specialty: finding.specialty }),
      origin: finding.origin,
      modelId: finding.modelId,
      promptVersion: finding.promptVersion,
      runId: finding.runId,
      createdAt: finding.createdAt.toISOString(),
      ...(finding.review === undefined
        ? {}
        : {
            review: {
              verdict: finding.review.verdict,
              ...(finding.review.reason === undefined ? {} : { reason: finding.review.reason }),
              reviewedBy: finding.review.reviewedBy,
              reviewedAt: finding.review.reviewedAt.toISOString(),
            },
          }),
    };
  }

  /** The patient's next booked appointment, when one is on record ("Before the visit"). */
  async nextAppointmentAt(patientId: PatientId): Promise<string | undefined> {
    const context = await this.#context(patientId);
    return context.dossier.upcomingAppointmentAt?.toISOString();
  }

  /** The whole series of the measurement the finding cites, cited points marked. */
  #trend(finding: ClinicalFinding, context: PatientContext): TrendView | undefined {
    const handles = finding.citations.flatMap((citation) => {
      const handle = context.dossier.handleOf(citation.source);
      return handle === undefined ? [] : [handle];
    });
    const measurement = handles
      .map((handle) => context.dossier.documents.get(handle)?.measurement)
      .find((key) => key !== undefined);
    const series = context.dossier.trends.find((trend) => trend.test === measurement);
    if (series === undefined) return undefined;
    const cited = new Set(handles);
    return {
      test: series.test,
      label: series.label,
      unit: series.unit,
      ...(series.low === undefined ? {} : { low: series.low }),
      ...(series.high === undefined ? {} : { high: series.high }),
      points: series.points.map((point) => {
        const source = context.dossier.documents.get(point.handle)?.source;
        return {
          docId: source === undefined ? point.handle : `${source.resourceType}/${source.id}`,
          date: point.at.toISOString(),
          value: point.value,
          cited: cited.has(point.handle),
        };
      }),
    };
  }
}

export function runView(run: ClinicalReviewRun): ReviewRunView {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    stopReason: run.stopReason,
    signalsCount: run.signalsCount,
    findingsCount: run.findingsCount,
    discardedCount: run.discardedCount,
    duplicateCount: run.duplicateCount,
    discarded: run.discarded.map((item) => ({ reason: item.reason, count: item.count })),
    steps: run.steps,
    toolCalls: run.toolCalls,
    trace: run.trace.map((step) => ({ ...step, arguments: { ...step.arguments } })),
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: run.costUsd,
    modelId: run.modelId,
    promptVersion: run.promptVersion,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
  };
}
