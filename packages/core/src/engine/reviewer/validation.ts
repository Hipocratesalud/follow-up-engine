import {
  type DiscardReason,
  FINDING_CATEGORIES,
  type FindingCategory,
  type FindingCitation,
  type FindingOrigin,
  type FindingSeverity,
  type FindingText,
  type FindingTexts,
  REVIEW_LOCALES,
  type ReviewLocale,
} from '../../domain/clinical-finding.ts';
import type { ProposedFinding } from '../../ports/clinical-review-agent.ts';
import { refKey } from '../timeline.ts';
import type { ReviewDossier } from './dossier.ts';
import { SCREENING_RULES } from './knowledge.ts';
import { foldWithMap, locateVerbatim } from './text.ts';

/** Letters or digits a quote needs to count as evidence. */
export const MIN_QUOTE_SIGNIFICANT_CHARS = 4;

/** A finding that passed every check, before persistence (id, mode and run are added then). */
export interface FindingDraft {
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
  readonly citations: readonly FindingCitation[];
  readonly origin: FindingOrigin;
  readonly signalIds: readonly string[];
  readonly specialty?: string;
  readonly dedupKey: string;
  /** Summary, rationale and suggestion per review locale, when the proposal gave them. */
  readonly texts?: FindingTexts;
}

export type ProposalCheck =
  | { readonly ok: true; readonly draft: FindingDraft }
  | { readonly ok: false; readonly reason: DiscardReason };

/**
 * Words of a message to the patient. The reviewer writes to the clinician
 * only; a "finding" addressed to the patient (an injected instruction, a
 * model drifting into advice) is dropped.
 */
const PATIENT_DIRECTED = [
  'estimado paciente',
  'estimada paciente',
  'querido paciente',
  'querida paciente',
  'usted debe',
  'le recomendamos',
  'envia un mensaje al paciente',
  'enviar un mensaje al paciente',
  'mensaje al paciente',
  'escribele al paciente',
  'avisale al paciente',
  'whatsapp',
  'sms al paciente',
  'dear patient',
  'message the patient',
  'text the patient',
  'send the patient',
  'tell the patient to',
];

function isPatientDirected(texts: readonly string[]): boolean {
  return texts.some((text) => {
    const folded = foldWithMap(text).folded;
    return PATIENT_DIRECTED.some((phrase) => folded.includes(phrase));
  });
}

function significantChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * `<category>|<topic>|<cited sources, sorted>`: the same check about the same
 * evidence. The topic is the detector rule a finding confirms
 * (`screening:diabetic_foot`, `symptom:headache`), so two different checks
 * that cite the same record (the fundus, foot and albuminuria gaps of a
 * diabetic all cite the diagnosis; two symptoms quoted from the same notes)
 * are never merged into one. Without a topic: `<category>|<cited sources>`.
 */
export function findingDedupKey(
  category: string,
  citations: readonly FindingCitation[],
  topic = '',
): string {
  const sources = [...new Set(citations.map((citation) => refKey(citation.source)))].sort();
  return topic === ''
    ? `${category}|${sources.join(',')}`
    : `${category}|${topic}|${sources.join(',')}`;
}

/**
 * What a proposal is about: the rules of the signals it confirms, else, for
 * a check-up the agent added on its own, the check-ups its text names.
 */
export function proposalTopic(
  proposal: Pick<ProposedFinding, 'category' | 'summary' | 'suggestion'>,
  signalRules: readonly string[],
): string {
  if (signalRules.length > 0) return [...new Set(signalRules)].sort().join('+');
  if (proposal.category !== 'missing_screening') return '';
  const text = foldWithMap(`${proposal.summary} ${proposal.suggestion}`).folded;
  return SCREENING_RULES.filter((rule) => rule.coverageTerms.some((term) => text.includes(term)))
    .map((rule) => `screening:${rule.key}`)
    .join('+');
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Checks one proposal against the record. Every citation must name a
 * document of this patient and quote it verbatim (whitespace aside); one bad
 * citation discards the whole finding, so a stored finding never carries a
 * hallucinated citation. The stored quote is the document's own text.
 */
export function checkProposal(
  proposal: ProposedFinding,
  dossier: ReviewDossier,
  options: {
    readonly enabled: (category: FindingCategory, specialty: string | undefined) => boolean;
    readonly knownSignals: ReadonlySet<string>;
    /** Detector rule of each known signal (`S2` -> `screening:diabetic_foot`). */
    readonly signalRules?: ReadonlyMap<string, string>;
  },
): ProposalCheck {
  const category = FINDING_CATEGORIES.find((item) => item === proposal.category);
  if (category === undefined) return { ok: false, reason: 'category_disabled' };
  if (category === 'similar_patients') return { ok: false, reason: 'category_reserved' };
  if (proposal.citations.length === 0) return { ok: false, reason: 'no_citation' };
  const translations = REVIEW_LOCALES.flatMap((locale): [ReviewLocale, FindingText][] => {
    const text = proposal.texts?.[locale];
    return text === undefined ? [] : [[locale, text]];
  });
  if (
    isPatientDirected([
      proposal.summary,
      proposal.rationale,
      proposal.suggestion,
      ...translations.flatMap(([, text]) => [text.summary, text.rationale, text.suggestion]),
    ])
  ) {
    return { ok: false, reason: 'patient_directed' };
  }
  const citations: FindingCitation[] = [];
  for (const citation of proposal.citations) {
    const document = dossier.documents.get(citation.docId.trim());
    if (document === undefined) return { ok: false, reason: 'unknown_document' };
    if (
      significantChars(citation.quote) <
      Math.min(MIN_QUOTE_SIGNIFICANT_CHARS, significantChars(document.text))
    ) {
      return { ok: false, reason: 'quote_too_short' };
    }
    const verbatim = locateVerbatim(document.text, citation.quote);
    if (verbatim === undefined) return { ok: false, reason: 'quote_not_found' };
    if (!citations.some((item) => item.source === document.source && item.quote === verbatim)) {
      citations.push({
        source: document.source,
        kind: document.kind,
        quote: verbatim,
        occurredAt: document.occurredAt,
      });
    }
  }
  const cited = citations
    .map((citation) => dossier.documents.get(dossier.handleOf(citation.source) ?? ''))
    .filter((document) => document !== undefined);
  const latestNote = cited
    .filter((document) => document.kind === 'note' && document.specialty !== undefined)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .at(-1);
  const specialty = latestNote?.specialty ?? dossier.specialty;
  if (!options.enabled(category, specialty)) return { ok: false, reason: 'category_disabled' };
  const signalIds = proposal.signalIds.filter((id) => options.knownSignals.has(id));
  const topic = proposalTopic(
    proposal,
    signalIds.flatMap((id) => {
      const rule = options.signalRules?.get(id);
      return rule === undefined ? [] : [rule];
    }),
  );
  return {
    ok: true,
    draft: {
      category,
      severity: proposal.severity,
      summary: clip(proposal.summary, 240),
      rationale: clip(proposal.rationale, 800),
      suggestion: clip(proposal.suggestion, 400),
      citations,
      origin: signalIds.length > 0 ? 'confirmed' : 'added',
      signalIds,
      ...(specialty === undefined ? {} : { specialty }),
      dedupKey: findingDedupKey(category, citations, topic),
      ...(translations.length === 0
        ? {}
        : {
            texts: Object.fromEntries(
              translations.map(([locale, text]) => [
                locale,
                {
                  summary: clip(text.summary, 240),
                  rationale: clip(text.rationale, 800),
                  suggestion: clip(text.suggestion, 400),
                },
              ]),
            ),
          }),
    },
  };
}
