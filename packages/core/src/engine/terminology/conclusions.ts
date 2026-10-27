import type { ResultInterpretation } from '../../domain/clinical-event.ts';

/**
 * What a report's free-text conclusion says, read deterministically (no
 * LLM): imaging reports usually carry their finding only there
 * (`DiagnosticReport.conclusion`), with no Observation to flag. Spanish and
 * English. A phrase preceded by a negation ("sin hallazgos sospechosos",
 * "no se observa restricción del crecimiento", "negative for") does not
 * count.
 *
 * - BI-RADS (ACR BI-RADS Atlas, 5th edition): 1 and 2 normal; 3 probably
 *   benign, a short-interval (6-month) follow-up study; 0 incomplete,
 *   additional imaging within 30 days; 4 and 5 suspicious, tissue diagnosis
 *   (a study or procedure within 14 days); 6 known malignancy.
 * - Fetal growth (ACOG Practice Bulletin 227, Fetal Growth Restriction,
 *   2021): estimated fetal weight or biometry below the 10th percentile, or
 *   growth restriction (RCIU, FGR, IUGR), calls for a growth scan with
 *   umbilical artery Doppler within about 2 weeks.
 * - A suspicious finding ("hallazgo sospechoso", "sospechoso de
 *   malignidad", "suspicious for") is abnormal.
 */
export interface ConclusionReading {
  readonly interpretation: ResultInterpretation;
  /** Days within which the finding calls for a follow-up study, when it does. */
  readonly followUpDays?: number;
  /** What the lexicon recognized, for tests and logs (`birads_3`, `fetal_growth_below_p10`). */
  readonly finding?: ConclusionFinding;
}

export type ConclusionFinding =
  | 'birads_0'
  | 'birads_1'
  | 'birads_2'
  | 'birads_3'
  | 'birads_4'
  | 'birads_5'
  | 'birads_6'
  | 'fetal_growth_below_p10'
  | 'suspicious_finding'
  | 'normal_wording';

/** Follow-up study interval of each BI-RADS category, in days (absent: none). */
const BIRADS: Readonly<
  Record<string, { readonly interpretation: ResultInterpretation; readonly followUpDays?: number }>
> = {
  '0': { interpretation: 'abnormal', followUpDays: 30 },
  '1': { interpretation: 'normal' },
  '2': { interpretation: 'normal' },
  '3': { interpretation: 'abnormal', followUpDays: 180 },
  '4': { interpretation: 'abnormal', followUpDays: 14 },
  '5': { interpretation: 'abnormal', followUpDays: 14 },
  '6': { interpretation: 'abnormal' },
};

/** Days to the growth scan after biometry below the 10th percentile. */
const FETAL_GROWTH_FOLLOW_UP_DAYS = 14;

const FETAL_GROWTH_PHRASES: readonly RegExp[] = [
  /\b(?:por )?debajo del? (?:percentil|p) ?10\b/,
  /\b(?:percentil|p) ?(?:<|menor (?:a|de|que)|inferior a) ?10\b/,
  /\bbelow the 10(?:th)? percentile\b/,
  /\b(?:<|less than) ?(?:the )?10(?:th)? percentile\b/,
  /\brciu\b/,
  /\brestriccion (?:del|de) crecimiento\b/,
  /\b(?:fetal|intrauterine) growth restriction\b/,
  /\b(?:fgr|iugr)\b/,
  /\bpequeno para (?:la )?edad gestacional\b/,
  /\bsmall for gestational age\b/,
];

const SUSPICIOUS_PHRASES: readonly RegExp[] = [
  /\bhallazgos? sospechosos?\b/,
  /\bsospechos[oa]s? de malignidad\b/,
  /\baltamente sugestiv[oa] de malignidad\b/,
  /\bsuspicious (?:for|of) malignancy\b/,
  /\bsuspicious (?:finding|lesion|mass)s?\b/,
  /\bhighly suggestive of malignancy\b/,
];

const NORMAL_PHRASES: readonly RegExp[] = [
  /\bacorde (?:a|con) (?:la )?edad gestacional\b/,
  /\bsin alteraciones\b/,
  /\bestudio normal\b/,
  /\bdentro de limites normales\b/,
  /\bnegativo para lesion intraepitelial\b/,
  /\bnilm\b/,
  /\bappropriate for gestational age\b/,
  /\bwithin normal limits\b/,
  /\bnormal study\b/,
  /\bnegative for intraepithelial lesion\b/,
];

/** Words that, just before a phrase, deny it ("sin hallazgos sospechosos"). */
const NEGATION =
  /\b(?:sin|no|niega|ni|descarta|descartan|ausencia de|negativo para|without|no evidence of|negative for|absence of)\b(?:\s+\S+){0,3}\s*$/;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Whether `pattern` occurs in `text` at least once without a negation just before it. */
function affirmed(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, 'g');
  for (const match of text.matchAll(global)) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const clause = before.split(/[.;:]/).at(-1) ?? '';
    if (!NEGATION.test(clause)) {
      return true;
    }
  }
  return false;
}

/** The worst BI-RADS category the text states, if any. */
function biradsCategory(text: string): string | undefined {
  let worst: string | undefined;
  for (const match of text.matchAll(
    /\bbi-?\s?rads\s*(?:categoria\s*|category\s*|:\s*)?([0-6])\b/g,
  )) {
    const category = match[1];
    if (category === undefined) {
      continue;
    }
    // 0 (incomplete) ranks above 1 and 2, below 3 to 6.
    const rank = (value: string): number => (value === '0' ? 2.5 : Number(value));
    if (worst === undefined || rank(category) > rank(worst)) {
      worst = category;
    }
  }
  return worst;
}

/** Reads a report conclusion (see {@link ConclusionReading}). */
export function readConclusion(conclusion: string | undefined): ConclusionReading {
  if (conclusion === undefined || conclusion.trim() === '') {
    return { interpretation: 'unknown' };
  }
  const text = normalize(conclusion);
  const birads = biradsCategory(text);
  const category = birads === undefined ? undefined : BIRADS[birads];
  if (birads !== undefined && category?.interpretation === 'abnormal') {
    return {
      interpretation: 'abnormal',
      ...(category.followUpDays === undefined ? {} : { followUpDays: category.followUpDays }),
      finding: `birads_${birads}` as ConclusionFinding,
    };
  }
  if (FETAL_GROWTH_PHRASES.some((pattern) => affirmed(text, pattern))) {
    return {
      interpretation: 'abnormal',
      followUpDays: FETAL_GROWTH_FOLLOW_UP_DAYS,
      finding: 'fetal_growth_below_p10',
    };
  }
  if (SUSPICIOUS_PHRASES.some((pattern) => affirmed(text, pattern))) {
    return { interpretation: 'abnormal', finding: 'suspicious_finding' };
  }
  if (birads !== undefined) {
    return { interpretation: 'normal', finding: `birads_${birads}` as ConclusionFinding };
  }
  if (NORMAL_PHRASES.some((pattern) => affirmed(text, pattern))) {
    return { interpretation: 'normal', finding: 'normal_wording' };
  }
  return { interpretation: 'unknown' };
}
