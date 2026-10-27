import type {
  CaseEvent,
  CaseResolutionKind,
  ExpectationLayer,
  JsonValue,
  PlanItemKind,
} from '@follow-up-engine/core';

/*
 * Spanish UI copy the API returns to the clinic inbox (neutral Spanish, "tú").
 * Reason labels come from the rule and protocol catalog; this file only
 * holds what the catalog does not: timeline, statuses, fallbacks.
 */

export const FRONT_DESK_LABEL = 'Recepción';
export const COORDINATOR_LABEL = 'Coordinación';
export const UNKNOWN_PATIENT_LABEL = 'Paciente sin nombre registrado';
export const DEFAULT_SUGGESTED_ACTION = 'Revisar el caso y contactar al paciente';
export const QUALITY_FINDING_LABEL = 'Nota sin plan de seguimiento';

export const LAYER_FALLBACK_LABELS: Record<ExpectationLayer, string> = {
  universal: 'Orden sin resultado registrado',
  doctor_plan: 'Seguimiento indicado por el médico',
  cadence: 'Dejó de venir a su control habitual',
  protocol: 'Control del protocolo pendiente',
};

export const PLAN_ITEM_LABELS: Record<PlanItemKind, string> = {
  follow_up_visit: 'Control indicado en el plan',
  lab: 'Examen de laboratorio indicado en el plan',
  imaging: 'Estudio de imagen indicado en el plan',
  session: 'Sesión indicada en el plan',
  other: 'Indicación del plan',
};

const UNCODED_PLAN_KEYS: Readonly<Record<string, PlanItemKind>> = {
  visit: 'follow_up_visit',
  session: 'session',
  lab: 'lab',
  imaging: 'imaging',
  other: 'other',
};

/**
 * Label of a doctor's-plan expectation from what it waits for (its match
 * key: `visit`, `session`, or a test code such as `loinc:4548-4`), so two
 * items of the same plan read differently ("Control indicado en el plan",
 * "Examen indicado en el plan: Perfil lipídico").
 */
export function planItemLabel(
  matchKey: string,
  testName: (code: string) => string | undefined,
): string {
  const kind = UNCODED_PLAN_KEYS[matchKey];
  if (kind !== undefined) {
    return PLAN_ITEM_LABELS[kind];
  }
  const code =
    matchKey
      .slice(matchKey.indexOf(':') + 1)
      .split('|')
      .at(-1) ?? '';
  const name = testName(code);
  return name === undefined ? 'Examen indicado en el plan' : `Examen indicado en el plan: ${name}`;
}

const RESOLUTION_LABELS: Record<CaseResolutionKind, string> = {
  fulfilled: 'Resuelto: se cumplió lo pendiente',
  handled_outside: 'Resuelto por el equipo',
  not_needed: 'Cerrado: ya no hace falta',
  patient_declined: 'Cerrado: el paciente no quiso continuar',
  patient_unreachable: 'Cerrado: no se pudo contactar al paciente',
};

const ESCALATION_ACTION_LABELS: Record<string, string> = {
  notify_clinic: 'Aviso al responsable del caso',
  raise_priority: 'Prioridad aumentada por falta de respuesta',
  request_patient_contact: 'Se pidió al sistema del consultorio contactar al paciente',
  escalate_to_coordinator: 'Escalado a coordinación del consultorio',
  mark_lost_to_follow_up: 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
};

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function shortDate(iso: string | undefined): string {
  if (iso === undefined) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('es', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * Spanish label of a case timeline entry. `reasonLabel` resolves a rule id
 * (from the event payload) to its catalog label; `personName` an owner id to
 * a display name.
 */
export function timelineLabel(
  event: CaseEvent,
  reasonLabel: (ruleId: string | undefined) => string,
  personName: (id: string | undefined) => string,
): string {
  const { payload } = event;
  switch (event.type) {
    case 'opened':
      return `Caso abierto: ${reasonLabel(text(payload['ruleId']))}`;
    case 'reason_added':
      return `Motivo agregado: ${reasonLabel(text(payload['ruleId']))}`;
    case 'released':
      return 'Publicado en la bandeja (pacientes por recuperar)';
    case 'notified':
      return event.actor.type === 'user'
        ? 'Marcado como avisado: el equipo se encarga de contactar al paciente'
        : 'Aviso al responsable del caso';
    case 'assigned':
      return `Asignado a ${personName(text(payload['assignee']))}`;
    case 'snoozed': {
      const until = shortDate(text(payload['until']));
      return until === '' ? 'Pospuesto' : `Pospuesto hasta el ${until}`;
    }
    case 'escalated':
      return ESCALATION_ACTION_LABELS[text(payload['action']) ?? ''] ?? 'Escalado';
    case 'patient_contact_requested':
      return 'Se pidió al sistema del consultorio contactar al paciente';
    case 'resolved': {
      const kind = text(payload['kind']) as CaseResolutionKind | undefined;
      return kind === undefined ? 'Resuelto' : RESOLUTION_LABELS[kind];
    }
    case 'dismissed':
      return 'Descartado por el equipo';
    case 'reopened':
      return 'Volvió a la bandeja al terminar el plazo pospuesto';
    case 'lost_to_follow_up':
      return 'Sin respuesta tras todos los escalamientos: perdido en seguimiento';
    case 'feedback_recorded':
      return payload['useful'] === true ? 'Marcado como útil' : 'Marcado como no útil';
  }
}
