import {
  type BeforeVisitView,
  FINDING_CATEGORIES,
  FINDING_VERDICTS,
  type FindingCategory,
  type FindingDetail,
  type FindingFlagUpdate,
  type FindingFlagView,
  type FindingListQuery,
  type FindingMode,
  type FindingPage,
  type FindingReviewRequest,
  type FindingStatus,
  type FindingView,
  type ReviewMetrics,
  type ReviewRunView,
} from '../api/reviewer-contract.ts';
import { LOCALES, type Locale, messagesFor } from '../i18n/index.ts';
import { mockApiCopy } from './api-copy.ts';

/**
 * The clinical reviewer side of the mock API: a handful of synthetic
 * findings (every name, note and value invented) and the category flags.
 */

class ReviewerMockError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: readonly { path: string; message: string }[];

  constructor(
    status: number,
    code: string,
    message: string,
    fields: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export { ReviewerMockError };

const DAY_MS = 86_400_000;

/** Stands for the seeded validator of the live category, named in the request's language. */
const SEEDED_VALIDATOR = 'seeded-validator';

const HEADACHE_NOTES = [
  'Paciente de 45 años que consulta por control de presión arterial. Refiere cefalea frontal vespertina de dos semanas. Alergias: niega. TA 124/80. Plan: paracetamol 500 mg si dolor, control en 3 meses.',
  'Control. Persiste cefalea, ahora casi diaria, que cede parcialmente con analgésicos. TA 126/82. Plan: continuar paracetamol, control en 3 meses.',
  'Acude nuevamente por cefalea que la despierta en la noche. Examen neurológico sin hallazgos. Plan: ibuprofeno 400 mg c/8h por 5 días, control en 2 meses.',
];

function run(id: string, startedAt: Date, trace: ReviewRunView['trace']): ReviewRunView {
  return {
    id,
    trigger: 'initial',
    status: 'completed',
    stopReason: 'submitted',
    signalsCount: 2,
    findingsCount: 2,
    discardedCount: 0,
    duplicateCount: 0,
    discarded: [],
    steps: trace.length,
    toolCalls: trace.length - 1,
    trace,
    inputTokens: 5_840,
    outputTokens: 610,
    costUsd: 0.0099,
    modelId: 'meta:muse-spark-1.3',
    promptVersion: 'clinical-review@1',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(startedAt.getTime() + 9_000).toISOString(),
  };
}

/**
 * The synthetic findings, written in `locale`. The engine writes a finding
 * in the clinic's language; the mock keeps both so either UI language reads
 * whole. Quotes and note text are clinical content: never translated.
 */
function seedFindings(now: Date, locale: Locale): { findings: FindingDetail[] } {
  const at = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
  const tr = (en: string, es: string): string => (locale === 'en' ? en : es);
  const CATEGORY_LABELS = messagesFor(locale).review.categories;
  const reviewedRun = run('run-mock-1', new Date(now.getTime() - DAY_MS), [
    {
      index: 1,
      tool: 'get_open_follow_ups',
      arguments: {},
      outcome: 'ok',
      summary: '2 expectations, 0 cases',
    },
    {
      index: 2,
      tool: 'get_lab_trend',
      arguments: { test: 'creatinine' },
      outcome: 'ok',
      summary: '4 points',
    },
    { index: 3, tool: 'get_medications', arguments: {}, outcome: 'ok', summary: '3 medications' },
    {
      index: 4,
      tool: 'submit_findings',
      arguments: { findings: 2 },
      outcome: 'ok',
      summary: '2 findings',
    },
  ]);
  const base = {
    mode: 'shadow' as FindingMode,
    status: 'open' as FindingStatus,
    alreadyCovered: false,
    coveredBy: [],
    origin: 'confirmed' as const,
    modelId: 'meta:muse-spark-1.3',
    promptVersion: 'clinical-review@1',
    runId: reviewedRun.id,
    run: reviewedRun,
    createdAt: at(1),
  };
  const maria = { id: 'pat-001', name: 'María Fernanda Ortiz', age: 58, sex: 'female' as const };
  const jose = { id: 'pat-002', name: 'José Luis Méndez', age: 64, sex: 'male' as const };
  const rafael = { id: 'pat-005', name: 'Rafael Contreras', age: 45, sex: 'male' as const };
  return {
    findings: [
      {
        ...base,
        id: 'cf-001',
        patient: maria,
        category: 'lab_trend',
        categoryLabel: CATEGORY_LABELS.lab_trend,
        severity: 'high',
        summary: tr(
          'Creatinine rising over the last 3 results (1.1 → 1.4 → 1.75 mg/dL) with no comment in the notes',
          'Creatinina en ascenso en los últimos 3 resultados (1.1 → 1.4 → 1.75 mg/dL) sin comentario en las notas',
        ),
        rationale: tr(
          '3 results in a row get worse (+59% in a year), the last one out of range, and no later note mentions it.',
          '3 resultados seguidos empeoran (+59 % en un año), el último fuera de rango, y ninguna nota posterior lo menciona.',
        ),
        suggestion: tr(
          'Consider assessing renal function and reviewing the drugs that depend on it (metformin, NSAIDs).',
          'Considera evaluar la función renal y revisar los fármacos que dependen de ella (metformina, AINE).',
        ),
        citations: [
          {
            docId: 'Observation/mock-cr-2',
            kind: 'result',
            quote: 'Creatinina: 1.1 mg/dL',
            date: at(360),
            title: tr('Creatinine', 'Creatinina'),
          },
          {
            docId: 'Observation/mock-cr-3',
            kind: 'result',
            quote: 'Creatinina: 1.4 mg/dL',
            date: at(180),
            title: tr('Creatinine', 'Creatinina'),
          },
          {
            docId: 'Observation/mock-cr-4',
            kind: 'result',
            quote: 'Creatinina: 1.75 mg/dL',
            date: at(40),
            title: tr('Creatinine', 'Creatinina'),
          },
        ],
        trend: {
          test: 'creatinine',
          label: tr('Creatinine', 'Creatinina'),
          unit: 'mg/dL',
          low: 0.5,
          high: 1.2,
          points: [
            { docId: 'Observation/mock-cr-1', date: at(540), value: 1.05, cited: false },
            { docId: 'Observation/mock-cr-2', date: at(360), value: 1.1, cited: true },
            { docId: 'Observation/mock-cr-3', date: at(180), value: 1.4, cited: true },
            { docId: 'Observation/mock-cr-4', date: at(40), value: 1.75, cited: true },
          ],
        },
        specialty: 'diabetology',
      },
      {
        ...base,
        id: 'cf-002',
        patient: jose,
        category: 'drug_interaction',
        categoryLabel: CATEGORY_LABELS.drug_interaction,
        severity: 'high',
        summary: tr(
          'Risky combination: Ibuprofen + Losartan + Hydrochlorothiazide',
          'Combinación de riesgo: Ibuprofeno + Losartán + Hidroclorotiazida',
        ),
        rationale: tr(
          'An NSAID with an ACE inhibitor/ARB and a diuretic ("triple whammy"): risk of acute kidney injury.',
          'AINE junto con IECA/ARA-II y diurético ("triple whammy"): riesgo de lesión renal aguda.',
        ),
        suggestion: tr(
          'Consider reviewing whether the NSAID is needed and checking renal function (creatinine, potassium).',
          'Considera revisar la necesidad del AINE y controlar la función renal (creatinina, potasio).',
        ),
        citations: [
          {
            docId: 'MedicationRequest/mock-mr-1',
            kind: 'medication',
            quote: 'Losartán 50 mg — 1 tab VO c/12h',
            date: at(400),
            title: 'Losartán 50 mg',
          },
          {
            docId: 'MedicationRequest/mock-mr-2',
            kind: 'medication',
            quote: 'Hidroclorotiazida 25 mg — 1 tab VO OD AM',
            date: at(400),
            title: 'Hidroclorotiazida 25 mg',
          },
          {
            docId: 'MedicationRequest/mock-mr-3',
            kind: 'medication',
            quote: 'Ibuprofeno 400 mg — 1 tab VO c/8h',
            date: at(60),
            title: 'Ibuprofeno 400 mg',
          },
        ],
        specialty: 'internal_medicine',
      },
      {
        ...base,
        id: 'cf-003',
        patient: rafael,
        category: 'unaddressed_symptom',
        categoryLabel: CATEGORY_LABELS.unaddressed_symptom,
        severity: 'medium',
        summary: tr(
          'Headache mentioned in 3 visits with no workup',
          'Cefalea mencionada en 3 consultas sin estudio',
        ),
        rationale: tr(
          'It shows up in 3 notes from the last year and none records a test or a referral for that symptom.',
          'Aparece en 3 notas del último año y ninguna registra un estudio o una derivación por ese síntoma.',
        ),
        suggestion: tr(
          'Consider a focused headache assessment (red flags, blood pressure).',
          'Considera una evaluación dirigida de la cefalea (signos de alarma, presión arterial).',
        ),
        citations: HEADACHE_NOTES.map((text, index) => {
          const quote =
            [
              'Refiere cefalea frontal vespertina de dos semanas',
              'Persiste cefalea, ahora casi diaria, que cede parcialmente con analgésicos',
              'Acude nuevamente por cefalea que la despierta en la noche',
            ][index] ?? '';
          return {
            docId: `DocumentReference/mock-doc-${String(index + 1)}`,
            kind: 'note' as const,
            quote,
            date: at(300 - index * 110),
            title: tr('Internal medicine note', 'Nota de medicina interna'),
            specialty: 'internal_medicine',
            text,
          };
        }),
        specialty: 'internal_medicine',
      },
      {
        ...base,
        id: 'cf-004',
        patient: maria,
        category: 'missing_screening',
        categoryLabel: CATEGORY_LABELS.missing_screening,
        severity: 'medium',
        alreadyCovered: true,
        coveredBy: [
          {
            kind: 'expectation',
            id: 'exp-mock-1',
            code: 'protocol_diabetes_fundus',
            label: tr('Yearly eye fundus exam due', 'Fondo de ojo anual pendiente'),
          },
        ],
        summary: tr(
          'Patient with diabetes and no eye fundus exam on record in the last year',
          'Paciente con diabetes sin fondo de ojo registrado en el último año',
        ),
        rationale: tr(
          'No note, order or result of a fundus exam in the last 12 months.',
          'No hay nota, orden ni resultado de fondo de ojo en los últimos 12 meses.',
        ),
        suggestion: tr(
          'Consider ordering a fundus exam (yearly diabetic retinopathy screening).',
          'Considera solicitar fondo de ojo (cribado anual de retinopatía diabética).',
        ),
        citations: [
          {
            docId: 'Condition/mock-cond-1',
            kind: 'condition',
            quote: 'E11.9 Diabetes mellitus tipo 2',
            date: at(700),
            title: 'Diabetes mellitus tipo 2',
          },
        ],
        specialty: 'diabetology',
      },
      {
        ...base,
        id: 'cf-005',
        patient: maria,
        mode: 'live',
        category: 'pre_visit_question',
        categoryLabel: CATEGORY_LABELS.pre_visit_question,
        severity: 'low',
        summary: tr(
          'Ask whether they have noticed tingling, burning or numbness in their feet.',
          'Pregunta si ha notado hormigueo, ardor o adormecimiento en los pies.',
        ),
        rationale: tr(
          'Patient with diabetes and no recent record of peripheral neuropathy symptoms in the notes.',
          'Paciente con diabetes sin registro reciente de síntomas de neuropatía periférica en las notas.',
        ),
        suggestion: tr(
          'Include it at the next visit; no action needed before.',
          'Inclúyela en la próxima consulta; no requiere acción antes.',
        ),
        citations: [
          {
            docId: 'Condition/mock-cond-1',
            kind: 'condition',
            quote: 'E11.9 Diabetes mellitus tipo 2',
            date: at(700),
            title: 'Diabetes mellitus tipo 2',
          },
        ],
        specialty: 'diabetology',
      },
      {
        ...base,
        id: 'cf-006',
        patient: maria,
        category: 'abnormal_result_no_followup',
        categoryLabel: CATEGORY_LABELS.abnormal_result_no_followup,
        severity: 'medium',
        summary: tr(
          'HbA1c at 9.1%, no visit or note since the result',
          'HbA1c en 9.1 %, sin consulta ni nota desde el resultado',
        ),
        rationale: tr(
          'The last HbA1c is well above target and no later visit or note mentions it.',
          'La última HbA1c está muy por encima de la meta y ninguna consulta o nota posterior la menciona.',
        ),
        suggestion: tr(
          'Consider reviewing it with the patient before adjusting treatment.',
          'Considera revisarla con el paciente antes de ajustar el tratamiento.',
        ),
        citations: [
          {
            docId: 'Observation/mock-hba1c-1',
            kind: 'result',
            quote: 'HbA1c: 9.1%',
            date: at(35),
            title: tr('HbA1c', 'HbA1c'),
          },
        ],
        specialty: 'diabetology',
      },
    ],
  };
}

/** Only María has an appointment booked (the "Before the visit" panel demo). */
const NEXT_APPOINTMENT_PATIENT = 'pat-001';
const NEXT_APPOINTMENT_IN_DAYS = 12;

/** `pre_visit_question` and `abnormal_result_no_followup`: the "Before the visit" panel. */
const BEFORE_VISIT_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  'pre_visit_question',
  'abnormal_result_no_followup',
]);
const BEFORE_VISIT_SEVERITY_ORDER: Record<FindingView['severity'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface ReviewerMock {
  listFindings(query: FindingListQuery): FindingPage;
  getFinding(id: string): FindingDetail;
  review(id: string, request: FindingReviewRequest): FindingView;
  metrics(): ReviewMetrics;
  listFlags(): { items: FindingFlagView[] };
  updateFlag(update: FindingFlagUpdate): FindingFlagView;
  /** "Before the visit" (HIP-112 V3): the next appointment and what to raise then. */
  beforeVisit(patientId: string): BeforeVisitView;
}

function view(finding: FindingDetail): FindingView {
  const copy: FindingDetail = { ...finding };
  delete copy.run;
  return copy;
}

export function createReviewerMock(now: () => Date, locale: () => Locale): ReviewerMock {
  // The same findings in each locale: a review updates every copy.
  const byLocale = Object.fromEntries(
    LOCALES.map((code) => [code, seedFindings(now(), code).findings]),
  ) as Record<Locale, FindingDetail[]>;
  const flags = new Map<FindingCategory, FindingFlagView>();
  for (const category of FINDING_CATEGORIES) {
    const implemented = category !== 'similar_patients';
    flags.set(category, {
      category,
      label: '',
      description: '',
      implemented,
      enabled: implemented,
      mode: category === 'pre_visit_question' ? 'live' : 'shadow',
      ...(category === 'pre_visit_question'
        ? { validatedBy: SEEDED_VALIDATOR, validatedAt: now().toISOString() }
        : {}),
      review: { reviewed: 0, relevant: 0, alreadyKnown: 0, notRelevant: 0 },
    });
  }

  /** A flag with its label, description and seeded validator in the request's language. */
  function flagView(flag: FindingFlagView): FindingFlagView {
    const copy = mockApiCopy(locale());
    return {
      ...flag,
      label: messagesFor(locale()).review.categories[flag.category],
      description: copy.reviewer.descriptions[flag.category],
      ...(flag.validatedBy === SEEDED_VALIDATOR ? { validatedBy: copy.reviewer.validatedBy } : {}),
    };
  }

  function current(): FindingDetail[] {
    return byLocale[locale()];
  }

  function find(id: string): FindingDetail {
    const finding = current().find((item) => item.id === id);
    if (!finding) {
      throw new ReviewerMockError(404, 'not_found', mockApiCopy(locale()).reviewer.findingNotFound);
    }
    return finding;
  }

  function flagReview(category: FindingCategory): FindingFlagView['review'] {
    const reviewed = current().filter(
      (item) => item.category === category && item.mode === 'shadow' && item.review,
    );
    const relevant = reviewed.filter((item) => item.review?.verdict === 'relevant').length;
    return {
      reviewed: reviewed.length,
      relevant,
      alreadyKnown: reviewed.filter((item) => item.review?.verdict === 'already_known').length,
      notRelevant: reviewed.filter((item) => item.review?.verdict === 'not_relevant').length,
      ...(reviewed.length === 0 ? {} : { precision: relevant / reviewed.length }),
    };
  }

  return {
    listFindings(query) {
      const mode = query.mode ?? 'shadow';
      const inMode = current().filter(
        (item) => item.mode === mode && (!query.patientId || item.patient.id === query.patientId),
      );
      const categories = query.category?.split(',').filter(Boolean);
      const severities = query.severity?.split(',').filter(Boolean);
      const matching = inMode.filter(
        (item) =>
          (query.status === undefined ||
            (query.status === 'reviewed'
              ? (FINDING_VERDICTS as readonly string[]).includes(item.status)
              : item.status === query.status)) &&
          (!categories || categories.includes(item.category)) &&
          (!severities || severities.includes(item.severity)),
      );
      const counts = {
        total: inMode.length,
        byStatus: {},
        byCategory: {},
        bySeverity: {},
      } as FindingPage['counts'];
      for (const item of inMode) {
        counts.byStatus[item.status] = (counts.byStatus[item.status] ?? 0) + 1;
        counts.byCategory[item.category] = (counts.byCategory[item.category] ?? 0) + 1;
        counts.bySeverity[item.severity] = (counts.bySeverity[item.severity] ?? 0) + 1;
      }
      return { items: matching.slice(0, query.limit ?? 30).map(view), counts };
    },
    getFinding: (id) => find(id),
    review(id, request) {
      const finding = find(id);
      if (request.verdict === 'not_relevant' && !request.reason?.trim()) {
        const copy = mockApiCopy(locale()).reviewer;
        throw new ReviewerMockError(422, 'invalid_request', copy.reasonRequired, [
          { path: 'reason', message: copy.reasonRequiredField },
        ]);
      }
      const reviewedAt = now().toISOString();
      for (const code of LOCALES) {
        const copy = byLocale[code].find((item) => item.id === id);
        if (!copy) continue;
        copy.status = request.verdict;
        copy.review = {
          verdict: request.verdict,
          ...(request.reason ? { reason: request.reason } : {}),
          reviewedBy: 'inbox-user',
          reviewedAt,
        };
      }
      return view(finding);
    },
    metrics() {
      const findings = current();
      const reviewed = findings.filter((item) => item.review).length;
      const relevant = findings.filter((item) => item.review?.verdict === 'relevant').length;
      return {
        since: new Date(now().getTime() - 90 * DAY_MS).toISOString(),
        runs: 42,
        patientsReviewed: 40,
        findings: findings.length,
        findingsPer100Patients: Math.round((findings.length / 40) * 1000) / 10,
        discarded: 1,
        duplicates: 0,
        degraded: 0,
        avgToolCalls: 2.4,
        avgCostUsd: 0.0094,
        costUsd: 0.3948,
        reviewed,
        relevant,
        alreadyKnown: findings.filter((item) => item.review?.verdict === 'already_known').length,
        ...(reviewed === 0 ? {} : { precision: relevant / reviewed }),
      };
    },
    listFlags() {
      return {
        items: [...flags.values()].map((flag) => ({
          ...flagView(flag),
          review: flagReview(flag.category),
        })),
      };
    },
    updateFlag(update) {
      const current = flags.get(update.category);
      if (!current?.implemented) {
        const copy = mockApiCopy(locale()).reviewer;
        throw new ReviewerMockError(422, 'invalid_request', copy.reservedCategory, [
          { path: 'enabled', message: copy.reservedCategoryField },
        ]);
      }
      if (update.mode === 'live' && !update.validatedBy && !current.validatedBy) {
        const copy = mockApiCopy(locale()).reviewer;
        throw new ReviewerMockError(422, 'invalid_request', copy.signOffRequired, [
          { path: 'validatedBy', message: copy.signOffRequiredField },
        ]);
      }
      const next: FindingFlagView = {
        ...current,
        enabled: update.enabled,
        mode: update.mode,
        ...(update.validatedBy
          ? { validatedBy: update.validatedBy, validatedAt: now().toISOString() }
          : {}),
        updatedBy: 'inbox-user',
        updatedAt: now().toISOString(),
      };
      flags.set(update.category, next);
      return { ...flagView(next), review: flagReview(update.category) };
    },
    beforeVisit(patientId) {
      const items = current()
        .filter(
          (item) =>
            item.patient.id === patientId &&
            item.status === 'open' &&
            BEFORE_VISIT_CATEGORIES.has(item.category),
        )
        .map(view)
        .sort(
          (left, right) =>
            BEFORE_VISIT_SEVERITY_ORDER[left.severity] -
            BEFORE_VISIT_SEVERITY_ORDER[right.severity],
        );
      const nextAppointmentAt =
        patientId === NEXT_APPOINTMENT_PATIENT
          ? new Date(now().getTime() + NEXT_APPOINTMENT_IN_DAYS * DAY_MS).toISOString()
          : undefined;
      return { ...(nextAppointmentAt === undefined ? {} : { nextAppointmentAt }), items };
    },
  };
}
