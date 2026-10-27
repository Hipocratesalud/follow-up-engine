import type {
  ExtractedConditionView,
  ExtractedMedicationView,
  ExtractedPlanItem,
  PlanItemKind,
} from '../api/contract.ts';

/**
 * A deterministic stand-in for the model reading a note, so the mock API can
 * answer the demo consultation without a network call. It follows the real
 * extractor's contract: every quote is a verbatim substring of the note and
 * due dates are resolved against the note's date.
 */

const DAY_MS = 86_400_000;

export const MOCK_MODEL = 'muse-spark';

interface ConditionPattern {
  readonly pattern: RegExp;
  readonly code: string;
  readonly display: string;
  readonly confidence: number;
}

const CONDITION_PATTERNS: readonly ConditionPattern[] = [
  {
    pattern: /\bDM2\b|diabetes mellitus tipo 2|diabetes tipo 2|type 2 diabetes|\bT2DM\b/i,
    code: 'E11',
    display: 'Diabetes mellitus tipo 2',
    confidence: 0.97,
  },
  { pattern: /prediabetes/i, code: 'R73.0', display: 'Prediabetes', confidence: 0.9 },
  {
    pattern: /\bHTA\b|hipertensi[oó]n arterial|hipertensi[oó]n|\bHTN\b|hypertension/i,
    code: 'I10',
    display: 'Hipertensión esencial (primaria)',
    confidence: 0.92,
  },
  {
    pattern: /crisis de angustia recurrentes|trastorno de p[aá]nico|episodios de p[aá]nico/i,
    code: 'F41.0',
    display: 'Trastorno de pánico',
    confidence: 0.82,
  },
  {
    pattern: /ansiedad generalizada/i,
    code: 'F41.1',
    display: 'Trastorno de ansiedad generalizada',
    confidence: 0.86,
  },
  {
    pattern: /episodio depresivo|depresi[oó]n/i,
    code: 'F32.9',
    display: 'Episodio depresivo',
    confidence: 0.76,
  },
  {
    pattern: /mioma intramural[^.,;]*|leiomioma[^.,;]*|mioma[^.,;]*/i,
    code: 'D25.1',
    display: 'Leiomioma intramural del útero',
    confidence: 0.88,
  },
  {
    pattern: /ovario poliqu[ií]stico/i,
    code: 'E28.2',
    display: 'Síndrome de ovario poliquístico',
    confidence: 0.8,
  },
  { pattern: /hipotiroidismo/i, code: 'E03.9', display: 'Hipotiroidismo', confidence: 0.9 },
  { pattern: /dislipidemia/i, code: 'E78.5', display: 'Dislipidemia', confidence: 0.85 },
];

const DRUGS = [
  'metformina',
  'sitagliptina',
  'empagliflozina',
  'insulina glargina',
  'glargina',
  'losart[aá]n',
  'enalapril',
  'amlodipino',
  'hidroclorotiazida',
  'sertralina',
  'escitalopram',
  'levotiroxina',
  'pregabalina',
  'atorvastatina',
  '[aá]cido tranex[aá]mico',
  // English (INN) names, for notes written in English.
  'metformin',
  'lisinopril',
  'amlodipine',
  'losartan',
  'atorvastatin',
  'levothyroxine',
  'sertraline',
];

const MEDICATION_PATTERN = new RegExp(
  `\\b(?:${DRUGS.join('|')})\\b[^.;]*?(?=\\s+(?:y|and)\\s|[.;]|$)`,
  'gi',
);

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  ocho: 8,
  diez: 10,
  doce: 12,
};

const DURATION_PATTERN =
  /\ben\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|ocho|diez|doce)\s+(d[ií]as?|semanas?|mes(?:es)?|a[nñ]os?)\b/i;

/** English intervals: "in 3 months", "RTC 6 wks", "f/u 2 weeks". */
const ENGLISH_DURATION_PATTERN =
  /\b(?:in|RTC|f\/u)\s+(\d+)\s*(days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?)\b/i;

function unitDays(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith('d')) return 1;
  if (normalized.startsWith('s') || normalized.startsWith('w')) return 7;
  if (normalized.startsWith('m')) return 30;
  return 365;
}

/** Days from the note to the moment a clause asks for (`en 3 meses` → 90). */
export function parseDueInDays(clause: string): number | undefined {
  const match = DURATION_PATTERN.exec(clause) ?? ENGLISH_DURATION_PATTERN.exec(clause);
  if (!match) return undefined;
  const [, amountText = '', unit = ''] = match;
  const amount = /^\d+$/.test(amountText)
    ? Number(amountText)
    : NUMBER_WORDS[amountText.toLowerCase()];
  if (amount === undefined) return undefined;
  return amount * unitDays(unit);
}

const SESSION = /\bsesi[oó]n(?:es)?\b/i;
const FOLLOW_UP =
  /^(?:control|ctrl|cita|consulta|reevaluar|reevaluaci[oó]n|revisi[oó]n|volver|RTC|f\/u|follow[- ]up|return)\b/i;
const LAB =
  /\b(?:HbA1c|A1c|perfil lip[ií]dico|lipid panel|microalbuminuria|creatinina|creatinine|hemograma|CBC|BMP|CMP|perfil hormonal|TSH|glicemia|potasio|potassium|orina)\b/i;
const IMAGING =
  /\b(?:ecograf[ií]a|mamograf[ií]a|ecocardiograma|MAPA|radiograf[ií]a|resonancia|tomograf[ií]a|densitometr[ií]a)\b/i;
const OTHER = /\b(?:escala|PHQ-9|GAD-7|referir|interconsulta|refer)\b/i;

function classify(clause: string): PlanItemKind | undefined {
  if (SESSION.test(clause)) return 'session';
  if (FOLLOW_UP.test(clause)) return 'follow_up_visit';
  if (LAB.test(clause)) return 'lab';
  if (IMAGING.test(clause)) return 'imaging';
  if (OTHER.test(clause)) return 'other';
  return undefined;
}

function sessionIntervalDays(clause: string): number | undefined {
  if (/quincenal/i.test(clause)) return 14;
  if (/semanal/i.test(clause)) return 7;
  if (/mensual/i.test(clause)) return 30;
  return undefined;
}

const DESCRIPTIONS: Record<PlanItemKind, string> = {
  follow_up_visit: 'Consulta de control',
  lab: 'Exámenes de laboratorio',
  imaging: 'Estudio de imagen',
  session: 'Sesión de seguimiento',
  other: 'Indicación del plan',
};

/** Splits the plan section (or the whole note if there is none) into clauses with their offsets. */
function planClauses(text: string): string[] {
  const planStart = /\bplan\s*:/i.exec(text);
  const body = planStart ? text.slice(planStart.index + planStart[0].length) : text;
  return body
    .split(/[.;]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

export interface MockExtraction {
  readonly hasPlan: boolean;
  readonly conditions: ExtractedConditionView[];
  readonly medications: ExtractedMedicationView[];
  readonly planItems: ExtractedPlanItem[];
}

export function extractFromNote(text: string, authoredAt: Date): MockExtraction {
  const conditions: ExtractedConditionView[] = [];
  for (const { pattern, code, display, confidence } of CONDITION_PATTERNS) {
    const match = pattern.exec(text);
    if (match && !conditions.some((condition) => condition.code.code === code)) {
      conditions.push({
        code: { system: 'http://hl7.org/fhir/sid/icd-10', code, display },
        confidence,
        evidenceQuote: match[0].trim(),
      });
    }
  }

  const medications: ExtractedMedicationView[] = [];
  for (const match of text.matchAll(MEDICATION_PATTERN)) {
    const quote = match[0].trim();
    const duration = /(?:por|for|x)\s+(\d+)\s+(?:d[ií]as|days)/i.exec(quote);
    medications.push({
      text: quote,
      evidenceQuote: quote,
      ...(duration?.[1] ? { durationDays: Number(duration[1]) } : {}),
    });
  }

  const hasExplicitPlan = /\bplan\s*:/i.test(text);
  const planItems: ExtractedPlanItem[] = [];
  let lastDueDays: number | undefined;
  for (const clause of planClauses(text)) {
    const kind = classify(clause);
    if (!kind) continue;
    const explicitDays = parseDueInDays(clause);
    // Outside an explicit "Plan:" section, only clauses with a deadline count as plan items.
    if (!hasExplicitPlan && explicitDays === undefined) continue;
    const dueDays =
      kind === 'session'
        ? (explicitDays ?? sessionIntervalDays(clause) ?? 7)
        : (explicitDays ?? lastDueDays ?? 30);
    lastDueDays = dueDays;
    planItems.push({
      kind,
      description: DESCRIPTIONS[kind],
      dueAt: new Date(authoredAt.getTime() + dueDays * DAY_MS).toISOString(),
      evidenceQuote: clause,
      confidence: explicitDays === undefined ? 0.81 : 0.93,
    });
  }

  return { hasPlan: planItems.length > 0, conditions, medications, planItems };
}

const STOPWORDS: Readonly<Record<'es' | 'en' | 'pt', readonly string[]>> = {
  es: ['de', 'la', 'el', 'en', 'con', 'y', 'por', 'se', 'los', 'las', 'del', 'paciente', 'control'],
  en: ['the', 'and', 'with', 'in', 'of', 'to', 'for', 'on', 'denies', 'patient', 'daily'],
  pt: ['de', 'com', 'em', 'do', 'da', 'os', 'as', 'não', 'paciente', 'retorno'],
};

/**
 * The language a note is written in, by counting common words: what the
 * engine's extractor reports as `noteLanguage` when the host sends none.
 */
export function detectNoteLanguage(text: string): string {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best: 'es' | 'en' | 'pt' = 'es';
  let bestScore = -1;
  for (const language of ['es', 'en', 'pt'] as const) {
    const stopwords = new Set(STOPWORDS[language]);
    const score = words.filter((word) => stopwords.has(word)).length;
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  return best;
}
