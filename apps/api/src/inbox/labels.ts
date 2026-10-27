import type {
  CallOutcome,
  CaseEvent,
  CaseResolutionKind,
  CaseStatus,
  ContactChannel,
  ContactOutcome,
  ContactSkipReason,
  DismissReason,
  EscalationAction,
  ExpectationLayer,
  JsonValue,
  PlanItemKind,
  QualityFindingKind,
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
export const QUALITY_FINDING_LABELS: Record<QualityFindingKind, string> = {
  note_without_plan: 'Nota sin plan de seguimiento',
  note_truncated: 'Nota leída en parte',
};

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

/** How the patient is contacted; an attempt without a channel goes by the clinic's own system. */
export const CHANNEL_LABELS: Record<ContactChannel, string> = {
  whatsapp: 'WhatsApp',
  phone_call: 'Llamada',
  sms: 'SMS',
  email: 'Correo',
};
export const HOST_CHANNEL_LABEL = 'Canal de la clínica';

export function channelLabel(channel: ContactChannel | undefined): string {
  return channel === undefined ? HOST_CHANNEL_LABEL : CHANNEL_LABELS[channel];
}

/** What came of an attempt. */
export const OUTCOME_LABELS: Record<ContactOutcome, string> = {
  delivered: 'Entregado',
  read: 'Leído',
  replied: 'Respondió',
  booked: 'Agendó cita',
  declined: 'No quiere seguimiento',
  treated_elsewhere: 'Se atiende en otro lugar',
  wrong_number: 'Número equivocado',
  no_answer: 'No contestó',
};

/** The call outcomes the team records, as the buttons read, in display order. */
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  booked: 'Contestó y agendó',
  treated_elsewhere: 'Contestó, se atiende en otro lado',
  no_answer: 'No contestó',
  wrong_number: 'Número equivocado',
  declined: 'No quiere seguimiento',
};

/** Where an attempt stands. */
export const ATTEMPT_STATUS_LABELS = {
  waiting: 'Esperando respuesta',
  answered: 'Respondió',
  unreached: 'No se pudo contactar',
  unanswered: 'Sin respuesta',
  pending_call: 'Llamada pendiente',
  closed: 'Cerrado sin respuesta',
} as const;
export type AttemptStatus = keyof typeof ATTEMPT_STATUS_LABELS;

/** Why the team dismissed a case. */
export const DISMISS_REASON_LABELS: Record<DismissReason, string> = {
  handled_elsewhere: 'Se atendió en otro lugar',
  already_done: 'Ya se hizo',
  not_applicable_to_patient: 'No aplica a este paciente',
  wrong_diagnosis: 'El diagnóstico no es correcto',
  wrong_interval: 'El plazo no es el adecuado',
  other: 'Otro motivo',
};

export const CONTACT_FLAG_LABEL = 'Número equivocado';

/** Why an escalation step did not contact the patient, for the case timeline. */
const CONTACT_SKIP_LABELS: Record<ContactSkipReason, string> = {
  clinic_disallows_contact: 'el consultorio no tiene activado el contacto con pacientes',
  patient_opted_out: 'el paciente pidió no recibir mensajes',
  backfill_case: 'el caso viene de la revisión del historial',
  low_confidence: 'el caso se apoya en una condición sin confirmar',
  contact_data_invalid: 'el número del paciente está marcado como equivocado',
  contact_window: 'ya se le escribió hace pocos días',
  patient_answered: 'el paciente ya respondió',
  already_requested: 'la llamada ya estaba pedida',
};

const RESOLUTION_LABELS: Record<CaseResolutionKind, string> = {
  fulfilled: 'Resuelto: se cumplió lo pendiente',
  handled_outside: 'Resuelto por el equipo',
  not_needed: 'Cerrado: ya no hace falta',
  patient_declined: 'Cerrado: el paciente no quiso continuar',
  patient_unreachable: 'Cerrado: no se pudo contactar al paciente',
};

/**
 * Why the engine closed an expectation (`Expectation.closedReason`), as the
 * team reads it: on the patient's closed expectations and on a case the
 * engine resolved on its own.
 */
const CLOSED_REASON_LABELS: Readonly<Record<string, string>> = {
  fulfilled_by_result: 'Llegó el resultado',
  fulfilled_by_encounter: 'El paciente asistió a la consulta',
  fulfilled_by_appointment: 'El paciente agendó una cita',
  fulfilled_by_service_request_created: 'Se emitió la orden',
  fulfilled_by_medication_prescribed: 'Se indicó el tratamiento',
  superseded_by_new_order: 'La reemplazó una orden nueva',
  source_withdrawn: 'El registro que la originó fue anulado o retirado',
  superseded_by_amended_note: 'La nota corregida del médico ya no lo indica',
  patient_discharged: 'El médico dio de alta al paciente',
  conditional_return: 'El médico indicó volver solo si hace falta',
  covered_by_plan: 'Ya lo cubre el plan del médico',
  covered_by_later_request: 'Ya se pidió en una orden o un plan posterior',
  condition_rejected: 'El equipo descartó el diagnóstico',
};

/** Spanish reason an expectation closed, or `undefined` for a code without copy. */
export function closedReasonLabel(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : CLOSED_REASON_LABELS[reason];
}

/** One step of an escalation policy, as the inbox's escalation meter names it. */
export const ESCALATION_STEP_LABELS: Record<EscalationAction, string> = {
  notify_clinic: 'Aviso al responsable',
  raise_priority: 'Aumento de prioridad',
  request_patient_contact: 'Pedido de contacto al paciente',
  escalate_to_coordinator: 'Paso a coordinación',
  mark_lost_to_follow_up: 'Cierre como perdido en seguimiento',
};

/** Where a case stands, for error messages ("ya está resuelto"). */
const STATUS_PHRASES: Record<CaseStatus, string> = {
  open: 'está abierto',
  notified: 'ya fue avisado',
  snoozed: 'está pospuesto',
  escalated: 'está escalado',
  resolved: 'ya está resuelto',
  dismissed: 'ya está descartado',
  lost_to_follow_up: 'ya está cerrado como perdido en seguimiento',
};

/** What a transition to a status means for the user ("descartar"). */
const TRANSITION_VERBS: Record<CaseStatus, string> = {
  open: 'reabrir',
  notified: 'marcar como avisado',
  snoozed: 'posponer',
  escalated: 'escalar',
  resolved: 'resolver',
  dismissed: 'descartar',
  lost_to_follow_up: 'cerrar como perdido en seguimiento',
};

function isCaseStatus(value: string): value is CaseStatus {
  return value in STATUS_PHRASES;
}

/**
 * Spanish answer to an action the case's status does not allow, for example
 * "No se puede descartar este caso: ya está resuelto." `verb` overrides the
 * one derived from the target status ("pedir contacto para").
 */
export function invalidTransitionMessage(from: string, to: string, verb?: string): string {
  const action = verb ?? (isCaseStatus(to) ? TRANSITION_VERBS[to] : 'cambiar');
  const state = isCaseStatus(from) ? STATUS_PHRASES[from] : 'cambió de estado';
  return `No se puede ${action} este caso: ${state}.`;
}

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

/** The internal note a clinic user wrote with an action, if any. */
export function eventNote(event: CaseEvent): string | undefined {
  const note = text(event.payload['note'])?.trim();
  return note === undefined || note === '' ? undefined : note;
}

/**
 * Spanish label of a case timeline entry. `reasonLabel` resolves the reason
 * of an event (its expectation id and rule id, from the payload) to the same
 * label the reason card shows; `personName` an owner id to a display name.
 */
export function timelineLabel(
  event: CaseEvent,
  reasonLabel: (reason: { expectationId?: string; ruleId?: string }) => string,
  personName: (id: string | undefined) => string,
): string {
  const { payload } = event;
  const reason = (): string => {
    const expectationId = text(payload['expectationId']);
    const ruleId = text(payload['ruleId']);
    return reasonLabel({
      ...(expectationId === undefined ? {} : { expectationId }),
      ...(ruleId === undefined ? {} : { ruleId }),
    });
  };
  switch (event.type) {
    case 'opened':
      return `Caso abierto: ${reason()}`;
    case 'reason_added':
      return `Motivo agregado: ${reason()}`;
    case 'released':
      return 'Entró a la bandeja desde la revisión del historial';
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
    case 'patient_contact_requested': {
      const channel = text(payload['channel']) as ContactChannel | undefined;
      if (channel === 'phone_call') {
        return text(payload['trigger']) === 'wrong_number'
          ? 'Llamada pedida al equipo: el mensaje llegó a un número equivocado'
          : 'Llamada pedida al equipo: llamar al paciente';
      }
      return channel === undefined
        ? 'Se pidió al sistema del consultorio contactar al paciente'
        : `Se pidió al sistema del consultorio escribir al paciente por ${CHANNEL_LABELS[channel]}`;
    }
    case 'contact_attempt_skipped': {
      const why = CONTACT_SKIP_LABELS[text(payload['reason']) as ContactSkipReason] as
        string | undefined;
      return why === undefined ? 'Contacto omitido' : `Contacto omitido: ${why}`;
    }
    case 'contact_outcome_recorded': {
      const outcome = OUTCOME_LABELS[text(payload['outcome']) as ContactOutcome] as
        string | undefined;
      const channel = text(payload['channel']) as ContactChannel | undefined;
      const via = channel === undefined ? '' : ` (${CHANNEL_LABELS[channel]})`;
      return `Respuesta del contacto${via}: ${outcome ?? 'registrada'}`;
    }
    case 'resolved': {
      const kind = text(payload['kind']) as CaseResolutionKind | undefined;
      const label = kind === undefined ? 'Resuelto' : RESOLUTION_LABELS[kind];
      const closedReasons = payload['closedReasons'];
      const why = [
        ...new Set(
          (Array.isArray(closedReasons) ? closedReasons : []).flatMap((reason: JsonValue) => {
            const reasonLabel = closedReasonLabel(text(reason));
            return reasonLabel === undefined ? [] : [reasonLabel];
          }),
        ),
      ];
      return why.length === 0 ? label : `${label} (${why.join('; ').toLowerCase()})`;
    }
    case 'dismissed': {
      const reasonLabel = DISMISS_REASON_LABELS[text(payload['reason']) as DismissReason] as
        string | undefined;
      return reasonLabel === undefined
        ? 'Descartado por el equipo'
        : `Descartado por el equipo: ${reasonLabel.toLowerCase()}`;
    }
    case 'reopened':
      return 'Volvió a la bandeja al terminar el plazo pospuesto';
    case 'lost_to_follow_up':
      return 'Sin respuesta tras todos los escalamientos: perdido en seguimiento';
    case 'feedback_recorded':
      return payload['useful'] === true ? 'Marcado como útil' : 'Marcado como no útil';
  }
}
