import type { DismissReason } from '../api/contract.ts';

/**
 * User-facing copy of the patient-contact loop and of dismissals (HIP-136),
 * in one place, keyed, ready for i18n. Components and the mock API import
 * these constants; none of this text is written inline. Short enumerated
 * labels (channels, outcomes, dismissal reasons) live in `labels.ts`.
 */

/** "Descartar" dialog. */
export const DISMISS_COPY = {
  intro:
    'Descarta el caso si no corresponde hacer seguimiento. El motivo también queda como tu opinión sobre el caso: así ajustamos la regla.',
  reasonLegend: '¿Por qué lo descartas?',
  noteLabelRequired: 'Nota interna',
  suppressLabel: 'Dejar de recordarlo para este paciente',
  suppressHint: (patientName: string): string =>
    `El motor no volverá a abrirlo para ${patientName}; los demás pacientes no cambian. Puedes volver a activarlo desde su ficha.`,
  suppressListTitle: 'Deja de recordar:',
  suppressKept: (kept: readonly string[]): string =>
    `Lo que pidió el médico o un resultado sigue activo para el paciente (${kept.join(', ')}): solo se descarta en este caso.`,
  nothingSuppressible:
    'Lo que pidió el médico o un resultado no se puede desactivar para el paciente: solo se descarta este caso.',
  wrongDiagnosisBefore: 'Si el diagnóstico no corresponde, recházalo en la',
  wrongDiagnosisLink: 'ficha del paciente',
  wrongDiagnosisAfter: ': así se cancelan todos los recordatorios que dependen de él.',
} as const;

/** What each dismissal reason means, under its option. */
export const DISMISS_REASON_HINTS: Record<DismissReason, string> = {
  handled_elsewhere: 'El paciente ya lo resolvió en otro centro.',
  already_done: 'Ocurrió, pero el sistema del consultorio no lo registró.',
  not_applicable_to_patient: 'Por su situación, este recordatorio no corresponde a este paciente.',
  wrong_diagnosis: 'El caso se apoya en un diagnóstico que el paciente no tiene.',
  wrong_interval: 'Se pidió antes de tiempo o con un plazo que no corresponde.',
  other: 'Cuéntanos en la nota por qué lo descartas.',
};

/** Validation messages (the inbox and the mock API, mirroring apps/api). */
export const VALIDATION_COPY = {
  dismissReasonRequired: 'Elige por qué descartas el caso.',
  dismissNoteRequired: 'Cuéntanos el motivo en la nota.',
  suppressOnlyNotApplicable: 'Solo puedes dejar de recordarlo si no aplica a este paciente.',
  nothingToSuppress:
    'Este caso no tiene recordatorios que se puedan desactivar para el paciente: descártalo sin esa opción.',
  callOutcomeRequired: 'Elige qué pasó con la llamada.',
  caseClosed: 'Este caso ya está cerrado.',
  noPendingCall: 'Este caso no tiene una llamada pendiente.',
  suppressionAlreadyActive: 'Ese recordatorio ya está activo.',
} as const;

/** The case's "Contacto con el paciente" timeline. */
export const CONTACT_COPY = {
  title: 'Contacto con el paciente',
  empty:
    'Aún no se intentó contactar al paciente por este caso. El motor lo pide según la política de escalamiento.',
  attemptTitle: (attempt: number, channel: string): string =>
    `Intento ${String(attempt)} · ${channel}`,
  waitsUntil: (date: string): string => `espera respuesta hasta el ${date}`,
  answerWindow: (date: string): string => `plazo de respuesta: ${date}`,
  outcomePrefix: 'Resultado:',
  senderTeam: 'el equipo',
  senderHost: 'sistema del consultorio',
  triggers: {
    policy: 'Según la política del caso',
    user: 'Pedido por el equipo',
    wrong_number: 'Adelantada por un número equivocado',
  },
} as const;

/** The patient's contact data flagged as wrong (case detail and patient page). */
export const CONTACT_FLAG_COPY = {
  body: (when: string): string =>
    `${when}: el teléfono registrado no es del paciente. No enviamos más mensajes hasta que el sistema del consultorio lo actualice; las llamadas del equipo siguen.`,
} as const;

/** "Llamar al paciente": the call task of a case. */
export const CALL_TASK_COPY = {
  title: 'Llamar al paciente',
  outcomesGroup: '¿Qué pasó con la llamada?',
  wrongNumber: (patientName: string): string =>
    `El mensaje le llegó a otra persona: llama a ${patientName} y confirma su teléfono.`,
  unanswered: (patientName: string): string =>
    `Los mensajes no tuvieron respuesta: llama a ${patientName} y cuéntanos qué pasó.`,
  overdue: (date: string): string => `Debía hacerse antes del ${date}.`,
  due: (date: string): string => `Hazla antes del ${date}.`,
} as const;

/** "Por qué se descartó" on a dismissed case. */
export const DISMISSAL_COPY = {
  title: 'Por qué se descartó',
  feedbackNote: 'El motivo cuenta como tu opinión sobre el caso: así ajustamos la regla.',
  suppressedTitle: 'Dejó de recordarse para este paciente',
  reactivatedSuffix: ' (reactivado)',
  patientLink: 'Ver o reactivar en la ficha del paciente',
} as const;

/** "Recordatorios desactivados" on the patient page. */
export const SUPPRESSIONS_COPY = {
  title: 'Recordatorios desactivados',
  intro:
    'Recordatorios que el equipo marcó como «No aplica a este paciente». El motor no los vuelve a abrir para este paciente; al resto de los pacientes les siguen aplicando.',
  empty: 'Ningún recordatorio desactivado.',
  history: (count: number): string => `Reactivados (${String(count)})`,
  caseLink: 'Ver el caso descartado',
  reactivate: 'Volver a activar',
  reactivatedBadge: 'Reactivado',
  reactivatedBy: (by: string | undefined, date: string): string =>
    `Reactivado${by ? ` por ${by}` : ''} el ${date}`,
  reactivatedDone: 'Listo: el motor vuelve a recordarlo para este paciente.',
} as const;

/** Case history entries the mock API writes (the real API sends its own). */
export const MOCK_TIMELINE_COPY = {
  callAssigned: 'Llamada al paciente asignada al equipo',
  contactRequested: (channel: string): string => `Se pidió contactar al paciente (${channel})`,
  contactOutcome: (outcome: string): string => `Resultado del contacto: ${outcome}`,
  callOutcome: (outcome: string): string => `Llamada: ${outcome}`,
  dismissed: (reason: string): string => `Descartado: ${reason}`,
  resolvedDeclined: 'Resuelto: el paciente no quiere seguimiento',
  resolvedTreatedElsewhere: 'Resuelto: el paciente se atiende en otro lugar',
} as const;
