import type {
  AdjudicationDecision,
  AdjudicationList,
  AdjudicationOverrideDecision,
  AdjudicationOverrideResponse,
  AdjudicationReasonCode,
  AdjudicationView,
} from '../api/adjudication-contract.ts';
import type { Locale } from '../i18n/index.ts';
import { MockHttpError, type MockStore } from './store.ts';

/**
 * The adjudicator in the in-browser mock (PRD V2): a decision for each
 * doctor's-plan item with a quote, decided from cue words in the quote like
 * the engine's scripted adjudicator, in shadow mode. The doctor's override
 * goes through the mock's plan item review (keep = confirm, discard =
 * reject), as the engine does.
 */

const COPY = {
  en: {
    decisions: {
      open: 'the note asks for it',
      discard: 'the note does not ask for it',
      needs_human: "needs a doctor's review",
    },
    rationale: {
      open: 'The note gives the instruction and its timing plainly.',
      discard: 'The note mentions the item but says it is not needed or already done.',
      needs_human: 'The note only asks for it under a condition: a doctor should decide.',
    },
    notFound: 'We could not find that decision.',
    alreadyOverridden: 'A doctor already overrode this decision.',
  },
  es: {
    decisions: {
      open: 'la nota lo pide',
      discard: 'la nota no lo pide',
      needs_human: 'requiere revisión médica',
    },
    rationale: {
      open: 'La nota da la indicación y su plazo de forma explícita.',
      discard: 'La nota menciona el ítem, pero dice que no hace falta o que ya se hizo.',
      needs_human: 'La nota solo lo pide bajo una condición: conviene que lo decida un médico.',
    },
    notFound: 'No encontramos esa decisión.',
    alreadyOverridden: 'Un médico ya corrigió esta decisión.',
  },
} satisfies Record<Locale, unknown>;

interface Decided {
  readonly decision: AdjudicationDecision;
  readonly probability: number;
  readonly codes: readonly AdjudicationReasonCode[];
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function decide(quote: string): Decided {
  const text = fold(quote);
  if (/\bno (requiere|hace falta)\b|\bya se (realizo|hizo)\b/.test(text)) {
    return { decision: 'discard', probability: 0.12, codes: ['negated'] };
  }
  if (
    /\bsi (persiste|empeora|no mejora)\b|\bsegun evolucion\b|\bevaluar\b|\bconsiderar\b/.test(text)
  ) {
    return { decision: 'needs_human', probability: 0.45, codes: ['conditional_plan'] };
  }
  if (/\b\d+ ?(dias?|semanas?|mes(es)?)\b/.test(text)) {
    return {
      decision: 'open',
      probability: 0.86,
      codes: ['explicit_instruction', 'timing_explicit'],
    };
  }
  return { decision: 'needs_human', probability: 0.52, codes: ['timing_vague'] };
}

interface Override {
  readonly decision: AdjudicationOverrideDecision;
  readonly at: string;
  readonly note?: string;
}

export interface AdjudicationMock {
  list(query: { caseId?: string; patientId?: string }, locale: Locale): AdjudicationList;
  override(
    id: string,
    decision: AdjudicationOverrideDecision,
    note: string | undefined,
    locale: Locale,
  ): AdjudicationOverrideResponse;
}

export function createAdjudicationMock(store: MockStore): AdjudicationMock {
  const overrides = new Map<string, Override>();
  /** Expectation id → patient, case and quote, learned from the views served. */
  const known = new Map<
    string,
    { patientId: string; caseId?: string; quote: string; documentId: string }
  >();

  function view(expectationId: string, locale: Locale): AdjudicationView | undefined {
    const item = known.get(expectationId);
    if (item === undefined) return undefined;
    const copy = COPY[locale];
    const decided = decide(item.quote);
    const override = overrides.get(`adj-${expectationId}`);
    return {
      id: `adj-${expectationId}`,
      expectationId,
      patientId: item.patientId,
      ...(item.caseId === undefined ? {} : { caseId: item.caseId }),
      decision: decided.decision,
      decisionLabel: copy.decisions[decided.decision],
      modelDecision: decided.decision,
      probability: decided.probability,
      reasons: decided.codes.map((code) => ({ code, label: code })),
      rationale: copy.rationale[decided.decision],
      quotes: [{ quote: item.quote, sourceDocumentId: item.documentId }],
      inputConfidence: 0.6,
      mode: 'shadow',
      applied: false,
      provider: 'fake',
      model: 'fake-adjudicator',
      promptVersion: 'adjudicator@1',
      costUsd: 0,
      createdAt: store.now().toISOString(),
      ...(override === undefined
        ? {}
        : {
            override: {
              decision: override.decision,
              decisionLabel: copy.decisions[override.decision],
              by: 'Dra. Lucía Paredes',
              at: override.at,
              ...(override.note === undefined ? {} : { note: override.note }),
            },
          }),
    };
  }

  function learnCase(caseId: string): string[] {
    const detail = store.getCase(caseId);
    return detail.reasons.flatMap((reason) => {
      if (reason.planItem === undefined || reason.evidence === undefined) return [];
      known.set(reason.expectationId, {
        patientId: detail.patient.id,
        caseId,
        quote: reason.evidence.quote,
        documentId: reason.evidence.documentId,
      });
      return [reason.expectationId];
    });
  }

  function learnPatient(patientId: string): string[] {
    const detail = store.getPatient(patientId);
    return detail.expectations.flatMap((expectation) => {
      if (expectation.planItem === undefined || expectation.evidence === undefined) return [];
      const previous = known.get(expectation.id);
      known.set(expectation.id, {
        patientId,
        ...(previous?.caseId === undefined ? {} : { caseId: previous.caseId }),
        quote: expectation.evidence.quote,
        documentId: expectation.evidence.documentId,
      });
      return [expectation.id];
    });
  }

  return {
    list(query, locale) {
      const ids =
        query.caseId !== undefined
          ? learnCase(query.caseId)
          : query.patientId !== undefined
            ? learnPatient(query.patientId)
            : [...known.keys()];
      return {
        items: ids.flatMap((id) => {
          const item = view(id, locale);
          return item === undefined ? [] : [item];
        }),
        settings: { mode: 'shadow', minConfidence: 0.4, maxConfidence: 0.75 },
      };
    },
    override(id, decision, note, locale) {
      const expectationId = id.replace(/^adj-/, '');
      if (!known.has(expectationId)) {
        throw new MockHttpError(404, 'not_found', COPY[locale].notFound);
      }
      if (overrides.has(id)) {
        throw new MockHttpError(409, 'conflict', COPY[locale].alreadyOverridden);
      }
      const review = store.reviewPlanItem(
        expectationId,
        decision === 'open' ? 'confirm' : 'reject',
      );
      overrides.set(id, {
        decision,
        at: store.now().toISOString(),
        ...(note === undefined || note === '' ? {} : { note }),
      });
      const adjudication = view(expectationId, locale);
      if (adjudication === undefined)
        throw new MockHttpError(404, 'not_found', COPY[locale].notFound);
      return { adjudication, casesResolved: review.casesResolved };
    },
  };
}
