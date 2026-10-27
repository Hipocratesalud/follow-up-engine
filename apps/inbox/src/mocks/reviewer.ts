import {
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
import { CATEGORY_LABELS } from '../features/reviewer/copy.ts';

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

const DESCRIPTIONS: Record<FindingCategory, string> = {
  pre_visit_question: 'Algo que vale la pena preguntarle al paciente según su condición.',
  lab_trend: 'Valores que empeoran de a poco a lo largo de varios resultados.',
  vital_trend: 'Presión arterial o peso que cambian de forma sostenida entre consultas.',
  abnormal_result_no_followup:
    'Un valor claramente fuera de rango sin consulta, cita ni comentario posterior.',
  drug_interaction: 'Combinaciones de fármacos activos con un riesgo conocido.',
  drug_condition_conflict: 'Un fármaco que no conviene con un diagnóstico o con la función renal.',
  unaddressed_symptom: 'Un síntoma que se repite en varias notas sin estudio ni derivación.',
  missing_screening: 'Chequeos que corresponden por condición, edad o sexo (fondo de ojo, pies).',
  record_quality:
    'Datos incompletos o inconsistentes: alergias sin registrar, diagnóstico sin codificar.',
  utilization_change: 'Consultas mucho más frecuentes que el patrón habitual del paciente.',
  similar_patients: 'Reservado: requiere datos de varias clínicas y validación clínica.',
};

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

function seedFindings(now: Date): { findings: FindingDetail[] } {
  const at = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
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
        summary:
          'Creatinina en ascenso en los últimos 3 resultados (1.1 → 1.4 → 1.75 mg/dL) sin comentario en las notas',
        rationale:
          '3 resultados seguidos empeoran (+59 % en un año), el último fuera de rango, y ninguna nota posterior lo menciona.',
        suggestion:
          'Considera evaluar la función renal y revisar los fármacos que dependen de ella (metformina, AINE).',
        citations: [
          {
            docId: 'Observation/mock-cr-2',
            kind: 'result',
            quote: 'Creatinina: 1.1 mg/dL',
            date: at(360),
            title: 'Creatinina',
          },
          {
            docId: 'Observation/mock-cr-3',
            kind: 'result',
            quote: 'Creatinina: 1.4 mg/dL',
            date: at(180),
            title: 'Creatinina',
          },
          {
            docId: 'Observation/mock-cr-4',
            kind: 'result',
            quote: 'Creatinina: 1.75 mg/dL',
            date: at(40),
            title: 'Creatinina',
          },
        ],
        trend: {
          test: 'creatinine',
          label: 'Creatinina',
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
        summary: 'Combinación de riesgo: Ibuprofeno + Losartán + Hidroclorotiazida',
        rationale:
          'AINE junto con IECA/ARA-II y diurético ("triple whammy"): riesgo de lesión renal aguda.',
        suggestion:
          'Considera revisar la necesidad del AINE y controlar la función renal (creatinina, potasio).',
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
        summary: 'Cefalea mencionada en 3 consultas sin estudio',
        rationale:
          'Aparece en 3 notas del último año y ninguna registra un estudio o una derivación por ese síntoma.',
        suggestion:
          'Considera una evaluación dirigida de la cefalea (signos de alarma, presión arterial).',
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
            title: 'Nota de medicina interna',
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
            label: 'Fondo de ojo anual pendiente',
          },
        ],
        summary: 'Paciente con diabetes sin fondo de ojo registrado en el último año',
        rationale: 'No hay nota, orden ni resultado de fondo de ojo en los últimos 12 meses.',
        suggestion: 'Considera solicitar fondo de ojo (cribado anual de retinopatía diabética).',
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
        summary: 'Pregunta si ha notado hormigueo, ardor o adormecimiento en los pies.',
        rationale:
          'Paciente con diabetes sin registro reciente de síntomas de neuropatía periférica en las notas.',
        suggestion: 'Inclúyela en la próxima consulta; no requiere acción antes.',
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
    ],
  };
}

export interface ReviewerMock {
  listFindings(query: FindingListQuery): FindingPage;
  getFinding(id: string): FindingDetail;
  review(id: string, request: FindingReviewRequest): FindingView;
  metrics(): ReviewMetrics;
  listFlags(): { items: FindingFlagView[] };
  updateFlag(update: FindingFlagUpdate): FindingFlagView;
}

function view(finding: FindingDetail): FindingView {
  const copy: FindingDetail = { ...finding };
  delete copy.run;
  return copy;
}

export function createReviewerMock(now: () => Date): ReviewerMock {
  const { findings } = seedFindings(now());
  const flags = new Map<FindingCategory, FindingFlagView>();
  for (const category of FINDING_CATEGORIES) {
    const implemented = category !== 'similar_patients';
    flags.set(category, {
      category,
      label: CATEGORY_LABELS[category],
      description: DESCRIPTIONS[category],
      implemented,
      enabled: implemented,
      mode: category === 'pre_visit_question' ? 'live' : 'shadow',
      ...(category === 'pre_visit_question'
        ? {
            validatedBy: 'Dra. Castellanos (coordinación médica)',
            validatedAt: now().toISOString(),
          }
        : {}),
      review: { reviewed: 0, relevant: 0, alreadyKnown: 0, notRelevant: 0 },
    });
  }

  function find(id: string): FindingDetail {
    const finding = findings.find((item) => item.id === id);
    if (!finding) throw new ReviewerMockError(404, 'not_found', 'No encontramos ese hallazgo.');
    return finding;
  }

  function flagReview(category: FindingCategory): FindingFlagView['review'] {
    const reviewed = findings.filter(
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
      const inMode = findings.filter(
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
        throw new ReviewerMockError(422, 'invalid_request', 'Cuéntanos por qué no es relevante.', [
          { path: 'reason', message: 'Escribe el motivo para marcarlo como no relevante.' },
        ]);
      }
      const reviewedAt = now().toISOString();
      finding.status = request.verdict;
      finding.review = {
        verdict: request.verdict,
        ...(request.reason ? { reason: request.reason } : {}),
        reviewedBy: 'inbox-user',
        reviewedAt,
      };
      return view(finding);
    },
    metrics() {
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
        items: [...flags.values()].map((flag) => ({ ...flag, review: flagReview(flag.category) })),
      };
    },
    updateFlag(update) {
      const current = flags.get(update.category);
      if (!current?.implemented) {
        throw new ReviewerMockError(
          422,
          'invalid_request',
          'Esta categoría está reservada y no se puede activar.',
          [{ path: 'enabled', message: 'La categoría "Pacientes similares" todavía no existe.' }],
        );
      }
      if (update.mode === 'live' && !update.validatedBy && !current.validatedBy) {
        throw new ReviewerMockError(
          422,
          'invalid_request',
          'Para pasar a "en vivo" hace falta la firma de quien validó la categoría.',
          [
            {
              path: 'validatedBy',
              message: 'Indica quién del equipo clínico validó esta categoría.',
            },
          ],
        );
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
      return { ...next, review: flagReview(update.category) };
    },
  };
}
