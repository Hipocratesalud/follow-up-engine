import type { PlanItemViewKind } from '../../api/plan-item-contract.ts';
import type { CopyLocale } from '../patient-queue/copy.ts';

/*
 * User-facing copy of the plan item review (HIP-141): confirm, correct or
 * reject what the AI read from the note. English is the default; Spanish is
 * keyed the same way.
 */

const en = {
  question: 'Read by the AI from the note. Is it what the doctor asked for?',
  kinds: {
    follow_up_visit: 'Follow-up visit',
    lab: 'Lab test',
    imaging: 'Imaging study',
    session: 'Session',
    other: 'Other',
  } satisfies Record<PlanItemViewKind, string>,
  states: {
    pending: 'Not reviewed yet',
    confirmed: (by: string | undefined): string => (by ? `Confirmed by ${by}` : 'Confirmed'),
    correction: (by: string | undefined): string => (by ? `Corrected by ${by}` : 'Corrected'),
    corrected: 'Corrected: replaced by the clinician’s correction',
    rejected: 'Rejected: the note did not ask for it',
  },
  confirm: 'Confirm',
  correct: 'Correct',
  reject: 'Reject',
  confirmed: 'Plan item confirmed.',
  correctedDone: 'Plan item corrected.',
  rejectedDone: 'Plan item rejected.',
  correctTitle: 'Correct the plan item',
  correctIntro:
    'Change what the note asked for. The correction keeps the quote as evidence; the original reading stays in the record as corrected.',
  kindLabel: 'What it asks for',
  dueDateLabel: 'Due date',
  dueDateHint: 'The clinic’s calendar day.',
  saveCorrection: 'Save correction',
  nothingChanged: 'Change the due date or what it asks for to correct the item.',
  invalidDate: 'Enter a valid date.',
  rejectTitle: 'Reject the plan item',
  rejectIntro:
    'The engine stops expecting it. If it was the only pending reason of its case, the case is resolved.',
  rejectConfirm: 'Reject item',
  cancel: 'Cancel',
  readingLabel: 'AI reading',
};

export type PlanItemCopy = typeof en;

const es: PlanItemCopy = {
  question: 'Leído por la IA de la nota. ¿Es lo que pidió el médico?',
  kinds: {
    follow_up_visit: 'Control',
    lab: 'Examen de laboratorio',
    imaging: 'Estudio de imagen',
    session: 'Sesión',
    other: 'Otro',
  },
  states: {
    pending: 'Sin revisar',
    confirmed: (by) => (by ? `Confirmado por ${by}` : 'Confirmado'),
    correction: (by) => (by ? `Corregido por ${by}` : 'Corregido'),
    corrected: 'Corregido: lo reemplaza la corrección del equipo clínico',
    rejected: 'Rechazado: la nota no lo pedía',
  },
  confirm: 'Confirmar',
  correct: 'Corregir',
  reject: 'Rechazar',
  confirmed: 'Punto del plan confirmado.',
  correctedDone: 'Punto del plan corregido.',
  rejectedDone: 'Punto del plan rechazado.',
  correctTitle: 'Corregir el punto del plan',
  correctIntro:
    'Cambia lo que pidió la nota. La corrección conserva la cita como evidencia; la lectura original queda en el historial como corregida.',
  kindLabel: 'Qué pide',
  dueDateLabel: 'Fecha límite',
  dueDateHint: 'Día del calendario del consultorio.',
  saveCorrection: 'Guardar corrección',
  nothingChanged: 'Cambia la fecha o lo que pide para corregir el punto.',
  invalidDate: 'Indica una fecha válida.',
  rejectTitle: 'Rechazar el punto del plan',
  rejectIntro:
    'El motor deja de esperarlo. Si era el único motivo pendiente de su caso, el caso se resuelve.',
  rejectConfirm: 'Rechazar punto',
  cancel: 'Cancelar',
  readingLabel: 'Lectura de la IA',
};

export const PLAN_ITEM_COPY: Readonly<Record<CopyLocale, PlanItemCopy>> = { en, es };

/** The copy of a locale (English by default). */
export function planItemCopy(locale: CopyLocale = 'en'): PlanItemCopy {
  return PLAN_ITEM_COPY[locale];
}
