import {
  type DiscardReason,
  FINDING_CATEGORIES,
  type FindingCategory,
  type FindingCitation,
  type FindingOrigin,
  type FindingSeverity,
} from '../../domain/clinical-finding.ts';
import type { ProposedFinding } from '../../ports/clinical-review-agent.ts';
import { refKey } from '../timeline.ts';
import type { ReviewDossier } from './dossier.ts';
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

/** `<category>|<cited sources, sorted>`: same category and same main citations. */
export function findingDedupKey(category: string, citations: readonly FindingCitation[]): string {
  const sources = [...new Set(citations.map((citation) => refKey(citation.source)))].sort();
  return `${category}|${sources.join(',')}`;
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
  },
): ProposalCheck {
  const category = FINDING_CATEGORIES.find((item) => item === proposal.category);
  if (category === undefined) return { ok: false, reason: 'category_disabled' };
  if (category === 'similar_patients') return { ok: false, reason: 'category_reserved' };
  if (proposal.citations.length === 0) return { ok: false, reason: 'no_citation' };
  if (isPatientDirected([proposal.summary, proposal.rationale, proposal.suggestion])) {
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
      dedupKey: findingDedupKey(category, citations),
    },
  };
}
