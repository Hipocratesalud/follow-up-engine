import {
  type ClinicId,
  type ExtractedCondition,
  type ExtractedMedication,
  ICD10_SYSTEM,
  type NoteExtraction,
  type NoteExtractionInput,
  type NoteExtractor,
  type PlanItem,
} from '@follow-up-engine/core';

const MS_PER_DAY = 86_400_000;
const LOINC = 'http://loinc.org';

const UNIT_DAYS: readonly { readonly pattern: RegExp; readonly days: number }[] = [
  { pattern: /^d[ií]as?$/i, days: 1 },
  { pattern: /^semanas?$/i, days: 7 },
  { pattern: /^mes(es)?$/i, days: 30 },
  { pattern: /^a[ñn]os?$/i, days: 365 },
];

/** "control en 3 meses", "ctrl en 6 semanas", "en 2 semanas", "cita en 15 días". */
const FOLLOW_UP =
  /(?:\b(?:control|ctrl|cita|consulta|reevaluaci[oó]n|revisi[oó]n)\s+)?\ben\s+(\d{1,3})\s+(d[ií]as?|semanas?|mes(?:es)?|a[ñn]os?)\b/giu;
/** "Se da de alta", "alta del proceso", "alta médica": the note ends follow-up. */
const DISCHARGE =
  /\b(?:se\s+(?:le\s+)?da\s+(?:de\s+)?alta|dar\s+de\s+alta|alta\s+(?:del\s+proceso|m[eé]dica|terap[eé]utica))\b/iu;
const HBA1C = /\b(?:hba1c|hemoglobina glicosilada|hb\s?a1c)\b/iu;

const CONDITION_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly code: string;
  readonly confidence: number;
}[] = [
  {
    pattern: /\b(?:DM2|DM\s?tipo\s?2|diabetes(?: mellitus)? tipo 2)\b/iu,
    code: 'E11',
    confidence: 0.92,
  },
  { pattern: /\b(?:DM1|diabetes(?: mellitus)? tipo 1)\b/iu, code: 'E10', confidence: 0.92 },
  { pattern: /\b(?:HTA|hipertensi[oó]n arterial)\b/iu, code: 'I10', confidence: 0.9 },
];

const MEDICATIONS =
  /\b(?:metformina|insulina|glibenclamida|losart[aá]n|enalapril|amlodipino|valsart[aá]n|hidroclorotiazida|amoxicilina|ibuprofeno|azitromicina)(?:\s+\d+\s?mg)?(?:[^.;\n]{0,40}?\bpor\s+(\d{1,3})\s+d[ií]as)?/giu;

/** Partial canned extraction; missing fields get neutral defaults. */
export type CannedExtraction = Partial<NoteExtraction>;

export interface FakeNoteExtractorOptions {
  readonly model?: string;
  readonly promptVersion?: string;
  readonly costUsd?: number;
}

/** Error thrown by a {@link FakeNoteExtractor} told to fail. */
export class FakeExtractionError extends Error {
  override readonly name = 'FakeExtractionError';
}

function unitDays(unit: string): number {
  return UNIT_DAYS.find((candidate) => candidate.pattern.test(unit))?.days ?? 1;
}

/**
 * Deterministic {@link NoteExtractor} for tests, CI and demos. Returns a
 * canned extraction when one is registered for the document; otherwise reads
 * the note with a few Spanish regexes ("control en N meses", "ctrl en N
 * meses", "en N semanas", DM2, HTA, common drugs). Can be told to fail, to
 * exercise the retry path.
 */
export class FakeNoteExtractor implements NoteExtractor {
  readonly calls: NoteExtractionInput[] = [];
  readonly #canned = new Map<string, CannedExtraction>();
  readonly #failing = new Set<string>();
  readonly #options: Required<FakeNoteExtractorOptions>;
  #failNext = 0;

  constructor(options: FakeNoteExtractorOptions = {}) {
    this.#options = {
      model: options.model ?? 'fake-regex-extractor',
      promptVersion: options.promptVersion ?? 'fake-1',
      costUsd: options.costUsd ?? 0,
    };
  }

  /** Returns `extraction` for this document instead of reading the text. */
  setExtraction(documentId: string, extraction: CannedExtraction): this {
    this.#canned.set(documentId, extraction);
    return this;
  }

  /** The next `times` calls throw. */
  failNext(times = 1): this {
    this.#failNext = times;
    return this;
  }

  /** Every call for this document throws until {@link FakeNoteExtractor.recover} is called. */
  failFor(documentId: string): this {
    this.#failing.add(documentId);
    return this;
  }

  recover(documentId?: string): this {
    if (documentId === undefined) {
      this.#failing.clear();
      this.#failNext = 0;
    } else {
      this.#failing.delete(documentId);
    }
    return this;
  }

  extract(_clinicId: ClinicId, input: NoteExtractionInput): Promise<NoteExtraction> {
    this.calls.push(input);
    if (this.#failNext > 0 || this.#failing.has(input.documentId)) {
      this.#failNext = Math.max(0, this.#failNext - 1);
      return Promise.reject(new FakeExtractionError(`Extraction of ${input.documentId} failed`));
    }
    const canned = this.#canned.get(input.documentId);
    const base = canned === undefined ? this.#read(input) : this.#fromCanned(canned);
    return Promise.resolve(base);
  }

  #fromCanned(canned: CannedExtraction): NoteExtraction {
    const planItems = canned.planItems ?? [];
    return {
      hasPlan: canned.hasPlan ?? planItems.length > 0,
      conditions: canned.conditions ?? [],
      medications: canned.medications ?? [],
      planItems,
      ...(canned.discharged === undefined ? {} : { discharged: canned.discharged }),
      ...(canned.pregnancy === undefined ? {} : { pregnancy: canned.pregnancy }),
      model: canned.model ?? this.#options.model,
      promptVersion: canned.promptVersion ?? this.#options.promptVersion,
      costUsd: canned.costUsd ?? this.#options.costUsd,
    };
  }

  #read(input: NoteExtractionInput): NoteExtraction {
    const planItems: PlanItem[] = [];
    for (const match of input.text.matchAll(FOLLOW_UP)) {
      const days = Number(match[1]) * unitDays(match[2] ?? '');
      const dueAt = new Date(input.authoredAt.getTime() + days * MS_PER_DAY);
      planItems.push({
        kind: input.specialty === 'psychology' ? 'session' : 'follow_up_visit',
        description: 'follow-up visit',
        dueAt,
        evidenceQuote: match[0],
        confidence: 0.9,
      });
      const end = input.text.indexOf('.', match.index);
      const sentence = input.text.slice(match.index, end === -1 ? undefined : end);
      const hba1c = HBA1C.exec(sentence);
      if (hba1c !== null) {
        planItems.push({
          kind: 'lab',
          description: 'repeat HbA1c',
          dueAt,
          evidenceQuote: hba1c[0],
          confidence: 0.85,
          code: { system: LOINC, code: '4548-4', display: 'Hemoglobin A1c' },
        });
      }
    }
    const conditions: ExtractedCondition[] = CONDITION_PATTERNS.flatMap(
      ({ pattern, code, confidence }) => {
        const found = pattern.exec(input.text);
        return found === null
          ? []
          : [{ code: { system: ICD10_SYSTEM, code }, confidence, evidenceQuote: found[0] }];
      },
    );
    const medications: ExtractedMedication[] = [...input.text.matchAll(MEDICATIONS)].map(
      (match) => ({
        text: match[0].trim(),
        evidenceQuote: match[0].trim(),
        ...(match[1] === undefined ? {} : { durationDays: Number(match[1]) }),
      }),
    );
    const discharged = DISCHARGE.test(input.text);
    return {
      hasPlan: planItems.length > 0 || discharged,
      conditions,
      medications,
      planItems,
      ...(discharged ? { discharged } : {}),
      model: this.#options.model,
      promptVersion: this.#options.promptVersion,
      costUsd: this.#options.costUsd,
    };
  }
}
