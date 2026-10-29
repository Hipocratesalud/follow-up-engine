import type { ApiMessages, RuleText } from './messages.ts';

/*
 * Spanish catalog (neutral Spanish, "tú"): the second locale, for hosts in
 * Latin America. Same keys as `en.ts`; the compiler checks both.
 */

/** Rules and protocol items, keyed by reason code (config/rules, config/protocols). */
const RULES: Readonly<Record<string, RuleText>> = {
  protocol_chronic_kidney_disease: { reason: 'Control de enfermedad renal crónica' },
  protocol_chronic_kidney_disease_renal_function: {
    reason: 'Creatinina y filtrado glomerular pendientes',
    action: 'Indicar creatinina con filtrado glomerular',
  },
  protocol_chronic_kidney_disease_albuminuria: {
    reason: 'Relación albúmina/creatinina en orina pendiente',
    action: 'Indicar relación albúmina/creatinina en orina',
  },
  protocol_chronic_kidney_disease_visit: {
    reason: 'Control renal pendiente',
    action: 'Agendar control renal',
  },
  protocol_diabetes: { reason: 'Control de diabetes' },
  protocol_diabetes_visit: {
    reason: 'Sin control de diabetes en 6 meses',
    action: 'Agendar control de diabetes',
  },
  protocol_diabetes_hba1c: { reason: 'Sin HbA1c reciente (cada 3 meses)', action: 'Indicar HbA1c' },
  protocol_diabetes_lipids: {
    reason: 'Perfil lipídico anual pendiente',
    action: 'Indicar perfil lipídico',
  },
  protocol_diabetes_fundus: {
    reason: 'Fondo de ojo anual pendiente',
    action: 'Referir a oftalmología para fondo de ojo',
  },
  protocol_dyslipidemia: { reason: 'Control de dislipidemia' },
  protocol_dyslipidemia_lipids: {
    reason: 'Perfil lipídico de control pendiente',
    action: 'Indicar perfil lipídico',
  },
  protocol_hypertension: { reason: 'Control de hipertensión' },
  protocol_hypertension_visit: {
    reason: 'Sin control de hipertensión en 6 meses',
    action: 'Agendar control de hipertensión',
  },
  protocol_hypertension_labs: {
    reason: 'Laboratorio anual pendiente (creatinina, potasio)',
    action: 'Indicar creatinina y potasio',
  },
  protocol_hypothyroidism: { reason: 'Control de hipotiroidismo' },
  protocol_hypothyroidism_tsh: { reason: 'TSH de control pendiente', action: 'Indicar TSH' },
  protocol_hypothyroidism_visit: {
    reason: 'Sin control de tiroides en 12 meses',
    action: 'Agendar control de tiroides',
  },
  protocol_pregnancy: { reason: 'Embarazo y puerperio' },
  protocol_pregnancy_prenatal_visit: {
    reason: 'Control prenatal pendiente',
    action: 'Agendar control prenatal',
  },
  protocol_pregnancy_glucose_tolerance: {
    reason: 'Prueba de tolerancia a la glucosa pendiente (semanas 24 a 28)',
    action: 'Indicar prueba de tolerancia oral a la glucosa',
  },
  protocol_pregnancy_postpartum_visit: {
    reason: 'Control posparto pendiente (semanas 3 a 8)',
    action: 'Agendar control posparto',
  },
  protocol_treatment_followup: { reason: 'Seguimiento de tratamiento' },
  protocol_treatment_followup_visit: {
    reason: 'Control de seguimiento pendiente',
    action: 'Agendar control de seguimiento',
  },
  cadence_break: {
    reason: 'Dejó de venir a su control habitual',
    action: 'Contactar al paciente para retomar sus controles',
  },
  doctor_plan_followup: {
    reason: 'Seguimiento indicado por el médico',
    action: 'Contactar al paciente para cumplir el plan indicado',
  },
  lab_order_result_pending: {
    reason: 'Resultado de laboratorio pendiente',
    action: 'Contactar al paciente para completar el examen',
  },
  imaging_order_result_pending: {
    reason: 'Resultado de imagen pendiente',
    action: 'Contactar al paciente para completar el estudio',
  },
  short_treatment_followup: {
    reason: 'Control al terminar el tratamiento',
    action: 'Agendar control de fin de tratamiento',
  },
  abnormal_result_followup: {
    reason: 'Resultado alterado sin consulta posterior',
    action: 'Revisar el resultado con el paciente',
  },
  abnormal_imaging_followup_study: {
    reason: 'Estudio de control que recomienda el informe',
    action: 'Pedir el estudio de control que recomienda el informe',
  },
};

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export const ES = {
  locale: 'es',
  intlLocale: 'es',
  people: {
    frontDesk: 'Recepción',
    coordinator: 'Coordinación',
    unknownPatient: 'Paciente sin nombre registrado',
    demoPatient: 'Paciente de demostración',
  },
  defaultSuggestedAction: 'Revisar el caso y contactar al paciente',
  pendingFollowUp: 'Seguimiento pendiente',
  qualityFindings: {
    note_without_plan: 'Nota sin plan de seguimiento',
    note_truncated: 'Nota leída en parte',
  },
  layerFallbacks: {
    universal: 'Orden sin resultado registrado',
    doctor_plan: 'Seguimiento indicado por el médico',
    cadence: 'Dejó de venir a su control habitual',
    protocol: 'Control del protocolo pendiente',
  },
  layerLabels: {
    universal: 'Órdenes y resultados',
    doctor_plan: 'Plan del médico',
    cadence: 'Frecuencia de visitas',
    protocol: 'Protocolo',
  },
  planItems: {
    follow_up_visit: 'Control indicado en el plan',
    lab: 'Examen de laboratorio indicado en el plan',
    imaging: 'Estudio de imagen indicado en el plan',
    session: 'Sesión indicada en el plan',
    other: 'Indicación del plan',
  },
  planItemKinds: {
    follow_up_visit: 'Control',
    lab: 'Examen de laboratorio',
    imaging: 'Estudio de imagen',
    session: 'Sesión',
    other: 'Otro',
  },
  planTest: 'Examen indicado en el plan',
  planTestNamed: (test) => `Examen indicado en el plan: ${test}`,
  rules: RULES,

  channels: { whatsapp: 'WhatsApp', phone_call: 'Llamada', sms: 'SMS', email: 'Correo' },
  hostChannel: 'Canal de la clínica',
  outcomes: {
    delivered: 'Entregado',
    read: 'Leído',
    replied: 'Respondió',
    booked: 'Agendó cita',
    declined: 'No quiere seguimiento',
    treated_elsewhere: 'Se atiende en otro lugar',
    wrong_number: 'Número equivocado',
    no_answer: 'No contestó',
  },
  callOutcomes: {
    booked: 'Contestó y agendó',
    treated_elsewhere: 'Contestó, se atiende en otro lado',
    no_answer: 'No contestó',
    wrong_number: 'Número equivocado',
    declined: 'No quiere seguimiento',
  },
  attemptStatuses: {
    waiting: 'Esperando respuesta',
    answered: 'Respondió',
    unreached: 'No se pudo contactar',
    unanswered: 'Sin respuesta',
    pending_call: 'Llamada pendiente',
    closed: 'Cerrado sin respuesta',
  },
  dismissReasons: {
    handled_elsewhere: 'Se atendió en otro lugar',
    already_done: 'Ya se hizo',
    not_applicable_to_patient: 'No aplica a este paciente',
    wrong_diagnosis: 'El diagnóstico no es correcto',
    wrong_interval: 'El plazo no es el adecuado',
    other: 'Otro motivo',
  },
  contactFlag: 'Número equivocado',
  contactLoop: {
    nothingToSuppress:
      'Este caso no tiene recordatorios que se puedan desactivar para el paciente: descártalo sin esa opción.',
    suppressionNotFound: 'No encontramos ese recordatorio desactivado.',
    suppressionAlreadyActive: 'Este recordatorio ya está activo de nuevo.',
  },
  contactSkips: {
    clinic_disallows_contact: 'el consultorio no tiene activado el contacto con pacientes',
    patient_opted_out: 'el paciente pidió no recibir mensajes',
    backfill_case: 'el caso viene de la revisión del historial',
    low_confidence: 'el caso se apoya en una condición sin confirmar',
    contact_data_invalid: 'el número del paciente está marcado como equivocado',
    contact_window: 'ya se le escribió hace pocos días',
    patient_answered: 'el paciente ya respondió',
    already_requested: 'la llamada ya estaba pedida',
  },
  contactDenials: {
    clinic_disallows_contact: 'El consultorio no tiene activado el contacto con pacientes.',
    patient_opted_out:
      'El paciente pidió no recibir mensajes del consultorio. Contáctalo por otra vía y luego resuelve el caso.',
    contact_window:
      'Ya se pidió contactar a este paciente hace pocos días. Espera a que responda o contáctalo por otra vía.',
    backfill_case:
      'Este caso viene de la revisión del historial: el equipo decide a quién contactar.',
    low_confidence: 'El caso se apoya en una condición sin confirmar: revísala antes de contactar.',
    contact_data_invalid:
      'El número del paciente está marcado como equivocado: corrígelo en el sistema del consultorio.',
  },
  resolutions: {
    fulfilled: 'Resuelto: se cumplió lo pendiente',
    handled_outside: 'Resuelto por el equipo',
    not_needed: 'Cerrado: ya no hace falta',
    patient_declined: 'Cerrado: el paciente no quiso continuar',
    patient_unreachable: 'Cerrado: no se pudo contactar al paciente',
  },
  closedReasons: {
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
    suppressed_for_patient: 'El equipo dejó de recordarlo para este paciente',
    // Only an episodic protocol closes (today, pregnancy). Says the episode
    // ended, never how (delivery or loss).
    protocol_closed: 'El protocolo terminó: se registró el fin del embarazo',
    // Everything a pregnancy asked for (prenatal labs, ultrasounds, the next
    // prenatal control) once it ended. Never says how it ended.
    pregnancy_ended: 'El embarazo terminó: no queda nada prenatal pendiente',
    rescheduled_by_protocol: 'Reprogramado: el protocolo pide el mismo control antes',
    corrected_by_clinician: 'Corregido por el equipo clínico',
    rejected_by_clinician: 'Rechazado por el equipo clínico: la nota no lo pedía',
    // A treatment protocol whose patient has no active prescription left (HIP-139).
    // Neutral: never names the drug or the condition.
    treatment_ended: 'Terminó el tratamiento que lo motivaba',
    // Clinical audit 2026-10-27: episodes, horizons and one request per test.
    episode_closed: 'Una consulta posterior dio de alta al paciente: el episodio terminó',
    past_relevance_horizon: 'Ya no es relevante: el episodio al que pertenecía terminó hace mucho',
    superseded_by_new_request: 'Una orden o un plan más reciente pide el mismo examen',
    covered_by_order: 'La orden de la misma consulta ya pide este examen',
    covered_by_other_visit: 'Otro motivo pendiente cubre la misma consulta',
    not_reordered: 'No se volvió a pedir en las consultas siguientes: el médico lo dejó',
  },
  escalationSteps: {
    notify_clinic: 'Aviso al responsable',
    raise_priority: 'Aumento de prioridad',
    request_patient_contact: 'Pedido de contacto al paciente',
    escalate_to_coordinator: 'Paso a coordinación',
    mark_lost_to_follow_up: 'Cierre como perdido en seguimiento',
  },
  phoneCallStep: 'Llamada del equipo al paciente',
  stepWithChannel: (step, channel) => `${step}: ${channel}`,
  escalationActions: {
    notify_clinic: 'Aviso al responsable del caso',
    raise_priority: 'Prioridad aumentada por falta de respuesta',
    request_patient_contact: 'Se pidió al sistema del consultorio contactar al paciente',
    escalate_to_coordinator: 'Escalado a coordinación del consultorio',
    mark_lost_to_follow_up: 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
  },

  transitions: {
    statusPhrases: {
      open: 'está abierto',
      notified: 'ya fue avisado',
      snoozed: 'está pospuesto',
      escalated: 'está escalado',
      resolved: 'ya está resuelto',
      dismissed: 'ya está descartado',
      lost_to_follow_up: 'ya está cerrado como perdido en seguimiento',
    },
    verbs: {
      open: 'reabrir',
      notified: 'marcar como avisado',
      snoozed: 'posponer',
      escalated: 'escalar',
      resolved: 'resolver',
      dismissed: 'descartar',
      lost_to_follow_up: 'cerrar como perdido en seguimiento',
    },
    requestContactVerb: 'pedir contacto para',
    changeVerb: 'cambiar',
    changedState: 'cambió de estado',
    cannot: (action, state) => `No se puede ${action} este caso: ${state}.`,
  },

  timeline: {
    opened: (reason) => `Caso abierto: ${reason}`,
    reasonAdded: (reason) => `Motivo agregado: ${reason}`,
    released: 'Entró a la bandeja desde la revisión del historial',
    notifiedByUser: 'Marcado como avisado: el equipo se encarga de contactar al paciente',
    notifiedBySystem: 'Aviso al responsable del caso',
    assigned: (person) => `Asignado a ${person}`,
    snoozed: 'Pospuesto',
    snoozedUntil: (date) => `Pospuesto hasta el ${date}`,
    escalated: 'Escalado',
    callAfterWrongNumber: 'Llamada pedida al equipo: el mensaje llegó a un número equivocado',
    call: 'Llamada pedida al equipo: llamar al paciente',
    contactRequested: 'Se pidió al sistema del consultorio contactar al paciente',
    contactRequestedVia: (channel) =>
      `Se pidió al sistema del consultorio escribir al paciente por ${channel}`,
    contactSkipped: 'Contacto omitido',
    contactSkippedBecause: (why) => `Contacto omitido: ${why}`,
    contactOutcome: (outcome, channel) =>
      `Respuesta del contacto${channel === undefined ? '' : ` (${channel})`}: ${outcome}`,
    outcomeRecorded: 'registrada',
    resolved: 'Resuelto',
    resolvedBecause: (label, why) => `${label} (${why})`,
    dismissed: 'Descartado por el equipo',
    dismissedBecause: (reason) => `Descartado por el equipo: ${reason}`,
    reopened: 'Volvió a la bandeja al terminar el plazo pospuesto',
    lostToFollowUp: 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
    useful: 'Marcado como útil',
    notUseful: 'Marcado como no útil',
    bookingOrigins: {
      follow_up_case: 'agendada desde este caso',
      patient_contact: 'agendada tras el pedido de contacto',
      organic: 'agendada por su cuenta',
    },
    appointmentBooked: (date, origin) => `Cita para el ${date} (${origin})`,
    appointmentBookedNoDate: (origin) => `Cita agendada (${origin})`,
    appointmentAttended: 'El paciente asistió a la cita',
    contactRequestedForPatient:
      'Se pidió contactar al paciente (un solo pedido cubre todos sus casos)',
    planItemReviews: {
      plan_item_confirmed: (kind) => `Punto del plan confirmado: ${kind}`,
      plan_item_corrected: (kind) => `Punto del plan corregido: ${kind}`,
      plan_item_rejected: (kind) => `Punto del plan rechazado: ${kind}`,
    },
  },

  patientQueue: {
    noActiveCases: 'Este paciente no tiene casos en la bandeja.',
    planItemNotFound: 'No encontramos ese punto del plan.',
    notAPlanItem:
      'Solo se puede confirmar, corregir o rechazar un punto del plan que la IA leyó de una nota.',
    alreadyReviewed: 'Alguien del equipo clínico ya corrigió o rechazó este punto del plan.',
    planItemClosed: 'Este punto del plan ya está cerrado: no queda nada que corregir ni rechazar.',
    nothingToCorrect: 'Cambia la fecha o el tipo para corregir el punto del plan.',
    invalidDueDate: 'Indica una fecha válida.',
    invalidKind: 'Elige qué pide el punto del plan.',
  },

  why: {
    kinds: {
      note: 'Nota clínica',
      order: 'Orden',
      result: 'Resultado',
      prescription: 'Receta',
      visit: 'Consulta',
      appointment: 'Cita',
      diagnosis: 'Diagnóstico',
      allergy: 'Registro de alergias',
      other: 'Registro',
    },
    anchorRoles: {
      trigger: 'origen',
      note: 'la nota',
      last_visit: 'la última consulta',
      last_done: 'última vez que se hizo',
      enrollment: 'ingreso al protocolo',
      treatment_change: 'inicio o cambio de tratamiento',
      episode_end: 'fin del episodio',
      window_open: 'apertura de la ventana',
      unknown: 'registro',
    },
    dueMath: (due, anchor, date, days) =>
      `Vence el ${due} = ${anchor} (${date}) + ${String(days)} ${days === 1 ? 'día' : 'días'}`,
    dueOnly: (due) => `Vence el ${due} (aquello desde lo que se contó ya no está en la historia)`,
    basis: {
      rule_days: (days) => `La regla da ${String(days)} días desde el origen.`,
      critical_result: (days) =>
        `Resultado crítico: se atiende en ${String(days)} días en lugar del plazo habitual.`,
      treatment_end: (treatmentDays, days) =>
        treatmentDays === undefined
          ? `Contado desde el fin del tratamiento, más ${String(days)} días.`
          : `${String(treatmentDays)} días de tratamiento, más ${String(days)} días después de terminarlo.`,
      plan_date: 'La fecha que el médico indicó en la nota.',
      cadence: (multiplier, interval) =>
        `${String(multiplier)} × el intervalo habitual del paciente, de ${String(interval)} días.`,
      protocol_interval: (days) =>
        `Cada ${String(days)} días, desde la última vez que se hizo (o desde el ingreso al protocolo).`,
      protocol_treatment_change:
        'Un control tras iniciar o cambiar el tratamiento, luego el intervalo regular del protocolo.',
      protocol_gestational_age: (weeks) =>
        weeks === undefined
          ? 'Intervalo prenatal de un embarazo sin fecha.'
          : `Intervalo prenatal a las ${String(weeks)} semanas de gestación.`,
      protocol_gestational_window: 'Vence cuando se cierra la ventana gestacional.',
      protocol_after_outcome: (days) =>
        `Dentro de los ${String(days)} días posteriores al desenlace.`,
      protocol_ckd_stage: (stage) =>
        stage === undefined
          ? 'Intervalo para un estadio de ERC desconocido (el del protocolo por defecto).'
          : `Intervalo para el estadio ${stage} de ERC (KDIGO).`,
    },
    dueAtWeek: (due, week) =>
      `Vence el ${due}, cuando el embarazo llega a las ${String(week)} semanas`,
    tooEarly: (record, date) =>
      `${record} del ${date} llegó demasiado pronto tras el cambio para contar como su control.`,
    bookingTolerance: (days) =>
      days === 0
        ? 'Una cita debe caer en la fecha de vencimiento o antes.'
        : `Una cita hasta ${String(days)} días después del vencimiento todavía cuenta.`,
    days: (count) => `${String(count)} ${count === 1 ? 'día' : 'días'}`,
    fulfill: {
      result: (test, code, equivalents) =>
        `Un resultado de ${test} (${code}${equivalents > 0 ? ' o un código equivalente' : ''}).`,
      orderResult: (test, code) => `El resultado de esta orden: ${test} (${code} o equivalente).`,
      anyResult: (kind) => `Un resultado de ${kind}.`,
      visit: (withBooking) =>
        withBooking ? 'Una consulta, o una cita agendada.' : 'Una consulta.',
      session: (withBooking) => (withBooking ? 'Una sesión, o una cita agendada.' : 'Una sesión.'),
      other: (withBooking) =>
        withBooking ? 'Una consulta, o una cita agendada.' : 'Un registro que lo cumpla.',
    },
    expectKinds: {
      follow_up_visit: 'consulta',
      lab: 'laboratorio',
      imaging: 'imagen',
      session: 'sesión',
      other: 'seguimiento',
    },
    enrollment: {
      diagnosis: (diagnosis, date) => `Diagnóstico codificado ${diagnosis}, registrado el ${date}.`,
      note: (diagnosis, date) => `${diagnosis}, leído de la nota del ${date}.`,
      medication: (medication, date, diagnosis) =>
        `Receta de ${medication} el ${date}: hace probable ${diagnosis} (sin diagnóstico codificado).`,
      results: (count, test, threshold, diagnosis) =>
        `${String(count)} ${count === 1 ? 'resultado' : 'resultados'} de ${test} ${threshold}: hace probable ${diagnosis}.`,
      record: (record, date, diagnosis) => `${record} el ${date}: hace probable ${diagnosis}.`,
      ended: (outcome, date) => `El episodio terminó (${outcome}) el ${date}.`,
      notEnrolled: 'La historia ya no incluye al paciente en este protocolo.',
      unknown: (diagnosis) => `${diagnosis} (el registro que lo respalda ya no está disponible).`,
      activeTreatment: (medication, date) => `Receta activa: ${medication} (${date}).`,
      confirm: (count, days) =>
        `al menos ${String(count)} resultados, con ${String(days)} días o más de separación`,
      outcomes: { delivery: 'parto', loss: 'pérdida gestacional', discharge: 'alta' },
    },
    protocolVersion: (name, version) => `${name} v${version}`,
    draft: 'Borrador: aún sin validar por el equipo clínico',
    validated: 'Validado por el equipo clínico',
    schedule: {
      interval: (days) => `Cada ${String(days)} días.`,
      treatment_change: (afterChange, every, titration) =>
        `${String(afterChange)} días después de iniciar o cambiar la dosis${titration === undefined ? '' : `, ${titration}`}, luego cada ${String(every)} días.`,
      titration: (every, controls) =>
        `cada ${String(every)} días hasta ${String(controls)} controles estables`,
      gestational_age: (intervals) => `Consultas prenatales: ${intervals}.`,
      gestationalInterval: (untilWeek, every) =>
        `cada ${String(every)} días hasta la semana ${String(untilWeek)}`,
      gestational_window: (from, to) =>
        `Una vez entre las semanas ${String(from)} y ${String(to)}.`,
      after_outcome: (outcome, days) =>
        `Una vez dentro de los ${String(days)} días posteriores al ${outcome}.`,
      ckd_stage: (fallback) =>
        `Según el estadio de ERC (KDIGO); cada ${String(fallback)} días si se desconoce el estadio.`,
    },
    cadence: (visits, pattern, interval, multiplier, expected) =>
      interval === undefined || multiplier === undefined
        ? `${String(visits)} consultas de esta especialidad; la próxima se esperaba antes del ${expected}.`
        : `${String(visits)} consultas de esta especialidad (${String(pattern)} forman el patrón): intervalo habitual de ${String(interval)} días, así que la próxima consulta se esperaba dentro de ${String(multiplier)} × ${String(interval)} días, antes del ${expected}.`,
    noPattern: 'Las consultas que forman el patrón ya no están en la historia.',
    closedBy: 'Cerrado por',
    noteBy: (author) => `por ${author}`,
    value: (value, interpretation) =>
      interpretation === undefined ? value : `${value} · ${interpretation}`,
    interpretations: {
      normal: 'normal',
      abnormal: 'alterado',
      unknown: 'sin interpretación',
      critical: 'crítico',
    },
    noKnownAllergy: 'Sin alergias conocidas',
    cancelled: 'cancelada',
    verification: { confirmed: 'confirmado', provisional: 'provisional' },
    durationDays: (days) => `${String(days)} días`,
  },

  sources: {
    types: {
      ServiceRequest: 'Orden',
      MedicationRequest: 'Receta',
      DocumentReference: 'Nota clínica',
      Composition: 'Nota clínica',
      Encounter: 'Consulta',
      Appointment: 'Cita',
      DiagnosticReport: 'Resultado',
      Observation: 'Resultado',
      Condition: 'Diagnóstico',
    },
    onDate: (type, date) => `${type} del ${date}`,
  },
  loinc: {
    '4548-4': 'Hemoglobina glicosilada (HbA1c)',
    '57698-3': 'Perfil lipídico',
    '24331-1': 'Perfil lipídico',
    '2093-3': 'Colesterol total',
    '2571-8': 'Triglicéridos',
    '2085-9': 'Colesterol HDL',
    '18262-6': 'Colesterol LDL',
    '13457-7': 'Colesterol LDL',
    '2160-0': 'Creatinina sérica',
    '2823-3': 'Potasio sérico',
    '3016-3': 'TSH',
    '1558-6': 'Glicemia en ayunas',
    '2345-7': 'Glicemia',
    '14959-1': 'Microalbuminuria (relación albúmina/creatinina)',
    '14957-5': 'Microalbuminuria',
    '718-7': 'Hemoglobina',
    '6690-2': 'Leucocitos',
    '58410-2': 'Hematología completa',
    '24357-6': 'Examen de orina',
    '5811-5': 'Densidad urinaria',
    '10524-7': 'Citología cervicovaginal (Papanicolaou)',
    '11525-3': 'Ecografía obstétrica',
    '24606-6': 'Mamografía bilateral de pesquisa',
    '11524-6': 'Electrocardiograma',
    '36643-5': 'Radiografía de tórax',
    'fundus-exam': 'Fondo de ojo',
  },
  priorities: { urgent: 'Urgente', high: 'Alta', medium: 'Media', low: 'Baja' },
  icd10: {
    E10: 'Diabetes mellitus tipo 1',
    E11: 'Diabetes mellitus tipo 2',
    E13: 'Otra diabetes mellitus especificada',
    E14: 'Diabetes mellitus, no especificada',
    R73: 'Prediabetes',
    E66: 'Obesidad',
    E78: 'Dislipidemia',
    E03: 'Hipotiroidismo',
    E28: 'Síndrome de ovario poliquístico',
    I10: 'Hipertensión arterial',
    N18: 'Enfermedad renal crónica',
    'N18.3': 'Enfermedad renal crónica estadio 3',
    N39: 'Infección urinaria',
    J02: 'Faringitis aguda',
    J03: 'Amigdalitis aguda',
    J06: 'Infección respiratoria alta',
    K29: 'Gastritis',
    M54: 'Lumbalgia',
    R53: 'Astenia',
    F32: 'Episodio depresivo',
    F41: 'Trastorno de ansiedad',
    'F41.0': 'Trastorno de pánico',
    'F41.1': 'Trastorno de ansiedad generalizada',
    F43: 'Trastorno adaptativo',
    F51: 'Insomnio',
    O80: 'Parto',
    Z01: 'Control ginecológico',
    Z30: 'Anticoncepción',
    Z33: 'Estado de embarazo',
    Z34: 'Control de embarazo',
    Z39: 'Control posparto',
    D25: 'Mioma uterino',
    N76: 'Vaginitis',
    B37: 'Candidiasis vulvovaginal',
    N95: 'Climaterio',
  },

  errors: {
    notFound: 'No encontramos lo que buscas.',
    routeNotFound: 'Ruta no encontrada.',
    caseNotFound: 'No encontramos ese caso.',
    patientNotFound: 'No encontramos ese paciente.',
    jobNotFound: 'No encontramos ese trabajo.',
    invalidConditionId: 'Identificador de condición no válido.',
    invalidIdentifier: 'Identificador no válido.',
    invalidCursor:
      'El cursor de paginación no es válido para esta lista. Vuelve a pedir la primera página.',
    conflict: 'La operación entra en conflicto con el estado actual.',
    internal: 'Ocurrió un error inesperado. Intenta de nuevo.',
    invalidJson: 'El cuerpo de la petición no es JSON válido.',
    invalidUrl: 'La dirección de la petición no es válida.',
    controlCharacters: 'La petición tiene caracteres de control en la dirección o los parámetros.',
    missingApiKey: 'Falta la clave de API (Authorization: Bearer).',
    invalidApiKey: 'Clave de API no válida.',
    payloadTooLarge: (kilobytes) => `El cuerpo supera el máximo de ${String(kilobytes)} KB.`,
    insufficientScope: (scope) =>
      `La clave de API no tiene el permiso "${scope}" que necesita esta operación.`,
    rateLimited: 'Demasiadas peticiones. Intenta de nuevo en unos segundos.',
    invalidUser: (maxLength) =>
      `El usuario (X-FollowUp-User) debe tener hasta ${String(maxLength)} caracteres visibles, sin caracteres de control.`,
    invalidData: 'Los datos no son válidos para esta operación.',
    feedbackReasonRequired:
      'Elige un motivo cuando el caso no fue útil: así podemos mejorar la regla.',
    domainValidation: {
      period: 'El período debe empezar antes de terminar y durar como mucho 800 días.',
      until: 'Solo puedes posponer un caso hasta una fecha futura.',
      status: 'El caso ya no está activo: no admite esta acción.',
      reason: 'Indica el motivo cuando el caso no fue útil.',
      note: 'Escribe una nota que explique el motivo.',
      suppressRuleIds: 'Solo puedes dejar de recordar un caso que no aplica a este paciente.',
      ruleId: 'Ese recordatorio no existe en el consultorio.',
      subject: 'La respuesta corresponde a otro paciente.',
      userId: 'Falta identificar a la persona del equipo que hace la revisión.',
    },
    webhookSinkUnavailable: 'El receptor de webhooks no respondió.',
    demoClinicOnly: 'Las consultas de demostración solo se guardan en la clínica de demostración.',
    invalidConsultation: 'No pudimos armar la consulta con esos datos.',
    noteNotRead: (model, error) =>
      `El modelo (${model}) no pudo leer la nota: ${error ?? 'sin respuesta'}. La consulta quedó ` +
      'guardada y la lectura del plan se reintentará automáticamente.',
  },

  validation: {
    required: 'Es obligatorio.',
    mustBe: (what) => `Debe ser ${what}.`,
    typeNames: {
      string: 'un texto',
      number: 'un número',
      int: 'un número entero',
      boolean: 'verdadero o falso',
      array: 'una lista',
      object: 'un objeto',
      date: 'una fecha',
    },
    otherType: 'un valor de otro tipo',
    notEmpty: 'No puede quedar vacío.',
    atMost: 'como máximo',
    atLeast: 'al menos',
    characters: (count) => plural(count, 'carácter', 'caracteres'),
    elements: (count) => plural(count, 'elemento', 'elementos'),
    sized: (limit, amount) => `Debe tener ${limit} ${amount}.`,
    dateTooLate: 'La fecha es demasiado tardía.',
    dateTooEarly: 'La fecha es demasiado temprana.',
    lessThan: (bound) => `Debe ser menor que ${bound}.`,
    greaterThan: (bound) => `Debe ser mayor que ${bound}.`,
    bounded: (limit, bound) => `Debe ser ${limit} ${bound}.`,
    oneOf: (options) => `Elige una de estas opciones: ${options}.`,
    invalidValue: 'El valor no es válido.',
    invalidDate:
      'La fecha no es válida (usa el formato ISO 8601, por ejemplo 2026-01-05T10:00:00Z).',
    invalidFormat: 'El formato no es válido.',
    unrecognizedKeys: (keys) => `Campo(s) no admitido(s): ${keys}.`,
    multipleOf: (divisor) => `Debe ser múltiplo de ${divisor}.`,
    checkRequest: 'Revisa los datos enviados.',
    checkRequestWith: (message) => `Revisa los datos enviados: ${message}`,
    checkField: (field, message) => `Revisa «${field}»: ${message}`,
    moreFields: (head, count) => `${head} (y ${plural(count, 'campo más', 'campos más')})`,
    fields: {
      action: 'Acción',
      assignee: 'Responsable',
      comment: 'Comentario',
      cursor: 'Página',
      days: 'Días',
      limit: 'Cantidad por página',
      note: 'Nota interna',
      noteText: 'Nota de la consulta',
      orders: 'Órdenes',
      origin: 'Origen',
      patient: 'Paciente',
      patientId: 'Paciente',
      patientName: 'Nombre del paciente',
      q: 'Búsqueda',
      query: 'Búsqueda',
      reason: 'Motivo',
      snoozeDays: 'Días para posponer',
      specialty: 'Especialidad',
      type: 'Tipo',
      useful: 'Utilidad',
      view: 'Vista',
    },
    custom: {
      snoozeDaysRequired: 'Indica por cuántos días posponer el caso.',
      dismissReasonRequired: 'Elige por qué descartas el caso.',
      dismissNoteRequired: 'Escribe una nota que explique el motivo.',
      suppressNeedsNotApplicable:
        'Solo puedes dejar de recordar un caso que no aplica a este paciente.',
    },
  },

  reviewer: {
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
        description:
          'Un valor claramente fuera de rango sin consulta, cita ni comentario posterior.',
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
  },
  admin: {
    fields: {
      ruleId:
        'Esa regla no existe para el consultorio. Consulta las reglas con GET /api/admin/rules.',
      dueInDays: 'El plazo debe ser un número entero de días, de 1 a 3650.',
      enabled: 'enabled debe ser true o false.',
      override: 'Indica dueInDays, enabled o ambos (u override: null para restablecer la regla).',
      reason:
        'Indica por qué cambia la regla (de 1 a 500 caracteres): queda en el registro de auditoría.',
      actor: 'Indica quién hace el cambio (X-FollowUp-User): queda en el registro de auditoría.',
      unknownField: 'Solo se pueden ajustar dueInDays y enabled.',
    },
    invalid: 'El cambio de la regla no es válido.',
    staleVersion:
      'Alguien cambió esta regla desde que la leíste. Vuelve a leerla y repite el cambio.',
    unchanged: 'La regla ya funciona así: no hubo cambios.',
    layers: {
      universal: 'Universal',
      doctor_plan: 'Plan del médico',
      cadence: 'Patrón de visitas',
      protocol: 'Protocolo',
    },
  },
  accessGate: {
    title: 'Seguimiento clínico',
    heading: 'Seguimiento clínico',
    intro: 'Esta demo es privada. Escribe el código de acceso que te compartieron.',
    codeLabel: 'Código de acceso',
    submit: 'Entrar',
    wrongCode: 'Ese código no es válido. Revísalo e inténtalo de nuevo.',
    tooManyAttempts: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.',
    required: 'Primero escribe el código de acceso.',
  },
} satisfies ApiMessages;
