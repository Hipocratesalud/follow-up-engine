import type { FindingCategory, ReviewLocale } from '@follow-up-engine/core';

/**
 * Every label and message the clinical reviewer's endpoints produce, per
 * locale, in one place (the inbox i18n pass switches `API_LABEL_LOCALE`).
 * Finding texts themselves come from the reviewer in the clinic's locale.
 */

export interface ReviewerLabels {
  readonly categories: Readonly<
    Record<FindingCategory, { readonly label: string; readonly description: string }>
  >;
  readonly noteFallbackTitle: string;
  readonly recordFallbackTitle: string;
  readonly activeCase: string;
  readonly findingNotFound: string;
  readonly patientNotFound: string;
  readonly reasonRequired: string;
  readonly reasonRequiredField: string;
  readonly reservedCategory: string;
  readonly reservedCategoryField: string;
  readonly signOffRequired: string;
  readonly signOffRequiredField: string;
}

const ES: ReviewerLabels = {
  categories: {
    pre_visit_question: {
      label: 'Para preguntar en la próxima consulta',
      description: 'Algo que vale la pena preguntarle al paciente según su condición.',
    },
    lab_trend: {
      label: 'Tendencia de laboratorio',
      description: 'Valores que empeoran de a poco a lo largo de varios resultados.',
    },
    vital_trend: {
      label: 'Tendencia de signos vitales',
      description: 'Presión arterial o peso que cambian de forma sostenida entre consultas.',
    },
    abnormal_result_no_followup: {
      label: 'Resultado alterado sin seguimiento',
      description: 'Un valor claramente fuera de rango sin consulta, cita ni comentario posterior.',
    },
    drug_interaction: {
      label: 'Interacción entre medicamentos',
      description: 'Combinaciones de fármacos activos con un riesgo conocido.',
    },
    drug_condition_conflict: {
      label: 'Medicamento y condición',
      description: 'Un fármaco que no conviene con un diagnóstico o con la función renal.',
    },
    unaddressed_symptom: {
      label: 'Síntoma sin estudiar',
      description: 'Un síntoma que se repite en varias notas sin estudio ni derivación.',
    },
    missing_screening: {
      label: 'Control preventivo pendiente',
      description: 'Chequeos que corresponden por condición, edad o sexo (fondo de ojo, pies).',
    },
    record_quality: {
      label: 'Calidad del registro',
      description:
        'Datos incompletos o inconsistentes: alergias sin registrar, diagnóstico sin codificar.',
    },
    utilization_change: {
      label: 'Cambio en el uso del consultorio',
      description: 'Consultas mucho más frecuentes que el patrón habitual del paciente.',
    },
    similar_patients: {
      label: 'Pacientes similares',
      description: 'Reservado: requiere datos de varias clínicas y validación clínica.',
    },
  },
  noteFallbackTitle: 'Nota clínica',
  recordFallbackTitle: 'Registro',
  activeCase: 'Caso de seguimiento activo',
  findingNotFound: 'No encontramos ese hallazgo.',
  patientNotFound: 'No encontramos a ese paciente.',
  reasonRequired: 'Cuéntanos por qué no es relevante: así sabemos qué ajustar.',
  reasonRequiredField: 'Escribe el motivo para marcarlo como no relevante.',
  reservedCategory: 'Esta categoría está reservada y no se puede activar.',
  reservedCategoryField: 'La categoría "Pacientes similares" todavía no existe.',
  signOffRequired: 'Para pasar a "en vivo" hace falta la firma de quien validó la categoría.',
  signOffRequiredField: 'Indica quién del equipo clínico validó esta categoría.',
};

const EN: ReviewerLabels = {
  categories: {
    pre_visit_question: {
      label: 'To ask at the next visit',
      description: 'Something worth asking the patient given their condition.',
    },
    lab_trend: {
      label: 'Lab trend',
      description: 'Values slowly getting worse over several results.',
    },
    vital_trend: {
      label: 'Vital sign trend',
      description: 'Blood pressure or weight changing steadily between visits.',
    },
    abnormal_result_no_followup: {
      label: 'Abnormal result without follow-up',
      description: 'A clearly out-of-range value with no visit, appointment or comment afterwards.',
    },
    drug_interaction: {
      label: 'Drug interaction',
      description: 'Combinations of active drugs with a known risk.',
    },
    drug_condition_conflict: {
      label: 'Drug and condition',
      description: 'A drug that does not suit a diagnosis or the renal function.',
    },
    unaddressed_symptom: {
      label: 'Symptom without workup',
      description: 'A symptom that recurs across notes with no test or referral.',
    },
    missing_screening: {
      label: 'Missing check-up',
      description: 'Check-ups due for the condition, age or sex (fundus exam, feet).',
    },
    record_quality: {
      label: 'Record quality',
      description: 'Incomplete or inconsistent data: allergies not recorded, uncoded diagnosis.',
    },
    utilization_change: {
      label: 'Change in clinic use',
      description: "Visits far more frequent than the patient's own pattern.",
    },
    similar_patients: {
      label: 'Similar patients',
      description: 'Reserved: needs data from several clinics and clinical validation.',
    },
  },
  noteFallbackTitle: 'Clinical note',
  recordFallbackTitle: 'Record',
  activeCase: 'Active follow-up case',
  findingNotFound: 'We could not find that finding.',
  patientNotFound: 'We could not find that patient.',
  reasonRequired: 'Tell us why it is not relevant: it tells us what to adjust.',
  reasonRequiredField: 'Write the reason to mark it as not relevant.',
  reservedCategory: 'This category is reserved and cannot be turned on.',
  reservedCategoryField: 'The "Similar patients" category does not exist yet.',
  signOffRequired: 'Going live needs the sign-off of whoever validated the category.',
  signOffRequiredField: 'Say who on the clinical team validated this category.',
};

export const REVIEWER_LABELS: Readonly<Record<ReviewLocale, ReviewerLabels>> = { en: EN, es: ES };

/** The locale of the API's labels (the rest of the inbox API is Spanish until its i18n pass). */
export const API_LABEL_LOCALE: ReviewLocale = 'es';

export const reviewerLabels: ReviewerLabels = REVIEWER_LABELS[API_LABEL_LOCALE];
