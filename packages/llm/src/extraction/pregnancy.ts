import { daysBetween, parseIsoDate } from './due-date.ts';
import {
  estimatedDeliveryDates,
  gestationalAges,
  isWrittenDay,
  lastMenstrualPeriods,
  namesDating,
  outcomeMentions,
  statedElapsedDays,
  statesCurrentPregnancy,
} from './pregnancy-signals.ts';
import type { QuoteIndex, QuoteSpan } from './quote.ts';
import type { ModelPregnancy } from './schema.ts';
import { OBSTETRIC_FORMULA, clauseAround } from './signals.ts';
import type { ExtractedPregnancy, PregnancyOutcomeKind, RejectedItem } from './types.ts';

const MS_PER_DAY = 86_400_000;
/** Longest gestation the engine accepts, in weeks. */
export const MAX_GESTATIONAL_WEEKS = 45;
/** Furthest back an outcome may be and still end the pregnancy this note is about, in days. */
export const MAX_OUTCOME_AGE_DAYS = 300;
/** Earliest estimated delivery date accepted, in days before the note (a late delivery). */
const EDD_DAYS_BEFORE_NOTE = 28;
/** Fewest letters or digits a pregnancy quote needs. */
const MIN_DATING_QUOTE_ALNUM = 2;
const MIN_OUTCOME_QUOTE_ALNUM = 4;

/** What the pregnancy post-check needs from the note (built once by `postProcessExtraction`). */
export interface PregnancyNote {
  readonly index: QuoteIndex;
  readonly authoredAt: Date;
  /** The verbatim note text of a located quote. */
  readonly verbatim: (span: QuoteSpan) => string;
}

export interface PostProcessedPregnancy {
  readonly pregnancy?: ExtractedPregnancy;
  readonly rejected: readonly RejectedItem[];
  /** Model items it read: the dating and the outcome count one each. */
  readonly modelItemCount: number;
}

function alnumCount(normalized: string): number {
  return normalized.replace(/[^a-z0-9]/g, '').length;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The quote-decided kind: what the words of the quote say, else the model's delivery kind. */
function outcomeKind(
  kinds: readonly (PregnancyOutcomeKind | undefined)[],
  modelKind: PregnancyOutcomeKind,
): PregnancyOutcomeKind | undefined {
  if (kinds.includes('cesarean_delivery')) return 'cesarean_delivery';
  if (kinds.includes('loss')) return 'loss';
  if (kinds.includes('vaginal_delivery')) return 'vaginal_delivery';
  // Only a puerperium word ("puerpera de 10 dias"): a delivery, of the kind the model says.
  return modelKind === 'loss' ? undefined : modelKind;
}

/**
 * When an outcome happened: the model's date when it is written in the
 * outcome's clause, else its "hace N dias" when the clause states that
 * elapsed time (computed here from the note's day, at noon UTC). `undefined`
 * when the model gave neither; `'unsupported'` when the note backs neither.
 */
function outcomeDate(
  date: string | null,
  daysAgo: number | null,
  clause: string,
  authoredAt: Date,
): Date | 'unsupported' | undefined {
  if (date === null && daysAgo === null) return undefined;
  const parsed = date === null ? undefined : parseIsoDate(date);
  if (parsed !== undefined && isWrittenDay(clause, utcDay(parsed))) return parsed;
  if (
    daysAgo !== null &&
    Number.isFinite(daysAgo) &&
    daysAgo >= 0 &&
    statedElapsedDays(clause).some(
      (written) => Math.abs(written - daysAgo) <= Math.max(1, written * 0.15),
    )
  ) {
    const noon = Date.UTC(
      authoredAt.getUTCFullYear(),
      authoredAt.getUTCMonth(),
      authoredAt.getUTCDate(),
      12,
    );
    return new Date(noon - Math.round(daysAgo) * MS_PER_DAY);
  }
  return 'unsupported';
}

/**
 * Deterministic checks of a model's pregnancy reading, in the spirit of the
 * rest of the post-checks: the note must back every value, or it is
 * dropped with its reason (`field: 'pregnancy'`).
 *
 * Outcome ("parto vaginal el 02/03/2026", "cesarea hace 10 dias", "aborto
 * espontaneo"):
 * - its quote is in the note, names a delivery or a loss, and is not the
 *   obstetric formula ("G2P1", `not_current`);
 * - the delivery or loss it names is this pregnancy's: not history
 *   ("cesarea previa", "antecedente de aborto", "2 partos", "cesarea hace 3
 *   anos", a year before last, `not_current`), not denied (`negated`), not
 *   planned or threatened ("cesarea programada", "amenaza de aborto", "via
 *   del parto", `quote_unrelated`);
 * - its kind is what the quote says ("cesarea" is a caesarean whatever the
 *   model said); a puerperium word alone ("puerpera") backs a delivery of
 *   the model's kind, never a loss;
 * - its date must be written where it is quoted, or its "hace N dias" must
 *   (the date is then computed here from `authoredAt`); otherwise the date
 *   is dropped (`timing_unsupported`) and the engine dates it with the note;
 *   a date after the note or more than 300 days before it rejects the
 *   outcome (`out_of_range`).
 *
 * Dating ("embarazo de 20 semanas", "FUM 03/04/2026", "FPP 10/01/2027"):
 * - its quote is in the note and names dating (weeks, "EG", "FUM", "FPP",
 *   a pregnancy word);
 * - the note states a current pregnancy (`statesCurrentPregnancy`): a
 *   routine "FUM" in an annual control is not one (`not_current`), and a
 *   pregnancy that this note ends (an accepted outcome) is not dated;
 * - weeks (0 to 45) and days (0 to 6) are a gestational age written in the
 *   note; the last menstrual period is a date written after "FUM"/"FUR",
 *   within 45 weeks before the note; the estimated delivery date is written
 *   after "FPP", from 4 weeks before to 45 weeks after the note. A value the
 *   note does not write is `timing_unsupported`, one out of range
 *   `out_of_range`; each is dropped alone.
 */
export function postProcessPregnancy(
  raw: ModelPregnancy | null | undefined,
  note: PregnancyNote,
): PostProcessedPregnancy {
  const rejected: RejectedItem[] = [];
  if (!raw) return { rejected, modelItemCount: 0 };
  const reject = (reason: RejectedItem['reason'], quote: string): void => {
    rejected.push({ field: 'pregnancy', reason, evidenceQuote: quote });
  };
  const { index, authoredAt } = note;
  const text = index.normalized.text;
  const noteDay = utcDay(authoredAt);
  const noteYear = authoredAt.getUTCFullYear();

  // Outcome
  let outcome: ExtractedPregnancy['outcome'];
  const rawOutcome = raw.outcome;
  if (rawOutcome) {
    const quote = rawOutcome.evidenceQuote;
    const span = index.locate(quote);
    const quoted = span === undefined ? '' : text.slice(span.normalizedStart, span.normalizedEnd);
    const mentions =
      span === undefined
        ? []
        : outcomeMentions(text, noteYear).filter(
            (m) => m.start < span.normalizedEnd && m.end > span.normalizedStart,
          );
    const accepted = mentions.filter((m) => m.excluded === undefined);
    const kind = outcomeKind(
      accepted.map((m) => m.kind),
      rawOutcome.kind,
    );
    if (span === undefined) reject('quote_not_found', quote);
    else if (alnumCount(quoted) < MIN_OUTCOME_QUOTE_ALNUM) reject('quote_too_short', quote);
    else if (OBSTETRIC_FORMULA.test(quoted)) reject('not_current', quote);
    else if (mentions.length === 0) reject('quote_unrelated', quote);
    else if (accepted.length === 0) {
      reject(mentions[0]?.excluded ?? 'quote_unrelated', quote);
    } else if (kind === undefined) reject('quote_unrelated', quote);
    else {
      const clause = clauseAround(text, span.normalizedStart, span.normalizedEnd);
      const date = outcomeDate(rawOutcome.date, rawOutcome.daysAgo, clause, authoredAt);
      if (date === 'unsupported') reject('timing_unsupported', quote);
      const dated = date instanceof Date ? date : undefined;
      if (
        dated !== undefined &&
        (utcDay(dated) > noteDay || daysBetween(dated, authoredAt) > MAX_OUTCOME_AGE_DAYS)
      ) {
        reject('out_of_range', quote);
      } else {
        outcome = {
          kind,
          ...(dated === undefined ? {} : { date: dated }),
          evidenceQuote: note.verbatim(span),
        };
      }
    }
  }

  // Dating
  const hasDating =
    raw.gestationalWeeks !== null ||
    raw.gestationalDays !== null ||
    raw.lastMenstrualPeriod !== null ||
    raw.estimatedDeliveryDate !== null;
  const dating: {
    gestationalWeeks?: number;
    gestationalDays?: number;
    lastMenstrualPeriod?: Date;
    estimatedDeliveryDate?: Date;
    datingEvidenceQuote?: string;
  } = {};
  if (hasDating) {
    const quote = raw.datingEvidenceQuote ?? '';
    const span = index.locate(quote);
    const quoted = span === undefined ? '' : text.slice(span.normalizedStart, span.normalizedEnd);
    if (span === undefined) reject('quote_not_found', quote);
    else if (alnumCount(quoted) < MIN_DATING_QUOTE_ALNUM) reject('quote_too_short', quote);
    else if (!namesDating(quoted)) reject('quote_unrelated', quote);
    else if (outcome !== undefined || !statesCurrentPregnancy(text)) reject('not_current', quote);
    else {
      const ages = gestationalAges(text);
      const weeks = raw.gestationalWeeks;
      if (weeks !== null) {
        if (!Number.isInteger(weeks) || weeks < 0 || weeks > MAX_GESTATIONAL_WEEKS) {
          reject('out_of_range', quote);
        } else if (!ages.some((age) => age.weeks === weeks)) {
          reject('timing_unsupported', quote);
        } else {
          dating.gestationalWeeks = weeks;
        }
      }
      const days = raw.gestationalDays;
      if (days !== null && dating.gestationalWeeks !== undefined) {
        if (!Number.isInteger(days) || days < 0 || days > 6) reject('out_of_range', quote);
        else if (!ages.some((age) => age.weeks === weeks && age.days === days)) {
          reject('timing_unsupported', quote);
        } else {
          dating.gestationalDays = days;
        }
      }
      const noteMs = Date.parse(`${noteDay}T12:00:00Z`);
      const lmp = raw.lastMenstrualPeriod;
      if (lmp !== null) {
        const date = parseIsoDate(lmp);
        if (date === undefined) reject('timing_unsupported', quote);
        else if (
          date.getTime() > noteMs ||
          date.getTime() < noteMs - MAX_GESTATIONAL_WEEKS * 7 * MS_PER_DAY
        ) {
          reject('out_of_range', quote);
        } else if (!lastMenstrualPeriods(text, noteDay).some((w) => w.date === utcDay(date))) {
          reject('timing_unsupported', quote);
        } else {
          dating.lastMenstrualPeriod = date;
        }
      }
      const edd = raw.estimatedDeliveryDate;
      if (edd !== null) {
        const date = parseIsoDate(edd);
        if (date === undefined) reject('timing_unsupported', quote);
        else if (
          date.getTime() < noteMs - EDD_DAYS_BEFORE_NOTE * MS_PER_DAY ||
          date.getTime() > noteMs + MAX_GESTATIONAL_WEEKS * 7 * MS_PER_DAY
        ) {
          reject('out_of_range', quote);
        } else if (!estimatedDeliveryDates(text, noteDay).some((w) => w.date === utcDay(date))) {
          reject('timing_unsupported', quote);
        } else {
          dating.estimatedDeliveryDate = date;
        }
      }
      const kept =
        dating.gestationalWeeks !== undefined ||
        dating.lastMenstrualPeriod !== undefined ||
        dating.estimatedDeliveryDate !== undefined;
      if (kept) dating.datingEvidenceQuote = note.verbatim(span);
    }
  }

  const pregnancy: ExtractedPregnancy = { ...dating, ...(outcome ? { outcome } : {}) };
  return {
    ...(Object.keys(pregnancy).length > 0 ? { pregnancy } : {}),
    rejected,
    modelItemCount: (hasDating ? 1 : 0) + (rawOutcome ? 1 : 0),
  };
}
