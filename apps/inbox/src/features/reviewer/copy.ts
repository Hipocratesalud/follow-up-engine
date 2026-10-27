/**
 * Every user-facing string of the clinical reviewer UI ("Revisión clínica"),
 * in one place so the i18n pass can translate it mechanically. Components
 * never hold copy literals. Finding texts (summary, rationale, suggestion)
 * and `categoryLabel` come from the API and are rendered as they arrive.
 */
import type {
  FindingCategory,
  FindingSeverity,
  FindingVerdict,
  ReviewStepView,
} from '../../api/reviewer-contract.ts';
import type { Tone } from '../../components/ui.tsx';

/** Short Spanish names of each category (the API also sends `categoryLabel`). */
export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  pre_visit_question: 'Para preguntar en la próxima consulta',
  lab_trend: 'Tendencia de laboratorio',
  vital_trend: 'Tendencia de signos vitales',
  abnormal_result_no_followup: 'Resultado alterado sin seguimiento',
  drug_interaction: 'Interacción entre medicamentos',
  drug_condition_conflict: 'Medicamento y condición',
  unaddressed_symptom: 'Síntoma sin estudiar',
  missing_screening: 'Control preventivo pendiente',
  record_quality: 'Calidad del registro',
  utilization_change: 'Cambio en el uso del consultorio',
  similar_patients: 'Pacientes similares',
};

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

export const SEVERITY_TONES: Record<FindingSeverity, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

/** Highest first. */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

export const VERDICT_LABELS: Record<FindingVerdict, string> = {
  relevant: 'Relevante',
  already_known: 'Ya lo sabía',
  not_relevant: 'No relevante',
};

/** What a stored citation is, for its caption. */
export const CITATION_KIND_LABELS = {
  note: 'Nota clínica',
  result: 'Resultado',
  medication: 'Medicamento',
  condition: 'Diagnóstico',
} as const;

const TEST_NAMES: Record<string, string> = {
  creatinine: 'la creatinina',
  egfr: 'el filtrado glomerular',
  hba1c: 'la HbA1c',
  glucose: 'la glucosa',
  ldl: 'el colesterol LDL',
  potassium: 'el potasio',
  hemoglobin: 'la hemoglobina',
  uacr: 'la albuminuria',
  systolic_bp: 'la presión sistólica',
  diastolic_bp: 'la presión diastólica',
  weight: 'el peso',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** One step of the agent, in plain Spanish ("Consultó la tendencia de la creatinina"). */
export function describeStep(step: ReviewStepView): string {
  const args = step.arguments;
  switch (step.tool) {
    case 'get_lab_trend': {
      const test = text(args['test']);
      const name = test === undefined ? 'un valor' : (TEST_NAMES[test] ?? test);
      return `Consultó la tendencia ${name.startsWith('el ') ? `del ${name.slice(3)}` : `de ${name}`}`;
    }
    case 'get_notes': {
      const query = text(args['query']);
      const ids = Array.isArray(args['docIds']) ? args['docIds'].length : 0;
      if (query !== undefined) return `Buscó «${query}» en las notas`;
      return ids > 0
        ? `Leyó ${String(ids)} nota${ids === 1 ? '' : 's'} completa${ids === 1 ? '' : 's'}`
        : 'Leyó notas';
    }
    case 'get_medications':
      return 'Revisó la lista de medicamentos';
    case 'get_open_follow_ups':
      return 'Revisó los seguimientos que el motor ya tiene abiertos';
    case 'check_interaction': {
      const a = text(args['drugA']);
      const b = text(args['drugB']);
      return a && b ? `Verificó la interacción ${a} + ${b}` : 'Verificó una interacción';
    }
    case 'submit_findings': {
      const count = typeof args['findings'] === 'number' ? args['findings'] : undefined;
      return count === undefined
        ? 'Entregó sus hallazgos'
        : `Entregó ${String(count)} hallazgo${count === 1 ? '' : 's'}`;
    }
    default:
      return `Pidió una herramienta desconocida (${step.tool})`;
  }
}

const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Correcto',
  invalid_arguments: 'Argumentos inválidos: se le devolvió el error',
  unknown_tool: 'Herramienta inexistente: se le devolvió el error',
  tool_budget_exhausted: 'Sin llamadas disponibles: se le pidió entregar',
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

const SEVERITY_WORDS: Record<string, string> = { low: 'baja', medium: 'media', high: 'alta' };

/** The tool's machine summary ("4 points", "found: high") in Spanish. */
export function summaryLabel(summary: string): string {
  const patterns: [RegExp, (match: RegExpExecArray) => string][] = [
    [/^(\d+) points?$/, (m) => `${m[1] ?? ''} valores`],
    [/^not found$/, () => 'sin datos en la historia'],
    [
      /^(\d+) expectations?, (\d+) cases?$/,
      (m) => `${m[1] ?? ''} expectativas, ${m[2] ?? ''} casos`,
    ],
    [/^(\d+) notes? match$/, (m) => `${m[1] ?? ''} notas coinciden`],
    [/^(\d+) notes?$/, (m) => `${m[1] ?? ''} notas`],
    [/^(\d+) medications?$/, (m) => `${m[1] ?? ''} medicamentos`],
    [/^(\d+) findings?$/, (m) => `${m[1] ?? ''} hallazgos`],
    [/^found: none$/, () => 'sin interacción en la tabla'],
    [/^found: (\w+)$/, (m) => `interacción ${SEVERITY_WORDS[m[1] ?? ''] ?? m[1] ?? ''}`],
  ];
  for (const [pattern, render] of patterns) {
    const match = pattern.exec(summary);
    if (match) return render(match);
  }
  return summary;
}

const STOP_REASONS: Record<string, string> = {
  submitted: 'Entregó sus hallazgos',
  step_limit: 'Llegó al límite de pasos',
  token_budget: 'Llegó al límite de tokens',
  llm_budget: 'Presupuesto de IA del mes agotado',
  error: 'El modelo no respondió',
  detectors_only: 'Solo detectores (sin modelo)',
  no_enabled_category: 'Ninguna categoría activa',
};

export function stopReasonLabel(reason: string): string {
  return STOP_REASONS[reason] ?? reason;
}

const DISCARD_REASONS: Record<string, string> = {
  no_citation: 'sin cita',
  unknown_document: 'citaba un documento inexistente',
  quote_not_found: 'la cita no estaba en el documento',
  quote_too_short: 'cita demasiado corta',
  category_disabled: 'categoría desactivada',
  category_reserved: 'categoría reservada',
  patient_directed: 'dirigido al paciente',
  duplicate: 'repetido (últimos 90 días)',
  merged: 'fusionado con otro',
};

export function discardLabel(reason: string): string {
  return DISCARD_REASONS[reason] ?? reason;
}

export const ORIGIN_LABELS = {
  confirmed: 'Detectado por reglas y confirmado por el agente',
  added: 'Encontrado por el agente',
  fallback: 'Detectado por reglas (el agente no pudo revisarlo)',
} as const;

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

export const REVIEW_COPY = {
  nav: { label: 'Revisión clínica', shortLabel: 'Revisión' },
  page: {
    title: 'Revisión clínica',
    intro:
      'Lo que el revisor clínico encontró en las historias: sugerencias con evidencia citada, nunca decisiones. Califica cada una para medir su precisión por categoría.',
    categoriesLink: 'Categorías',
    selectTitle: 'Elige un hallazgo de la lista',
    selectBody:
      'Verás la evidencia citada, cómo llegó el agente a la conclusión y podrás calificarlo.',
  },
  banner: {
    shadowStrong: 'Modo sombra: el equipo médico no ve estos hallazgos.',
    shadowRest: 'Revísalos para validar cada categoría antes de activarla.',
    liveStrong: 'En vivo:',
    liveRest: 'estos hallazgos son de categorías ya validadas y el equipo médico sí los ve.',
  },
  metrics: {
    ariaLabel: 'Métricas del revisor',
    loading: 'Cargando métricas',
    error: 'No pudimos cargar las métricas',
    patients: 'Pacientes revisados',
    patientsHint: (runs: number) => `${plural(runs, 'revisión', 'revisiones')} en 90 días`,
    per100: 'Hallazgos por 100 pacientes',
    per100Hint: (discarded: number) =>
      `${plural(discarded, 'descartado', 'descartados')} por no tener cita válida`,
    cost: 'Costo medio por revisión',
    costHint: (calls: string) => `${calls} consultas del agente por revisión`,
    precision: 'Precisión hasta ahora',
    precisionNone: 'Aún no hay hallazgos calificados',
    precisionHint: (reviewed: number) => `relevantes, de ${String(reviewed)} calificados`,
    empty: '—',
  },
  list: {
    title: 'Hallazgos',
    modeGroup: 'Modo',
    modeShadow: 'Sombra',
    modeLive: 'En vivo',
    statusGroup: 'Estado de los hallazgos',
    tabOpen: 'Por revisar',
    tabReviewed: 'Revisados',
    categoryLabel: 'Categoría',
    allCategories: 'Todas las categorías',
    severityLabel: 'Severidad',
    allSeverities: 'Toda severidad',
    optionWithCount: (label: string, count: number) => `${label} (${String(count)})`,
    loading: 'Cargando hallazgos',
    error: 'No pudimos cargar los hallazgos',
    emptyTitle: 'Sin hallazgos aquí',
    emptyOpen: 'No quedan hallazgos por revisar con estos filtros.',
    emptyReviewed: 'Aún no calificaste hallazgos con estos filtros.',
    loadMore: 'Cargar más hallazgos',
  },
  row: {
    severityPrefix: 'Severidad: ',
    covered: 'Ya cubierto',
  },
  detail: {
    back: 'Volver a la revisión',
    shadowBadge: 'Modo sombra',
    liveBadge: 'En vivo',
    detectedOn: (date: string) => `Detectado el ${date}`,
    viewPatient: 'Ver paciente',
    suggestionTitle: 'Sugerencia para el equipo',
    suggestionNote: 'Es una sugerencia, no una indicación: decide el médico.',
    coveredTitle: 'Ya lo cubre el seguimiento',
    evidenceTitle: 'Evidencia citada',
    evidenceNote:
      'Cada cita se comprobó palabra por palabra contra el documento antes de guardar el hallazgo.',
    citationCaption: (kind: string, date: string) => `${kind} · ${date}`,
    traceTitle: 'Cómo llegó a esto',
    traceToggle: 'Ver los pasos',
    traceFacts: {
      steps: 'Pasos',
      toolCalls: 'Consultas a herramientas',
      cost: 'Costo',
      model: 'Modelo',
      stop: 'Cierre',
      signals: 'Señales de las reglas',
    },
    discardedPrefix: 'Descartado por el motor: ',
    discardedItem: (count: number, reason: string) => `${String(count)} ${reason}`,
    verdictTitle: '¿Es relevante este hallazgo?',
    loading: 'Cargando hallazgo',
    error: 'No pudimos cargar el hallazgo',
    notFound: 'No encontramos ese hallazgo',
  },
  trend: {
    caption: (label: string, unit: string) => `${label} (${unit})`,
    values: (count: number) => plural(count, 'valor', 'valores'),
    referenceLegend: ' · línea punteada: rango de referencia',
    description: (label: string, values: string, unit: string, range: string, reference: string) =>
      `${label}: ${values} ${unit}${range}${reference}.`,
    range: (from: string, to: string) => ` entre el ${from} y el ${to}`,
    reference: (parts: string) => `. Rango de referencia: ${parts}`,
    low: (value: string) => `mínimo ${value}`,
    high: (value: string) => `máximo ${value}`,
    dateHeader: 'Fecha',
    valueHeader: (unit: string) => `Valor (${unit})`,
    cited: ' (citado)',
  },
  verdict: {
    groupLabel: 'Calificación',
    reasonRequiredLabel: '¿Por qué no es relevante?',
    commentLabel: 'Comentario (opcional)',
    submit: 'Enviar',
    change: 'Cambiar',
    reasonRequired: 'Cuéntanos por qué no es relevante: así sabemos qué ajustar.',
    reasonTooLong: (limit: string) => `El motivo puede tener hasta ${limit} caracteres.`,
    summaryPrefix: 'Calificado como ',
    summaryBy: (user: string, date: string) => ` por ${user} el ${date}`,
  },
  flags: {
    back: 'Volver a la revisión',
    title: 'Categorías del revisor',
    intro:
      'Cada categoría empieza apagada y en modo sombra. Pasa a en vivo solo cuando el equipo clínico revisó sus hallazgos y firma la validación.',
    loading: 'Cargando categorías',
    error: 'No pudimos cargar las categorías',
    live: 'En vivo',
    shadow: 'Sombra',
    enabled: 'Activa',
    disabled: 'Apagada',
    noReviews: 'Aún sin calificaciones en modo sombra.',
    reviewStats: (reviewed: number, relevant: number, precision: string) =>
      `${String(reviewed)} calificados · ${String(relevant)} relevantes · precisión ${precision}`,
    validatedBy: (who: string, date: string | undefined) =>
      `Validada por ${who}${date === undefined ? '' : ` el ${date}`}`,
    promote: 'Pasar a en vivo',
    demote: 'Volver a sombra',
    validatorLabel: '¿Quién del equipo clínico validó esta categoría?',
    validatorPlaceholder: 'Nombre y cargo, por ejemplo Dra. Pérez (coordinación médica)',
    validatorRequired: 'Indica quién del equipo clínico validó esta categoría.',
    validatorHint:
      'En vivo, los médicos verán los hallazgos de esta categoría y el sistema anfitrión los recibirá.',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    reservedBody:
      'Reservada: todavía no existe. Necesita datos de varias clínicas y una validación clínica propia, porque una correlación no es una recomendación.',
  },
  preVisit: {
    title: 'Para preguntar en la próxima consulta',
    suggestedOn: (date: string) => `Sugerido por el revisor clínico el ${date}`,
  },
} as const;
