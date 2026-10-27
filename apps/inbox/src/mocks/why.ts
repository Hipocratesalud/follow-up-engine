import type { Layer, ProtocolRef } from '../api/contract.ts';
import type {
  DocumentRefView,
  PatientDocumentView,
  ReasonWhyView,
  WhyDocumentKind,
} from '../api/why-contract.ts';
import type { Locale } from '../i18n/index.ts';

/*
 * The mock API's "Why this?" (HIP-142): the same shape the API answers,
 * built from what the mock store knows (the note, the reason's source, the
 * patient's conditions). Texts follow the API catalogs in both languages.
 */

const MS_PER_DAY = 86_400_000;

const KIND_BY_RESOURCE: Readonly<Record<string, WhyDocumentKind>> = {
  DocumentReference: 'note',
  ServiceRequest: 'order',
  Observation: 'result',
  DiagnosticReport: 'result',
  MedicationRequest: 'prescription',
  Encounter: 'visit',
  Appointment: 'appointment',
  Condition: 'diagnosis',
  AllergyIntolerance: 'allergy',
};

const COPY = {
  en: {
    kinds: {
      note: 'Clinical note',
      order: 'Order',
      result: 'Result',
      prescription: 'Prescription',
      visit: 'Visit',
      appointment: 'Appointment',
      diagnosis: 'Diagnosis',
      allergy: 'Allergy record',
      other: 'Record',
    },
    roles: {
      note: 'note',
      trigger: 'trigger',
      lastDone: 'last time done',
      lastVisit: 'latest visit',
    },
    dueMath: (due: string, anchor: string, date: string, days: number) =>
      `Due ${due} = ${anchor} (${date}) + ${String(days)} days`,
    planDate: 'The date the doctor gave in the note.',
    ruleDays: (days: number) => `The rule gives ${String(days)} days after the trigger.`,
    every: (days: number) =>
      `Every ${String(days)} days, from the last time it was done (or from enrollment).`,
    cadence: (interval: number) => `3 × the patient’s usual interval of ${String(interval)} days.`,
    pattern: (interval: number, expected: string) =>
      `3 visits of this specialty (3 make the pattern): usual interval ${String(interval)} days, so the next visit was expected within 3 × ${String(interval)} days, by ${expected}.`,
    visit: 'A visit, or a booked appointment.',
    result: 'A matching result.',
    tolerance: (days: number) =>
      `A booking up to ${String(days)} days after the due date still counts.`,
    schedule: (days: number) => `Every ${String(days)} days.`,
    enrolled: (diagnosis: string, date: string) =>
      `Coded diagnosis ${diagnosis}, recorded ${date}.`,
    draft: 'Draft: not yet validated by the clinical team',
    confirmed: 'confirmed',
  },
  es: {
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
    roles: {
      note: 'nota',
      trigger: 'origen',
      lastDone: 'última vez que se hizo',
      lastVisit: 'última consulta',
    },
    dueMath: (due: string, anchor: string, date: string, days: number) =>
      `Vence el ${due} = ${anchor} (${date}) + ${String(days)} días`,
    planDate: 'La fecha que el médico indicó en la nota.',
    ruleDays: (days: number) => `La regla da ${String(days)} días desde el origen.`,
    every: (days: number) =>
      `Cada ${String(days)} días, desde la última vez que se hizo (o desde el ingreso al protocolo).`,
    cadence: (interval: number) =>
      `3 × el intervalo habitual del paciente, de ${String(interval)} días.`,
    pattern: (interval: number, expected: string) =>
      `3 consultas de esta especialidad (3 forman el patrón): intervalo habitual de ${String(interval)} días, así que la próxima consulta se esperaba dentro de 3 × ${String(interval)} días, antes del ${expected}.`,
    visit: 'Una consulta, o una cita agendada.',
    result: 'Un resultado que lo cumpla.',
    tolerance: (days: number) =>
      `Una cita hasta ${String(days)} días después del vencimiento todavía cuenta.`,
    schedule: (days: number) => `Cada ${String(days)} días.`,
    enrolled: (diagnosis: string, date: string) =>
      `Diagnóstico codificado ${diagnosis}, registrado el ${date}.`,
    draft: 'Borrador: aún sin validar por el equipo clínico',
    confirmed: 'confirmado',
  },
} as const;

/** Days a mock rule or protocol item gives (what the real catalog says for these ids). */
function intervalOf(ruleId: string, layer: Layer): number {
  if (ruleId.endsWith('_hba1c')) return 90;
  if (ruleId.endsWith('_visit')) return 180;
  if (ruleId.includes('lipid') || ruleId.endsWith('_labs') || ruleId.endsWith('_fundus')) {
    return 365;
  }
  if (layer === 'cadence') return 90;
  if (ruleId === 'abnormal_result_followup') return 7;
  return layer === 'protocol' ? 180 : 15;
}

export interface MockWhyInput {
  readonly locale: Locale;
  readonly ruleId: string;
  readonly layer: Layer;
  readonly dueAt: Date;
  readonly source: { readonly resourceType: string; readonly id: string; readonly display: string };
  readonly note?: {
    readonly id: string;
    readonly authoredAt: Date;
    readonly specialty: string;
    readonly text: string;
  };
  readonly quote?: string;
  readonly noteExcerpt?: string;
  readonly protocol?: ProtocolRef;
  readonly condition?: { readonly id: string; readonly code: string; readonly display: string };
}

function format(date: Date, locale: Locale): string {
  return date.toLocaleDateString(locale === 'es' ? 'es' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function docRef(
  locale: Locale,
  source: MockWhyInput['source'],
  at: Date,
  extra: Partial<DocumentRefView> = {},
): DocumentRefView {
  const kind = KIND_BY_RESOURCE[source.resourceType] ?? 'other';
  return {
    resourceType: source.resourceType,
    id: source.id,
    kind,
    kindLabel: COPY[locale].kinds[kind],
    at: at.toISOString(),
    title: kind === 'note' ? COPY[locale].kinds.note : source.display,
    ...extra,
  };
}

export function mockWhy(input: MockWhyInput): ReasonWhyView {
  const copy = COPY[input.locale];
  const { locale, dueAt, layer } = input;
  const planNote = layer === 'doctor_plan' ? input.note : undefined;
  const plan = planNote !== undefined;
  const days =
    planNote === undefined
      ? intervalOf(input.ruleId, layer)
      : Math.round((dueAt.getTime() - planNote.authoredAt.getTime()) / MS_PER_DAY);
  const anchorAt = new Date(dueAt.getTime() - days * MS_PER_DAY);
  const note =
    input.note === undefined
      ? undefined
      : docRef(
          locale,
          { resourceType: 'DocumentReference', id: input.note.id, display: '' },
          input.note.authoredAt,
          { documentId: input.note.id, specialty: input.note.specialty },
        );
  const anchor =
    plan && note !== undefined
      ? note
      : layer === 'cadence'
        ? docRef(
            locale,
            { resourceType: 'Encounter', id: `${input.source.id}-visit`, display: '' },
            anchorAt,
            {
              title: copy.kinds.visit,
            },
          )
        : docRef(locale, input.source, anchorAt);
  const role = plan
    ? copy.roles.note
    : layer === 'protocol'
      ? copy.roles.lastDone
      : layer === 'cadence'
        ? copy.roles.lastVisit
        : copy.roles.trigger;
  const visit = layer === 'cadence' || input.ruleId.endsWith('_visit') || plan;
  const tolerance = visit ? Math.max(3, Math.ceil(days * 0.15)) : undefined;
  const interval = Math.round(days / 3);
  return {
    layer,
    due: {
      basis: plan
        ? 'plan_date'
        : layer === 'cadence'
          ? 'cadence'
          : layer === 'protocol'
            ? 'protocol_interval'
            : 'rule_days',
      anchorRole: plan
        ? 'note'
        : layer === 'protocol'
          ? 'last_done'
          : layer === 'cadence'
            ? 'last_visit'
            : 'trigger',
      anchor,
      anchorAt: anchorAt.toISOString(),
      days,
      dueAt: dueAt.toISOString(),
      text: copy.dueMath(
        format(dueAt, locale),
        `${role}: ${anchor.title}`,
        format(anchorAt, locale),
        days,
      ),
      basisText: plan
        ? copy.planDate
        : layer === 'cadence'
          ? copy.cadence(interval)
          : layer === 'protocol'
            ? copy.every(days)
            : copy.ruleDays(days),
      ...(tolerance === undefined
        ? {}
        : { bookingToleranceDays: tolerance, toleranceText: copy.tolerance(tolerance) }),
    },
    fulfilledBy: {
      expects: visit ? 'follow_up_visit' : 'lab',
      equivalentCodes: [],
      events: visit ? ['encounter.finished', 'appointment.booked'] : ['result.received'],
      specialties: [],
      text: visit ? copy.visit : copy.result,
    },
    ...(planNote !== undefined && input.quote !== undefined && note !== undefined
      ? {
          plan: {
            documentId: planNote.id,
            quote: input.quote,
            authoredAt: planNote.authoredAt.toISOString(),
            specialty: planNote.specialty,
            ...(input.noteExcerpt === undefined ? {} : { noteExcerpt: input.noteExcerpt }),
            note,
          },
        }
      : {}),
    ...(layer === 'protocol' && input.protocol !== undefined
      ? {
          protocol: {
            id: input.protocol.id,
            ...(input.protocol.name === undefined ? {} : { name: input.protocol.name }),
            version: input.protocol.version,
            ...(input.protocol.status === undefined
              ? {}
              : { status: input.protocol.status, statusText: copy.draft }),
            title: `${input.protocol.name ?? input.protocol.id} v${input.protocol.version}`,
            scheduleText: copy.schedule(days),
            enrollment: {
              episode: 'active' as const,
              basis: 'diagnosis' as const,
              ...(input.condition === undefined
                ? {}
                : {
                    condition: {
                      code: input.condition.code,
                      display: input.condition.display,
                      status: 'confirmed',
                      sourceType: 'recorded',
                    },
                  }),
              evidence:
                input.condition === undefined
                  ? []
                  : [
                      docRef(
                        locale,
                        {
                          resourceType: 'Condition',
                          id: input.condition.id,
                          display: input.condition.display,
                        },
                        new Date(anchorAt.getTime() - 200 * MS_PER_DAY),
                        { code: input.condition.code, detail: copy.confirmed },
                      ),
                    ],
              text: copy.enrolled(
                input.condition === undefined
                  ? (input.protocol.name ?? input.protocol.id)
                  : `${input.condition.code} ${input.condition.display}`,
                format(new Date(anchorAt.getTime() - 200 * MS_PER_DAY), locale),
              ),
            },
          },
        }
      : {}),
    ...(layer === 'cadence'
      ? {
          cadence: {
            visits: [2, 1, 0].map((back) => ({
              at: new Date(anchorAt.getTime() - back * interval * MS_PER_DAY).toISOString(),
              encounterId: `${input.source.id}-visit-${String(back)}`,
              inPattern: true,
            })),
            usualIntervalDays: interval,
            multiplier: 3,
            expectedBy: dueAt.toISOString(),
            text: copy.pattern(interval, format(dueAt, locale)),
          },
        }
      : {}),
  };
}

/** A note of the mock patient as a document. */
export function mockNoteRef(
  locale: Locale,
  note: { readonly id: string; readonly authoredAt: Date; readonly specialty: string },
): DocumentRefView {
  return docRef(
    locale,
    { resourceType: 'DocumentReference', id: note.id, display: '' },
    note.authoredAt,
    { documentId: note.id, specialty: note.specialty },
  );
}

/** Every document a reason cites, plus the patient's notes, oldest first. */
export function mockDocuments(
  cited: readonly DocumentRefView[],
  notes: readonly { readonly view: DocumentRefView; readonly text: string }[],
): PatientDocumentView[] {
  const byKey = new Map<string, PatientDocumentView>();
  for (const doc of cited) byKey.set(`${doc.resourceType}/${doc.id}`, doc);
  for (const note of notes) {
    byKey.set(`${note.view.resourceType}/${note.view.id}`, { ...note.view, text: note.text });
  }
  return [...byKey.values()].sort((left, right) => left.at.localeCompare(right.at));
}
