import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../domain/errors.ts';
import type {
  ClinicalReviewAgent,
  ProposedFinding,
  ReviewAgentRequest,
  ReviewAgentResult,
} from '../../ports/clinical-review-agent.ts';
import { LlmBudgetExceededError } from '../../ports/llm.ts';
import { buildDossier } from './dossier.ts';
import { applyFlagUpdate, modeOf, resolveFlag, shadowPilotFlags } from './flags.ts';
import { reviewRecord } from './pipeline.ts';
import {
  aCase,
  anExpectation,
  CLINIC,
  day,
  medication,
  note,
  result,
  snapshot,
} from './test-support.ts';
import { checkProposal, findingDedupKey } from './validation.ts';

const RISING = [
  result(-400, '2160-0', 1.05, 'mg/dL', { id: 'obs-1' }),
  result(-300, '2160-0', 1.1, 'mg/dL', { id: 'obs-2' }),
  result(-150, '2160-0', 1.4, 'mg/dL', { id: 'obs-3' }),
  result(-40, '2160-0', 1.75, 'mg/dL', { id: 'obs-4' }),
];
const NOTE = note(
  -30,
  'Control de DM2. Refiere buena tolerancia a la metformina. Alergias: niega. Plan: control en 3 meses.',
  {
    specialty: 'diabetology',
  },
);
const RECORD = snapshot([
  ...RISING,
  NOTE,
  medication(-500, 'Metformina 850 mg', { atc: 'A10BA02' }),
]);
const ALL = (): boolean => true;

function proposal(overrides: Partial<ProposedFinding> = {}): ProposedFinding {
  return {
    category: 'lab_trend',
    severity: 'medium',
    summary: 'Creatinina en ascenso',
    rationale: 'Tres resultados seguidos empeoran.',
    suggestion: 'Considera evaluar la función renal.',
    citations: [{ docId: 'R4', quote: 'Creatinine: 1.75 mg/dL' }],
    signalIds: [],
    ...overrides,
  };
}

/** An agent that answers with fixed proposals, recording what it was given. */
function scriptedAgent(
  proposals: readonly ProposedFinding[],
  seen: ReviewAgentRequest[] = [],
): ClinicalReviewAgent {
  return {
    review(_clinicId, request): Promise<ReviewAgentResult> {
      seen.push(request);
      return Promise.resolve({
        proposals,
        stopReason: 'submitted',
        steps: 2,
        toolCalls: 1,
        trace: [],
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.002,
        modelId: 'test:model',
        promptVersion: 'test@1',
      });
    },
  };
}

describe('citation checks (0 hallucinated citations is a hard rule)', () => {
  const dossier = buildDossier(RECORD);
  const options = { enabled: ALL, knownSignals: new Set<string>() };

  it("accepts a verbatim quote and stores the document's own text", () => {
    const check = checkProposal(
      proposal({
        citations: [{ docId: 'N1', quote: 'Refiere buena  tolerancia\na la metformina' }],
      }),
      dossier,
      options,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.draft.citations[0]).toMatchObject({
        source: { resourceType: 'DocumentReference' },
        kind: 'note',
        // Whitespace re-flowed by the model is mapped back to the note's own text.
        quote: 'Refiere buena tolerancia a la metformina',
      });
    }
  });

  it.each([
    [
      'a quote that is not in the document',
      { docId: 'N1', quote: 'Refiere dolor torácico' },
      'quote_not_found',
    ],
    ['a paraphrase', { docId: 'R4', quote: 'creatinina de 1,75' }, 'quote_not_found'],
    ['a document of no one', { docId: 'N99', quote: 'Control de DM2' }, 'unknown_document'],
    ['a quote of a few characters', { docId: 'R4', quote: '1.7' }, 'quote_too_short'],
  ])('drops the whole finding for %s', (_label, citation, reason) => {
    const check = checkProposal(
      proposal({ citations: [{ docId: 'R3', quote: 'Creatinine: 1.4 mg/dL' }, citation] }),
      dossier,
      options,
    );
    expect(check).toEqual({ ok: false, reason });
  });

  it('drops a finding without citations, of a reserved or disabled category, or addressed to the patient', () => {
    expect(checkProposal(proposal({ citations: [] }), dossier, options)).toEqual({
      ok: false,
      reason: 'no_citation',
    });
    expect(checkProposal(proposal({ category: 'similar_patients' }), dossier, options)).toEqual({
      ok: false,
      reason: 'category_reserved',
    });
    expect(
      checkProposal(proposal(), dossier, {
        ...options,
        enabled: (category) => category !== 'lab_trend',
      }),
    ).toEqual({ ok: false, reason: 'category_disabled' });
    expect(
      checkProposal(
        proposal({ suggestion: 'Envía un mensaje al paciente por WhatsApp.' }),
        dossier,
        options,
      ),
    ).toEqual({ ok: false, reason: 'patient_directed' });
  });

  it('the dedup key is the category and the cited sources, in any order', () => {
    const left = {
      source: { resourceType: 'Observation', id: 'b' },
      kind: 'result' as const,
      quote: 'x',
      occurredAt: day(0),
    };
    const right = { ...left, source: { resourceType: 'Observation', id: 'a' } };
    expect(findingDedupKey('lab_trend', [left, right])).toBe(
      findingDedupKey('lab_trend', [right, left, left]),
    );
    expect(findingDedupKey('lab_trend', [left])).not.toBe(findingDedupKey('vital_trend', [left]));
  });
});

describe('reviewRecord', () => {
  it('gives the agent a pseudonymous input with handles, never host ids, and the signals', async () => {
    const seen: ReviewAgentRequest[] = [];
    await reviewRecord(CLINIC, RECORD, {
      agent: scriptedAgent([], seen),
      enabled: ALL,
      patientRef: 'P-1',
    });
    const input = seen[0]?.input;
    expect(input?.patientRef).toBe('P-1');
    expect(JSON.stringify(input)).not.toMatch(
      /obs-|DocumentReference|pat-reviewer|clinic-reviewer/,
    );
    expect(input?.labTrends[0]?.values.map((value) => value.docId)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
    ]);
    expect(input?.signals.map((signal) => signal.category)).toContain('lab_trend');
    expect(seen[0]?.documents.get('R4')).toBe('Creatinine: 1.75 mg/dL');
  });

  it('keeps what passes, drops hallucinated citations and merges duplicates', async () => {
    const outcome = await reviewRecord(CLINIC, RECORD, {
      agent: scriptedAgent([
        proposal({ signalIds: ['S1'] }),
        proposal({ summary: 'Lo mismo otra vez', signalIds: ['S1'] }),
        proposal({
          category: 'unaddressed_symptom',
          citations: [{ docId: 'N1', quote: 'Refiere cefalea' }],
        }),
      ]),
      enabled: ALL,
      patientRef: 'P-1',
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({ category: 'lab_trend', origin: 'confirmed' });
    expect(outcome.discarded).toEqual({ merged: 1, quote_not_found: 1 });
  });

  it('falls back to the checked detector signals when the agent fails (never blocks)', async () => {
    const failing: ClinicalReviewAgent = {
      review: () => Promise.reject(new LlmBudgetExceededError(CLINIC)),
    };
    const outcome = await reviewRecord(CLINIC, RECORD, {
      agent: failing,
      enabled: ALL,
      patientRef: 'P-1',
    });
    expect(outcome).toMatchObject({ status: 'degraded', stopReason: 'llm_budget' });
    expect(outcome.findings.map((finding) => finding.category)).toContain('lab_trend');
    expect(outcome.findings.every((finding) => finding.origin === 'fallback')).toBe(true);
  });

  it('an agent that stopped before submitting degrades the same way', async () => {
    const stalled: ClinicalReviewAgent = {
      review: async (clinicId, request) => ({
        ...(await scriptedAgent([]).review(clinicId, request)),
        stopReason: 'step_limit',
      }),
    };
    const outcome = await reviewRecord(CLINIC, RECORD, {
      agent: stalled,
      enabled: ALL,
      patientRef: 'P-1',
    });
    expect(outcome).toMatchObject({ status: 'degraded', stopReason: 'step_limit' });
  });

  it('decides coverage by code from the open expectations and cases', async () => {
    const expectation = anExpectation({ source: { resourceType: 'Observation', id: 'obs-4' } });
    const covered = snapshot(RECORD.events, {
      liveExpectations: [expectation],
      activeCases: [aCase(expectation.id)],
    });
    const outcome = await reviewRecord(CLINIC, covered, {
      agent: scriptedAgent([proposal({ signalIds: ['S1'] })]),
      enabled: ALL,
      patientRef: 'P-1',
    });
    expect(outcome.findings[0]).toMatchObject({
      alreadyCovered: true,
      coveredBy: [
        { kind: 'expectation', id: 'exp-1', code: 'abnormal_result_followup' },
        { kind: 'case', id: 'case-1', code: 'abnormal_result_followup' },
      ],
    });
    // A pending order of the same test (any code of it) covers a trend too.
    const ordered = anExpectation({
      source: { resourceType: 'ServiceRequest', id: 'sr-1' },
      ruleId: 'lab_order_result_pending',
      matchKey: 'loinc:38483-4',
    });
    const pending = await reviewRecord(
      CLINIC,
      snapshot(RECORD.events, { liveExpectations: [ordered] }),
      {
        agent: scriptedAgent([proposal()]),
        enabled: ALL,
        patientRef: 'P-1',
      },
    );
    expect(pending.findings[0]?.alreadyCovered).toBe(true);
  });

  it('skips the review when no category is enabled', async () => {
    const outcome = await reviewRecord(CLINIC, RECORD, { enabled: () => false, patientRef: 'P-1' });
    expect(outcome).toMatchObject({ status: 'skipped', findings: [], signals: [] });
  });
});

describe('finding flags', () => {
  const now = day(0);

  it('every category starts off and in shadow; a specialty flag wins over the clinic-wide one', () => {
    expect(modeOf([], 'lab_trend', undefined)).toBeUndefined();
    const flags = [
      ...shadowPilotFlags(CLINIC, 'admin', now),
      {
        clinicId: CLINIC,
        category: 'lab_trend' as const,
        specialty: 'psychology',
        enabled: false,
        mode: 'shadow' as const,
        updatedAt: now,
      },
    ];
    expect(modeOf(flags, 'lab_trend', 'diabetology')).toBe('shadow');
    expect(modeOf(flags, 'lab_trend', 'psychology')).toBeUndefined();
    expect(resolveFlag(flags, 'lab_trend', 'psychology')?.specialty).toBe('psychology');
    expect(modeOf(flags, 'similar_patients', undefined)).toBeUndefined();
  });

  it('goes live only with a sign-off; reserved categories cannot be enabled', () => {
    expect(() =>
      applyFlagUpdate(
        CLINIC,
        undefined,
        { category: 'lab_trend', enabled: true, mode: 'live' },
        'u1',
        now,
      ),
    ).toThrow(ValidationError);
    const live = applyFlagUpdate(
      CLINIC,
      undefined,
      { category: 'lab_trend', enabled: true, mode: 'live', validatedBy: 'dra-castellanos' },
      'u1',
      now,
    );
    expect(live).toMatchObject({ mode: 'live', validatedBy: 'dra-castellanos', validatedAt: now });
    expect(modeOf([live], 'lab_trend', undefined)).toBe('live');
    // Back to shadow keeps the earlier sign-off on record.
    const back = applyFlagUpdate(
      CLINIC,
      live,
      { category: 'lab_trend', enabled: true, mode: 'shadow' },
      'u2',
      now,
    );
    expect(back).toMatchObject({ mode: 'shadow', validatedBy: 'dra-castellanos' });
    expect(() =>
      applyFlagUpdate(
        CLINIC,
        undefined,
        { category: 'similar_patients', enabled: true, mode: 'shadow' },
        'u1',
        now,
      ),
    ).toThrow(ValidationError);
  });

  it('a live flag without a sign-off (corrupt data) is still treated as shadow', () => {
    expect(
      modeOf(
        [{ clinicId: CLINIC, category: 'lab_trend', enabled: true, mode: 'live', updatedAt: now }],
        'lab_trend',
        undefined,
      ),
    ).toBe('shadow');
  });
});
