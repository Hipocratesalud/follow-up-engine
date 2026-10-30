import {
  codeMatchKey,
  itemSchedule,
  matchKeyFor,
  type Protocol,
  type ProtocolItem,
} from '@follow-up-engine/core';
import type { ApiLocale } from '../i18n/index.ts';
import { messagesFor } from '../i18n/index.ts';

/**
 * A clinical sign-off page (docs/protocols/signoff/*.md, *.es.md) is built
 * only from: the protocol's own config file, the other protocol files it
 * shares a test with (for the cross-protocol exception), the engine's
 * reason-and-action catalog (apps/api/src/i18n), and the test references in
 * `./tests.ts`. Nothing here is hand-typed clinical prose: if a number or a
 * label changes in config or in the catalog, regenerating changes the page
 * the same way. `pnpm test` fails (`generate.test.ts`) if a committed page
 * no longer matches a fresh generation.
 */

/** A test that proves one behavior the page describes, cited in its appendix. */
export interface SignoffTestRef {
  /** Path from the repo root. */
  readonly file: string;
  readonly describe: string;
  readonly it: string;
}

/** The two generic ways a protocol item never duplicates a request already in play. */
export type SignoffExceptionId = 'covered_by_plan' | 'covered_by_protocol';

export interface SignoffException {
  readonly id: SignoffExceptionId;
  readonly test: SignoffTestRef;
}

/** What proves one item of the protocol, for the appendix. */
export interface ItemTestRefs {
  readonly fires: SignoffTestRef;
  readonly exceptions: readonly SignoffException[];
}

/** Every item's test references, by protocol id then item key. */
export type SignoffTestCatalog = Readonly<Record<string, Readonly<Record<string, ItemTestRefs>>>>;

const EXCEPTION_TITLE: Readonly<Record<SignoffExceptionId, Readonly<Record<ApiLocale, string>>>> = {
  covered_by_plan: {
    en: "Already covered by the doctor's plan or an open order",
    es: 'Ya cubierto por el plan del médico o una orden abierta',
  },
  covered_by_protocol: {
    en: 'Shared with another protocol, due no later',
    es: 'Compartido con otro protocolo, vence igual o antes',
  },
};

const EXCEPTION_BODY: Readonly<Record<SignoffExceptionId, Readonly<Record<ApiLocale, string>>>> = {
  covered_by_plan: {
    en:
      "If a live doctor's-plan or universal-layer expectation already asks for the same " +
      "test (the same code, a code of the item's equivalence group, or an uncoded plan " +
      'item whose quote names the test — see `planTerms` below), the protocol never adds a ' +
      "second one: the doctor's plan always wins.",
    es:
      'Si una expectativa viva del plan del médico o de una regla universal ya pide la ' +
      'misma prueba (el mismo código, un código del mismo grupo de equivalencia, o un ' +
      'punto del plan sin código cuya cita nombra la prueba — ver `planTerms` abajo), el ' +
      'protocolo nunca agrega una segunda: el plan del médico siempre gana.',
  },
  covered_by_protocol: {
    en:
      'One test, one expectation: when another protocol the clinic also runs expects the ' +
      'same test (same code or an equivalent one) no later than this item, only the one ' +
      'due first is kept.',
    es:
      'Una prueba, una expectativa: cuando otro protocolo que el consultorio también ' +
      'activa pide la misma prueba (mismo código o uno equivalente) igual o antes que ' +
      'este punto, solo queda la que vence primero.',
  },
};

/** Codes that fulfill `item`: its own code and every code its `fulfilledBy` filters accept. */
function fulfillingMatchKeys(item: ProtocolItem): ReadonlySet<string> {
  if (item.code === undefined) {
    return new Set<string>([matchKeyFor(item.kind, undefined)]);
  }
  const keys = new Set<string>([
    matchKeyFor(item.kind, { system: item.code.system, code: item.code.code }),
  ]);
  for (const correlation of item.fulfilledBy) {
    const codes = correlation.filter?.['code.code'];
    for (const code of Array.isArray(codes) ? codes : []) {
      if (typeof code === 'string') {
        keys.add(codeMatchKey({ system: item.code.system, code }));
      }
    }
  }
  return keys;
}

/** The other protocols (by id and item key) that expect the same test as `item`. */
export function sharedTestItems(
  allProtocols: readonly Protocol[],
  protocolId: string,
  item: ProtocolItem,
): readonly { readonly protocolId: string; readonly itemKey: string }[] {
  if (item.code === undefined) {
    return [];
  }
  const mine = fulfillingMatchKeys(item);
  const shared: { protocolId: string; itemKey: string }[] = [];
  for (const other of allProtocols) {
    if (other.id === protocolId) {
      continue;
    }
    for (const otherItem of other.items) {
      if (otherItem.code === undefined) {
        continue;
      }
      const theirs = fulfillingMatchKeys(otherItem);
      if ([...mine].some((key) => theirs.has(key)) || [...theirs].some((key) => mine.has(key))) {
        shared.push({ protocolId: other.id, itemKey: otherItem.key });
      }
    }
  }
  return shared;
}

function ruleReason(locale: ApiLocale, code: string, fallback: string): string {
  return messagesFor(locale).rules[code]?.reason ?? fallback;
}

function ruleAction(locale: ApiLocale, code: string, fallback: string): string {
  return messagesFor(locale).rules[code]?.action ?? fallback;
}

function protocolName(locale: ApiLocale, protocol: Protocol): string {
  return ruleReason(locale, protocol.reason.code, protocol.reason.label);
}

function daysText(locale: ApiLocale, days: number): string {
  return messagesFor(locale).why.schedule.interval(days);
}

const DUE_RULE: Readonly<Record<ApiLocale, (days: number) => string>> = {
  en: (days) =>
    `Due ${String(days)} days after the last qualifying visit or result; without one yet, ` +
    `${String(days)} days after the patient enrolled in the protocol. A booking fulfills the ` +
    'open expectation but never anchors the next one: the next item still counts from ' +
    'something that actually happened.',
  es: (days) =>
    `Vence ${String(days)} días después de la última consulta o resultado que lo cumpla; si ` +
    `aún no hay ninguno, ${String(days)} días después de que el paciente entró al protocolo. ` +
    'Una cita agendada cumple la expectativa abierta, pero nunca marca el punto de partida ' +
    'de la siguiente: esa siempre se cuenta desde algo que ya ocurrió.',
};

/**
 * The protocol's own `sources`, one bullet each: the fallback for an item
 * with no pinpoint `source` of its own. Title and organization are literal
 * config data (not translated, like a drug name): the same in both
 * languages.
 */
function sourceCitations(locale: ApiLocale, protocol: Protocol): readonly string[] {
  if (protocol.sources.length === 0) {
    return [
      locale === 'en'
        ? 'No guideline cited — physician to confirm.'
        : 'Sin guía citada — el médico debe confirmarla.',
    ];
  }
  return protocol.sources.map(
    (source) =>
      `${source.title} — ${source.organization} (${String(source.year)}). <${source.url}>`,
  );
}

/** An item's own pinpoint citation (`ProtocolItem.source`), ready to show. */
export interface ItemCitation {
  readonly guideline: string;
  readonly section: string;
  /** A paraphrase, not a verbatim quote: `render.ts` always labels it as one. */
  readonly statement: string;
}

/**
 * Spanish paraphrase of each item's `source.statement` (English, in
 * config): the generator authors this translation itself, like `DUE_RULE`
 * and `EXCEPTION_BODY`, because it is prose the generator writes for the
 * page, not literal data the engine reads. Keyed by the item's reason code
 * so a missing translation fails loudly instead of leaking English into
 * the Spanish page.
 */
const ITEM_CITATION_STATEMENT_ES: Readonly<Record<string, string>> = {
  protocol_diabetes_hba1c:
    'Recomienda medir la HbA1c con regularidad para seguir el control glicémico, con mayor ' +
    'frecuencia (por ejemplo cada 3 meses) cuando el paciente no está en meta o tras un cambio ' +
    'de tratamiento, y al menos dos veces al año en el resto de los casos.',
  protocol_diabetes_lipids:
    'Recomienda un perfil lipídico anual en adultos con diabetes como parte de la evaluación ' +
    'del riesgo cardiovascular, con mayor frecuencia si el riesgo o el tratamiento lo ' +
    'justifican.',
  protocol_diabetes_fundus:
    'Recomienda un examen de fondo de ojo con dilatación al diagnóstico y luego cada año, con ' +
    'intervalos más largos posibles tras uno o más exámenes normales, a criterio del médico ' +
    'tratante.',
};

/**
 * `item.source`, ready to show, in `locale`. `undefined` when the item has
 * none: the page falls back to the protocol's own sources instead
 * (`sourceCitations`) rather than guess which section covers it.
 */
function itemCitation(locale: ApiLocale, item: ProtocolItem): ItemCitation | undefined {
  if (item.source === undefined) {
    return undefined;
  }
  const statement =
    locale === 'en' ? item.source.statement : ITEM_CITATION_STATEMENT_ES[item.reason.code];
  if (statement === undefined) {
    throw new Error(
      'protocol-signoff: no Spanish translation of the citation statement for ' +
        `"${item.reason.code}" in model.ts (ITEM_CITATION_STATEMENT_ES).`,
    );
  }
  return { guideline: item.source.guideline, section: item.source.section, statement };
}

function minimumStatusText(locale: ApiLocale, minimumStatus: 'confirmed' | 'probable'): string {
  if (minimumStatus === 'confirmed') {
    return locale === 'en' ? 'a confirmed diagnosis only' : 'solo un diagnóstico confirmado';
  }
  return locale === 'en'
    ? 'a confirmed diagnosis, or one the record only makes probable'
    : 'un diagnóstico confirmado, o uno que la historia solo hace probable';
}

/** Bullets describing exactly who enrolls, from `protocol.enrollment` — nothing else. */
export function enrollmentBullets(locale: ApiLocale, protocol: Protocol): readonly string[] {
  const { enrollment } = protocol;
  const bullets: string[] = [];
  const codes = enrollment.conditionCodes.join(', ');
  bullets.push(
    locale === 'en'
      ? `An ICD-10 diagnosis of ${codes} (or a more specific code under one of them, for ` +
          `example ${enrollment.conditionCodes[0] ?? ''}.9) at ${minimumStatusText(locale, enrollment.minimumStatus)}.`
      : `Un diagnóstico CIE-10 ${codes} (o uno más específico dentro de alguno de ellos, por ` +
          `ejemplo ${enrollment.conditionCodes[0] ?? ''}.9), con ${minimumStatusText(locale, enrollment.minimumStatus)}.`,
  );
  for (const medication of enrollment.medications ?? []) {
    const names = medication.match?.join(', ');
    const atc = medication.atc?.join(', ');
    bullets.push(
      locale === 'en'
        ? `A prescription matching${names === undefined ? '' : `: ${names}`}` +
            `${atc === undefined ? '' : ` (ATC ${atc})`} — read as ${medication.conditionCode} ` +
            'when the record has no coded diagnosis.'
        : `Una receta que coincide${names === undefined ? '' : ` con: ${names}`}` +
            `${atc === undefined ? '' : ` (ATC ${atc})`} — se lee como ${medication.conditionCode} ` +
            'cuando la historia no tiene un diagnóstico codificado.',
    );
  }
  for (const result of enrollment.results ?? []) {
    const bound =
      result.gte !== undefined
        ? locale === 'en'
          ? `of ${String(result.gte)} or more`
          : `de ${formatNumberEs(result.gte)} o más`
        : locale === 'en'
          ? `under ${String(result.lt)}`
          : `menor a ${formatNumberEs(result.lt)}`;
    const confirm =
      result.confirm === undefined
        ? ''
        : locale === 'en'
          ? `, confirmed by ${String(result.confirm.count)} such results at least ` +
            `${String(result.confirm.minDaysApart)} days apart`
          : `, confirmado con ${String(result.confirm.count)} resultados así, con ` +
            `${String(result.confirm.minDaysApart)} días o más de separación`;
    const testName = result.code.display ?? `LOINC ${result.code.code}`;
    bullets.push(
      locale === 'en'
        ? `A ${testName} result ${bound}${confirm} — read as ${result.conditionCode} when the ` +
            'record has no coded diagnosis.'
        : `Un resultado ${testName === `LOINC ${result.code.code}` ? testName : `de ${testName}`} ` +
            `${bound}${confirm} — se lee como ${result.conditionCode} cuando la historia no tiene ` +
            'un diagnóstico codificado.',
    );
  }
  return bullets;
}

export interface ItemSection {
  readonly key: string;
  readonly ruleId: string;
  readonly kind: ProtocolItem['kind'];
  readonly expected: string;
  readonly why: string;
  readonly howOften: string;
  readonly dueRule: string;
  /** This item's own citation, when one is known for certain; else the page points to "Guidelines cited". */
  readonly citation?: ItemCitation;
  readonly priority: number;
  readonly evidenceCodes: readonly string[];
  readonly planTerms: readonly string[];
  readonly sharedWith: readonly { readonly protocolName: string; readonly itemKey: string }[];
}

/** One item of the protocol, as the sign-off page shows it. Fails loudly on a schedule this generator does not know how to describe. */
export function itemSection(
  locale: ApiLocale,
  protocol: Protocol,
  item: ProtocolItem,
  allProtocols: readonly Protocol[],
): ItemSection {
  const schedule = itemSchedule(item);
  if (schedule.type !== 'interval') {
    throw new Error(
      `protocol-signoff: item "${item.key}" of "${protocol.id}" has a "${schedule.type}" ` +
        'schedule; the generator only knows how to describe a plain interval. Extend ' +
        'model.ts before adding this kind of schedule to diabetes or hypertension.',
    );
  }
  const shared = sharedTestItems(allProtocols, protocol.id, item).map((ref) => {
    const other = allProtocols.find((candidate) => candidate.id === ref.protocolId);
    return {
      protocolName: other === undefined ? ref.protocolId : protocolName(locale, other),
      itemKey: ref.itemKey,
    };
  });
  const evidenceCodes = [
    ...new Set(
      item.fulfilledBy.flatMap((correlation) => {
        const codes = correlation.filter?.['code.code'];
        return Array.isArray(codes) ? codes.filter((code) => typeof code === 'string') : [];
      }),
    ),
  ] as string[];
  const citation = itemCitation(locale, item);
  return {
    key: item.key,
    ruleId: item.reason.code,
    kind: item.kind,
    expected: ruleAction(locale, item.reason.code, item.suggestedAction.label),
    why: ruleReason(locale, item.reason.code, item.reason.label),
    howOften: daysText(locale, schedule.everyDays),
    dueRule: DUE_RULE[locale](schedule.everyDays),
    ...(citation === undefined ? {} : { citation }),
    priority: item.priority,
    evidenceCodes,
    planTerms: item.planTerms ?? [],
    sharedWith: shared,
  };
}

export interface ExceptionSection {
  readonly id: SignoffExceptionId;
  readonly title: string;
  readonly body: string;
  readonly test: SignoffTestRef;
}

export interface NotApplicableFact {
  readonly label: string;
}

/** One item with no pinpoint citation of its own: a question for the physician to answer first. */
export interface ToAnswerFirst {
  readonly key: string;
  readonly label: string;
}

export interface SignoffPageData {
  readonly protocol: Protocol;
  readonly name: string;
  /** The protocol's own `sources`, one bullet each (the "Guidelines cited" section). */
  readonly sources: readonly string[];
  /** Items with no `citation` (see `ItemSection.citation`): raised first, in the opening lines. */
  readonly toAnswerFirst: readonly ToAnswerFirst[];
  readonly enrollment: readonly string[];
  readonly items: readonly ItemSection[];
  readonly exceptions: readonly ExceptionSection[];
  readonly notApplicable: readonly string[];
  readonly appendix: readonly {
    readonly key: string;
    readonly ruleId: string;
    readonly firesTest: SignoffTestRef;
    readonly exceptionTests: readonly {
      readonly id: SignoffExceptionId;
      readonly test: SignoffTestRef;
    }[];
  }[];
}

/** Facts read directly from the JSON: present only when the field is absent for this protocol. */
function notApplicableFacts(locale: ApiLocale, protocol: Protocol): string[] {
  const facts: string[] = [];
  if (protocol.closing === undefined) {
    facts.push(
      locale === 'en'
        ? 'No episode closing (pregnancy-style): this protocol is chronic, not episodic. It ' +
            'never ends on an outcome diagnosis, and nothing like the postpartum visit applies.'
        : 'Sin cierre de episodio (como en embarazo): este protocolo es crónico, no episódico. ' +
            'Nunca termina por un diagnóstico de desenlace, ni aplica nada parecido a la visita ' +
            'posparto.',
    );
  }
  if (protocol.closesOnDischarge !== true) {
    facts.push(
      locale === 'en'
        ? 'No discharge closing: a note that discharges the patient from another protocol ' +
            "(treatment follow-up) does not end this one. There is no condition this protocol's " +
            'own notes discharge from.'
        : 'Sin cierre por alta: una nota que da de alta al paciente de otro protocolo ' +
            '(seguimiento de tratamiento) no cierra este. Este protocolo no tiene una condición ' +
            'de la que sus propias notas den de alta.',
    );
  }
  if (protocol.sensitive !== true) {
    facts.push(
      locale === 'en'
        ? 'Not sensitive: the condition this protocol tracks can be named in its reasons, ' +
            "suggested actions and patient-contact purpose (unlike treatment follow-up's " +
            'mental-health masking).'
        : 'No es sensible: la condición que sigue este protocolo se puede nombrar en sus ' +
            'motivos, acciones sugeridas y el propósito del contacto al paciente (a diferencia ' +
            'del enmascaramiento de salud mental de seguimiento de tratamiento).',
    );
  }
  if ((protocol.enrollment.results ?? []).every((result) => result.confirm === undefined)) {
    facts.push(
      locale === 'en'
        ? 'No repeated-result confirmation window (unlike chronic kidney disease, which needs ' +
            'two qualifying results at least 90 days apart): one qualifying result or diagnosis ' +
            'enrolls the patient.'
        : 'Sin ventana de confirmación por resultados repetidos (a diferencia de enfermedad ' +
            'renal crónica, que exige dos resultados que califiquen con 90 días o más de ' +
            'separación): un solo resultado o diagnóstico que califique ya inscribe al paciente.',
    );
  }
  if (protocol.enrollment.activeTreatment === undefined) {
    facts.push(
      locale === 'en'
        ? 'No active-treatment-only gate (unlike treatment follow-up): a diagnosis alone, ' +
            'without an active prescription, is enough to enroll.'
        : 'Sin filtro de solo-tratamiento-activo (a diferencia de seguimiento de tratamiento): ' +
            'un diagnóstico por sí solo, sin receta activa, basta para inscribir al paciente.',
    );
  }
  return facts;
}

/** Everything a sign-off page needs, for one protocol and one language. Throws if a referenced test's title is not literally in its file (see `tests.ts`). */
export function buildSignoffPageData(
  locale: ApiLocale,
  protocol: Protocol,
  allProtocols: readonly Protocol[],
  tests: Readonly<Record<string, ItemTestRefs>>,
): SignoffPageData {
  const items = protocol.items.map((item) => itemSection(locale, protocol, item, allProtocols));
  const exceptions: ExceptionSection[] = [];
  const seen = new Set<SignoffExceptionId>();
  for (const item of protocol.items) {
    for (const exception of tests[item.key]?.exceptions ?? []) {
      if (seen.has(exception.id)) {
        continue;
      }
      seen.add(exception.id);
      exceptions.push({
        id: exception.id,
        title: EXCEPTION_TITLE[exception.id][locale],
        body: EXCEPTION_BODY[exception.id][locale],
        test: exception.test,
      });
    }
  }
  const appendix = protocol.items.map((item) => {
    const refs = tests[item.key];
    if (refs === undefined) {
      throw new Error(
        `protocol-signoff: no test reference for item "${item.key}" of "${protocol.id}" in ` +
          'tests.ts. Every item needs a fires-test before this page can claim it is proven.',
      );
    }
    return {
      key: item.key,
      ruleId: item.reason.code,
      firesTest: refs.fires,
      exceptionTests: refs.exceptions.map((exception) => ({
        id: exception.id,
        test: exception.test,
      })),
    };
  });
  const toAnswerFirst = items
    .filter((item) => item.citation === undefined)
    .map((item) => ({ key: item.key, label: item.expected }));
  return {
    protocol,
    name: protocolName(locale, protocol),
    sources: sourceCitations(locale, protocol),
    toAnswerFirst,
    enrollment: enrollmentBullets(locale, protocol),
    items,
    exceptions,
    notApplicable: notApplicableFacts(locale, protocol),
    appendix,
  };
}

/** A threshold as a Spanish reader writes it ("6,5"); English keeps String(). */
function formatNumberEs(value: number | undefined): string {
  return value === undefined
    ? ''
    : new Intl.NumberFormat('es', { useGrouping: false }).format(value);
}
