import type { Messages } from './types.ts';

/**
 * Spanish UI catalog (neutral Spanish, "tú"): the second locale, for Latin
 * American hosts. Typed against the English catalog: every key and every
 * parameter must match, or the inbox does not compile.
 */

const plurals = new Intl.PluralRules('es');
const numbers = new Intl.NumberFormat('es');

/** "1 caso", "3 casos". */
function count(n: number, one: string, other: string): string {
  return `${numbers.format(n)} ${plurals.select(n) === 'one' ? one : other}`;
}

const common: Messages['common'] = {
  appName: 'Seguimiento',
  clinicFallback: 'Consultorio',
  yourTeam: 'Tu equipo',
  demoSubtitle: 'Demostración',
  clinicSubtitle: 'Consultorio',
  skipToContent: 'Saltar al contenido',
  mainNav: 'Principal',
  retry: 'Reintentar',
  cancel: 'Cancelar',
  gotIt: 'Entendido',
  close: 'Cerrar',
  change: 'Cambiar',
  confirm: 'Confirmar',
  newBadge: 'Nuevo',
  backToInbox: 'Volver a la bandeja',
  goToInbox: 'Ir a la bandeja',
  inboxLink: 'Bandeja',
  viewPatient: 'Ver paciente',
  noValue: '—',
  quoted: (text) => `«${text}»`,
  separator: ' · ',
  useLightTheme: 'Usar tema claro',
  useDarkTheme: 'Usar tema oscuro',
  language: 'Idioma',
  languageNames: { en: 'English', es: 'Español' },
  preferredLanguage: (language) => `Idioma preferido: ${language}`,
};

const nav: Messages['nav'] = {
  inbox: 'Bandeja',
  recovery: 'Por recuperar',
  review: 'Revisión clínica',
  reviewShort: 'Revisión',
  demo: 'Demo',
  simulatedDate: 'Fecha simulada:',
  simulatedDateTitle: 'La API usa un reloj simulado para la demostración',
};

const errors: Messages['errors'] = {
  generic: 'Algo salió mal. Intenta de nuevo.',
  network: 'No pudimos conectar con el servidor. Revisa tu conexión.',
  unexpected: 'El servidor no respondió como esperábamos. Intenta de nuevo.',
  insufficientScope:
    'Tu acceso no permite esta acción. Pide a quien administra el consultorio una clave con ese permiso.',
  rateLimited: 'Demasiadas solicitudes seguidas. Espera unos segundos e intenta de nuevo.',
  payloadTooLarge: 'El texto es demasiado largo. Acórtalo e intenta de nuevo.',
  invalidCursor: 'La lista cambió mientras la recorrías. Vuelve a la primera página.',
  validationFallback: 'Revisa los datos ingresados e intenta de nuevo.',
  loadFailed: 'No pudimos cargar esta información',
  notFoundBody: 'Puede que el enlace esté mal o que ya no exista.',
  pageNotFound: 'Esta página no existe',
  pageNotFoundBody: 'Revisa la dirección o vuelve a la bandeja.',
};

const time: Messages['time'] = {
  dueToday: 'Vence hoy',
  dueTodayPassed: 'Venció hoy',
  overdue: (days) => `Vencido hace ${count(days, 'día', 'días')}`,
  days: (days) => count(days, 'día', 'días'),
  seconds: (value) => `${value} s`,
  milliseconds: (value) => `${value} ms`,
};

const labels: Messages['labels'] = {
  layers: {
    universal: 'Orden o resultado',
    doctor_plan: 'Plan del médico',
    cadence: 'Frecuencia de visitas',
    protocol: 'Protocolo',
  },
  layerDescriptions: {
    universal:
      'Una orden (examen, estudio, referencia) sin resultado registrado, o un resultado alterado sin consulta posterior.',
    doctor_plan: 'Algo que el médico escribió en el plan de la nota y no ha ocurrido.',
    cadence: 'El paciente lleva más tiempo del habitual sin consulta.',
    protocol: 'Un control que el protocolo de su condición indica y nadie ha pedido.',
  },
  draftProtocol: 'Protocolo en borrador · pendiente de validación clínica',
  draftProtocolHint: 'Este protocolo aún no fue validado por el equipo clínico de tu consultorio.',
  protocolPrefix: 'Protocolo:',
  statuses: {
    open: 'Abierto',
    notified: 'Avisado',
    snoozed: 'Pospuesto',
    escalated: 'Escalado',
    resolved: 'Resuelto',
    dismissed: 'Descartado',
    lost_to_follow_up: 'Perdido en seguimiento',
  },
  priorities: { urgente: 'Urgente', alta: 'Alta', media: 'Media', baja: 'Baja' },
  priorityTitle: (priority) => `Prioridad ${String(priority)} de 100`,
  priorityPrefix: 'Prioridad ',
  escalationNone: (total) => `Escalamiento: ningún paso de ${String(total)}`,
  escalationStep: (passed, total) => `Escalamiento: paso ${String(passed)} de ${String(total)}`,
  escalationPrefix: 'Escalamiento: ',
  escalationNext: (step, date) => `Siguiente: ${step}, ${date}`,
  feedbackReasons: {
    wrong_rule: 'La regla no aplica a este paciente',
    wrong_interval: 'El plazo no es el correcto',
    bad_extraction: 'La nota se leyó mal',
    already_handled: 'Ya estaba resuelto',
    other: 'Otro motivo',
  },
  conditionStatuses: {
    confirmed: 'Confirmada',
    probable: 'Probable',
    resolved: 'Resuelta',
    rejected: 'Descartada',
    entered_in_error: 'Registrada por error',
  },
  conditionSources: {
    recorded: 'Registrada por el médico',
    extracted_from_note: 'Leída de la nota por IA',
    inferred_from_medication: 'Inferida por la medicación',
    inferred_from_result: 'Inferida por un resultado',
  },
  expectationStatuses: {
    open: 'En plazo',
    fulfilled: 'Cumplida',
    superseded: 'Reemplazada',
    expired: 'Vencida',
    cancelled: 'Cancelada',
  },
  planKinds: {
    follow_up_visit: 'Control',
    lab: 'Laboratorio',
    imaging: 'Imagen',
    session: 'Sesión',
    other: 'Otro',
  },
  sexes: { female: 'Femenino', male: 'Masculino', other: 'Otro', unknown: 'Sin dato' },
  sexShort: { female: 'F', male: 'M' },
  specialties: {
    diabetology: 'Diabetología',
    internal_medicine: 'Medicina interna',
    psychology: 'Psicología',
    gynecology: 'Ginecología y obstetricia',
  },
  reader: {
    generic: 'Lectura de notas',
    genericName: 'el lector de notas',
    simulated: 'Lectura simulada (sin modelo)',
    simulatedName: 'la lectura simulada',
    openAiCompatible: 'API compatible con OpenAI',
  },
  webhooks: {
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
    'contact.outcome_recorded': 'Resultado del contacto registrado',
    'backfill.completed': 'Revisión del historial terminada',
    'backfill.paused': 'Revisión del historial en pausa',
  },
  actors: {
    rule: 'Regla automática',
    system: 'Motor de seguimiento',
    patient: 'Paciente',
    team: 'Equipo del consultorio',
  },
  hostChannel: 'Canal de la clínica',
  channels: { whatsapp: 'WhatsApp', phone_call: 'Llamada', sms: 'SMS', email: 'Correo' },
  contactOutcomes: {
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
  sourceTypes: {
    ServiceRequest: 'Orden',
    DocumentReference: 'Nota clínica',
    PlanDefinition: 'Protocolo',
    Encounter: 'Consulta',
    MedicationRequest: 'Receta',
    DiagnosticReport: 'Resultado',
    Observation: 'Resultado',
    Condition: 'Diagnóstico',
    Appointment: 'Cita',
    Composition: 'Nota clínica',
  },
  sourceTypeFallback: 'Registro clínico',
  source: (type, display) => `${type} — ${display}`,
};

const dismiss: Messages['dismiss'] = {
  intro:
    'Descarta el caso si no corresponde hacer seguimiento. El motivo también queda como tu opinión sobre el caso: así ajustamos la regla.',
  reasonLegend: '¿Por qué lo descartas?',
  noteLabelRequired: 'Nota interna',
  suppressLabel: 'Dejar de recordarlo para este paciente',
  suppressHint: (patientName) =>
    `El motor no volverá a abrirlo para ${patientName}; los demás pacientes no cambian. Puedes volver a activarlo desde su ficha.`,
  suppressListTitle: 'Deja de recordar:',
  suppressKept: (kept) =>
    `Lo que pidió el médico o un resultado sigue activo para el paciente (${kept.join(', ')}): solo se descarta en este caso.`,
  nothingSuppressible:
    'Lo que pidió el médico o un resultado no se puede desactivar para el paciente: solo se descarta este caso.',
  wrongDiagnosisBefore: 'Si el diagnóstico no corresponde, recházalo en la',
  wrongDiagnosisLink: 'ficha del paciente',
  wrongDiagnosisAfter: ': así se cancelan todos los recordatorios que dependen de él.',
  reasonHints: {
    handled_elsewhere: 'El paciente ya lo resolvió en otro centro.',
    already_done: 'Ocurrió, pero el sistema del consultorio no lo registró.',
    not_applicable_to_patient:
      'Por su situación, este recordatorio no corresponde a este paciente.',
    wrong_diagnosis: 'El caso se apoya en un diagnóstico que el paciente no tiene.',
    wrong_interval: 'Se pidió antes de tiempo o con un plazo que no corresponde.',
    other: 'Cuéntanos en la nota por qué lo descartas.',
  },
};

const validation: Messages['validation'] = {
  dismissReasonRequired: 'Elige por qué descartas el caso.',
  dismissNoteRequired: 'Cuéntanos el motivo en la nota.',
  suppressOnlyNotApplicable: 'Solo puedes dejar de recordarlo si no aplica a este paciente.',
  nothingToSuppress:
    'Este caso no tiene recordatorios que se puedan desactivar para el paciente: descártalo sin esa opción.',
  callOutcomeRequired: 'Elige qué pasó con la llamada.',
  caseClosed: 'Este caso ya está cerrado.',
  noPendingCall: 'Este caso no tiene una llamada pendiente.',
  suppressionAlreadyActive: 'Ese recordatorio ya está activo.',
  snoozeDays: (max) => `Indica un número de días entre 1 y ${String(max)}.`,
  noteTooLong: (limit) =>
    `La nota puede tener hasta ${limit} caracteres. Acórtala e intenta de nuevo.`,
  commentTooLong: (limit) => `El comentario puede tener hasta ${limit} caracteres.`,
  feedbackReasonRequired: 'Elige un motivo para continuar: así sabemos qué ajustar.',
  patientRequired: 'Escribe el nombre del paciente o elige uno existente.',
  patientNameTooLong: (limit) => `El nombre puede tener hasta ${limit} caracteres.`,
  noteRequired: 'Escribe la nota de la consulta (al menos 20 caracteres) o usa un ejemplo.',
};

const contact: Messages['contact'] = {
  title: 'Contacto con el paciente',
  empty:
    'Aún no se intentó contactar al paciente por este caso. El motor lo pide según la política de escalamiento.',
  attemptTitle: (attempt, channel) => `Intento ${String(attempt)} · ${channel}`,
  waitsUntil: (date) => `espera respuesta hasta el ${date}`,
  answerWindow: (date) => `plazo de respuesta: ${date}`,
  outcomePrefix: 'Resultado:',
  senderTeam: 'el equipo',
  senderHost: 'sistema del consultorio',
  triggers: {
    policy: 'Según la política del caso',
    user: 'Pedido por el equipo',
    wrong_number: 'Adelantada por un número equivocado',
  },
  flagBody: (when) =>
    `${when}: el teléfono registrado no es del paciente. No enviamos más mensajes hasta que el sistema del consultorio lo actualice; las llamadas del equipo siguen.`,
  callTitle: 'Llamar al paciente',
  callOutcomesGroup: '¿Qué pasó con la llamada?',
  callWrongNumber: (patientName) =>
    `El mensaje le llegó a otra persona: llama a ${patientName} y confirma su teléfono.`,
  callUnanswered: (patientName) =>
    `Los mensajes no tuvieron respuesta: llama a ${patientName} y cuéntanos qué pasó.`,
  callOverdue: (date) => `Debía hacerse antes del ${date}.`,
  callDue: (date) => `Hazla antes del ${date}.`,
  dismissalTitle: 'Por qué se descartó',
  dismissalFeedbackNote: 'El motivo cuenta como tu opinión sobre el caso: así ajustamos la regla.',
  suppressedTitle: 'Dejó de recordarse para este paciente',
  reactivatedSuffix: ' (reactivado)',
  dismissalPatientLink: 'Ver o reactivar en la ficha del paciente',
};

const suppressions: Messages['suppressions'] = {
  title: 'Recordatorios desactivados',
  intro:
    'Recordatorios que el equipo marcó como «No aplica a este paciente». El motor no los vuelve a abrir para este paciente; al resto de los pacientes les siguen aplicando.',
  empty: 'Ningún recordatorio desactivado.',
  history: (n) => `Reactivados (${String(n)})`,
  caseLink: 'Ver el caso descartado',
  reactivate: 'Volver a activar',
  reactivatedBadge: 'Reactivado',
  reactivatedBy: (by, date) => `Reactivado${by ? ` por ${by}` : ''} el ${date}`,
  reactivatedDone: 'Listo: el motor vuelve a recordarlo para este paciente.',
};

const stats: Messages['stats'] = {
  loading: 'Cargando resumen',
  error: 'No pudimos cargar el resumen',
  region: 'Resumen',
  activeCases: 'Casos activos',
  escalated: (n) => count(n, 'escalado', 'escalados'),
  snoozed: (n) => count(n, 'pospuesto', 'pospuestos'),
  byLayer: 'Por capa',
  usefulness: 'Utilidad según el equipo',
  noFeedback: 'Aún no hay casos calificados',
  usefulOf: (n) => `útiles, de ${count(n, 'caso calificado', 'casos calificados')}`,
  readingCost: 'Costo de lectura del mes',
  aiCost: 'Costo de IA del mes',
  notesRead: (n) => count(n, 'nota leída', 'notas leídas'),
  perNote: (cost) => `${cost} por nota`,
};

const evidence: Messages['evidence'] = {
  title: 'Cita textual de la nota',
  readBy: (name) => `Leída por ${name}`,
  noteOf: (date) => `nota del ${date}`,
};

const caseActions: Messages['caseActions'] = {
  notifyTitle: 'Pedir contacto con el paciente',
  notifyConfirm: 'Pedir contacto',
  notifyDone: 'Listo: le pedimos al sistema del consultorio que contacte al paciente.',
  snoozeTitle: 'Posponer el caso',
  snoozeConfirm: 'Posponer',
  snoozeDone: 'Caso pospuesto.',
  resolveTitle: 'Resolver el caso',
  resolveConfirm: 'Resolver caso',
  resolveDone: 'Caso resuelto.',
  dismissTitle: 'Descartar el caso',
  dismissConfirm: 'Descartar caso',
  dismissDone: 'Caso descartado.',
  notify: 'Pedir contacto',
  snooze: 'Posponer',
  resolve: 'Resolver',
  dismiss: 'Descartar',
  patientMessage: (firstName) =>
    `Hola, ${firstName}. Tienes un control pendiente con tu equipo de salud. Responde este mensaje para agendar tu cita.`,
  noMessages: (patientName) =>
    `${patientName} no acepta mensajes del consultorio. Contáctalo por otra vía y luego resuelve el caso.`,
  notifyBody: (patientName) =>
    `Enviaremos un aviso al sistema del consultorio para que contacte a ${patientName} por su canal habitual.`,
  messagePreview: 'Mensaje que recibirá el paciente',
  messagePrivacy: 'Sin diagnósticos, resultados ni nombres de exámenes.',
  snoozeFor: 'Posponer por',
  snoozeOther: 'Otro plazo (días)',
  snoozeBack: (date) => `Volverá a la bandeja el ${date}.`,
  snoozePlaceholder: 'Por ejemplo, 10',
  noteOptional: 'Nota interna (opcional)',
  noteHint: (limit) => `Solo la ve el equipo. Hasta ${limit} caracteres.`,
  resolvePlaceholder: 'Por ejemplo: trajo el resultado, ya está cargado',
};

const caseDetail: Messages['caseDetail'] = {
  dueBefore: (date) => `Debía ocurrir antes del ${date}`,
  origin: (source) => `Origen: ${source}`,
  internalNote: 'Nota interna: ',
  stepSkipped: 'No aplicó en este caso',
  stepDoneOn: (date) => `Hecho el ${date}`,
  stepDone: 'Hecho',
  stepScheduled: (date) => `Programado para el ${date}`,
  stepPlanned: (date) => `Previsto para el ${date} si nadie actúa`,
  stepNeverRan: 'No llegó a ejecutarse: el caso se cerró antes',
  stepOnEntry: 'Al entrar el caso a la bandeja',
  stepAfterDays: (days) => `${count(days, 'día', 'días')} sin respuesta, según la política`,
  noMessages: 'No acepta mensajes',
  contactNotAllowed: 'Contacto no permitido',
  contactAllowed: 'Contacto permitido',
  lastContact: (when) => `Último contacto ${when}`,
  noContacts: 'Sin contactos registrados',
  owner: (name) => `Responsable: ${name}`,
  recovered: 'Recuperado del historial',
  openedAgo: (when) => `Abierto ${when}`,
  suggestedStep: 'Siguiente paso sugerido',
  snoozedUntil: (date) => `Pospuesto hasta el ${date}`,
  closedNotice: (status) =>
    `Este caso está cerrado (${status}). Si el paciente vuelve a tener algo pendiente, el motor abrirá un caso nuevo.`,
  reasons: 'Motivos',
  quotesNote: 'Las citas resaltadas son texto literal de la nota del médico, no una paráfrasis.',
  escalation: 'Escalamiento',
  escalationIntro:
    'Lo que hace el motor si nadie responde, según la política de este caso. Pedir contacto o posponer el caso reinicia la espera.',
  escalationSnoozed: (date) =>
    `Pospuesto hasta el ${date}: mientras tanto no avanza, y la espera de cada paso se cuenta desde ese día.`,
  feedbackTitle: '¿Te sirvió este caso?',
  history: 'Historial del caso',
  loading: 'Cargando caso',
  error: 'No pudimos cargar el caso',
  notFound: 'No encontramos ese caso',
  standaloneTitle: 'Detalle del caso',
};

const feedback: Messages['feedback'] = {
  useful: 'Útil',
  notUseful: 'No útil',
  markedUseful: 'Marcaste este caso como útil.',
  markedNotUseful: 'Marcaste este caso como no útil',
  reasonSuffix: (reason) => `: ${reason}.`,
  whyNot: '¿Por qué no fue útil?',
  comment: 'Comentario (opcional)',
  send: 'Enviar comentario',
};

const inbox: Messages['inbox'] = {
  title: 'Bandeja de seguimiento',
  intro:
    'Pacientes con algo pendiente, ordenados por prioridad. Cada caso reúne los motivos de un paciente por un mismo tipo de seguimiento: si tiene pendientes de distinto tipo, aparece en más de un caso.',
  views: { active: 'Activos', closed: 'Cerrados', all: 'Todos' },
  viewGroup: 'Estado de los casos',
  empty: {
    active: {
      title: 'No hay casos activos',
      body: 'Todos los pacientes tienen su seguimiento al día. Los casos nuevos aparecen aquí apenas una expectativa vence.',
    },
    closed: {
      title: 'Aún no hay casos cerrados',
      body: 'Los casos resueltos o descartados aparecen aquí.',
    },
    all: {
      title: 'Aún no hay casos',
      body: 'Los casos aparecen cuando una expectativa vence sin cumplirse.',
    },
  },
  noResults: 'Sin resultados',
  noMatches: (search) => `No hay casos de pacientes que coincidan con «${search}» en esta vista.`,
  noOwnerCases: (owner) => `No hay casos de ${owner} en esta vista.`,
  thisOwner: 'este responsable',
  cases: 'Casos',
  searchLabel: 'Buscar paciente',
  searchPlaceholder: 'Buscar paciente por nombre',
  clearSearch: 'Borrar búsqueda',
  ownerLabel: 'Responsable',
  allOwners: 'Todos los responsables',
  loading: 'Cargando casos',
  error: 'No pudimos cargar los casos',
  showing: (shown, total) => `Mostrando ${String(shown)} de ${count(total, 'caso', 'casos')}`,
  loadMore: 'Cargar más casos',
  selectTitle: 'Elige un caso de la lista',
  selectBody:
    'Verás todos los motivos del paciente, la evidencia citada de la nota y el siguiente paso sugerido.',
};

const caseRow: Messages['caseRow'] = {
  age: (years) => `${String(years)} años`,
  moreReasons: (n) => `+${count(n, 'motivo', 'motivos')}`,
  releaseNever: 'No entra sola a la bandeja (pendiente muy antiguo)',
  releaseToday: (date) => `Entra a la bandeja hoy (${date})`,
  releaseTomorrow: (date) => `Entra a la bandeja mañana (${date})`,
  releaseOn: (date) => `Entra a la bandeja el ${date}`,
};

const patient: Messages['patient'] = {
  confidence: 'Confianza',
  confidenceValue: (percent) => `${percent} de confianza`,
  icd10: (code) => `CIE-10 ${code}`,
  readFromNoteSimulated: 'Leída de la nota (lectura simulada)',
  rejectedBy: {
    host: 'Descartada por el sistema del consultorio',
    clinician: 'Descartada por el equipo',
  },
  evidence: 'Evidencia:',
  reviewPrompt:
    '¿Es correcta? Si la confirmas, sus controles de protocolo quedan firmes; si la descartas, se cancelan.',
  confirm: 'Confirmar',
  reject: 'Descartar',
  deadline: (date) => `Fecha límite: ${date}`,
  closedReason: (reason) => `Motivo del cierre: ${reason}`,
  back: 'Bandeja',
  age: (years) => count(years, 'año', 'años'),
  noDemographics: 'Sin edad ni sexo registrados',
  noMessages: 'No acepta mensajes',
  contactAllowed: 'Contacto permitido',
  lastContact: (when) => `Último contacto ${when}`,
  noContacts: 'Sin contactos registrados',
  conditions: 'Condiciones',
  probableOne:
    'Hay una condición probable leída de las notas. Revísala: mientras no la confirmes, nadie contacta al paciente por ella.',
  probableMany: (n) =>
    `Hay ${String(n)} condiciones probables leídas de las notas. Revísalas: mientras no las confirmes, nadie contacta al paciente por ellas.`,
  noConditions: 'Sin condiciones registradas.',
  ruledOut: (n) => `Descartadas (${String(n)})`,
  openExpectations: 'Expectativas abiertas',
  nothingPending: 'Nada pendiente.',
  closedExpectations: 'Expectativas cerradas',
  noClosed: 'Aún no hay expectativas cerradas.',
  quality: 'Calidad de la documentación',
  qualityOk: 'Las notas de este paciente tienen plan de seguimiento.',
  truncated: (date) =>
    `La nota del ${date} es más larga de lo que se lee: se leyeron su inicio y su final, no la parte del medio. Revisa la nota por si el plan pide algo más.`,
  noPlan: (date) =>
    `La nota del ${date} no indica cuándo debe volver el paciente. Sin plan, el seguimiento depende de la frecuencia habitual de la especialidad.`,
  loading: 'Cargando paciente',
  error: 'No pudimos cargar el paciente',
  notFound: 'No encontramos ese paciente',
};

const recovery: Messages['recovery'] = {
  title: 'Pacientes por recuperar',
  intro: 'Pacientes que perdieron su seguimiento antes de que el consultorio usara el motor.',
  noticeTitle: 'No son notificaciones.',
  noticeBody:
    'Salieron de revisar el historial del consultorio. Nadie recibe avisos por ellos todavía: entran a la bandeja poco a poco, por prioridad y con un tope diario por responsable, para que el equipo pueda atenderlos sin saturarse.',
  loading: 'Cargando pacientes',
  error: 'No pudimos cargar la lista',
  emptyTitle: 'No quedan pacientes por recuperar',
  emptyBody: 'Todos los pacientes del historial ya están en la bandeja.',
  waiting: (n) => `${count(n, 'paciente', 'pacientes')} en espera, por prioridad`,
};

const demo: Messages['demo'] = {
  daysButton: (days) => `+${count(days, 'día', 'días')}`,
  releasedNone: (left) =>
    `Ningún paciente de «Por recuperar» entró a la bandeja (quedan ${String(left)}).`,
  released: (released, left) =>
    `${released === 1 ? 'Entró' : 'Entraron'} ${count(released, 'paciente', 'pacientes')} de «Por recuperar» a la bandeja (${
      left === 0 ? 'ya no queda ninguno' : left === 1 ? 'queda 1' : `quedan ${String(left)}`
    }).`,
  simulatedDate: 'Fecha simulada',
  advance: 'Avanzar el tiempo',
  passed: (days) => (days === 1 ? 'Pasó 1 día' : `Pasaron ${count(days, 'día', 'días')}`),
  engineRan: '. El motor revisó los vencimientos y escaló los casos sin respuesta',
  activeCases: ': casos activos',
  viewInbox: 'Ver la bandeja',
  clockHint:
    'Cada salto ejecuta lo que el motor haría con el paso de los días: vencer expectativas, abrir o agrupar casos y escalarlos.',
  signatureValid: 'Firma válida',
  signatureInvalid: 'Firma inválida',
  delivered: 'Entregado',
  pendingDelivery: 'Pendiente de entrega',
  viewContent: 'Ver contenido',
  webhookContent: (type) => `Contenido del webhook ${type}`,
  webhookFilters: {
    all: 'Todos los eventos',
    opened: 'Casos abiertos',
    escalated: 'Casos escalados',
    contact: 'Pedidos de contacto',
    resolved: 'Casos cerrados',
    backfill: 'Revisión del historial',
  },
  webhooksTitle: 'Eventos enviados al sistema del consultorio',
  webhooksIntro:
    'Webhooks firmados: así el sistema del consultorio se entera de cada caso y decide cómo contactar al paciente. Se muestran los últimos 30.',
  eventType: 'Tipo de evento',
  loadingEvents: 'Cargando eventos',
  eventsError: 'No pudimos cargar los eventos',
  noEvents: 'Aún no hay eventos',
  noEventsBody: 'Aparecen cuando el motor abre, escala o cierra un caso.',
  loading: 'Cargando demostración',
  clockError: 'No pudimos consultar el reloj de la API',
  unavailableTitle: 'Demostración no disponible',
  unavailableBody: 'El panel de demostración solo funciona cuando la API usa el reloj simulado.',
  title: 'Demostración',
  introSimulated:
    'De la consulta al caso: guarda una nota, mira lo que entiende la lectura simulada y adelanta el reloj para ver cómo el motor abre y escala casos.',
  introModel: (name) =>
    `De la consulta al caso: guarda una nota, mira lo que lee ${name} y adelanta el reloj para ver cómo el motor abre y escala casos.`,
};

const consultation: Messages['consultation'] = {
  title: 'Nueva consulta',
  introSimulated:
    'Simula que el médico guarda una consulta en el sistema del consultorio. El motor la recibe como FHIR y la lee con reglas (lectura simulada, sin modelo).',
  introModel: (name) =>
    `Simula que el médico guarda una consulta en el sistema del consultorio. El motor la recibe como FHIR y ${name} lee la nota.`,
  useExample: 'Usar un ejemplo',
  patient: 'Paciente',
  newPatient: 'Paciente nuevo',
  specialty: 'Especialidad',
  newPatientName: 'Nombre del paciente nuevo',
  namePlaceholder: 'Nombre y apellido (ficticio)',
  note: 'Nota de la consulta',
  noteHint: (limit) =>
    `Escribe como lo haría el médico. Solo datos ficticios, hasta ${limit} caracteres.`,
  orders: 'Órdenes de laboratorio (opcional)',
  reading: 'Leyendo la nota…',
  save: 'Guardar consulta',
  examples: {
    'diabetes-plan': 'Diabetes con plan',
    'psychology-plan': 'Psicología con sesiones',
    'gynecology-no-plan': 'Ginecología sin plan',
    'english-hypertension': 'Hipertensión (nota en inglés)',
  },
  labs: {
    '4548-4': 'HbA1c',
    '57698-3': 'Perfil lipídico',
    '14957-5': 'Microalbuminuria',
    '2160-0': 'Creatinina sérica',
    '3016-3': 'TSH',
    '58410-2': 'Hemograma completo',
  },
};

const extraction: Messages['extraction'] = {
  legend: { plan: 'Plan del médico', condition: 'Condición', medication: 'Medicamento' },
  annotatedNote: 'Nota con las citas marcadas',
  noCaseYet:
    'Aún no hay un caso abierto para este paciente: se abre cuando una expectativa vence sin cumplirse. Adelanta el reloj para verlo.',
  casesOpened: (n) =>
    n === 1
      ? 'El motor abrió un caso para este paciente'
      : `El motor abrió ${String(n)} casos para este paciente`,
  viewCase: 'Ver caso',
  viewCaseOf: (name) => ` de ${name}`,
  readingOf: (model) => `Lectura de ${model}`,
  introSimulated:
    'Lo que las reglas de la demostración entendieron de la nota (ningún modelo de IA la leyó), con la cita exacta de cada dato.',
  introModel: 'Lo que el modelo entendió de la nota, con la cita exacta de cada dato.',
  noteLanguage: (language) => `Nota leída en: ${language}`,
  noPlanTitle: 'Nota sin plan de seguimiento.',
  noPlanBody:
    'Se registró como hallazgo de calidad. El seguimiento queda a cargo de la frecuencia habitual y del protocolo.',
  plan: 'Plan del médico',
  noPlanItems: 'La nota no indica próximos pasos.',
  dueConfidence: (date, percent) => `Antes del ${date} · ${percent} de confianza`,
  conditions: 'Condiciones',
  probable: (percent) => `Probable · ${percent}`,
  medications: 'Medicamentos',
  expectations: 'Expectativas creadas',
  expectationsIntro:
    'Lo que el motor espera que ocurra. Si una fecha pasa sin que ocurra, se abre un caso en la bandeja.',
  dueBefore: (date) => `Antes del ${date}`,
  viewBundle: 'Ver el Bundle FHIR que recibió el motor',
  bundleRegion: 'Bundle FHIR en JSON',
  placeholderTitle: 'Lectura de la nota',
  readingNote: 'Leyendo la nota',
  placeholderBody:
    'Guarda una consulta para ver qué se entiende de la nota: el plan del médico con su cita textual, las condiciones probables y las expectativas que crea el motor.',
};

const review: Messages['review'] = {
  categories: {
    pre_visit_question: 'Para preguntar en la próxima consulta',
    lab_trend: 'Tendencia de laboratorio',
    vital_trend: 'Tendencia de signos vitales',
    abnormal_result_no_followup: 'Resultado alterado sin seguimiento',
    drug_interaction: 'Interacción entre medicamentos',
    drug_condition_conflict: 'Medicamento y condición',
    unaddressed_symptom: 'Síntoma sin estudiar',
    missing_screening: 'Control preventivo pendiente',
    record_quality: 'Calidad del registro',
    utilization_change: 'Cambio en el uso del consultorio',
    similar_patients: 'Pacientes similares',
  },
  severities: { high: 'Alta', medium: 'Media', low: 'Baja' },
  verdicts: { relevant: 'Relevante', already_known: 'Ya lo sabía', not_relevant: 'No relevante' },
  citationKinds: {
    note: 'Nota clínica',
    result: 'Resultado',
    medication: 'Medicamento',
    condition: 'Diagnóstico',
  },
  testNames: {
    creatinine: 'la creatinina',
    egfr: 'el filtrado glomerular',
    hba1c: 'la HbA1c',
    glucose: 'la glucosa',
    ldl: 'el colesterol LDL',
    potassium: 'el potasio',
    hemoglobin: 'la hemoglobina',
    uacr: 'la albuminuria',
    systolic_bp: 'la presión sistólica',
    diastolic_bp: 'la presión diastólica',
    weight: 'el peso',
  },
  steps: {
    labTrend: (test) =>
      test === undefined
        ? 'Consultó la tendencia de un valor'
        : `Consultó la tendencia ${test.startsWith('el ') ? `del ${test.slice(3)}` : `de ${test}`}`,
    searchNotes: (query) => `Buscó «${query}» en las notas`,
    readNotes: (n) =>
      n > 0 ? `Leyó ${count(n, 'nota completa', 'notas completas')}` : 'Leyó notas',
    medications: 'Revisó la lista de medicamentos',
    openFollowUps: 'Revisó los seguimientos que el motor ya tiene abiertos',
    interaction: (a, b) =>
      a && b ? `Verificó la interacción ${a} + ${b}` : 'Verificó una interacción',
    submitted: (n) =>
      n === undefined ? 'Entregó sus hallazgos' : `Entregó ${count(n, 'hallazgo', 'hallazgos')}`,
    unknownTool: (tool) => `Pidió una herramienta desconocida (${tool})`,
  },
  outcomes: {
    ok: 'Correcto',
    invalid_arguments: 'Argumentos inválidos: se le devolvió el error',
    unknown_tool: 'Herramienta inexistente: se le devolvió el error',
    tool_budget_exhausted: 'Sin llamadas disponibles: se le pidió entregar',
  },
  summaries: {
    points: (n) => `${n} valores`,
    notFound: 'sin datos en la historia',
    expectations: (expectations, cases) => `${expectations} expectativas, ${cases} casos`,
    notesMatch: (n) => `${n} notas coinciden`,
    notes: (n) => `${n} notas`,
    medications: (n) => `${n} medicamentos`,
    findings: (n) => `${n} hallazgos`,
    noInteraction: 'sin interacción en la tabla',
    interaction: (severity) => `interacción ${severity}`,
    severityWords: { low: 'baja', medium: 'media', high: 'alta' },
  },
  stopReasons: {
    submitted: 'Entregó sus hallazgos',
    step_limit: 'Llegó al límite de pasos',
    token_budget: 'Llegó al límite de tokens',
    llm_budget: 'Presupuesto de IA del mes agotado',
    error: 'El modelo no respondió',
    detectors_only: 'Solo detectores (sin modelo)',
    no_enabled_category: 'Ninguna categoría activa',
  },
  discards: {
    no_citation: 'sin cita',
    unknown_document: 'citaba un documento inexistente',
    quote_not_found: 'la cita no estaba en el documento',
    quote_too_short: 'cita demasiado corta',
    category_disabled: 'categoría desactivada',
    category_reserved: 'categoría reservada',
    patient_directed: 'dirigido al paciente',
    duplicate: 'repetido (últimos 90 días)',
    merged: 'fusionado con otro',
  },
  origins: {
    confirmed: 'Detectado por reglas y confirmado por el agente',
    added: 'Encontrado por el agente',
    fallback: 'Detectado por reglas (el agente no pudo revisarlo)',
  },
  page: {
    title: 'Revisión clínica',
    intro:
      'Lo que el revisor clínico encontró en las historias: sugerencias con evidencia citada, nunca decisiones. Califica cada una para medir su precisión por categoría.',
    categoriesLink: 'Categorías',
    selectTitle: 'Elige un hallazgo de la lista',
    selectBody:
      'Verás la evidencia citada, cómo llegó el agente a la conclusión y podrás calificarlo.',
  },
  banner: {
    shadowStrong: 'Modo sombra: el equipo médico no ve estos hallazgos.',
    shadowRest: 'Revísalos para validar cada categoría antes de activarla.',
    liveStrong: 'En vivo:',
    liveRest: 'estos hallazgos son de categorías ya validadas y el equipo médico sí los ve.',
  },
  metrics: {
    ariaLabel: 'Métricas del revisor',
    loading: 'Cargando métricas',
    error: 'No pudimos cargar las métricas',
    patients: 'Pacientes revisados',
    patientsHint: (runs) => `${count(runs, 'revisión', 'revisiones')} en 90 días`,
    per100: 'Hallazgos por 100 pacientes',
    per100Hint: (discarded) =>
      `${count(discarded, 'descartado', 'descartados')} por no tener cita válida`,
    cost: 'Costo medio por revisión',
    costHint: (calls) => `${calls} consultas del agente por revisión`,
    precision: 'Precisión hasta ahora',
    precisionNone: 'Aún no hay hallazgos calificados',
    precisionHint: (reviewed) => `relevantes, de ${String(reviewed)} calificados`,
  },
  list: {
    title: 'Hallazgos',
    modeGroup: 'Modo',
    modeShadow: 'Sombra',
    modeLive: 'En vivo',
    statusGroup: 'Estado de los hallazgos',
    tabOpen: 'Por revisar',
    tabReviewed: 'Revisados',
    categoryLabel: 'Categoría',
    allCategories: 'Todas las categorías',
    severityLabel: 'Severidad',
    allSeverities: 'Toda severidad',
    optionWithCount: (label, n) => `${label} (${String(n)})`,
    loading: 'Cargando hallazgos',
    error: 'No pudimos cargar los hallazgos',
    emptyTitle: 'Sin hallazgos aquí',
    emptyOpen: 'No quedan hallazgos por revisar con estos filtros.',
    emptyReviewed: 'Aún no calificaste hallazgos con estos filtros.',
    loadMore: 'Cargar más hallazgos',
  },
  row: { severityPrefix: 'Severidad: ', covered: 'Ya cubierto' },
  detail: {
    back: 'Volver a la revisión',
    shadowBadge: 'Modo sombra',
    liveBadge: 'En vivo',
    detectedOn: (date) => `Detectado el ${date}`,
    suggestionTitle: 'Sugerencia para el equipo',
    suggestionNote: 'Es una sugerencia, no una indicación: decide el médico.',
    coveredTitle: 'Ya lo cubre el seguimiento',
    evidenceTitle: 'Evidencia citada',
    evidenceNote:
      'Cada cita se comprobó palabra por palabra contra el documento antes de guardar el hallazgo.',
    citationCaption: (kind, date) => `${kind} · ${date}`,
    traceTitle: 'Cómo llegó a esto',
    traceToggle: 'Ver los pasos',
    traceFacts: {
      steps: 'Pasos',
      toolCalls: 'Consultas a herramientas',
      cost: 'Costo',
      model: 'Modelo',
      stop: 'Cierre',
      signals: 'Señales de las reglas',
    },
    discardedPrefix: 'Descartado por el motor: ',
    discardedItem: (n, reason) => `${String(n)} ${reason}`,
    verdictTitle: '¿Es relevante este hallazgo?',
    loading: 'Cargando hallazgo',
    error: 'No pudimos cargar el hallazgo',
    notFound: 'No encontramos ese hallazgo',
  },
  trend: {
    caption: (label, unit) => `${label} (${unit})`,
    values: (n) => count(n, 'valor', 'valores'),
    referenceLegend: ' · línea punteada: rango de referencia',
    description: (label, values, unit, range, reference) =>
      `${label}: ${values} ${unit}${range}${reference}.`,
    range: (from, to) => ` entre el ${from} y el ${to}`,
    reference: (parts) => `. Rango de referencia: ${parts}`,
    low: (value) => `mínimo ${value}`,
    high: (value) => `máximo ${value}`,
    dateHeader: 'Fecha',
    valueHeader: (unit) => `Valor (${unit})`,
    cited: ' (citado)',
  },
  verdict: {
    groupLabel: 'Calificación',
    reasonRequiredLabel: '¿Por qué no es relevante?',
    commentLabel: 'Comentario (opcional)',
    submit: 'Enviar',
    change: 'Cambiar',
    reasonRequired: 'Cuéntanos por qué no es relevante: así sabemos qué ajustar.',
    reasonTooLong: (limit) => `El motivo puede tener hasta ${limit} caracteres.`,
    summaryPrefix: 'Calificado como ',
    summaryBy: (user, date) => ` por ${user} el ${date}`,
  },
  flags: {
    back: 'Volver a la revisión',
    title: 'Categorías del revisor',
    intro:
      'Cada categoría empieza apagada y en modo sombra. Pasa a en vivo solo cuando el equipo clínico revisó sus hallazgos y firma la validación.',
    loading: 'Cargando categorías',
    error: 'No pudimos cargar las categorías',
    live: 'En vivo',
    shadow: 'Sombra',
    enabled: 'Activa',
    disabled: 'Apagada',
    noReviews: 'Aún sin calificaciones en modo sombra.',
    reviewStats: (reviewed, relevant, precision) =>
      `${String(reviewed)} calificados · ${String(relevant)} relevantes · precisión ${precision}`,
    validatedBy: (who, date) => `Validada por ${who}${date === undefined ? '' : ` el ${date}`}`,
    promote: 'Pasar a en vivo',
    demote: 'Volver a sombra',
    validatorLabel: '¿Quién del equipo clínico validó esta categoría?',
    validatorPlaceholder: 'Nombre y cargo, por ejemplo Dra. Pérez (coordinación médica)',
    validatorRequired: 'Indica quién del equipo clínico validó esta categoría.',
    validatorHint:
      'En vivo, los médicos verán los hallazgos de esta categoría y el sistema anfitrión los recibirá.',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    reservedBody:
      'Reservada: todavía no existe. Necesita datos de varias clínicas y una validación clínica propia, porque una correlación no es una recomendación.',
  },
  preVisit: {
    title: 'Para preguntar en la próxima consulta',
    suggestedOn: (date) => `Sugerido por el revisor clínico el ${date}`,
  },
};

export const es: Messages = {
  common,
  nav,
  errors,
  time,
  labels,
  dismiss,
  validation,
  contact,
  suppressions,
  stats,
  evidence,
  caseActions,
  caseDetail,
  feedback,
  inbox,
  caseRow,
  patient,
  recovery,
  demo,
  consultation,
  extraction,
  review,
};
