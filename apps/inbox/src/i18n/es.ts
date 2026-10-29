import type { MetricsCopy } from './metrics-copy.ts';
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
  updatedBadge: 'Actualizado',
  backToInbox: 'Volver a la bandeja',
  goToInbox: 'Ir a la bandeja',
  evaluatingAs: (email) => `Evaluando como ${email}`,
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
  metrics: 'Métricas',
  inbox: 'Bandeja',
  recovery: 'Por recuperar',
  review: 'Revisión clínica',
  reviewShort: 'Revisión',
  demo: 'Demo',
  engineTests: 'Pruebas del motor',
  lab: 'Laboratorio',
  evaluators: 'Evaluadores',
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
  priorities: { urgent: 'Urgente', high: 'Alta', medium: 'Media', low: 'Baja' },
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
  labPatientRequired: 'Elige uno de tus pacientes de laboratorio, o crea uno nuevo.',
  labDateRequired: 'Elige una fecha.',
  labDateInFuture: 'Esa fecha es posterior a la fecha actual de tu laboratorio.',
  labDateInPast: 'La fecha de tu laboratorio solo puede avanzar hacia adelante.',
  labDocumentRequired: 'Sube un archivo o pega el texto.',
  labFieldRequired: 'Este campo es obligatorio.',
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
  activePatients: 'Pacientes con casos activos',
  cases: (n) => count(n, 'caso', 'casos'),
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
    'Pacientes con algo pendiente, ordenados por prioridad. Cada tarjeta reúne todos los motivos de un paciente; actúa sobre cada uno de sus casos desde ella.',
  tryYourOwnDocuments: 'Para probar tus propios documentos, ve a',
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
  noMatches: (search) => `No hay pacientes que coincidan con «${search}» en esta vista.`,
  noOwnerCases: (owner) => `No hay pacientes con casos de ${owner} en esta vista.`,
  thisOwner: 'este responsable',
  cases: 'Casos',
  patients: 'Pacientes',
  searchLabel: 'Buscar paciente',
  searchPlaceholder: 'Buscar paciente por nombre',
  clearSearch: 'Borrar búsqueda',
  ownerLabel: 'Responsable',
  allOwners: 'Todos los responsables',
  filters: {
    groupLabel: 'Filtrar la cola',
    reasonType: 'Tipo de motivo',
    condition: 'Condición',
    clear: 'Borrar filtros',
    title: 'Sin coincidencias',
    body: 'Ningún paciente coincide con estos filtros en esta vista.',
  },
  loading: 'Cargando pacientes',
  error: 'No pudimos cargar los pacientes',
  showing: (shown, total) => `Mostrando ${String(shown)} de ${count(total, 'caso', 'casos')}`,
  showingPatients: (shown, total, cases) =>
    `Mostrando ${String(shown)} de ${count(total, 'paciente', 'pacientes')} · ${count(cases, 'caso', 'casos')}`,
  loadMore: 'Cargar más pacientes',
  selectTitle: 'Elige un paciente de la lista',
  selectBody:
    'Verás todos los casos del paciente, la evidencia citada de la nota y el siguiente paso sugerido.',
};

const patientCard: Messages['patientCard'] = {
  cases: (n) => count(n, 'caso', 'casos'),
  activeCases: (n) => count(n, 'caso activo', 'casos activos'),
  reasons: (n) => count(n, 'motivo', 'motivos'),
  owners: (names) => `Responsable: ${names}`,
  contactAllowed: 'Contacto permitido',
  contactNotAllowed: 'Contacto no permitido',
  optedOut: 'No acepta mensajes',
  lastContact: (when) => `Último contacto ${when}`,
  noContacts: 'Sin contactos registrados',
  requestContact: 'Pedir contacto',
  requestHint:
    'Un solo pedido cubre todos los casos del paciente: como máximo un mensaje cada 14 días.',
  requestTitle: 'Pedir contacto con el paciente',
  requestBody: (name, cases) =>
    `Le pediremos al sistema del consultorio que contacte a ${name} por su canal habitual, una sola vez por sus ${count(cases, 'caso', 'casos')}.`,
  blocked: (name) =>
    `${name} no acepta mensajes del consultorio. Contáctalo por otra vía y luego resuelve los casos.`,
  done: 'Listo: el sistema del consultorio contactará al paciente, una sola vez por todos sus casos.',
  casesTitle: 'Casos',
  closedTitle: 'Casos cerrados',
  loading: 'Cargando paciente',
  error: 'No pudimos cargar el paciente',
  caseError: 'No pudimos cargar este caso',
};

const planReview: Messages['planReview'] = {
  reading: 'Lectura de la IA',
  question: 'Leído por la IA de la nota. ¿Es lo que pidió el médico?',
  pending: 'Sin revisar',
  confirmedBy: (who) => `Confirmado por ${who}`,
  confirmed: 'Confirmado',
  correctedBy: (who) => `Corregido por ${who}`,
  correctedShort: 'Corregido',
  superseded: 'Corregido: lo reemplaza la corrección del equipo clínico',
  rejected: 'Rechazado: la nota no lo pedía',
  confirm: 'Confirmar',
  correct: 'Corregir',
  reject: 'Rechazar',
  confirmedDone: 'Punto del plan confirmado.',
  correctedDone: 'Punto del plan corregido.',
  rejectedDone: 'Punto del plan rechazado.',
  correctTitle: 'Corregir el punto del plan',
  correctBody:
    'Cambia lo que pidió la nota. La corrección conserva la cita como evidencia; la lectura original queda en el historial como corregida.',
  kindLabel: 'Qué pide',
  dueDateLabel: 'Fecha límite',
  dueDateHint: 'Día del calendario del consultorio.',
  save: 'Guardar corrección',
  nothingChanged: 'Cambia la fecha o lo que pide para corregir el punto.',
  invalidDate: 'Indica una fecha válida.',
  rejectTitle: 'Rechazar el punto del plan',
  rejectBody:
    'El motor deja de esperarlo. Si era el único motivo pendiente de su caso, el caso se resuelve.',
  rejectConfirm: 'Rechazar punto',
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
  evaluatorAdvanceDisabled:
    'Como evaluador, mueves el reloj de tu propio laboratorio en lugar del de la demo compartida: nunca cambia lo que ve otro evaluador.',
  goToLab: 'Ir al laboratorio',
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
  // "Laboratorio: HbA1c", never two items both titled "Laboratorio".
  planItemNamed: (kind, testName) => `${kind}: ${testName}`,
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

/** The Metrics view (HIP-141). */
const metrics: MetricsCopy = {
  title: 'Métricas',
  subtitle:
    'Qué pasó con los casos que llegaron a la bandeja en el período: cuántos terminaron en una consulta, qué tan rápido actuó el equipo y cuánto costó la IA.',
  periodLegend: 'Período',
  preset: (days) => (days === 365 ? 'Último año' : `Últimos ${String(days)} días`),
  periodRange: (from, to) => `${from} – ${to}`,
  loading: 'Cargando métricas',
  errorTitle: 'No pudimos cargar las métricas',
  empty: {
    title: 'No hay casos en este período',
    body: 'Elige un período más largo, o vuelve cuando lleguen casos a la bandeja.',
  },
  tiles: {
    opened: 'Casos abiertos',
    openedHint: (live, backfill) => `${String(live)} en vivo · ${String(backfill)} del historial`,
    booked: 'Terminaron en una cita',
    bookedHint: (rate) => `${rate} de los casos`,
    attended: 'Consulta realizada',
    attendedHint: (rate) => `${rate} de las citas`,
    firstAction: 'Mediana hasta la primera acción',
    firstActionHint: (measured, pending) =>
      `${String(measured)} atendidos · ${String(pending)} en espera`,
    useful: 'Útiles según el equipo',
    usefulHint: (count) =>
      `de ${String(count)} ${count === 1 ? 'caso calificado' : 'casos calificados'}`,
    costPerCase: 'Costo de IA por caso',
    costPerCaseHint: (total) => `${total} en el período`,
    lost: 'Perdidos en seguimiento',
    lostHint: (dismissed) => `${String(dismissed)} descartados por el equipo`,
    recovered: 'Pacientes recuperados del historial',
    recoveredHint: (cases) =>
      `${String(cases)} ${cases === 1 ? 'caso resuelto' : 'casos resueltos'}`,
    none: '—',
  },
  funnel: {
    title: 'Del caso a la consulta',
    description:
      'Casos abiertos en el período, los que consiguieron una cita y aquellos cuya consulta se realizó. Las citas atribuidas salieron de trabajar el caso o de un pedido de contacto; las orgánicas, no.',
    opened: 'Abiertos',
    booked: 'Con cita',
    attended: 'Con consulta',
    resolvedByBooking: 'Resueltos por la cita',
    byOrigin: 'Las citas, por origen',
    origin: {
      followUpCase: 'Desde el caso',
      patientContact: 'Tras un pedido de contacto',
      organic: 'Orgánica',
    },
    summary: (stage, total, parts) => `${stage}: ${String(total)}${parts ? ` (${parts})` : ''}`,
  },
  timing: {
    title: 'Tiempo hasta la primera acción',
    description:
      'Desde que el caso llega a la bandeja hasta lo primero que hizo el equipo o el primer pedido de contacto.',
    median: 'Mediana',
    p75: 'Percentil 75',
    p90: 'Percentil 90',
    none: 'Todavía no se actuó sobre ningún caso del período.',
    summary: (median, p75, p90) => `Mediana ${median}, percentil 75 ${p75}, percentil 90 ${p90}`,
  },
  dismissals: {
    title: 'Descartes por motivo',
    description: (total) =>
      `${String(total)} ${total === 1 ? 'caso descartado' : 'casos descartados'} por el equipo. Un motivo que se repite señala la regla a ajustar.`,
    none: 'No se descartó ningún caso del período.',
    reasons: {
      handled_elsewhere: 'Atendido en otro lugar',
      already_done: 'Ya se hizo',
      not_applicable_to_patient: 'No aplica a este paciente',
      wrong_diagnosis: 'Diagnóstico equivocado',
      wrong_interval: 'Plazo equivocado',
      other: 'Otro',
    },
  },
  extraction: {
    title: 'Lo que corrigieron los médicos',
    description:
      'Condiciones leídas de las notas que un clínico confirmó o rechazó en el período, y correcciones a ítems del plan.',
    conditions: 'Condiciones leídas de notas',
    confirmed: 'Confirmadas',
    rejected: 'Rechazadas',
    pending: 'Por revisar',
    legend: (label, count) => `${label} ${String(count)}`,
    corrections: (rate) => `${rate} rechazadas`,
    planItems: 'Ítems del plan',
    planItemsNone: 'No se revisó ningún ítem del plan en este período.',
    planItemsCounts: (confirmed, corrected, rejected) =>
      `${count(confirmed, 'confirmado', 'confirmados')} · ${count(corrected, 'corregido', 'corregidos')} · ${count(rejected, 'rechazado', 'rechazados')}`,
  },
  ai: {
    title: 'Costo de IA',
    description:
      'Cada llamada a un modelo del consultorio en el período, por tarea. Leer una nota se carga a los casos que abrió su plan.',
    tasks: {
      note_extraction: 'Lectura de notas',
      clinical_review: 'Revisión clínica',
    },
    calls: (count) => `${String(count)} ${count === 1 ? 'llamada' : 'llamadas'}`,
    tokens: (count) => `${count} tokens`,
    perReviewRun: (cost, runs) =>
      `${cost} por revisión (${String(runs)} ${runs === 1 ? 'revisión' : 'revisiones'})`,
    attributed: (cost, cases) =>
      `${cost} de lectura de notas detrás de ${String(cases)} ${cases === 1 ? 'caso' : 'casos'}`,
    none: 'Ninguna llamada a un modelo en este período.',
  },
  ruleVersion: {
    rule: 'Regla',
    protocol: 'Protocolo',
    version: (version) => `versión ${version}`,
  },
  hours: (hours) => {
    // Intl, not toFixed: arithmetic and formatting only (the catalog test passes a boxed sample).
    const value = hours;
    const one = new Intl.NumberFormat('es', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    if (value < 1) return `${String(Math.round(value * 60))} min`;
    return value < 48 ? `${one.format(value)} h` : `${one.format(value / 24)} d`;
  },
};

const why: Messages['why'] = {
  button: '¿Por qué?',
  hide: 'Ocultar el porqué',
  regionLabel: (label) => `Por qué: ${label}`,
  dueDate: 'Cómo se calculó la fecha',
  doctorsPlan: 'Lo que escribió el médico',
  noteOf: (date) => `Nota del ${date}`,
  aiRead: (description) => `Lo que leyó la IA: ${description}`,
  records: 'Registros desde los que cuenta',
  protocol: 'Protocolo de atención',
  enrolledBecause: 'Por qué el paciente está en este protocolo',
  interval: 'Intervalo',
  pattern: 'Patrón de consultas',
  inPattern: 'forma parte del patrón',
  outOfPattern: 'episodio cerrado, no forma parte del patrón',
  fulfilledBy: 'Qué lo cerraría',
  equivalents: (codes) => `Códigos equivalentes que también cuentan: ${codes}`,
  closedBy: 'Cerrado por',
  viewDocuments: 'Ver documentos',
  showInDocuments: 'Ver en documentos',
  documentsTitle: (name) => `Documentos de ${name}`,
  documentsDescription:
    'Todos los registros que envió el sistema del consultorio para este paciente, del más reciente al más antiguo. Contrasta cada motivo con ellos.',
  documentsCount: (n) => count(n, 'documento', 'documentos'),
  filterLabel: 'Mostrar',
  filters: {
    all: 'Todos',
    note: 'Notas',
    result: 'Resultados',
    order: 'Órdenes',
    prescription: 'Recetas',
    visit: 'Consultas',
    appointment: 'Citas',
    diagnosis: 'Diagnósticos',
    allergy: 'Alergias',
    other: 'Otros',
  },
  withdrawn: 'Retirado por el sistema del consultorio',
  cited: 'Citado',
  loading: 'Cargando documentos…',
  error: 'No pudimos cargar los documentos.',
  empty: 'No hay documentos de este tipo.',
  code: (code) => `Código ${code}`,
  status: (status) => `Estado: ${status}`,
  by: (author) => `por ${author}`,
  statuses: {
    final: 'final',
    amended: 'enmendado',
    corrected: 'corregido',
    preliminary: 'preliminar',
    finished: 'finalizada',
    active: 'activa',
    completed: 'completada',
    current: 'vigente',
    booked: 'agendada',
    cancelled: 'cancelada',
    stopped: 'suspendida',
    'on-hold': 'en pausa',
    'entered-in-error': 'registrado por error',
    noshow: 'no asistió',
    fulfilled: 'cumplida',
  },
  conditionQuote: 'Cita de la nota',
};

const engineTests: Messages['engineTests'] = {
  title: 'Pruebas del motor',
  intro:
    'Verifica, un comportamiento a la vez, que el motor hace lo que el producto promete — construido en vivo en tu propia clínica de prueba, nunca una demo armada de antemano.',
  progress: (reviewed: number, total: number): string =>
    `${String(reviewed)} de ${String(total)} pruebas revisadas`,
  groups: { data_intake: 'Entrada de datos', expectations: 'Expectativas', rules: 'Reglas' },
  loading: 'Cargando las pruebas del motor',
  loadError: 'No pudimos cargar las pruebas del motor',
  runTest: 'Correr la prueba',
  runAgain: 'Correr de nuevo',
  running: 'Corriendo…',
  tryOwnData: 'Probar con tus propios datos',
  reviewed: 'Revisada',
  worksAsExpected: 'Funciona como espero',
  doesNotWork: 'No funciona',
  savingVerdict: 'Guardando…',
  verdictSaved: 'Veredicto guardado',
  verdictError: 'No pudimos guardar tu veredicto',
  commentLabel: 'Comentario (opcional)',
  commentPlaceholder: 'Algo que notaste…',
  autoCheck: {
    expected: 'Esperado',
    observed: 'Observado',
    pass: 'Chequeo automático: pasa',
    fail: 'Chequeo automático: falla',
    notSupported: 'Todavía no soportado',
  },
  timelineTitle: 'Qué pasó',
  timelineEmpty: 'Todavía no hay eventos.',
  expectationsTitle: 'Expectativas',
  expectationsEmpty: 'Todavía no hay expectativas.',
  diffTags: {
    new: 'Nueva',
    fulfilled: 'Cumplida',
    superseded: 'Reemplazada',
    expired: 'Vencida',
    cancelled: 'Cancelada',
    still_open: 'Sigue abierta',
  },
  columns: { rule: 'Regla', layer: 'Capa', version: 'Versión', due: 'Vence', status: 'Estado' },
  readByRules: 'Leído por reglas',
  ruleCard: {
    trigger: 'Disparador',
    fulfilledBy: 'Se cumple con',
    supersededBy: 'Se reemplaza con',
    escalationPolicy: 'Política de escalamiento',
    version: 'Versión',
    dueInDays: (days: number): string => count(days, 'día', 'días'),
  },
  eventTypes: {
    'service_request.created': 'Orden emitida',
    'result.received': 'Resultado recibido',
    'medication.prescribed': 'Medicamento indicado',
    'condition.recorded': 'Diagnóstico registrado',
    'encounter.finished': 'Consulta',
    'appointment.booked': 'Cita agendada',
    'appointment.cancelled': 'Cita cancelada',
    'note.received': 'Nota guardada',
    'plan.extracted': 'Plan extraído',
  },
  startTest: 'Empezar la prueba',
  starting: 'Empezando…',
  stepOf: (step: number, total: number): string => `Paso ${String(step)} de ${String(total)}`,
  whatShouldHappen: 'Qué debería pasar',
  loadButton: 'Cargar',
  saveButton: 'Guardar',
  confirmButton: 'Confirmar',
  viewRuleButton: 'Cargar la ficha de la regla',
  startOver: 'Empezar de nuevo',
  stepChecksTitle: 'Chequeos hasta ahora',
  moveLabDateLabel: 'Mueve la fecha de tu laboratorio a',
  ruleTimeframeLabel: 'Nuevo plazo (días)',
  confirmPlanStepHint: 'Confirma como correcto el punto del plan de arriba.',
  ruleCardStepHint: 'Lee la regla directo de su propia configuración — no hay nada que editar.',
  diagnosisAttachedHint:
    'Se adjunta a la misma nota, para que el paciente se inscriba en el protocolo.',
  visitStepHint: 'Una consulta sola — sin documento, nada más que llenar.',
  tryAnythingElse: {
    title: 'Prueba cualquier otra cosa',
    intro:
      'Pide otro examen, agrega un resultado, indica un tratamiento o sube un documento — sobre el mismo paciente.',
    loadButton: 'Cargar',
  },
  scenarios: {
    'structured-no-llm': {
      title: 'Los datos estructurados no pasan por la IA',
      statement:
        'Una orden, una receta con duración y un resultado se leen cada uno por reglas — nunca por el modelo de lenguaje.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden la lee reglas — sin modelo de lenguaje.',
        },
        {
          title: 'Indica un tratamiento',
          whatShouldHappen: 'La receta también la leen las reglas.',
        },
        {
          title: 'Agrega el resultado',
          whatShouldHappen:
            'El resultado cierra la orden automáticamente, todavía con cero llamadas a IA.',
        },
      ],
    },
    'note-ai-once-per-save': {
      title: 'Una nota solo la lee la IA cuando se guarda',
      statement:
        'Guardar una nota la lee una vez con el modelo; mover el reloj hacia adelante después nunca la vuelve a leer.',
      steps: [
        {
          title: 'Sube un informe o pega una nota',
          whatShouldHappen: 'Guardar la nota la lee una vez con el modelo.',
        },
        {
          title: 'Mueve la fecha de tu laboratorio hacia adelante',
          whatShouldHappen: 'Mover el reloj solo no vuelve a leer la nota.',
        },
      ],
    },
    'note-extraction-quotes': {
      title: 'Diagnósticos, medicamentos y el plan vienen con citas',
      statement:
        'Un diagnóstico (CIE-10), un medicamento y el plan del médico se extraen cada uno de la nota con la cita exacta que los respalda.',
      steps: [
        {
          title: 'Sube un informe o pega una nota',
          whatShouldHappen:
            'El diagnóstico, el medicamento y el plan vienen cada uno con la cita exacta que los respalda.',
        },
      ],
    },
    'plan-item-confirm': {
      title: 'El médico confirma un punto del plan con un clic',
      statement:
        'Un punto de seguimiento que la IA leyó de la nota se puede confirmar como correcto en una sola acción.',
      steps: [
        {
          title: 'Sube un informe o pega una nota',
          whatShouldHappen:
            'El plan de la nota (“control en un mes”) abre un punto para confirmar.',
        },
        {
          title: 'Confirma el punto del plan',
          whatShouldHappen: 'El punto del plan queda confirmado por ti, con un clic.',
        },
      ],
    },
    'condition-inferred': {
      title: 'Una condición se puede inferir del tratamiento o de un resultado',
      statement:
        'Indicar metformina, o un HbA1c de 6.5% o más, sugieren diabetes por sí solos, sin que nadie haya escrito el diagnóstico en ningún lado.',
      steps: [
        {
          title: 'Indica un tratamiento',
          whatShouldHappen:
            'La metformina sola sugiere diabetes, sin que nadie escriba el diagnóstico.',
        },
        {
          title: 'Agrega un resultado',
          whatShouldHappen: 'Un HbA1c de 6.5% o más sugiere diabetes por sí solo también.',
        },
      ],
    },
    'expectation-has-due-date': {
      title: 'Cada evento abre una expectativa con fecha de vencimiento',
      statement:
        'Cada evento clínico que el motor lee crea una expectativa con una fecha de vencimiento concreta.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden abre una expectativa con una fecha de vencimiento concreta.',
        },
      ],
    },
    'universal-layer': {
      title: 'La capa universal detecta órdenes y tratamientos sin seguimiento',
      statement:
        'Una orden sin resultado, y un tratamiento corto sin control, abren cada uno su propia expectativa — para cualquier consultorio, cualquier especialidad.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden sin resultado abre su propia expectativa.',
        },
        {
          title: 'Indica un tratamiento corto',
          whatShouldHappen:
            'El tratamiento corto abre su propia expectativa también, independiente de la orden.',
        },
      ],
    },
    'doctor-plan-layer': {
      title: 'El plan del propio médico abre su propia expectativa',
      statement:
        'Una nota que dice "control en un mes" abre una expectativa que vence en unos 30 días.',
      steps: [
        {
          title: 'Sube un informe o pega una nota',
          whatShouldHappen: '“Control en un mes” abre una expectativa que vence en unos 30 días.',
        },
      ],
    },
    'cadence-break': {
      title: 'Un ritmo de consultas roto se vuelve un caso — pero solo con un patrón',
      statement:
        'Un paciente con dos o más consultas previas que rompe su ritmo abre un caso; una sola consulta previa no abre nada.',
      steps: [
        {
          title: 'Registra una consulta',
          whatShouldHappen: 'Una sola consulta todavía no abre nada.',
        },
        {
          title: 'Mueve la fecha de tu laboratorio 30 días hacia adelante',
          whatShouldHappen: 'Mover el reloj solo no cambia nada por sí mismo.',
        },
        {
          title: 'Registra otra consulta',
          whatShouldHappen:
            'Una segunda consulta, 30 días después, abre una expectativa de ritmo roto.',
        },
        {
          title: 'Mueve la fecha de tu laboratorio más allá del vencimiento',
          whatShouldHappen: 'Vencida, la expectativa de ritmo roto vence y se vuelve un caso.',
        },
      ],
    },
    'protocol-fills-gaps': {
      title: 'Un protocolo de enfermedad crónica llena lo que el plan dejó abierto',
      statement:
        'Una vez inscrito en el protocolo de diabetes, los controles de rutina que el plan del médico no mencionó (un perfil lipídico, un examen de fondo de ojo, una consulta de rutina) igual quedan programados.',
      steps: [
        {
          title: 'Sube una nota que inscribe al paciente',
          whatShouldHappen: 'El plan del propio médico abre el control de HbA1c que pidió.',
        },
        {
          title: 'Registra una consulta unos días después',
          whatShouldHappen: 'El protocolo de diabetes llena lo que el plan no cubrió.',
        },
      ],
    },
    'plan-beats-protocol': {
      title: 'El plan del médico siempre tiene prioridad sobre el protocolo',
      statement:
        'Cuando el plan del propio médico ya pide un examen, el protocolo de enfermedad crónica nunca abre una segunda expectativa duplicada para lo mismo.',
      steps: [
        {
          title: 'Sube una nota que inscribe al paciente',
          whatShouldHappen: 'El plan del propio médico abre el control de HbA1c.',
        },
        {
          title: 'Registra una consulta unos días después',
          whatShouldHappen: 'El protocolo nunca abre un segundo control de HbA1c duplicado.',
        },
      ],
    },
    'auto-close-fulfilled': {
      title: 'Un resultado cierra su orden automáticamente',
      statement:
        'Una orden seguida de su resultado queda marcada como cumplida sin que nadie tenga que actuar.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden abre su propia expectativa.',
        },
        {
          title: 'Agrega el resultado',
          whatShouldHappen:
            'El resultado cierra la orden automáticamente — nadie tiene que actuar.',
        },
      ],
    },
    supersession: {
      title: 'Una orden repetida reemplaza a la anterior',
      statement:
        'Pedir el mismo examen otra vez marca la orden anterior como reemplazada y arranca una fecha de vencimiento nueva desde la orden nueva.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden abre una expectativa nueva con fecha de vencimiento.',
        },
        {
          title: 'Pide el mismo examen otra vez',
          whatShouldHappen:
            'La orden nueva reemplaza a la anterior y arranca su propio reloj de 15 días.',
        },
      ],
    },
    'independent-clocks': {
      title: 'Exámenes distintos llevan relojes separados',
      statement:
        'Dos exámenes distintos pedidos para el mismo paciente se siguen cada uno con su propia fecha de vencimiento, independiente uno del otro.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden abre su propia expectativa, que vence en 15 días.',
        },
        {
          title: 'Pide un examen distinto',
          whatShouldHappen:
            'El examen nuevo conserva su propio reloj de 15 días, independiente del primero.',
        },
      ],
    },
    'visit-closes-controls-not-tests': {
      title: 'Una consulta cierra controles pendientes, nunca exámenes pendientes',
      statement:
        'Una consulta cumple un control de seguimiento pendiente, pero un resultado de laboratorio o imagen pendiente todavía necesita su propio resultado para cerrar.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'La orden de laboratorio abre su propia expectativa.',
        },
        {
          title: 'Indica un tratamiento corto',
          whatShouldHappen: 'El tratamiento corto abre su propio control pendiente.',
        },
        {
          title: 'Registra una consulta',
          whatShouldHappen:
            'La consulta cierra el control pendiente, pero el examen pendiente sigue abierto.',
        },
      ],
    },
    'note-without-plan-finding': {
      title: 'Una nota sin plan se vuelve un hallazgo de calidad',
      statement:
        'Una nota que no deja ningún plan de seguimiento se registra como un hallazgo de calidad de la documentación para el equipo clínico.',
      steps: [
        {
          title: 'Sube un informe o pega una nota',
          whatShouldHappen:
            'Una nota sin plan de seguimiento se registra como un hallazgo de calidad de la documentación.',
        },
      ],
    },
    'rule-is-configuration': {
      title: 'Las reglas son configuración, no código',
      statement:
        'El disparador de cada regla, cómo se cumple y se reemplaza, su política de escalamiento y su versión se leen directo de la configuración de la propia regla.',
      steps: [
        {
          title: 'Carga la ficha de la regla',
          whatShouldHappen: 'Cada campo se lee directo de la configuración de la propia regla.',
        },
      ],
    },
    'case-keeps-rule-version': {
      title: 'Un caso conserva la versión de la regla con la que abrió',
      statement:
        'Una vez que un caso abre, conserva exactamente la versión de la regla que lo creó, incluso después de que el consultorio cambie esa regla más adelante.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen:
            'La orden abre una expectativa que lleva la versión actual de la regla.',
        },
        {
          title: 'Mueve la fecha de tu laboratorio más allá del vencimiento',
          whatShouldHappen: 'Vencida, la expectativa vence y se vuelve un caso.',
        },
        {
          title: 'Cambia el plazo del consultorio',
          whatShouldHappen:
            'El caso conserva la versión de la regla con la que abrió, incluso después de que el consultorio cambie la regla.',
        },
      ],
    },
    'per-clinic-override': {
      title: 'Un consultorio puede ajustar sus propios plazos',
      statement:
        'El ajuste propio de esta clínica de prueba mueve la fecha de vencimiento de una regla (por ejemplo de 15 a 10 días), sin cambiarla para ningún otro consultorio.',
      steps: [
        {
          title: 'Pide un examen',
          whatShouldHappen: 'Antes de cualquier ajuste, aplica el plazo por defecto de la regla.',
        },
        {
          title: 'Cambia el plazo del consultorio',
          whatShouldHappen: 'El ajuste propio de este consultorio de prueba ya está activo.',
        },
        {
          title: 'Pide el examen otra vez',
          whatShouldHappen: 'Pedirlo otra vez ya usa el plazo propio de este consultorio.',
        },
      ],
    },
  },
};

const EVALUATOR_ACTION_LABELS: Record<string, string> = {
  login: 'Inició sesión',
  case_feedback: 'Dio una opinión sobre un caso',
  case_dismiss: 'Descartó un caso',
  case_resolve: 'Resolvió un caso',
  case_snooze: 'Pospuso un caso',
  case_request_contact: 'Pidió contactar a un paciente',
  case_call_outcome: 'Registró el resultado de una llamada',
  suppression_reactivate: 'Reactivó un recordatorio',
  plan_item_confirm: 'Confirmó un ítem del plan',
  plan_item_correct: 'Corrigió un ítem del plan',
  plan_item_reject: 'Rechazó un ítem del plan',
  finding_review: 'Revisó un hallazgo clínico',
  lab_patient_created: 'Creó un paciente de laboratorio',
  lab_document_uploaded: 'Subió un documento de laboratorio',
  lab_record_added: 'Agregó un registro de laboratorio',
  lab_date_viewed: 'Movió el reloj del laboratorio',
  case_viewed: 'Vio un caso',
  patient_documents_viewed: 'Vio los documentos de un paciente',
  engine_test_step: 'Cargó un paso de una prueba del motor',
};

const lab: Messages['lab'] = {
  title: 'Laboratorio',
  intro:
    'Tu propio consultorio de prueba: sube un documento, agrega registros y mira el impacto en una fecha, aislado de la demo compartida y de cualquier otro evaluador.',
  patientsTitle: 'Mis pacientes de laboratorio',
  loadingPatients: 'Cargando tus pacientes de laboratorio',
  patientsError: 'No pudimos cargar tus pacientes de laboratorio',
  noPatients: 'Todavía no has creado un paciente de laboratorio.',
  noPatientsBody: 'Crea uno para empezar a agregar documentos y registros.',
  newPatient: 'Nuevo paciente',
  newPatientOption: '+ Nuevo paciente',
  newPatientTitle: 'Nuevo paciente de laboratorio',
  patientName: 'Nombre',
  patientNamePlaceholder: 'Nombre y apellido (ficticio)',
  patientSex: 'Sexo',
  patientSexUnspecified: 'Sin especificar',
  patientAge: 'Edad',
  patientAgeUnspecified: 'Sin especificar',
  patientSpecialty: 'Especialidad',
  createPatient: 'Crear paciente',
  creatingPatient: 'Creando paciente…',
  selectPatient: 'Selecciona un paciente',
  noPatientSelected: 'Selecciona o crea un paciente de laboratorio para agregar a su registro.',
  uploadTitle: 'Cargar un informe o documento',
  uploadIntro:
    'Suelta un archivo, elígelo, o pega el texto. Se lee igual que lo haría un documento real.',
  dropzoneHint: 'Arrastra y suelta un archivo aquí',
  chooseFile: 'Elegir archivo',
  orPasteText: 'o pega el texto',
  backToFile: 'Subir un archivo en su lugar',
  readDocument: 'Leer documento',
  reading: 'Leyendo…',
  resultTitle: 'Lo que el motor espera ahora',
  addWithoutDocumentTitle: 'Agregar algo sin un documento',
  addWithoutDocumentIntro:
    'Una orden de laboratorio o imagen, un resultado, una receta, una consulta, un diagnóstico o una cita, sin documento y sin lectura de IA.',
  showForm: 'Mostrar',
  hideForm: 'Ocultar',
  recordType: 'Tipo',
  recordTypes: {
    order: 'Orden de laboratorio o imagen',
    result: 'Resultado',
    prescription: 'Receta',
    visit: 'Consulta',
    appointment_booked: 'Cita agendada',
    appointment_cancelled: 'Cita cancelada',
    diagnosis: 'Diagnóstico',
  },
  date: 'Fecha',
  dateHint:
    'Por defecto es la fecha actual de tu laboratorio. Se permiten fechas pasadas; no futuras.',
  documentType: 'Tipo',
  documentTypes: {
    consultation_note: 'Nota de consulta',
    lab_result: 'Informe de laboratorio',
    imaging_report: 'Informe de imagen',
    prescription: 'Receta u orden',
    other: 'Otro',
  },
  fileLabel: 'Archivo',
  fileHint: 'PDF, DOCX o TXT, hasta 2 MB.',
  textLabel: 'Texto',
  textPlaceholder: 'Pega aquí el texto del documento…',
  orderLoinc: 'Código del estudio (LOINC)',
  orderDisplay: 'Nombre del estudio',
  orderCategory: 'Categoría',
  orderCategories: { laboratory: 'Laboratorio', imaging: 'Imagen' },
  resultValue: 'Valor',
  resultUnit: 'Unidad',
  resultInterpretation: 'Interpretación',
  interpretations: { normal: 'Normal', abnormal: 'Anormal' },
  resultBasedOnOrder: 'Cumple una orden (opcional)',
  resultBasedOnOrderNone: 'Ninguna orden en particular',
  prescriptionDrug: 'Medicamento',
  prescriptionDrugPlaceholder: 'Por ejemplo, Metformina 850 mg',
  prescriptionDuration: 'Duración (días, opcional)',
  diagnosisIcd10: 'Diagnóstico (CIE-10)',
  diagnosisOther: 'Otro (escribe el código)',
  diagnosisCode: 'Código CIE-10',
  diagnosisCodePlaceholder: 'E11',
  diagnosisDisplay: 'Descripción',
  appointmentScheduledFor: 'Agendada para',
  appointmentSpecialty: 'Especialidad (opcional)',
  appointmentToCancel: 'Cita a cancelar',
  appointmentToCancelNone: 'Todavía no hay una cita agendada',
  save: 'Guardar',
  saving: 'Guardando…',
  readByTitle: (model) => `Leído por ${model}`,
  savedTitle: 'Guardado en el registro',
  documentUploadedTitle: (documentType) => `Documento cargado: ${documentType}`,
  timelineTitle: 'Cronología',
  timelineEmpty: 'Todavía no hay nada en el registro de este paciente.',
  expectationsTitle: 'Expectativas',
  expectationsIntro:
    'Lo que el motor espera que pase para este paciente. Los cambios desde tu última acción están resaltados.',
  expectationsEmpty: 'Todavía no hay expectativas para este paciente.',
  due: (date) => `Vence el ${date}`,
  ruleVersion: (version) => `Regla ${version}`,
  impactTitle: '¿Qué pasa en una fecha?',
  impactIntro:
    'Mueve el reloj de tu laboratorio (nunca el de la demo compartida). Las expectativas vencen, los casos se abren, se combinan y escalan, exactamente como lo haría el motor en ese tramo de tiempo.',
  impactDate: 'Fecha',
  impactButton: 'Ver el impacto',
  impactSeeing: 'Moviendo el reloj…',
  impactSummary: (expired, opened, escalated) =>
    `${count(expired, 'expectativa vencida', 'expectativas vencidas')}, ${count(opened, 'caso abierto', 'casos abiertos')}, ${count(escalated, 'caso escalado', 'casos escalados')}.`,
  impactNone: 'Nada cambió en esa fecha.',
  impactMovedTo: (date) => `Tu laboratorio ahora está en el ${date}.`,
  viewLabCases: 'Ver los casos de tu laboratorio',
  labCasesTitle: 'Los casos de tu laboratorio',
  labCasesEmpty: 'Todavía no hay casos abiertos en tu laboratorio.',
  labCasesEmptyBody: 'Agrega registros y mueve el reloj hacia adelante para ver casos abrirse.',
};

const evaluators: Messages['evaluators'] = {
  title: 'Evaluadores',
  intro: 'Todos los que han abierto la demo alojada, y qué han hecho con ella.',
  loading: 'Cargando evaluadores',
  error: 'No pudimos cargar los evaluadores',
  empty: 'Todavía ningún evaluador ha iniciado sesión.',
  email: 'Evaluador',
  lastSeen: 'Última vez visto',
  firstSeen: 'Primera vez visto',
  totalActions: 'Acciones',
  actionsByType: 'Por acción',
  activityLogTitle: 'Registro de actividad',
  activityLogEmpty: 'Todavía no hay actividad.',
  activityLogError: 'No pudimos cargar el registro de actividad',
  filterByEvaluator: 'Filtrar por evaluador',
  allEvaluators: 'Todos los evaluadores',
  downloadCsv: 'Descargar CSV',
  action: EVALUATOR_ACTION_LABELS,
};

export const es: Messages = {
  metrics,
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
  why,
  caseActions,
  caseDetail,
  feedback,
  inbox,
  patientCard,
  planReview,
  caseRow,
  patient,
  recovery,
  demo,
  consultation,
  extraction,
  review,
  engineTests,
  lab,
  evaluators,
};
