import type { CaseListView } from '../../api/contract.ts';

/*
 * User-facing copy of the patient queue (HIP-141): the inbox list with one
 * card per patient and the patient panel. English is the default; Spanish is
 * keyed the same way, so the inbox's locale catalogs can plug both in.
 */

export const COPY_LOCALES = ['en', 'es'] as const;
export type CopyLocale = (typeof COPY_LOCALES)[number];

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

const en = {
  page: {
    title: 'Follow-up inbox',
    intro:
      'Patients with something pending, by priority. Each card groups every reason of one patient; act on each case inside it.',
    chooseTitle: 'Choose a patient from the list',
    chooseBody:
      "You'll see every case of the patient, the evidence quoted from the note and the suggested next step.",
  },
  list: {
    title: 'Patients',
    viewsLabel: 'Case status',
    views: { active: 'Active', closed: 'Closed', all: 'All' } satisfies Record<
      CaseListView,
      string
    >,
    empty: {
      active: {
        title: 'No active cases',
        body: 'Every patient is up to date. New cases show up here as soon as an expectation expires.',
      },
      closed: { title: 'No closed cases yet', body: 'Resolved or dismissed cases show up here.' },
      all: { title: 'No cases yet', body: 'Cases show up when an expectation expires unmet.' },
    } satisfies Record<CaseListView, { title: string; body: string }>,
    searchLabel: 'Search patient',
    searchPlaceholder: 'Search patient by name',
    clearSearch: 'Clear search',
    ownerLabel: 'Owner',
    allOwners: 'All owners',
    loading: 'Loading patients',
    loadError: 'We could not load the patients',
    noResults: 'No results',
    noMatch: (search: string): string => `No patients match «${search}» in this view.`,
    noOwner: (name: string | undefined): string =>
      `No patients of ${name ?? 'this owner'} in this view.`,
    showing: (shown: number, total: number, cases: number): string =>
      `Showing ${String(shown)} of ${plural(total, 'patient', 'patients')} · ${plural(cases, 'case', 'cases')}`,
    loadMore: 'Load more patients',
  },
  row: {
    newBadge: 'New',
    moreReasons: (count: number): string => `+${plural(count, 'reason', 'reasons')}`,
    cases: (count: number): string => plural(count, 'case', 'cases'),
    age: (years: number): string => `${String(years)} y`,
    female: 'F',
    male: 'M',
  },
  panel: {
    back: 'Back to the inbox',
    viewPatient: 'View patient',
    owners: (names: readonly string[]): string => `Owner: ${names.join(', ')}`,
    activeCases: (count: number): string => plural(count, 'active case', 'active cases'),
    contactAllowed: 'Contact allowed',
    contactNotAllowed: 'Contact not allowed',
    optedOut: 'Does not accept messages',
    lastContact: (relative: string): string => `Last contact ${relative}`,
    noContacts: 'No contacts recorded',
    nextStep: 'Suggested next step',
    requestContact: 'Request contact',
    requestHint: 'One request covers every case of the patient: at most one message every 14 days.',
    requestTitle: 'Request contact with the patient',
    requestIntro: (name: string, cases: number): string =>
      `We will ask the clinic system to contact ${name} through their usual channel, once for their ${plural(cases, 'case', 'cases')}.`,
    messagePreview: 'Message the patient will receive',
    noDiagnosis: 'No diagnoses, results or test names.',
    blocked: (name: string): string =>
      `${name} does not accept messages from the clinic. Contact them another way, then resolve the cases.`,
    noteLabel: 'Internal note (optional)',
    noteHint: (limit: string): string => `Only the team sees it. Up to ${limit} characters.`,
    noteTooLong: (limit: string): string =>
      `The note can have up to ${limit} characters. Shorten it and try again.`,
    cancel: 'Cancel',
    gotIt: 'Got it',
    send: 'Request contact',
    done: 'Done: the clinic system will contact the patient, once for all their cases.',
    casesTitle: 'Cases',
    closedTitle: 'Closed cases',
    caseOpened: (relative: string): string => `Opened ${relative}`,
    fromHistory: 'Recovered from history',
    reasons: (count: number): string => plural(count, 'reason', 'reasons'),
    focused: 'The case you opened',
    actionsTitle: 'Actions on this case',
    detailsSummary: 'Escalation and history',
    escalationTitle: 'Escalation',
    historyTitle: 'Case history',
    feedbackTitle: 'Was this case useful?',
    closedNotice: (status: string): string =>
      `This case is closed (${status}). If the patient has something pending again, the engine opens a new case.`,
    loading: 'Loading patient',
    loadError: 'We could not load the patient',
    notFound: 'We could not find that case',
    caseLoadError: 'We could not load this case',
  },
};

export type PatientQueueCopy = typeof en;

const es: PatientQueueCopy = {
  page: {
    title: 'Bandeja de seguimiento',
    intro:
      'Pacientes con algo pendiente, ordenados por prioridad. Cada tarjeta reúne todos los motivos de un paciente; actúa sobre cada caso desde ella.',
    chooseTitle: 'Elige un paciente de la lista',
    chooseBody:
      'Verás todos los casos del paciente, la evidencia citada de la nota y el siguiente paso sugerido.',
  },
  list: {
    title: 'Pacientes',
    viewsLabel: 'Estado de los casos',
    views: { active: 'Activos', closed: 'Cerrados', all: 'Todos' },
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
    searchLabel: 'Buscar paciente',
    searchPlaceholder: 'Buscar paciente por nombre',
    clearSearch: 'Borrar búsqueda',
    ownerLabel: 'Responsable',
    allOwners: 'Todos los responsables',
    loading: 'Cargando pacientes',
    loadError: 'No pudimos cargar los pacientes',
    noResults: 'Sin resultados',
    noMatch: (search) => `No hay pacientes que coincidan con «${search}» en esta vista.`,
    noOwner: (name) => `No hay pacientes de ${name ?? 'este responsable'} en esta vista.`,
    showing: (shown, total, cases) =>
      `Mostrando ${String(shown)} de ${plural(total, 'paciente', 'pacientes')} · ${plural(cases, 'caso', 'casos')}`,
    loadMore: 'Cargar más pacientes',
  },
  row: {
    newBadge: 'Nuevo',
    moreReasons: (count) => `+${plural(count, 'motivo', 'motivos')}`,
    cases: (count) => plural(count, 'caso', 'casos'),
    age: (years) => `${String(years)} años`,
    female: 'F',
    male: 'M',
  },
  panel: {
    back: 'Volver a la bandeja',
    viewPatient: 'Ver paciente',
    owners: (names) => `Responsable: ${names.join(', ')}`,
    activeCases: (count) => plural(count, 'caso activo', 'casos activos'),
    contactAllowed: 'Contacto permitido',
    contactNotAllowed: 'Contacto no permitido',
    optedOut: 'No acepta mensajes',
    lastContact: (relative) => `Último contacto ${relative}`,
    noContacts: 'Sin contactos registrados',
    nextStep: 'Siguiente paso sugerido',
    requestContact: 'Pedir contacto',
    requestHint:
      'Un solo pedido cubre todos los casos del paciente: como máximo un mensaje cada 14 días.',
    requestTitle: 'Pedir contacto con el paciente',
    requestIntro: (name, cases) =>
      `Le pediremos al sistema del consultorio que contacte a ${name} por su canal habitual, una sola vez por sus ${plural(cases, 'caso', 'casos')}.`,
    messagePreview: 'Mensaje que recibirá el paciente',
    noDiagnosis: 'Sin diagnósticos, resultados ni nombres de exámenes.',
    blocked: (name) =>
      `${name} no acepta mensajes del consultorio. Contáctalo por otra vía y luego resuelve los casos.`,
    noteLabel: 'Nota interna (opcional)',
    noteHint: (limit) => `Solo la ve el equipo. Hasta ${limit} caracteres.`,
    noteTooLong: (limit) =>
      `La nota puede tener hasta ${limit} caracteres. Acórtala e intenta de nuevo.`,
    cancel: 'Cancelar',
    gotIt: 'Entendido',
    send: 'Pedir contacto',
    done: 'Listo: el sistema del consultorio contactará al paciente, una sola vez por todos sus casos.',
    casesTitle: 'Casos',
    closedTitle: 'Casos cerrados',
    caseOpened: (relative) => `Abierto ${relative}`,
    fromHistory: 'Recuperado del historial',
    reasons: (count) => plural(count, 'motivo', 'motivos'),
    focused: 'El caso que abriste',
    actionsTitle: 'Acciones sobre este caso',
    detailsSummary: 'Escalamiento e historial',
    escalationTitle: 'Escalamiento',
    historyTitle: 'Historial del caso',
    feedbackTitle: '¿Te sirvió este caso?',
    closedNotice: (status) =>
      `Este caso está cerrado (${status}). Si el paciente vuelve a tener algo pendiente, el motor abrirá un caso nuevo.`,
    loading: 'Cargando paciente',
    loadError: 'No pudimos cargar el paciente',
    notFound: 'No encontramos ese caso',
    caseLoadError: 'No pudimos cargar este caso',
  },
};

export const PATIENT_QUEUE_COPY: Readonly<Record<CopyLocale, PatientQueueCopy>> = { en, es };

/** The copy of a locale (English by default). */
export function patientQueueCopy(locale: CopyLocale = 'en'): PatientQueueCopy {
  return PATIENT_QUEUE_COPY[locale];
}
