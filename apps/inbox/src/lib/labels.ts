import type {
  CaseStatus,
  ConditionStatus,
  EscalationView,
  ExpectationStatus,
  FeedbackReason,
  Layer,
  PlanItemKind,
  PriorityLabel,
  Sex,
} from '../api/contract.ts';

export const LAYER_LABELS: Record<Layer, string> = {
  universal: 'Orden o resultado',
  doctor_plan: 'Plan del médico',
  cadence: 'Frecuencia de visitas',
  protocol: 'Protocolo',
};

export const LAYER_DESCRIPTIONS: Record<Layer, string> = {
  universal:
    'Una orden (examen, estudio, referencia) sin resultado registrado, o un resultado alterado sin consulta posterior.',
  doctor_plan: 'Algo que el médico escribió en el plan de la nota y no ha ocurrido.',
  cadence: 'El paciente lleva más tiempo del habitual sin consulta.',
  protocol: 'Un control que el protocolo de su condición indica y nadie ha pedido.',
};

/** Badge of a reason from a protocol the clinical team has not validated yet (`status: draft`). */
export const DRAFT_PROTOCOL_LABEL = 'Protocolo en borrador · pendiente de validación clínica';
/** Tooltip and screen-reader text of {@link DRAFT_PROTOCOL_LABEL}. */
export const DRAFT_PROTOCOL_HINT =
  'Este protocolo aún no fue validado por el equipo clínico de tu consultorio.';
/** Prefix of the protocol's name under a reason ("Protocolo: Embarazo y puerperio"). */
export const PROTOCOL_NAME_PREFIX = 'Protocolo:';

export const STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Abierto',
  notified: 'Avisado',
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

/**
 * "Escalamiento: paso 2 de 5, aumento de prioridad": how far the case went
 * along its escalation policy (step labels come from the API). The last step
 * is named only when the API says it ran (case detail); a list view does not
 * know whether a passed step was skipped, so it gives the count only.
 */
export function escalationSummary(escalation: EscalationView): string {
  const total = escalation.steps.length;
  const passed = Math.min(escalation.currentStep, total);
  if (passed === 0) return `Escalamiento: ningún paso de ${String(total)}`;
  const count = `Escalamiento: paso ${String(passed)} de ${String(total)}`;
  const lastDone = escalation.steps
    .slice(0, passed)
    .filter((step) => step.outcome === 'done')
    .at(-1);
  return lastDone ? `${count}, ${lastDone.label.toLowerCase()}` : count;
}

/** "Siguiente: Paso a coordinación, 12 feb 2026" (empty when nothing is scheduled). */
export function escalationNext(
  escalation: EscalationView,
  formatDate: (iso: string) => string,
): string {
  return escalation.next
    ? `Siguiente: ${escalation.next.label.toLowerCase()}, ${formatDate(escalation.next.at)}`
    : '';
}

export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  wrong_rule: 'La regla no aplica a este paciente',
  wrong_interval: 'El plazo no es el correcto',
  bad_extraction: 'La nota se leyó mal',
  already_handled: 'Ya estaba resuelto',
  other: 'Otro motivo',
};

export const CONDITION_STATUS_LABELS: Record<ConditionStatus, string> = {
  confirmed: 'Confirmada',
  probable: 'Probable',
  resolved: 'Resuelta',
  rejected: 'Descartada',
  entered_in_error: 'Registrada por error',
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

/** The specialties of the synthetic clinic (codes the engine's cadence and rules use). */
export const SPECIALTY_OPTIONS = [
  { value: 'diabetology', label: 'Diabetología' },
  { value: 'internal_medicine', label: 'Medicina interna' },
  { value: 'psychology', label: 'Psicología' },
  { value: 'gynecology', label: 'Ginecología y obstetricia' },
] as const;

/** Display name of the model the API reports ("muse-spark-1.3" → "Muse Spark"). */
export function modelDisplayName(model: string): string {
  if (/muse[-_ ]?spark[-_ ]?open/i.test(model)) return 'Muse Spark Open';
  if (/muse[-_ ]?spark/i.test(model)) return 'Muse Spark';
  return model;
}

const PROVIDER_NAMES: Record<string, string> = {
  meta: 'Meta',
  baseten: 'Baseten',
  'openai-compatible': 'API compatible con OpenAI',
};

/** Who reads the notes, as the API reports it (`llm.provider` / `llm.model` of the stats). */
export interface NoteReader {
  /** No model at all: the fake provider's rule-based reading (demos, tests). */
  readonly simulated: boolean;
  /** "Muse Spark · Meta", or "Lectura simulada (sin modelo)". */
  readonly label: string;
  /** Short name for sentences: "Muse Spark", or "la lectura simulada". */
  readonly name: string;
}

export const SIMULATED_READER_LABEL = 'Lectura simulada (sin modelo)';

export function noteReader(llm: { provider: string; model: string } | undefined): NoteReader {
  if (llm === undefined)
    return { simulated: false, label: 'Lectura de notas', name: 'el lector de notas' };
  if (llm.provider === 'fake') {
    return { simulated: true, label: SIMULATED_READER_LABEL, name: 'la lectura simulada' };
  }
  const name = modelDisplayName(llm.model);
  return {
    simulated: false,
    label: `${name} · ${PROVIDER_NAMES[llm.provider] ?? llm.provider}`,
    name,
  };
}

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
  'patient_contact.requested': 'Contactar al paciente',
  'backfill.completed': 'Revisión del historial terminada',
  'backfill.paused': 'Revisión del historial en pausa',
};

/** Spanish label for an actor in the timeline. */
export function actorLabel(actor: {
  type: 'rule' | 'user' | 'patient' | 'system';
  id?: string;
}): string {
  switch (actor.type) {
    case 'rule':
      return 'Regla automática';
    case 'system':
      return 'Motor de seguimiento';
    case 'patient':
      return 'Paciente';
    case 'user':
      // `inbox-user` is the API's default when the host sends no user.
      return actor.id === undefined || actor.id === 'inbox-user'
        ? 'Equipo del consultorio'
        : actor.id;
  }
}
