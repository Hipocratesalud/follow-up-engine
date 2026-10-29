import type {
  CaseStatus,
  ContactChannel,
  ContactOutcome,
  DismissReason,
  FeedbackReason,
  Layer,
  ProtocolRef,
  ProtocolStatus,
  Sex,
} from '../api/contract.ts';
import type { Locale } from '../i18n/index.ts';
import type { Localized } from './localized.ts';

/**
 * Synthetic clinic used by the mock API. Every name, note and result here is
 * invented. Offsets are in days relative to the mock clock's start, so the
 * data always looks fresh. Labels the API would write (reasons, sources,
 * suggested actions, protocol names) come in English and Spanish; notes,
 * quotes, names and diagnoses are clinical content and stay as written.
 */

export type Specialty = 'diabetology' | 'internal_medicine' | 'psychology' | 'gynecology';

export interface SeedReason {
  readonly ruleId: string;
  readonly layer: Layer;
  readonly label: Localized;
  /** Days past due at the mock start. Negative means it is still in the future. */
  readonly overdueDays: number;
  readonly source: { readonly resourceType: string; readonly display: Localized };
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

/** One attempt to reach the patient, in days before the mock start. */
export interface SeedAttempt {
  /** Absent: the clinic's own messaging channel. */
  readonly channel?: ContactChannel;
  readonly daysAgo: number;
  readonly windowDays: number;
  readonly trigger?: 'policy' | 'user' | 'wrong_number';
  readonly outcomes?: readonly {
    readonly outcome: ContactOutcome;
    readonly daysAgo: number;
    readonly sender?: 'host' | 'user';
  }[];
}

export interface SeedCase {
  readonly status: CaseStatus;
  /** Attempts to reach the patient about the case, oldest first. */
  readonly contact?: readonly SeedAttempt[];
  /** A dismissed case: why, and whether its rules were stopped for the patient. */
  readonly dismissal?: {
    readonly reason: DismissReason;
    readonly note?: string;
    readonly suppress?: boolean;
  };
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
  readonly contact?: {
    readonly optedOut?: boolean;
    readonly lastContactDaysAgo?: number;
    /** A message reached the wrong person this many days ago (the contact data is flagged). */
    readonly wrongNumberDaysAgo?: number;
  };
  readonly note?: { readonly daysAgo: number; readonly text: string };
  readonly reasons: readonly SeedReason[];
  readonly conditions?: readonly SeedCondition[];
  /** Absent: the reasons are future expectations (opened by advancing the clock). */
  readonly case?: SeedCase;
  /** Already-closed expectations, for the patient's history. */
  readonly history?: readonly {
    readonly label: Localized;
    readonly layer: Layer;
    readonly ruleId: string;
    readonly daysAgo: number;
    readonly status: 'fulfilled' | 'superseded' | 'cancelled';
  }[];
}

export const CLINIC_NAME = 'Centro Médico Los Álamos';

/**
 * The mock clinic's care protocols, by id. Like the real ones in
 * config/protocols, diabetes, hypertension and pregnancy are drafts (their
 * reasons carry the draft badge); the two mock-only ones are validated, so
 * the inbox also shows protocol reasons without it.
 */
export const MOCK_PROTOCOLS: Readonly<
  Record<
    string,
    { readonly name: Localized; readonly version: string; readonly status: ProtocolStatus }
  >
> = {
  diabetes: {
    name: { en: 'Diabetes follow-up', es: 'Control de diabetes' },
    version: '1.2.1',
    status: 'draft',
  },
  hypertension: {
    name: { en: 'Hypertension follow-up', es: 'Control de hipertensión' },
    version: '1.1.1',
    status: 'draft',
  },
  pregnancy: {
    name: { en: 'Pregnancy and postpartum', es: 'Embarazo y puerperio' },
    version: '0.1.0',
    status: 'draft',
  },
  womens_screening: {
    name: { en: 'Women’s preventive screening', es: 'Tamizaje preventivo de la mujer' },
    version: '1.0.0',
    status: 'validated',
  },
  fibroid: {
    name: { en: 'Uterine fibroid follow-up', es: 'Seguimiento de miomatosis uterina' },
    version: '1.0.0',
    status: 'validated',
  },
};

/** The protocol behind a `protocol_<id>_<item>` rule id, as the API names it in `locale`. */
export function mockProtocolRef(ruleId: string, locale: Locale): ProtocolRef | undefined {
  const id = Object.keys(MOCK_PROTOCOLS).find((key) => ruleId.startsWith(`protocol_${key}_`));
  const protocol = id === undefined ? undefined : MOCK_PROTOCOLS[id];
  return id === undefined || protocol === undefined
    ? undefined
    : { id, name: protocol.name[locale], version: protocol.version, status: protocol.status };
}

/** The mock clinic's protocols, by id, named in `locale` (the condition filter's options). */
export function mockProtocolCatalog(
  locale: Locale,
): { readonly id: string; readonly name: string }[] {
  return Object.entries(MOCK_PROTOCOLS).map(([id, protocol]) => ({
    id,
    name: protocol.name[locale],
  }));
}

export const ASSIGNEES = {
  paredes: 'Dra. Lucía Paredes',
  rivas: 'Dr. Andrés Rivas',
  medina: 'Lic. Sofía Medina',
  ibarra: 'Dra. Carmen Ibarra',
  /** The front desk: a role, not a person (the API names it in the request's language). */
  reception: 'front_desk',
} as const;

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
        label: {
          en: 'Diabetes follow-up ordered in the note not booked',
          es: 'Control de diabetes indicado en la nota sin agendar',
        },
        overdueDays: 22,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Progress note · Diabetology', es: 'Nota de evolución · Diabetología' },
        },
        quote: 'control en 3 meses con HbA1c y perfil lipídico',
      },
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: { en: 'HbA1c result pending', es: 'Resultado de HbA1c pendiente' },
        overdueDays: 18,
        source: {
          resourceType: LAB,
          display: { en: 'Glycated hemoglobin (HbA1c)', es: 'Hemoglobina glicosilada (HbA1c)' },
        },
      },
      {
        ruleId: 'doctor_plan_referral',
        layer: 'doctor_plan',
        label: {
          en: 'Ophthalmology referral not on record',
          es: 'Referencia a oftalmología sin registrar',
        },
        overdueDays: 12,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Progress note · Diabetology', es: 'Nota de evolución · Diabetología' },
        },
        quote: 'Referir a oftalmología para fondo de ojo anual',
      },
    ],
    conditions: [DM2],
    case: { status: 'escalated', escalationStep: 2, origin: 'live' },
    history: [
      {
        label: { en: 'Lipid panel result', es: 'Resultado de perfil lipídico' },
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
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    note: {
      daysAgo: 75,
      text: 'Paciente masculino de 64 años con HTA estadio 2. PA en consulta 158/96, FC 78. Refiere cefalea ocasional. Se ajusta losartán 100 mg/día y se agrega amlodipino 5 mg/día. Solicito MAPA de 24 horas y creatinina sérica. Control en 6 semanas con resultados.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: {
          en: 'Blood pressure follow-up at 6 weeks not booked',
          es: 'Control de presión arterial a las 6 semanas sin agendar',
        },
        overdueDays: 33,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Progress note · Hypertension', es: 'Nota de evolución · Hipertensión' },
        },
        quote: 'Control en 6 semanas con resultados',
      },
      {
        ruleId: 'procedure_result_pending',
        layer: 'universal',
        label: {
          en: '24-hour ambulatory BP monitoring result pending',
          es: 'Resultado de MAPA de 24 horas pendiente',
        },
        overdueDays: 31,
        source: {
          resourceType: LAB,
          display: {
            en: 'Ambulatory blood pressure monitoring (ABPM)',
            es: 'Monitoreo ambulatorio de presión (MAPA)',
          },
        },
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
        label: {
          en: 'Weekly psychotherapy session not booked',
          es: 'Sesión semanal de psicoterapia sin agendar',
        },
        overdueDays: 26,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Session note · Psychology', es: 'Nota de sesión · Psicología' },
        },
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
        label: {
          en: 'Yearly gynecology check-up overdue',
          es: 'Control ginecológico anual vencido',
        },
        overdueDays: 35,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last gynecology visit', es: 'Última consulta de ginecología' },
        },
      },
      {
        ruleId: 'protocol_womens_screening_cervical_cytology',
        layer: 'protocol',
        label: {
          en: 'Cervical cytology overdue per protocol',
          es: 'Citología cervical vencida según protocolo',
        },
        overdueDays: 35,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Cervical cancer screening', es: 'Tamizaje de cáncer de cuello uterino' },
        },
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
        ruleId: 'protocol_diabetes_hba1c',
        layer: 'protocol',
        label: { en: 'No recent HbA1c (every 3 months)', es: 'Sin HbA1c reciente (cada 3 meses)' },
        overdueDays: 41,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Type 2 diabetes protocol', es: 'Protocolo de diabetes tipo 2' },
        },
      },
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: {
          en: 'Microalbuminuria result pending',
          es: 'Resultado de microalbuminuria pendiente',
        },
        overdueDays: 27,
        source: {
          resourceType: LAB,
          display: { en: '24-hour urine microalbumin', es: 'Microalbuminuria en orina de 24 h' },
        },
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
        label: {
          en: 'Follow-up with results at 4 weeks not booked',
          es: 'Control con resultados a las 4 semanas sin agendar',
        },
        overdueDays: 32,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Progress note · Gynecology', es: 'Nota de evolución · Ginecología' },
        },
        quote: 'Control con resultados en 4 semanas',
      },
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: { en: 'Hormone panel result pending', es: 'Resultado de perfil hormonal pendiente' },
        overdueDays: 30,
        source: {
          resourceType: LAB,
          display: {
            en: 'Hormone panel (LH, FSH, total testosterone)',
            es: 'Perfil hormonal (LH, FSH, testosterona total)',
          },
        },
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
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    contact: { lastContactDaysAgo: 3 },
    reasons: [
      {
        ruleId: 'cadence_internal_medicine_visit',
        layer: 'cadence',
        label: {
          en: 'No blood pressure check in 7 months',
          es: 'Sin control de presión arterial en 7 meses',
        },
        overdueDays: 30,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last hypertension visit', es: 'Última consulta de hipertensión' },
        },
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
        label: {
          en: 'Biweekly session with PHQ-9 reassessment not booked',
          es: 'Sesión quincenal con reevaluación PHQ-9 sin agendar',
        },
        overdueDays: 36,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Session note · Psychology', es: 'Nota de sesión · Psicología' },
        },
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
        label: {
          en: 'No diabetology visit in 5 months',
          es: 'Sin consulta de diabetología en 5 meses',
        },
        overdueDays: 60,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last diabetology visit', es: 'Última consulta de diabetología' },
        },
      },
      {
        ruleId: 'protocol_diabetes_fundus',
        layer: 'protocol',
        label: { en: 'Yearly eye fundus exam due', es: 'Fondo de ojo anual pendiente' },
        overdueDays: 15,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Type 2 diabetes protocol', es: 'Protocolo de diabetes tipo 2' },
        },
      },
    ],
    conditions: [DM2],
    contact: { lastContactDaysAgo: 4, wrongNumberDaysAgo: 3 },
    case: {
      status: 'open',
      escalationStep: 1,
      origin: 'live',
      contact: [
        {
          channel: 'whatsapp',
          daysAgo: 4,
          windowDays: 7,
          outcomes: [{ outcome: 'wrong_number', daysAgo: 3 }],
        },
        { channel: 'phone_call', daysAgo: 3, windowDays: 3, trigger: 'wrong_number' },
      ],
    },
  },
  {
    name: 'Rosa Inés Montilla',
    age: 68,
    sex: 'female',
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    contact: { lastContactDaysAgo: 9 },
    note: {
      daysAgo: 80,
      text: 'Paciente de 68 años con HTA de larga data y disnea de medianos esfuerzos. Soplo sistólico II/VI en foco aórtico. Se solicita ecocardiograma transtorácico. Continúa enalapril 10 mg c/12h. Control en 1 mes con ecocardiograma.',
    },
    reasons: [
      {
        ruleId: 'doctor_plan_follow_up_visit',
        layer: 'doctor_plan',
        label: {
          en: 'Cardiology follow-up with echocardiogram not booked',
          es: 'Control cardiológico con ecocardiograma sin agendar',
        },
        overdueDays: 50,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Progress note · Hypertension', es: 'Nota de evolución · Hipertensión' },
        },
        quote: 'Control en 1 mes con ecocardiograma',
      },
      {
        ruleId: 'imaging_result_pending',
        layer: 'universal',
        label: { en: 'Echocardiogram result pending', es: 'Resultado de ecocardiograma pendiente' },
        overdueDays: 48,
        source: {
          resourceType: LAB,
          display: { en: 'Transthoracic echocardiogram', es: 'Ecocardiograma transtorácico' },
        },
      },
    ],
    conditions: [HTA],
    case: {
      status: 'escalated',
      escalationStep: 2,
      origin: 'live',
      contact: [
        {
          channel: 'whatsapp',
          daysAgo: 9,
          windowDays: 7,
          outcomes: [
            { outcome: 'delivered', daysAgo: 9 },
            { outcome: 'read', daysAgo: 8 },
          ],
        },
        { channel: 'phone_call', daysAgo: 2, windowDays: 3 },
      ],
    },
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
        label: { en: 'Cytology result pending', es: 'Resultado de citología pendiente' },
        overdueDays: 21,
        source: {
          resourceType: LAB,
          display: { en: 'Cervicovaginal cytology', es: 'Citología cervicovaginal' },
        },
      },
      {
        ruleId: 'protocol_pregnancy_glucose_tolerance',
        layer: 'protocol',
        label: {
          en: 'Glucose tolerance test due (weeks 24 to 28)',
          es: 'Prueba de tolerancia a la glucosa pendiente (semanas 24 a 28)',
        },
        overdueDays: 6,
        source: {
          resourceType: 'PlanDefinition',
          display: {
            en: 'Pregnancy and postpartum protocol',
            es: 'Protocolo de embarazo y puerperio',
          },
        },
      },
    ],
    case: {
      status: 'notified',
      escalationStep: 0,
      origin: 'live',
      contact: [{ daysAgo: 2, windowDays: 7, trigger: 'user' }],
    },
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
        label: {
          en: 'Follow-up session at 2 weeks not booked',
          es: 'Sesión de seguimiento a las 2 semanas sin agendar',
        },
        overdueDays: 16,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Session note · Psychology', es: 'Nota de sesión · Psicología' },
        },
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
        ruleId: 'protocol_diabetes_hba1c',
        layer: 'protocol',
        label: { en: 'No recent HbA1c (every 3 months)', es: 'Sin HbA1c reciente (cada 3 meses)' },
        overdueDays: 300,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Type 2 diabetes protocol', es: 'Protocolo de diabetes tipo 2' },
        },
      },
      {
        ruleId: 'cadence_diabetology_visit',
        layer: 'cadence',
        label: {
          en: 'No diabetology visit in 14 months',
          es: 'Sin consulta de diabetología en 14 meses',
        },
        overdueDays: 240,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last diabetology visit', es: 'Última consulta de diabetología' },
        },
      },
    ],
    conditions: [DM2],
    case: { status: 'open', escalationStep: 0, origin: 'backfill' },
  },
  {
    name: 'Fernando Ríos',
    age: 49,
    sex: 'male',
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'protocol_hypertension_labs',
        layer: 'protocol',
        label: {
          en: 'Yearly labs due (creatinine, potassium)',
          es: 'Laboratorio anual pendiente (creatinina, potasio)',
        },
        overdueDays: 20,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Hypertension protocol', es: 'Protocolo de hipertensión arterial' },
        },
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
        label: { en: 'Mammogram result pending', es: 'Resultado de mamografía pendiente' },
        overdueDays: 25,
        source: {
          resourceType: LAB,
          display: { en: 'Bilateral mammogram', es: 'Mamografía bilateral' },
        },
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
        label: {
          en: 'No session in 6 weeks (weekly frequency)',
          es: 'Sin sesión en 6 semanas (frecuencia semanal)',
        },
        overdueDays: 28,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last psychology session', es: 'Última sesión de psicología' },
        },
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
        label: {
          en: 'No diabetology visit in 3 months',
          es: 'Sin consulta de diabetología en 3 meses',
        },
        overdueDays: 10,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last diabetology visit', es: 'Última consulta de diabetología' },
        },
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
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: {
          en: 'Serum creatinine result pending',
          es: 'Resultado de creatinina sérica pendiente',
        },
        overdueDays: 40,
        source: { resourceType: LAB, display: { en: 'Serum creatinine', es: 'Creatinina sérica' } },
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
        label: {
          en: 'No diabetology visit in 4 months',
          es: 'Sin consulta de diabetología en 4 meses',
        },
        overdueDays: 44,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last diabetology visit', es: 'Última consulta de diabetología' },
        },
      },
    ],
    conditions: [DM2],
    case: {
      status: 'dismissed',
      escalationStep: 0,
      origin: 'live',
      dismissal: {
        reason: 'not_applicable_to_patient',
        note: 'Se controla con su endocrinólogo en otra ciudad.',
        suppress: true,
      },
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
        label: {
          en: 'No session in 4 months (biweekly frequency)',
          es: 'Sin sesión en 4 meses (frecuencia quincenal)',
        },
        overdueDays: 120,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last psychology session', es: 'Última sesión de psicología' },
        },
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
        ruleId: 'protocol_womens_screening_mammography',
        layer: 'protocol',
        label: {
          en: 'Biennial mammogram overdue per protocol',
          es: 'Mamografía bienal vencida según protocolo',
        },
        overdueDays: 38,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Breast cancer screening', es: 'Tamizaje de cáncer de mama' },
        },
      },
    ],
    case: { status: 'resolved', escalationStep: 0, origin: 'live', feedback: { useful: true } },
  },
  {
    name: 'Samuel Ochoa',
    age: 50,
    sex: 'male',
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'procedure_result_pending',
        layer: 'universal',
        label: {
          en: 'Electrocardiogram result pending',
          es: 'Resultado de electrocardiograma pendiente',
        },
        overdueDays: 19,
        source: {
          resourceType: LAB,
          display: { en: '12-lead electrocardiogram', es: 'Electrocardiograma de 12 derivaciones' },
        },
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
        label: {
          en: 'No diabetology visit in 16 months',
          es: 'Sin consulta de diabetología en 16 meses',
        },
        overdueDays: 400,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last diabetology visit', es: 'Última consulta de diabetología' },
        },
      },
      {
        ruleId: 'protocol_diabetes_hba1c',
        layer: 'protocol',
        label: { en: 'No recent HbA1c (every 3 months)', es: 'Sin HbA1c reciente (cada 3 meses)' },
        overdueDays: 380,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Type 2 diabetes protocol', es: 'Protocolo de diabetes tipo 2' },
        },
      },
    ],
    conditions: [DM2],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 1 },
  },
  {
    name: 'Héctor Villalobos',
    age: 69,
    sex: 'male',
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'cadence_internal_medicine_visit',
        layer: 'cadence',
        label: {
          en: 'No blood pressure check in 13 months',
          es: 'Sin control de presión arterial en 13 meses',
        },
        overdueDays: 300,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last hypertension visit', es: 'Última consulta de hipertensión' },
        },
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
        ruleId: 'protocol_womens_screening_cervical_cytology',
        layer: 'protocol',
        label: {
          en: 'Cervical cytology overdue per protocol',
          es: 'Citología cervical vencida según protocolo',
        },
        overdueDays: 500,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Cervical cancer screening', es: 'Tamizaje de cáncer de cuello uterino' },
        },
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
        label: { en: 'HbA1c result pending', es: 'Resultado de HbA1c pendiente' },
        overdueDays: 210,
        source: {
          resourceType: LAB,
          display: { en: 'Glycated hemoglobin (HbA1c)', es: 'Hemoglobina glicosilada (HbA1c)' },
        },
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
        label: {
          en: 'No session in 5 months (weekly frequency)',
          es: 'Sin sesión en 5 meses (frecuencia semanal)',
        },
        overdueDays: 150,
        source: {
          resourceType: 'Encounter',
          display: { en: 'Last psychology session', es: 'Última sesión de psicología' },
        },
      },
    ],
    case: { status: 'open', escalationStep: 0, origin: 'backfill', releaseInDays: 3 },
  },
  {
    name: 'Óscar Paz',
    age: 63,
    sex: 'male',
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'protocol_hypertension_labs',
        layer: 'protocol',
        label: {
          en: 'Yearly labs due (creatinine, potassium)',
          es: 'Laboratorio anual pendiente (creatinina, potasio)',
        },
        overdueDays: 450,
        source: {
          resourceType: 'PlanDefinition',
          display: { en: 'Hypertension protocol', es: 'Protocolo de hipertensión arterial' },
        },
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
        label: {
          en: 'Prediabetes follow-up ordered in the note not booked',
          es: 'Control de prediabetes indicado en la nota sin agendar',
        },
        overdueDays: -12,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Progress note · Diabetology', es: 'Nota de evolución · Diabetología' },
        },
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
        label: {
          en: 'Follow-up session in a week not booked',
          es: 'Sesión de seguimiento a la semana sin agendar',
        },
        overdueDays: -8,
        source: {
          resourceType: 'DocumentReference',
          display: { en: 'Session note · Psychology', es: 'Nota de sesión · Psicología' },
        },
        quote: 'próxima sesión en 1 semana',
      },
    ],
  },
  {
    name: 'Manuel Arias',
    age: 70,
    sex: 'male',
    specialty: 'internal_medicine',
    assignee: ASSIGNEES.rivas,
    reasons: [
      {
        ruleId: 'lab_order_result_pending',
        layer: 'universal',
        label: {
          en: 'Serum potassium result pending',
          es: 'Resultado de potasio sérico pendiente',
        },
        overdueDays: -20,
        source: { resourceType: LAB, display: { en: 'Serum potassium', es: 'Potasio sérico' } },
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
        label: {
          en: 'Pelvic ultrasound result pending',
          es: 'Resultado de ecografía pélvica pendiente',
        },
        overdueDays: -5,
        source: {
          resourceType: LAB,
          display: { en: 'Transvaginal pelvic ultrasound', es: 'Ecografía pélvica transvaginal' },
        },
      },
    ],
  },
];

/** Suggested next step per rule, shown to the clinic team (never to the patient). */
export const SUGGESTED_ACTIONS: Record<string, Localized> = {
  lab_order_result_pending: {
    en: 'Check with the patient whether the test was done. If so, ask for the result; if not, remind them of the order and offer a date.',
    es: 'Confirma con el paciente si ya se hizo el examen. Si lo hizo, pide el resultado; si no, recuérdale la orden y ofrécele una fecha.',
  },
  procedure_result_pending: {
    en: 'Check whether the study was done and upload the report. If not, contact the patient to reschedule it.',
    es: 'Verifica si el estudio se realizó y carga el informe. Si no se hizo, contacta al paciente para reprogramarlo.',
  },
  imaging_result_pending: {
    en: 'Check whether the imaging study was done and attach the report. If not, offer them an appointment for it.',
    es: 'Verifica si el estudio de imagen se realizó y adjunta el informe. Si no se hizo, ofrécele una cita para realizarlo.',
  },
  doctor_plan_follow_up_visit: {
    en: 'Book the follow-up visit the doctor ordered in the note and make sure the patient brings their results.',
    es: 'Agenda la consulta de control que indicó el médico en la nota y confirma que el paciente traiga sus resultados.',
  },
  doctor_plan_session: {
    en: 'Offer the client the next available slot to resume the agreed session frequency.',
    es: 'Ofrécele al consultante el próximo horario disponible para retomar la frecuencia de sesiones acordada.',
  },
  doctor_plan_referral: {
    en: 'Check whether the patient went to the referral. If not, help them get the specialist appointment.',
    es: 'Confirma si el paciente ya asistió a la referencia. Si no, ayúdalo a conseguir la cita con el especialista.',
  },
  cadence_annual_gynecology: {
    en: 'Offer the patient her yearly gynecology check-up.',
    es: 'Ofrécele a la paciente su control ginecológico anual.',
  },
  cadence_internal_medicine_visit: {
    en: 'Book a blood pressure check and ask the patient to bring their home log.',
    es: 'Agenda un control de presión arterial y pide al paciente que traiga su registro en casa.',
  },
  cadence_diabetology_visit: {
    en: 'Book a diabetes follow-up visit; if due, order the HbA1c before the appointment.',
    es: 'Agenda una consulta de control de diabetes; si toca, ordena la HbA1c antes de la cita.',
  },
  cadence_psychology_session: {
    en: 'Contact the client to resume the sessions.',
    es: 'Contacta al consultante para retomar las sesiones.',
  },
  protocol_diabetes_hba1c: {
    en: 'Order the quarterly HbA1c the protocol calls for and book the result review.',
    es: 'Ordena la HbA1c trimestral que indica el protocolo y agenda la revisión del resultado.',
  },
  protocol_womens_screening_cervical_cytology: {
    en: 'Offer the screening cytology the protocol calls for.',
    es: 'Ofrécele la citología de tamizaje que corresponde según el protocolo.',
  },
  protocol_hypertension_labs: {
    en: 'Order the yearly labs the protocol calls for.',
    es: 'Ordena el laboratorio anual que indica el protocolo.',
  },
  protocol_diabetes_fundus: {
    en: 'Help the patient book their yearly eye fundus exam.',
    es: 'Ayuda al paciente a agendar su fondo de ojo anual.',
  },
  protocol_womens_screening_mammography: {
    en: 'Offer the screening mammogram that is due.',
    es: 'Ofrécele la mamografía de tamizaje que corresponde.',
  },
  protocol_pregnancy_glucose_tolerance: {
    en: 'Order the glucose tolerance test the protocol calls for and book the review.',
    es: 'Ordena la prueba de tolerancia a la glucosa que indica el protocolo y agenda la revisión.',
  },
};

export const DEFAULT_SUGGESTED_ACTION: Localized = {
  en: 'Review the case with the treating doctor and agree on the next step with the patient.',
  es: 'Revisa el caso con el médico tratante y define el próximo paso con el paciente.',
};
