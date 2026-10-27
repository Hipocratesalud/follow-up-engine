import type { Expectation } from '../../domain/expectation.ts';
import { containsPhrase, foldText } from '../support/text.ts';
import type { PatientTimeline } from '../timeline.ts';

/**
 * Canonical specialty keys (the engine's specialty CodeSystem codes) and the
 * Spanish and English words that name each of them in clinical text or in a
 * host's specialty label. Accents and case do not matter.
 */
const SPECIALTY_LEXICON: Readonly<Record<string, readonly string[]>> = {
  cardiology: ['cardiologia', 'cardiologo', 'cardiologa', 'cardiology'],
  endocrinology: ['endocrinologia', 'endocrinologo', 'endocrinologa', 'endocrino', 'endocrinology'],
  diabetology: ['diabetologia', 'diabetologo', 'diabetologa', 'diabetology'],
  nephrology: ['nefrologia', 'nefrologo', 'nefrologa', 'nephrology'],
  neurology: ['neurologia', 'neurologo', 'neurologa', 'neurology'],
  gastroenterology: [
    'gastroenterologia',
    'gastroenterologo',
    'gastroenterologa',
    'gastroenterology',
  ],
  pulmonology: [
    'neumologia',
    'neumonologia',
    'neumologo',
    'neumologa',
    'neumonologo',
    'neumonologa',
    'pulmonology',
  ],
  dermatology: ['dermatologia', 'dermatologo', 'dermatologa', 'dermatology'],
  ophthalmology: ['oftalmologia', 'oftalmologo', 'oftalmologa', 'ophthalmology'],
  otolaryngology: [
    'otorrinolaringologia',
    'otorrinolaringologo',
    'otorrinolaringologa',
    'otorrino',
    'otolaryngology',
  ],
  gynecology: ['ginecologia', 'ginecologo', 'ginecologa', 'gynecology'],
  obstetrics: ['obstetricia', 'obstetra', 'obstetrics'],
  urology: ['urologia', 'urologo', 'urologa', 'urology'],
  psychiatry: ['psiquiatria', 'psiquiatra', 'psychiatry'],
  psychology: ['psicologia', 'psicologo', 'psicologa', 'psychology'],
  rheumatology: ['reumatologia', 'reumatologo', 'reumatologa', 'rheumatology'],
  oncology: ['oncologia', 'oncologo', 'oncologa', 'oncology'],
  hematology: ['hematologia', 'hematologo', 'hematologa', 'hematology'],
  traumatology: [
    'traumatologia',
    'traumatologo',
    'traumatologa',
    'ortopedia',
    'traumatology',
    'orthopedics',
  ],
  infectious_diseases: ['infectologia', 'infectologo', 'infectologa', 'infectious diseases'],
  pediatrics: ['pediatria', 'pediatra', 'pediatrics'],
  geriatrics: ['geriatria', 'geriatra', 'geriatrics'],
  nutrition: ['nutricion', 'nutriologo', 'nutriologa', 'nutricionista', 'nutrition'],
  physiotherapy: ['fisioterapia', 'fisioterapeuta', 'physiotherapy'],
  physical_medicine: ['fisiatria', 'fisiatra', 'physical medicine'],
  general_surgery: ['cirugia general', 'cirujano general', 'general surgery'],
  internal_medicine: ['medicina interna', 'internista', 'internal medicine'],
  general_practice: ['medicina general', 'medico general', 'general practice'],
  family_medicine: ['medicina familiar', 'medico familiar', 'medico de familia', 'family medicine'],
};

const KEY_BY_TERM = new Map(
  Object.entries(SPECIALTY_LEXICON).flatMap(([key, terms]) => [
    [key, key] as const,
    ...terms.map((term) => [term.replace(/\s+/g, '_'), key] as const),
  ]),
);

/** `Medicina Interna`, `medicina_interna` and `internal_medicine` compare equal; accents and case do not matter. */
export function canonicalSpecialty(specialty: string | undefined): string {
  const normalized = foldText(specialty ?? '')
    .trim()
    .replace(/[\s-]+/g, '_');
  return KEY_BY_TERM.get(normalized) ?? normalized;
}

/** The specialties a piece of clinical text names ("control con cardiología" → `cardiology`). */
export function specialtiesNamedIn(text: string): Set<string> {
  const named = new Set<string>();
  for (const [key, terms] of Object.entries(SPECIALTY_LEXICON)) {
    if (containsPhrase(text, terms)) {
      named.add(key);
    }
  }
  return named;
}

/** Sentence and clause boundaries: a plan item's own words end there. */
const CLAUSE_BOUNDARY = /[.;:,\n]|\s(?:y|e)\s/gu;

/**
 * The clause of `text` around `quote` (the plan item's verbatim quote),
 * folded to lowercase without accents: the extractor may quote only "en 1
 * mes" of "control con cardiología en 1 mes". The quote itself when it is
 * not found in the text.
 */
export function clauseAround(text: string, quote: string): string {
  const foldedText = foldText(text);
  const foldedQuote = foldText(quote).trim();
  const start = foldedQuote === '' ? -1 : foldedText.indexOf(foldedQuote);
  if (start < 0) {
    return quote;
  }
  const end = start + foldedQuote.length;
  let from = 0;
  let to = foldedText.length;
  for (const boundary of foldedText.matchAll(CLAUSE_BOUNDARY)) {
    const at = boundary.index;
    if (at + boundary[0].length <= start) {
      from = at + boundary[0].length;
    } else if (at >= end) {
      to = Math.min(to, at);
    }
  }
  return foldedText.slice(from, to);
}

/**
 * The specialties a doctor's-plan item sends the patient to, read
 * deterministically from the item's words: its description and the clause
 * of the note around its quote ("control con cardiología en 1 mes" written
 * by internal medicine asks for a cardiology visit). Empty when the item
 * names none.
 */
export function referredSpecialties(
  expectation: Expectation,
  timeline: PatientTimeline,
): Set<string> {
  const quote = expectation.evidence?.quote;
  if (quote === undefined) {
    return new Set();
  }
  const sourceKey = `${expectation.source.resourceType}/${expectation.source.id}`;
  const fromSource = timeline.events.filter(
    (event) => `${event.source.resourceType}/${event.source.id}` === sourceKey,
  );
  const note = fromSource.filter((event) => event.type === 'note.received').at(-1);
  const descriptions = fromSource.flatMap((event) =>
    event.type === 'plan.extracted'
      ? event.items.filter((item) => item.evidenceQuote === quote).map((item) => item.description)
      : [],
  );
  const texts = [
    note?.type === 'note.received' ? clauseAround(note.text, quote) : quote,
    ...descriptions,
  ];
  return specialtiesNamedIn(texts.join('\n'));
}
