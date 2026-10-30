import {
  buildDossier,
  type ClinicalFinding,
  type ClinicalReviewRun,
  type ClinicId,
  type FindingCategory,
  observationComponents,
  type PatientId,
  type ReviewDossier,
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
    const components = new Map<string, ReturnType<typeof observationComponents>>();
    for (const event of events) {
      if (event.type === 'result.received' && event.value === undefined) {
        const stored = await stores.clinicalRecords.getResource(clinicId, event.source);
        if (stored !== undefined) {
          components.set(
            `${event.source.resourceType}/${event.source.id}`,
            observationComponents(stored.resource),
          );
        }
      }
    }
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

  async view(finding: ClinicalFinding): Promise<FindingView> {
    const context = await this.#context(finding.patientId);
    const citations: CitationView[] = finding.citations.map((citation) => {
      const document = context.dossier.documents.get(
        context.dossier.handleOf(citation.source) ?? '',
      );
      return {
        docId: `${citation.source.resourceType}/${citation.source.id}`,
        kind: citation.kind,
        quote: citation.quote,
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
      summary: finding.summary,
      rationale: finding.rationale,
      suggestion: finding.suggestion,
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
