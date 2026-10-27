import type { CaseStatus, FeedbackReason, Layer, Sex } from '../api/contract.ts';

/**
 * Synthetic clinic used by the mock API. Every name, note and result here is
 * invented. Offsets are in days relative to the mock clock's start, so the
 * data always looks fresh.
 */

export type Specialty = 'diabetology' | 'hypertension' | 'psychology' | 'gynecology';

export interface SeedReason {
  readonly ruleId: string;
  readonly layer: Layer;
  readonly label: string;
  /** Days past due at the mock start. Negative means it is still in the future. */
  readonly overdueDays: number;
  readonly source: { readonly resourceType: string; readonly display: string };
  /** Verbatim substring of the seed note, for doctor's-plan reasons. */
  readonly quote?: string;
}

export interface SeedCondition {
  readonly code: string;
  readonly display: string;
  readonly status: 'confirmed' | 'probable';
  readonly confidence: number;
  readonly sourceType: 'recorded' | 'extracted_from_note' | 'inferred_from_medication';
  /** Verbatim substring of the seed note when extracted from it. */
  readonly quote?: string;
}

export interface SeedCase {
  readonly status: CaseStatus;
  readonly escalationStep: number;
  readonly origin: 'live' | 'backfill';
  /** Backfill cases not yet visible in the inbox: days until release. */
  readonly releaseInDays?: number;
  readonly snoozeDays?: number;
  readonly feedback?: { readonly useful: boolean; readonly reason?: FeedbackReason };
}

export interface SeedPatient {
  readonly name: string;
  readonly age: number;
  readonly sex: Sex;
  readonly specialty: Specialty;
  readonly assignee: string;
  readonly contact?: { readonly optedOut?: boolean; readonly lastContactDaysAgo?: number };
  readonly note?: { readonly daysAgo: number; readonly text: string };
  readonly reasons: readonly SeedReason[];
  readonly conditions?: readonly SeedCondition[];
  /** Absent: the reasons are future expectations (opened by advancing the clock). */
  readonly case?: SeedCase;
  /** Already-closed expectations, for the patient's history. */
  readonly history?: readonly {
    readonly label: string;
    readonly layer: Layer;
    readonly ruleId: string;
    readonly daysAgo: number;
    readonly status: 'fulfilled' | 'superseded' | 'cancelled';
  }[];
}

export const CLINIC_NAME = 'Centro Médico Los Álamos';

export const ASSIGNEES = {
  paredes: 'Dra. Lucía Paredes',
  rivas: 'Dr. Andrés Rivas',
  medina: 'Lic. Sofía Medina',
  ibarra: 'Dra. Carmen Ibarra',
  reception: 'Recepción',
} as const;

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  diabetology: 'Diabetología',
  hypertension: 'Hipertensión arterial',
  psychology: 'Psicología',
  gynecology: 'Ginecología',
};

const DM2: SeedCondition = {
  code: 'E11',
  display: 'Diabetes mellitus tipo 2',
  status: 'confirmed',
  confidence: 1,
  sourceType: 'recorded',
};
const HTA: SeedCondition = {
  code: 'I10',
  display: 'Hipertensión esencial (primaria)',
  status: 'confirmed',
  confidence: 1,
  sourceType: 'recorded',
};

const LAB = 'ServiceRequest';

export const SEED_PATIENTS: readonly SeedPatient[] = [
  {
    name: 'María Fernanda Ortiz',
    age: 58,
    sex: 'female',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    contact: { lastContactDaysAgo: 9 },
    note: {
      daysAgo: 112,
      text: 'Paciente femenina de 58 años con DM2 de 8 años de evolución, en tratamiento con metformina 850 mg c/12h. Refiere adherencia irregular a la dieta. HbA1c previa 8,4 %. PA 128/82. Se agrega empagliflozina 10 mg/día. Plan: control en 3 meses con HbA1c y perfil lipídico. Referir a oftalmología para fondo de ojo anual.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: 'Control de diabetes indicado en la nota sin agendar',
        overdueDays: 22,
        source: { resourceType: 'DocumentReference', display: 'Nota de evolución · Diabetología' },
        quote: 'control en 3 meses con HbA1c y perfil lipídico',
      },
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de HbA1c pendiente',
        overdueDays: 18,
        source: { resourceType: LAB, display: 'Hemoglobina glicosilada (HbA1c)' },
      },
      {
        ruleId: 'doctor_plan_referral',
        layer: 'doctor_plan',
        label: 'Referencia a oftalmología sin registrar',
        overdueDays: 12,
        source: { resourceType: 'DocumentReference', display: 'Nota de evolución · Diabetología' },
        quote: 'Referir a oftalmología para fondo de ojo anual',
      },
    ],
    conditions: [DM2],
    case: { status: 'escalated', escalationStep: 2, origin: 'live' },
    history: [
      {
        label: 'Resultado de perfil lipídico',
        layer: 'universal',
        ruleId: 'lab_order_result_pending',
        daysAgo: 200,
        status: 'fulfilled',
      },
    ],
  },
  {
    name: 'José Luis Méndez',
    age: 64,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    note: {
      daysAgo: 75,
      text: 'Paciente masculino de 64 años con HTA estadio 2. PA en consulta 158/96, FC 78. Refiere cefalea ocasional. Se ajusta losartán 100 mg/día y se agrega amlodipino 5 mg/día. Solicito MAPA de 24 horas y creatinina sérica. Control en 6 semanas con resultados.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: 'Control de presión arterial a las 6 semanas sin agendar',
        overdueDays: 33,
        source: { resourceType: 'DocumentReference', display: 'Nota de evolución · Hipertensión' },
        quote: 'Control en 6 semanas con resultados',
      },
      {
        ruleId: 'procedure_result_pending',
        layer: 'universal',
        label: 'Resultado de MAPA de 24 horas pendiente',
        overdueDays: 31,
        source: { resourceType: LAB, display: 'Monitoreo ambulatorio de presión (MAPA)' },
      },
    ],
    conditions: [HTA],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Valentina Rojas',
    age: 34,
    sex: 'female',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    contact: { lastContactDaysAgo: 4 },
    note: {
      daysAgo: 40,
      text: 'Consultante de 34 años, cuadro compatible con trastorno de ansiedad generalizada. Refiere insomnio de conciliación y preocupación persistente por el trabajo. Se trabaja psicoeducación y registro de pensamientos. Plan: sesiones semanales durante 8 semanas; próxima sesión en 7 días.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_session',
        layer: 'doctor_plan',
        label: 'Sesión semanal de psicoterapia sin agendar',
        overdueDays: 26,
        source: { resourceType: 'DocumentReference', display: 'Nota de sesión · Psicología' },
        quote: 'sesiones semanales durante 8 semanas; próxima sesión en 7 días',
      },
    ],
    conditions: [
      {
        code: 'F41.1',
        display: 'Trastorno de ansiedad generalizada',
        status: 'probable',
        confidence: 0.86,
        sourceType: 'extracted_from_note',
        quote: 'cuadro compatible con trastorno de ansiedad generalizada',
      },
    ],
    case: { status: 'notified', escalationStep: 1, origin: 'live' },
  },
  {
    name: 'Carmen Elena Salazar',
    age: 47,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    reasons: [
      {
        ruleId: 'cadence_annual_gynecology',
        layer: 'cadence',
        label: 'Control ginecológico anual vencido',
        overdueDays: 35,
        source: { resourceType: 'Encounter', display: 'Última consulta de ginecología' },
      },
      {
        ruleId: 'protocol_cervical_screening',
        layer: 'protocol',
        label: 'Citología cervical vencida según protocolo',
        overdueDays: 35,
        source: { resourceType: 'PlanDefinition', display: 'Tamizaje de cáncer de cuello uterino' },
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Rafael Contreras',
    age: 71,
    sex: 'male',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    contact: { optedOut: true, lastContactDaysAgo: 63 },
    note: {
      daysAgo: 128,
      text: 'Paciente de 71 años con DM2 e hipertensión, en tratamiento con insulina glargina 18 UI nocturna. Glicemias capilares en ayunas entre 140 y 180 mg/dL. Se titula glargina a 20 UI. Se solicita microalbuminuria en orina de 24 h. Control en 3 meses.',
    },
    reasons: [
      {
        ruleId: 'protocol_hba1c_quarterly',
        layer: 'protocol',
        label: 'HbA1c trimestral vencida (protocolo DM2)',
        overdueDays: 41,
        source: { resourceType: 'PlanDefinition', display: 'Protocolo de diabetes tipo 2' },
      },
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de microalbuminuria pendiente',
        overdueDays: 27,
        source: { resourceType: LAB, display: 'Microalbuminuria en orina de 24 h' },
      },
    ],
    conditions: [
      DM2,
      {
        code: 'I10',
        display: 'Hipertensión esencial (primaria)',
        status: 'probable',
        confidence: 0.83,
        sourceType: 'extracted_from_note',
        quote: 'DM2 e hipertensión',
      },
    ],
    case: { status: 'escalated', escalationStep: 1, origin: 'live' },
  },
  {
    name: 'Ana Lucía Torres',
    age: 29,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    note: {
      daysAgo: 60,
      text: 'Paciente de 29 años, G0, consulta por ciclos irregulares de 45 a 60 días e hirsutismo leve. Ecografía transvaginal con ovarios de aspecto poliquístico. Se sospecha síndrome de ovario poliquístico. Solicito perfil hormonal (LH, FSH, testosterona total) en fase folicular. Control con resultados en 4 semanas.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: 'Control con resultados a las 4 semanas sin agendar',
        overdueDays: 32,
        source: { resourceType: 'DocumentReference', display: 'Nota de evolución · Ginecología' },
        quote: 'Control con resultados en 4 semanas',
      },
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de perfil hormonal pendiente',
        overdueDays: 30,
        source: { resourceType: LAB, display: 'Perfil hormonal (LH, FSH, testosterona total)' },
      },
    ],
    conditions: [
      {
        code: 'E28.2',
        display: 'Síndrome de ovario poliquístico',
        status: 'probable',
        confidence: 0.78,
        sourceType: 'extracted_from_note',
        quote: 'Se sospecha síndrome de ovario poliquístico',
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Pedro Antonio Lugo',
    age: 55,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    contact: { lastContactDaysAgo: 3 },
    reasons: [
      {
        ruleId: 'cadence_hypertension_visit',
        layer: 'cadence',
        label: 'Sin control de presión arterial en 7 meses',
        overdueDays: 30,
        source: { resourceType: 'Encounter', display: 'Última consulta de hipertensión' },
      },
    ],
    conditions: [HTA],
    case: { status: 'snoozed', escalationStep: 0, origin: 'live', snoozeDays: 5 },
  },
  {
    name: 'Gabriela Pineda',
    age: 42,
    sex: 'female',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    note: {
      daysAgo: 50,
      text: 'Consultante de 42 años en proceso de duelo por el fallecimiento de su madre hace 4 meses. Ánimo bajo, llanto frecuente, sin ideación suicida. Plan: sesiones quincenales; reevaluar con PHQ-9 en la próxima sesión.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_session',
        layer: 'doctor_plan',
        label: 'Sesión quincenal con reevaluación PHQ-9 sin agendar',
        overdueDays: 36,
        source: { resourceType: 'DocumentReference', display: 'Nota de sesión · Psicología' },
        quote: 'sesiones quincenales; reevaluar con PHQ-9 en la próxima sesión',
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Luis Alberto Herrera',
    age: 60,
    sex: 'male',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    reasons: [
      {
        ruleId: 'cadence_diabetology_visit',
        layer: 'cadence',
        label: 'Sin consulta de diabetología en 5 meses',
        overdueDays: 60,
        source: { resourceType: 'Encounter', display: 'Última consulta de diabetología' },
      },
      {
        ruleId: 'protocol_diabetic_foot_annual',
        layer: 'protocol',
        label: 'Examen de pie diabético anual vencido',
        overdueDays: 15,
        source: { resourceType: 'PlanDefinition', display: 'Protocolo de diabetes tipo 2' },
      },
    ],
    conditions: [DM2],
    case: { status: 'open', escalationStep: 1, origin: 'live' },
  },
  {
    name: 'Rosa Inés Montilla',
    age: 68,
    sex: 'female',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    contact: { lastContactDaysAgo: 21 },
    note: {
      daysAgo: 80,
      text: 'Paciente de 68 años con HTA de larga data y disnea de medianos esfuerzos. Soplo sistólico II/VI en foco aórtico. Se solicita ecocardiograma transtorácico. Continúa enalapril 10 mg c/12h. Control en 1 mes con ecocardiograma.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: 'Control cardiológico con ecocardiograma sin agendar',
        overdueDays: 50,
        source: { resourceType: 'DocumentReference', display: 'Nota de evolución · Hipertensión' },
        quote: 'Control en 1 mes con ecocardiograma',
      },
      {
        ruleId: 'imaging_result_pending',
        layer: 'universal',
        label: 'Resultado de ecocardiograma pendiente',
        overdueDays: 48,
        source: { resourceType: LAB, display: 'Ecocardiograma transtorácico' },
      },
    ],
    conditions: [HTA],
    case: { status: 'escalated', escalationStep: 2, origin: 'live' },
  },
  {
    name: 'Daniela Castillo',
    age: 26,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    contact: { lastContactDaysAgo: 2 },
    reasons: [
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de citología pendiente',
        overdueDays: 21,
        source: { resourceType: LAB, display: 'Citología cervicovaginal' },
      },
    ],
    case: { status: 'notified', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Miguel Ángel Suárez',
    age: 38,
    sex: 'male',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    note: {
      daysAgo: 30,
      text: 'Consultante de 38 años con episodios de pánico en el transporte público desde hace 2 meses. Se inicia exposición gradual y técnicas de respiración diafragmática. Plan: próxima sesión en 2 semanas para revisar el registro de exposición.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_session',
        layer: 'doctor_plan',
        label: 'Sesión de seguimiento a las 2 semanas sin agendar',
        overdueDays: 16,
        source: { resourceType: 'DocumentReference', display: 'Nota de sesión · Psicología' },
        quote: 'próxima sesión en 2 semanas para revisar el registro de exposición',
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Teresa Guzmán',
    age: 73,
    sex: 'female',
    specialty: 'diabetology',
    assignee: ASSIGNEES.reception,
    reasons: [
      {
        ruleId: 'protocol_hba1c_quarterly',
        layer: 'protocol',
        label: 'HbA1c trimestral vencida (protocolo DM2)',
        overdueDays: 300,
        source: { resourceType: 'PlanDefinition', display: 'Protocolo de diabetes tipo 2' },
      },
      {
        ruleId: 'cadence_diabetology_visit',
        layer: 'cadence',
        label: 'Sin consulta de diabetología en 14 meses',
        overdueDays: 240,
        source: { resourceType: 'Encounter', display: 'Última consulta de diabetología' },
      },
    ],
    conditions: [DM2],
    case: { status: 'open', escalationStep: 0, origin: 'backfill' },
  },
  {
    name: 'Fernando Ríos',
    age: 49,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'protocol_lipid_panel_annual',
        layer: 'protocol',
        label: 'Perfil lipídico anual vencido (protocolo HTA)',
        overdueDays: 20,
        source: { resourceType: 'PlanDefinition', display: 'Protocolo de hipertensión arterial' },
      },
    ],
    conditions: [HTA],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Isabel Cristina Navas',
    age: 52,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    reasons: [
      {
        ruleId: 'imaging_result_pending',
        layer: 'universal',
        label: 'Resultado de mamografía pendiente',
        overdueDays: 25,
        source: { resourceType: LAB, display: 'Mamografía bilateral' },
      },
    ],
    case: { status: 'open', escalationStep: 1, origin: 'live' },
  },
  {
    name: 'Andrea Morales',
    age: 31,
    sex: 'female',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    reasons: [
      {
        ruleId: 'cadence_psychology_session',
        layer: 'cadence',
        label: 'Sin sesión en 6 semanas (frecuencia semanal)',
        overdueDays: 28,
        source: { resourceType: 'Encounter', display: 'Última sesión de psicología' },
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  {
    name: 'Jorge Eduardo Blanco',
    age: 66,
    sex: 'male',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    note: {
      daysAgo: 100,
      text: 'Paciente de 66 años con DM2 y neuropatía periférica. Refiere parestesias en ambos pies de predominio nocturno. Glicemia en ayunas 168 mg/dL. Continúa metformina 1000 mg c/12h y pregabalina 75 mg nocturna.',
    },
    reasons: [
      {
        ruleId: 'cadence_diabetology_visit',
        layer: 'cadence',
        label: 'Sin consulta de diabetología en 3 meses',
        overdueDays: 10,
        source: { resourceType: 'Encounter', display: 'Última consulta de diabetología' },
      },
    ],
    conditions: [
      DM2,
      {
        code: 'G63.2',
        display: 'Polineuropatía diabética',
        status: 'probable',
        confidence: 0.74,
        sourceType: 'extracted_from_note',
        quote: 'neuropatía periférica',
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'live' },
  },
  // Closed cases.
  {
    name: 'Lucía Fernández',
    age: 45,
    sex: 'female',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de creatinina sérica pendiente',
        overdueDays: 40,
        source: { resourceType: LAB, display: 'Creatinina sérica' },
      },
    ],
    conditions: [HTA],
    case: {
      status: 'resolved',
      escalationStep: 1,
      origin: 'live',
      feedback: { useful: true },
    },
  },
  {
    name: 'Ricardo Peña',
    age: 57,
    sex: 'male',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    reasons: [
      {
        ruleId: 'cadence_diabetology_visit',
        layer: 'cadence',
        label: 'Sin consulta de diabetología en 4 meses',
        overdueDays: 44,
        source: { resourceType: 'Encounter', display: 'Última consulta de diabetología' },
      },
    ],
    conditions: [DM2],
    case: {
      status: 'dismissed',
      escalationStep: 0,
      origin: 'live',
      feedback: { useful: false, reason: 'already_handled' },
    },
  },
  {
    name: 'Elena Vargas',
    age: 39,
    sex: 'female',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    reasons: [
      {
        ruleId: 'cadence_psychology_session',
        layer: 'cadence',
        label: 'Sin sesión en 4 meses (frecuencia quincenal)',
        overdueDays: 120,
        source: { resourceType: 'Encounter', display: 'Última sesión de psicología' },
      },
    ],
    case: { status: 'lost_to_follow_up', escalationStep: 3, origin: 'live' },
  },
  {
    name: 'Patricia Aguilar',
    age: 61,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    reasons: [
      {
        ruleId: 'protocol_mammography_biennial',
        layer: 'protocol',
        label: 'Mamografía bienal vencida según protocolo',
        overdueDays: 38,
        source: { resourceType: 'PlanDefinition', display: 'Tamizaje de cáncer de mama' },
      },
    ],
    case: { status: 'resolved', escalationStep: 0, origin: 'live', feedback: { useful: true } },
  },
  {
    name: 'Samuel Ochoa',
    age: 50,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'procedure_result_pending',
        layer: 'universal',
        label: 'Resultado de electrocardiograma pendiente',
        overdueDays: 19,
        source: { resourceType: LAB, display: 'Electrocardiograma de 12 derivaciones' },
      },
    ],
    conditions: [HTA],
    case: { status: 'resolved', escalationStep: 0, origin: 'live' },
  },
  // Backfill: found by reviewing the clinic's history, released gradually.
  {
    name: 'Mercedes Rangel',
    age: 76,
    sex: 'female',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    reasons: [
      {
        ruleId: 'cadence_diabetology_visit',
        layer: 'cadence',
        label: 'Sin consulta de diabetología en 16 meses',
        overdueDays: 400,
        source: { resourceType: 'Encounter', display: 'Última consulta de diabetología' },
      },
      {
        ruleId: 'protocol_hba1c_quarterly',
        layer: 'protocol',
        label: 'HbA1c trimestral vencida (protocolo DM2)',
        overdueDays: 380,
        source: { resourceType: 'PlanDefinition', display: 'Protocolo de diabetes tipo 2' },
      },
    ],
    conditions: [DM2],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 1 },
  },
  {
    name: 'Héctor Villalobos',
    age: 69,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'cadence_hypertension_visit',
        layer: 'cadence',
        label: 'Sin control de presión arterial en 13 meses',
        overdueDays: 300,
        source: { resourceType: 'Encounter', display: 'Última consulta de hipertensión' },
      },
    ],
    conditions: [HTA],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 1 },
  },
  {
    name: 'Carolina Díaz',
    age: 36,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    reasons: [
      {
        ruleId: 'protocol_cervical_screening',
        layer: 'protocol',
        label: 'Citología cervical vencida según protocolo',
        overdueDays: 500,
        source: { resourceType: 'PlanDefinition', display: 'Tamizaje de cáncer de cuello uterino' },
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 2 },
  },
  {
    name: 'Alberto Quintero',
    age: 58,
    sex: 'male',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    reasons: [
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de HbA1c pendiente',
        overdueDays: 210,
        source: { resourceType: LAB, display: 'Hemoglobina glicosilada (HbA1c)' },
      },
    ],
    conditions: [DM2],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 2 },
  },
  {
    name: 'Natalia Briceño',
    age: 28,
    sex: 'female',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    reasons: [
      {
        ruleId: 'cadence_psychology_session',
        layer: 'cadence',
        label: 'Sin sesión en 5 meses (frecuencia semanal)',
        overdueDays: 150,
        source: { resourceType: 'Encounter', display: 'Última sesión de psicología' },
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 3 },
  },
  {
    name: 'Óscar Paz',
    age: 63,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'protocol_lipid_panel_annual',
        layer: 'protocol',
        label: 'Perfil lipídico anual vencido (protocolo HTA)',
        overdueDays: 450,
        source: { resourceType: 'PlanDefinition', display: 'Protocolo de hipertensión arterial' },
      },
    ],
    conditions: [HTA],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 3 },
  },
  // Patients with expectations still in the future: advancing the clock opens their cases.
  {
    name: 'Julia Romero',
    age: 44,
    sex: 'female',
    specialty: 'diabetology',
    assignee: ASSIGNEES.paredes,
    note: {
      daysAgo: 78,
      text: 'Paciente de 44 años con prediabetes (glicemia en ayunas 112 mg/dL) y sobrepeso. Se indica plan de alimentación y actividad física 150 minutos por semana. Plan: control en 3 meses con glicemia en ayunas y HbA1c.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: 'Control de prediabetes indicado en la nota sin agendar',
        overdueDays: -12,
        source: { resourceType: 'DocumentReference', display: 'Nota de evolución · Diabetología' },
        quote: 'control en 3 meses con glicemia en ayunas y HbA1c',
      },
    ],
  },
  {
    name: 'Tomás Rivero',
    age: 41,
    sex: 'male',
    specialty: 'psychology',
    assignee: ASSIGNEES.medina,
    note: {
      daysAgo: 6,
      text: 'Consultante de 41 años con estrés laboral sostenido y dificultad para desconectarse del trabajo. Se acuerdan pausas activas y registro de horas de sueño. Plan: próxima sesión en 1 semana.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_session',
        layer: 'doctor_plan',
        label: 'Sesión de seguimiento a la semana sin agendar',
        overdueDays: -8,
        source: { resourceType: 'DocumentReference', display: 'Nota de sesión · Psicología' },
        quote: 'próxima sesión en 1 semana',
      },
    ],
  },
  {
    name: 'Manuel Arias',
    age: 70,
    sex: 'male',
    specialty: 'hypertension',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: 'Resultado de potasio sérico pendiente',
        overdueDays: -20,
        source: { resourceType: LAB, display: 'Potasio sérico' },
      },
    ],
    conditions: [HTA],
  },
  {
    name: 'Sara Delgado',
    age: 33,
    sex: 'female',
    specialty: 'gynecology',
    assignee: ASSIGNEES.ibarra,
    reasons: [
      {
        ruleId: 'imaging_result_pending',
        layer: 'universal',
        label: 'Resultado de ecografía pélvica pendiente',
        overdueDays: -5,
        source: { resourceType: LAB, display: 'Ecografía pélvica transvaginal' },
      },
    ],
  },
];

/** Suggested next step per rule, shown to the clinic team (never to the patient). */
export const SUGGESTED_ACTIONS: Record<string, string> = {
  lab_order_result_pending:
    'Confirma con el paciente si ya se hizo el examen. Si lo hizo, pide el resultado; si no, recuérdale la orden y ofrécele una fecha.',
  procedure_result_pending:
    'Verifica si el estudio se realizó y carga el informe. Si no se hizo, contacta al paciente para reprogramarlo.',
  imaging_result_pending:
    'Verifica si el estudio de imagen se realizó y adjunta el informe. Si no se hizo, ofrécele una cita para realizarlo.',
  doctor_plan_follow_up_visit:
    'Agenda la consulta de control que indicó el médico en la nota y confirma que el paciente traiga sus resultados.',
  doctor_plan_session:
    'Ofrécele al consultante el próximo horario disponible para retomar la frecuencia de sesiones acordada.',
  doctor_plan_referral:
    'Confirma si el paciente ya asistió a la referencia. Si no, ayúdalo a conseguir la cita con el especialista.',
  cadence_annual_gynecology: 'Ofrécele a la paciente su control ginecológico anual.',
  cadence_hypertension_visit:
    'Agenda un control de presión arterial y pide al paciente que traiga su registro en casa.',
  cadence_diabetology_visit:
    'Agenda una consulta de control de diabetes; si toca, ordena la HbA1c antes de la cita.',
  cadence_psychology_session: 'Contacta al consultante para retomar las sesiones.',
  protocol_hba1c_quarterly:
    'Ordena la HbA1c trimestral que indica el protocolo y agenda la revisión del resultado.',
  protocol_cervical_screening:
    'Ofrécele la citología de tamizaje que corresponde según el protocolo.',
  protocol_lipid_panel_annual: 'Ordena el perfil lipídico anual que indica el protocolo.',
  protocol_diabetic_foot_annual: 'Agenda el examen anual de pie diabético.',
  protocol_mammography_biennial: 'Ofrécele la mamografía de tamizaje que corresponde.',
};

export const DEFAULT_SUGGESTED_ACTION =
  'Revisa el caso con el médico tratante y define el próximo paso con el paciente.';
