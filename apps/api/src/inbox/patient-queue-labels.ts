import type { CaseEvent, PlanItemKind, PlanItemReviewType } from '@follow-up-engine/core';

/*
 * User-facing copy of the patient queue and of the plan item review
 * (HIP-141), in English (the default) and Spanish, keyed the same way so the
 * API's locale catalogs can plug them in. Everything else the inbox API says
 * lives in labels.ts.
 */

export const API_LABEL_LOCALES = ['en', 'es'] as const;
export type ApiLabelLocale = (typeof API_LABEL_LOCALES)[number];
export const DEFAULT_API_LABEL_LOCALE: ApiLabelLocale = 'en';

export interface PatientQueueLabels {
  readonly planItemKinds: Readonly<Record<PlanItemKind, string>>;
  readonly closedReasons: {
    readonly corrected_by_clinician: string;
    readonly rejected_by_clinician: string;
  };
  /** Case timeline entry of a plan item review. `kind`: the plan item's kind label. */
  readonly timeline: Readonly<Record<PlanItemReviewType, (kind: string) => string>>;
  /** Timeline entry of a contact request made for the patient from another of their cases. */
  readonly sharedContactRequest: string;
  readonly messages: {
    readonly patientNotFound: string;
    readonly noActiveCases: string;
    readonly planItemNotFound: string;
    readonly notAPlanItem: string;
    readonly alreadyReviewed: string;
    readonly planItemClosed: string;
    readonly nothingToCorrect: string;
    readonly invalidDueDate: string;
    readonly invalidKind: string;
  };
}

const en: PatientQueueLabels = {
  planItemKinds: {
    follow_up_visit: 'Follow-up visit',
    lab: 'Lab test',
    imaging: 'Imaging study',
    session: 'Session',
    other: 'Other',
  },
  closedReasons: {
    corrected_by_clinician: 'Corrected by a clinician',
    rejected_by_clinician: 'Rejected by a clinician: the note did not ask for it',
  },
  timeline: {
    plan_item_confirmed: (kind) => `Plan item confirmed: ${kind}`,
    plan_item_corrected: (kind) => `Plan item corrected: ${kind}`,
    plan_item_rejected: (kind) => `Plan item rejected: ${kind}`,
  },
  sharedContactRequest: 'Contact requested for the patient (one request covers all their cases)',
  messages: {
    patientNotFound: 'We could not find that patient.',
    noActiveCases: 'This patient has no active cases in the inbox.',
    planItemNotFound: 'We could not find that plan item.',
    notAPlanItem:
      'Only a plan item the AI read from a note can be confirmed, corrected or rejected.',
    alreadyReviewed: 'A clinician already corrected or rejected this plan item.',
    planItemClosed: 'This plan item is already closed: there is nothing left to correct or reject.',
    nothingToCorrect: 'Change the due date or the kind to correct the plan item.',
    invalidDueDate: 'Enter a valid due date.',
    invalidKind: 'Choose what the plan item asks for.',
  },
};

const es: PatientQueueLabels = {
  planItemKinds: {
    follow_up_visit: 'Control',
    lab: 'Examen de laboratorio',
    imaging: 'Estudio de imagen',
    session: 'Sesión',
    other: 'Otro',
  },
  closedReasons: {
    corrected_by_clinician: 'Corregido por el equipo clínico',
    rejected_by_clinician: 'Rechazado por el equipo clínico: la nota no lo pedía',
  },
  timeline: {
    plan_item_confirmed: (kind) => `Punto del plan confirmado: ${kind}`,
    plan_item_corrected: (kind) => `Punto del plan corregido: ${kind}`,
    plan_item_rejected: (kind) => `Punto del plan rechazado: ${kind}`,
  },
  sharedContactRequest: 'Se pidió contactar al paciente (un solo pedido cubre todos sus casos)',
  messages: {
    patientNotFound: 'No encontramos ese paciente.',
    noActiveCases: 'Este paciente no tiene casos activos en la bandeja.',
    planItemNotFound: 'No encontramos ese punto del plan.',
    notAPlanItem:
      'Solo se puede confirmar, corregir o rechazar un punto del plan que la IA leyó de una nota.',
    alreadyReviewed: 'Alguien del equipo clínico ya corrigió o rechazó este punto del plan.',
    planItemClosed: 'Este punto del plan ya está cerrado: no queda nada que corregir ni rechazar.',
    nothingToCorrect: 'Cambia la fecha o el tipo para corregir el punto del plan.',
    invalidDueDate: 'Indica una fecha válida.',
    invalidKind: 'Elige qué pide el punto del plan.',
  },
};

export const PATIENT_QUEUE_LABELS: Readonly<Record<ApiLabelLocale, PatientQueueLabels>> = {
  en,
  es,
};

/** The labels of a locale (English by default). */
export function patientQueueLabels(
  locale: ApiLabelLocale = DEFAULT_API_LABEL_LOCALE,
): PatientQueueLabels {
  return PATIENT_QUEUE_LABELS[locale];
}

function payloadText(event: CaseEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function isKind(value: string | undefined, labels: PatientQueueLabels): value is PlanItemKind {
  return value !== undefined && value in labels.planItemKinds;
}

/**
 * The case timeline entry of a plan item review, or of a contact request
 * shared from another case of the patient; `undefined` for any other event.
 */
export function patientQueueTimelineLabel(
  event: CaseEvent,
  locale: ApiLabelLocale = DEFAULT_API_LABEL_LOCALE,
): string | undefined {
  const labels = patientQueueLabels(locale);
  if (
    event.type === 'plan_item_confirmed' ||
    event.type === 'plan_item_corrected' ||
    event.type === 'plan_item_rejected'
  ) {
    const kind = payloadText(
      event,
      event.type === 'plan_item_corrected' ? 'correctedKind' : 'kind',
    );
    return labels.timeline[event.type](
      isKind(kind, labels) ? labels.planItemKinds[kind].toLowerCase() : '',
    );
  }
  return event.type === 'patient_contact_requested' &&
    payloadText(event, 'sharedFromCaseId') !== undefined
    ? labels.sharedContactRequest
    : undefined;
}

/** Label of the closed reasons a clinician's review leaves on a plan item. */
export function reviewClosedReasonLabel(
  reason: string | undefined,
  locale: ApiLabelLocale = DEFAULT_API_LABEL_LOCALE,
): string | undefined {
  const { closedReasons } = patientQueueLabels(locale);
  return reason === 'corrected_by_clinician' || reason === 'rejected_by_clinician'
    ? closedReasons[reason]
    : undefined;
}
