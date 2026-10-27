import type {
  CaseStatus,
  ConditionStatus,
  ExpectationStatus,
  FeedbackReason,
  Layer,
  PlanItemKind,
  PriorityLabel,
  Sex,
} from '../api/contract.ts';

export const LAYER_LABELS: Record<Layer, string> = {
  universal: 'Orden pendiente',
  doctor_plan: 'Plan del médico',
  cadence: 'Frecuencia de visitas',
  protocol: 'Protocolo',
};

export const LAYER_DESCRIPTIONS: Record<Layer, string> = {
  universal: 'Una orden (examen, estudio, referencia) sin resultado registrado.',
  doctor_plan: 'Algo que el médico escribió en el plan de la nota y no ha ocurrido.',
  cadence: 'El paciente lleva más tiempo del habitual sin consulta.',
  protocol: 'Un control que el protocolo de su condición indica y nadie ha pedido.',
};

export const STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Abierto',
  notified: 'Contacto solicitado',
  snoozed: 'Pospuesto',
  escalated: 'Escalado',
  resolved: 'Resuelto',
  dismissed: 'Descartado',
  lost_to_follow_up: 'Perdido en seguimiento',
};

export const PRIORITY_LABELS: Record<PriorityLabel, string> = {
  urgente: 'Urgente',
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
};

export const ESCALATION_STEP_LABELS = [
  'Sin escalar',
  'Recordatorio',
  'Coordinación',
  'Médico tratante',
] as const;

export const MAX_ESCALATION_STEP = ESCALATION_STEP_LABELS.length - 1;

export function escalationLabel(step: number): string {
  return ESCALATION_STEP_LABELS[Math.min(step, MAX_ESCALATION_STEP)] ?? 'Escalado';
}

export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  wrong_rule: 'La regla no aplica a este paciente',
  wrong_interval: 'El plazo no es el correcto',
  bad_extraction: 'La IA leyó mal la nota',
  already_handled: 'Ya estaba resuelto',
  other: 'Otro motivo',
};

export const CONDITION_STATUS_LABELS: Record<ConditionStatus, string> = {
  confirmed: 'Confirmada',
  probable: 'Probable',
  resolved: 'Resuelta',
};

export const CONDITION_SOURCE_LABELS: Record<string, string> = {
  recorded: 'Registrada por el médico',
  extracted_from_note: 'Leída de la nota por IA',
  inferred_from_medication: 'Inferida por la medicación',
  inferred_from_result: 'Inferida por un resultado',
};

export const EXPECTATION_STATUS_LABELS: Record<ExpectationStatus, string> = {
  open: 'En plazo',
  fulfilled: 'Cumplida',
  superseded: 'Reemplazada',
  expired: 'Vencida',
  cancelled: 'Cancelada',
};

export const PLAN_KIND_LABELS: Record<PlanItemKind, string> = {
  follow_up_visit: 'Control',
  lab: 'Laboratorio',
  imaging: 'Imagen',
  session: 'Sesión',
  other: 'Otro',
};

export const SEX_LABELS: Record<Sex, string> = {
  female: 'Femenino',
  male: 'Masculino',
  other: 'Otro',
  unknown: 'Sin dato',
};

export const SPECIALTY_OPTIONS = [
  { value: 'diabetology', label: 'Diabetología' },
  { value: 'hypertension', label: 'Hipertensión arterial' },
  { value: 'psychology', label: 'Psicología' },
  { value: 'gynecology', label: 'Ginecología' },
] as const;

export const WEBHOOK_LABELS: Record<string, string> = {
  'case.opened': 'Caso abierto',
  'case.reason_added': 'Motivo agregado a un caso',
  'case.escalated': 'Caso escalado',
  'case.patient_contact_requested': 'Contactar al paciente',
  'case.snoozed': 'Caso pospuesto',
  'case.resolved': 'Caso resuelto',
  'case.dismissed': 'Caso descartado',
  'case.lost_to_follow_up': 'Paciente perdido en seguimiento',
  'consultation.processed': 'Consulta procesada',
};

/** Spanish label for an actor in the timeline. */
export function actorLabel(actor: {
  type: 'rule' | 'user' | 'patient' | 'system';
  id?: string;
}): string {
  switch (actor.type) {
    case 'rule':
      return 'Regla';
    case 'system':
      return 'Motor de seguimiento';
    case 'patient':
      return 'Paciente';
    case 'user':
      return actor.id ?? 'Equipo del consultorio';
  }
}
