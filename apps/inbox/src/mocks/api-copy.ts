import type { EscalationAction } from '../api/contract.ts';
import type { FindingCategory } from '../api/reviewer-contract.ts';
import type { Locale } from '../i18n/index.ts';

/**
 * The words the mock API writes that the inbox catalogs do not hold: case
 * timeline entries, escalation steps, error messages and the demo's
 * expectation labels. They mirror apps/api (`apps/api/src/i18n/en.ts` and
 * `es.ts`): English by default, Spanish for `Accept-Language: es`. The mock
 * cannot import the API (an app never imports another app), so the texts
 * the inbox shows are copied here.
 */

const englishCount = new Intl.PluralRules('en-US');
const spanishCount = new Intl.PluralRules('es-419');

function count(rules: Intl.PluralRules, n: number, one: string, other: string): string {
  return `${String(n)} ${rules.select(n) === 'one' ? one : other}`;
}

const EN = {
  people: { frontDesk: 'Front desk', coordinator: 'Care coordination' },
  timeline: {
    opened: (reason: string) => `Case opened: ${reason}`,
    reasonAdded: (reason: string) => `Reason added: ${reason}`,
    released: 'Entered the inbox from the history review',
    backfillFound: "Found while reviewing the clinic's history",
    escalated: 'Escalated',
    contactRequested: "The clinic's system was asked to contact the patient",
    contactRequestedVia: (channel: string) =>
      `The clinic's system was asked to message the patient by ${channel}`,
    call: 'Call requested from the team: call the patient',
    contactOutcome: (outcome: string) => `Contact reply: ${outcome}`,
    callOutcome: (outcome: string) => `Call: ${outcome}`,
    snoozed: (days: number) => `Snoozed for ${count(englishCount, days, 'day', 'days')}`,
    snoozedAtPatientRequest: (days: number) =>
      `Snoozed for ${count(englishCount, days, 'day', 'days')}: the patient asked to be called later`,
    resolvedAttended: 'Resolved: the patient came and the result was recorded',
    resolvedByTeam: 'Resolved by the team',
    resolvedDeclined: 'Resolved: the patient declined follow-up',
    resolvedTreatedElsewhere: 'Resolved: the patient is treated elsewhere',
    dismissedBecause: (reason: string) => `Dismissed by the team: ${reason}`,
    reopened: 'Back in the inbox when the snooze ended',
    lostToFollowUp: 'No response after every escalation: lost to follow-up',
    useful: 'Marked as useful',
    notUseful: 'Marked as not useful',
  },
  /** Timeline entries of the escalation steps the mock runs (`escalationActions` in the API). */
  escalationActions: {
    notify_clinic: 'Notice to the case owner',
    raise_priority: 'Priority raised for lack of response',
    request_patient_contact: "The clinic's system was asked to contact the patient",
    escalate_to_coordinator: "Escalated to the clinic's care coordination",
    mark_lost_to_follow_up: 'No response after every escalation: lost to follow-up',
  } satisfies Record<EscalationAction, string>,
  escalationSteps: {
    notify_clinic: 'Notice to the owner',
    raise_priority: 'Priority raised',
    request_patient_contact: 'Patient contact request',
    escalate_to_coordinator: 'Handed to care coordination',
    mark_lost_to_follow_up: 'Closed as lost to follow-up',
  } satisfies Record<EscalationAction, string>,
  noteWithoutPlan: 'Note without a follow-up plan',
  /** Names of the ICD-10 codes the mock uses (the API names them from its own table). */
  conditionNames: {
    E11: 'Type 2 diabetes mellitus',
    'R73.0': 'Prediabetes',
    I10: 'Hypertension',
    'F41.0': 'Panic disorder',
    'F41.1': 'Generalized anxiety disorder',
    'F32.9': 'Depressive episode',
    'D25.1': 'Intramural uterine fibroid',
    'E28.2': 'Polycystic ovary syndrome',
    'E03.9': 'Hypothyroidism',
    'E78.5': 'Dyslipidemia',
    'G63.2': 'Diabetic polyneuropathy',
  } as Readonly<Record<string, string>>,
  errors: {
    patientMissing: 'Patient not found.',
    caseNotFound: 'We could not find that case.',
    patientNotFound: 'We could not find that patient.',
    conditionNotFound: 'We could not find that condition.',
    conditionReviewed: 'This condition was already reviewed.',
    cannotChange: (resolved: boolean) =>
      `You cannot change this case: it is already ${resolved ? 'resolved' : 'closed'}.`,
    contactNotAllowed:
      'The patient asked not to receive messages from the clinic. Reach them another way.',
    snoozeDays: (max: number) => `Give between 1 and ${String(max)} days.`,
    feedbackReasonRequired:
      'Pick a reason when the case was not useful: it helps us improve the rule.',
    feedbackUseful: 'Say whether the case was useful.',
    noteTooShort: 'Write a note of at least 20 characters.',
    patientRequired: 'Pick a patient or type a name.',
    invalidDays: 'Give between 1 and 365 days.',
    invalidJson: 'The request body is not valid JSON.',
    invalidAction: 'Invalid action.',
    consultationIncomplete: 'The specialty or the note is missing.',
    tooLong: (field: string, max: string) => `${field} can be up to ${max} characters.`,
    fields: { note: 'The note', comment: 'The comment', name: 'The name', search: 'The search' },
  },
  demo: {
    resultPending: (test: string) => `${test} result pending`,
    plan: {
      follow_up_visit: 'Follow-up visit ordered in the note',
      lab: 'Tests ordered in the plan',
      imaging: 'Imaging study ordered in the plan',
      session: 'Follow-up session ordered in the note',
      other: 'Plan item pending',
    },
    note: 'Consultation note',
    todayVisit: "Today's visit",
    nextVisit: (specialty: string) => `Next ${specialty} visit at the usual frequency`,
    hba1c: 'No recent HbA1c (every 3 months)',
    diabetesProtocol: 'Type 2 diabetes protocol',
    fibroid: 'Fibroid follow-up ultrasound (protocol)',
    fibroidProtocol: 'Uterine fibroid follow-up',
  },
  reviewer: {
    descriptions: {
      pre_visit_question: 'Something worth asking the patient given their condition.',
      lab_trend: 'Values slowly getting worse over several results.',
      vital_trend: 'Blood pressure or weight changing steadily between visits.',
      abnormal_result_no_followup:
        'A clearly out-of-range value with no visit, appointment or comment afterwards.',
      drug_interaction: 'Combinations of active drugs with a known risk.',
      drug_condition_conflict: 'A drug that does not suit a diagnosis or the renal function.',
      unaddressed_symptom: 'A symptom that recurs across notes with no test or referral.',
      missing_screening: 'Check-ups due for the condition, age or sex (fundus exam, feet).',
      record_quality: 'Incomplete or inconsistent data: allergies not recorded, uncoded diagnosis.',
      utilization_change: "Visits far more frequent than the patient's own pattern.",
      similar_patients: 'Reserved: needs data from several clinics and clinical validation.',
    } satisfies Record<FindingCategory, string>,
    validatedBy: 'Dr. Castellanos (medical coordination)',
    findingNotFound: 'We could not find that finding.',
    reasonRequired: 'Tell us why it is not relevant: it tells us what to adjust.',
    reasonRequiredField: 'Write the reason to mark it as not relevant.',
    reservedCategory: 'This category is reserved and cannot be turned on.',
    reservedCategoryField: 'The "Similar patients" category does not exist yet.',
    signOffRequired: 'Going live needs the sign-off of whoever validated the category.',
    signOffRequiredField: 'Say who on the clinical team validated this category.',
  },
};

export type MockApiCopy = typeof EN;

const ES: MockApiCopy = {
  people: { frontDesk: 'Recepción', coordinator: 'Coordinación' },
  timeline: {
    opened: (reason) => `Caso abierto: ${reason}`,
    reasonAdded: (reason) => `Motivo agregado: ${reason}`,
    released: 'Entró a la bandeja desde la revisión del historial',
    backfillFound: 'Encontrado al revisar el historial del consultorio',
    escalated: 'Escalado',
    contactRequested: 'Se pidió al sistema del consultorio contactar al paciente',
    contactRequestedVia: (channel) =>
      `Se pidió al sistema del consultorio escribir al paciente por ${channel}`,
    call: 'Llamada pedida al equipo: llamar al paciente',
    contactOutcome: (outcome) => `Respuesta del contacto: ${outcome}`,
    callOutcome: (outcome) => `Llamada: ${outcome}`,
    snoozed: (days) => `Pospuesto ${count(spanishCount, days, 'día', 'días')}`,
    snoozedAtPatientRequest: (days) =>
      `Pospuesto ${count(spanishCount, days, 'día', 'días')}: el paciente pidió que lo llamen después`,
    resolvedAttended: 'Resuelto: el paciente asistió y se cargó el resultado',
    resolvedByTeam: 'Resuelto por el equipo',
    resolvedDeclined: 'Resuelto: el paciente no quiere seguimiento',
    resolvedTreatedElsewhere: 'Resuelto: el paciente se atiende en otro lugar',
    dismissedBecause: (reason) => `Descartado por el equipo: ${reason}`,
    reopened: 'Volvió a la bandeja al terminar el plazo pospuesto',
    lostToFollowUp: 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
    useful: 'Marcado como útil',
    notUseful: 'Marcado como no útil',
  },
  escalationActions: {
    notify_clinic: 'Aviso al responsable del caso',
    raise_priority: 'Prioridad aumentada por falta de respuesta',
    request_patient_contact: 'Se pidió al sistema del consultorio contactar al paciente',
    escalate_to_coordinator: 'Escalado a coordinación del consultorio',
    mark_lost_to_follow_up: 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
  },
  escalationSteps: {
    notify_clinic: 'Aviso al responsable',
    raise_priority: 'Aumento de prioridad',
    request_patient_contact: 'Pedido de contacto al paciente',
    escalate_to_coordinator: 'Paso a coordinación',
    mark_lost_to_follow_up: 'Cierre como perdido en seguimiento',
  },
  noteWithoutPlan: 'Nota sin plan de seguimiento',
  conditionNames: {
    E11: 'Diabetes mellitus tipo 2',
    'R73.0': 'Prediabetes',
    I10: 'Hipertensión esencial (primaria)',
    'F41.0': 'Trastorno de pánico',
    'F41.1': 'Trastorno de ansiedad generalizada',
    'F32.9': 'Episodio depresivo',
    'D25.1': 'Leiomioma intramural del útero',
    'E28.2': 'Síndrome de ovario poliquístico',
    'E03.9': 'Hipotiroidismo',
    'E78.5': 'Dislipidemia',
    'G63.2': 'Polineuropatía diabética',
  },
  errors: {
    patientMissing: 'Paciente no encontrado.',
    caseNotFound: 'No encontramos ese caso.',
    patientNotFound: 'No encontramos ese paciente.',
    conditionNotFound: 'No encontramos esa condición.',
    conditionReviewed: 'Esta condición ya fue revisada.',
    cannotChange: (resolved) =>
      `No se puede cambiar este caso: ya está ${resolved ? 'resuelto' : 'cerrado'}.`,
    contactNotAllowed: 'El paciente no acepta mensajes del consultorio. Contáctalo por otra vía.',
    snoozeDays: (max) => `Indica entre 1 y ${String(max)} días.`,
    feedbackReasonRequired:
      'Elige un motivo cuando el caso no fue útil: nos ayuda a mejorar la regla.',
    feedbackUseful: 'Indica si el caso fue útil.',
    noteTooShort: 'Escribe una nota de al menos 20 caracteres.',
    patientRequired: 'Elige un paciente o escribe un nombre.',
    invalidDays: 'Indica entre 1 y 365 días.',
    invalidJson: 'El cuerpo de la petición no es JSON válido.',
    invalidAction: 'Acción no válida.',
    consultationIncomplete: 'Faltan la especialidad o la nota.',
    tooLong: (field, max) => `${field} puede tener hasta ${max} caracteres.`,
    fields: { note: 'La nota', comment: 'El comentario', name: 'El nombre', search: 'La búsqueda' },
  },
  demo: {
    resultPending: (test) => `Resultado de ${test} pendiente`,
    plan: {
      follow_up_visit: 'Consulta de control indicada en la nota',
      lab: 'Exámenes indicados en el plan',
      imaging: 'Estudio de imagen indicado en el plan',
      session: 'Sesión de seguimiento indicada en la nota',
      other: 'Indicación del plan pendiente',
    },
    note: 'Nota de la consulta',
    todayVisit: 'Consulta de hoy',
    nextVisit: (specialty) => `Próxima consulta de ${specialty} según la frecuencia habitual`,
    hba1c: 'Sin HbA1c reciente (cada 3 meses)',
    diabetesProtocol: 'Protocolo de diabetes tipo 2',
    fibroid: 'Ecografía de control de mioma (protocolo)',
    fibroidProtocol: 'Seguimiento de miomatosis uterina',
  },
  reviewer: {
    descriptions: {
      pre_visit_question: 'Algo que vale la pena preguntarle al paciente según su condición.',
      lab_trend: 'Valores que empeoran de a poco a lo largo de varios resultados.',
      vital_trend: 'Presión arterial o peso que cambian de forma sostenida entre consultas.',
      abnormal_result_no_followup:
        'Un valor claramente fuera de rango sin consulta, cita ni comentario posterior.',
      drug_interaction: 'Combinaciones de fármacos activos con un riesgo conocido.',
      drug_condition_conflict:
        'Un fármaco que no conviene con un diagnóstico o con la función renal.',
      unaddressed_symptom: 'Un síntoma que se repite en varias notas sin estudio ni derivación.',
      missing_screening:
        'Chequeos que corresponden por condición, edad o sexo (fondo de ojo, pies).',
      record_quality:
        'Datos incompletos o inconsistentes: alergias sin registrar, diagnóstico sin codificar.',
      utilization_change: 'Consultas mucho más frecuentes que el patrón habitual del paciente.',
      similar_patients: 'Reservado: requiere datos de varias clínicas y validación clínica.',
    },
    validatedBy: 'Dra. Castellanos (coordinación médica)',
    findingNotFound: 'No encontramos ese hallazgo.',
    reasonRequired: 'Cuéntanos por qué no es relevante: así sabemos qué ajustar.',
    reasonRequiredField: 'Escribe el motivo para marcarlo como no relevante.',
    reservedCategory: 'Esta categoría está reservada y no se puede activar.',
    reservedCategoryField: 'La categoría "Pacientes similares" todavía no existe.',
    signOffRequired: 'Para pasar a "en vivo" hace falta la firma de quien validó la categoría.',
    signOffRequiredField: 'Indica quién del equipo clínico validó esta categoría.',
  },
};

const COPIES: Readonly<Record<Locale, MockApiCopy>> = { en: EN, es: ES };

export function mockApiCopy(locale: Locale): MockApiCopy {
  return COPIES[locale];
}
