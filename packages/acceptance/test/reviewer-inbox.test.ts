import { FakeNoteExtractor, SequentialIdGenerator } from '@follow-up-engine/adapter-memory';
import {
  type ClinicalFinding,
  type ClinicalReviewer,
  clinicId,
  createClinicalReviewer,
  FINDING_TRANSLATION_JOB,
  findingTextIn,
  type FindingSeverity,
  patientId,
  type ReviewInput,
  shadowPilotFlags,
} from '@follow-up-engine/core';
import {
  CLINICAL_REVIEW_TASK,
  createFakeProvider,
  createFindingTranslator,
  createLlmGateway,
  createReviewAgent,
  DEFAULT_PRICING,
  FAKE_REVIEWER_MODEL,
  FINDING_TRANSLATION_OUTPUT_NAME,
  FINDING_TRANSLATION_TASK,
  InMemoryLlmUsageLog,
} from '@follow-up-engine/llm';
import {
  aClinicalFinding,
  BASE_DATE,
  contractBuilders,
  loadReviewerCohort,
} from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

/*
 * PRD V3, the doctor's inbox cards:
 * - a finding the model wrote in one language only is kept (never dropped
 *   for a missing translation), shown with its own words in the other
 *   locale, and a job translates it through the gateway with nothing but
 *   its three texts (names masked); only a failed citation check drops;
 * - a daily cap per doctor: today's slots go to the most severe then
 *   oldest findings, the rest wait (never dropped) and roll over on the
 *   clinic's own calendar, each doctor with their own quota.
 */

const MINUTE = 60_000;
const cohort = loadReviewerCohort();
const NAME = ['Rodolfo', 'Arismendi'];

/** A model that answers in Spanish only, twice, and invents one quote. */
function spanishOnlyResponder(request: {
  output: { name: string };
  messages: readonly { role: string; content: string }[];
}): unknown {
  if (request.output.name === FINDING_TRANSLATION_OUTPUT_NAME) return undefined;
  const raw = request.messages
    .map((message) => /<review_input>([\s\S]*)<\/review_input>/.exec(message.content)?.[1])
    .find((match) => match !== undefined);
  const input = JSON.parse(raw ?? '{}') as ReviewInput;
  const trend = input.signals.find((signal) => signal.category === 'lab_trend');
  const findings =
    trend === undefined
      ? []
      : [
          {
            category: 'lab_trend',
            severity: 'high',
            // The model's own words (not the detector's), in Spanish only, with a name it should not write.
            summary: 'La creatinina de Rodolfo sigue subiendo sin comentario',
            rationale: 'Cuatro resultados seguidos empeoran y ninguna nota lo menciona.',
            suggestion: 'Considera evaluar la función renal y ajustar la metformina.',
            citations: trend.evidence.map((item) => ({ docId: item.docId, quote: item.quote })),
            signalIds: [trend.id],
          },
          {
            category: 'unaddressed_symptom',
            severity: 'medium',
            summary: 'Síntoma inventado',
            rationale: 'No está en el registro.',
            suggestion: 'Considera estudiarlo.',
            citations: [{ docId: 'N1', quote: 'una frase que ninguna nota contiene' }],
            signalIds: [],
          },
        ];
  return {
    thought: 'Submitting.',
    tool: 'submit_findings',
    arguments: JSON.stringify({ findings }),
  };
}

function reviewerFor(harness: EngineHarness, translated: string[][]): ClinicalReviewer {
  const gateway = createLlmGateway({
    providers: {
      fake: createFakeProvider({
        respond: (request) => {
          if (request.output.name === FINDING_TRANSLATION_OUTPUT_NAME) {
            translated.push(request.messages.map((message) => message.content));
            return {
              summary: "[REDACTED]'s creatinine keeps rising with no comment",
              rationale: 'Four results in a row got worse and no note mentions it.',
              suggestion: 'Consider assessing renal function and adjusting metformin.',
            };
          }
          return spanishOnlyResponder(request);
        },
      }),
    },
    tasks: {
      [CLINICAL_REVIEW_TASK]: { route: [{ provider: 'fake', model: FAKE_REVIEWER_MODEL }] },
      [FINDING_TRANSLATION_TASK]: { route: [{ provider: 'fake', model: FAKE_REVIEWER_MODEL }] },
    },
    usageLog: new InMemoryLlmUsageLog(),
    pricing: DEFAULT_PRICING,
    clock: harness.clock,
  });
  return createClinicalReviewer({
    unitOfWork: harness.unitOfWork,
    clock: harness.clock,
    ids: new SequentialIdGenerator(),
    agent: createReviewAgent({ gateway }),
    translator: createFindingTranslator({ gateway }),
    localeOf: () => 'es',
    redactTermsOf: () => NAME,
    loadCatalog: (id) => harness.engine.catalog(id),
  });
}

async function sendHistory(harness: EngineHarness, id: string, at: Date): Promise<void> {
  harness.clock.set(at);
  const patient = cohort.patients.find((item) => item.patientId === id);
  for (const entry of patient?.entries ?? []) {
    const bundle = JSON.parse(
      JSON.stringify(entry.bundle).replaceAll('clinic-demo', harness.clinicId),
    ) as unknown;
    await ingestBundle(harness, bundle, at);
  }
}

function describeTranslation(
  adapter: string,
  makeHarness: (options: HarnessOptions) => Promise<EngineHarness>,
): void {
  const start = new Date(BASE_DATE.getTime() - 60 * MINUTE);

  it('keeps a Spanish-only finding, labels it for English readers, and a job fills the English', async () => {
    const harness = await makeHarness({
      clinicId: clinicId(`clinic-translation-${adapter}`),
      start,
      extractor: new FakeNoteExtractor(),
    });
    await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
      for (const flag of shadowPilotFlags(harness.clinicId, 'pilot-lead', start)) {
        await stores.findingFlags.upsert(harness.clinicId, flag);
      }
    });
    await sendHistory(harness, 'rev-0001', start);
    const translated: string[][] = [];
    const reviewer = reviewerFor(harness, translated);
    const report = await reviewer.reviewPatient(harness.clinicId, patientId('rev-0001'), 'manual');

    // The invented quote is the only thing dropped; the untranslated finding is kept.
    expect(report.run.discarded).toEqual([{ reason: 'quote_not_found', count: 1 }]);
    const finding = report.findings.find((item) => item.category === 'lab_trend');
    if (finding === undefined) throw new Error('the Spanish-only finding was not kept');
    expect(finding.texts).toEqual({
      es: {
        summary: 'La creatinina de Rodolfo sigue subiendo sin comentario',
        rationale: 'Cuatro resultados seguidos empeoran y ninguna nota lo menciona.',
        suggestion: 'Considera evaluar la función renal y ajustar la metformina.',
      },
    });
    // An English reader gets the Spanish words until the translation arrives (the UI labels them).
    expect(findingTextIn(finding, 'en').summary).toBe(finding.summary);
    expect(finding.texts?.en).toBeUndefined();
    // The model was asked once to resubmit with both languages, then kept what it gave.
    expect(report.run.trace.map((step) => step.outcome)).toEqual(['missing_translation', 'ok']);

    // The translation job: queued with the review, run by the worker.
    const jobs = await harness.read((stores) =>
      stores.jobs.claim({
        workerId: 'test',
        types: [FINDING_TRANSLATION_JOB],
        limit: 10,
        leaseFor: { minutes: 5 },
        now: harness.clock.now(),
      }),
    );
    expect(jobs.map((job) => job.payload['findingId'])).toEqual([finding.id]);
    const [job] = jobs;
    if (job === undefined) throw new Error('no translation job');
    expect(await reviewer.runTranslationJob(harness.clinicId, job.payload)).toEqual(['en']);

    const stored = await reviewer.getFinding(harness.clinicId, finding.id);
    expect(stored?.texts?.en?.summary).toBe("[REDACTED]'s creatinine keeps rising with no comment");
    expect(stored?.texts?.es).toEqual(finding.texts?.es);
    expect(stored && findingTextIn(stored, 'en').suggestion).toMatch(/^Consider assessing/);
    // Only the three texts left, the name masked: no record, no quote, no identifier.
    const sent = translated.flat().join('\n');
    expect(sent).toContain('creatinina');
    expect(sent).not.toMatch(/Rodolfo|Arismendi|rev-0001|Creatinina: \d/);
    // Nothing left to translate: a second run adds nothing.
    expect(await reviewer.runTranslationJob(harness.clinicId, job.payload)).toEqual([]);
  });
}

describe('reviewer translations (memory)', () => {
  describeTranslation('memory', (options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('reviewer translations'), () => {
  const database = useIsolatedDatabase();
  describeTranslation('postgres', (options) => postgresHarness(database(), options));
});

/* The daily cap per doctor. */

function finding(
  harness: EngineHarness,
  overrides: Partial<ClinicalFinding> & { readonly severity: FindingSeverity },
): ClinicalFinding {
  return aClinicalFinding(harness.clinicId, {
    category: 'lab_trend',
    mode: 'live',
    ...overrides,
  });
}

function describeCap(
  adapter: string,
  makeHarness: (options: HarnessOptions) => Promise<EngineHarness>,
): void {
  // 10:00 in Caracas (UTC-4): the clinic's day turns at 04:00 UTC.
  const start = new Date('2026-03-02T14:00:00.000Z');

  it('releases at most the cap per doctor per day, most severe then oldest, and rolls the rest over', async () => {
    const harness = await makeHarness({
      clinicId: clinicId(`clinic-cap-${adapter}`),
      start,
      settings: { dailyFindingCapPerDoctor: 2, timezone: 'America/Caracas' },
    });
    const reviewer = createClinicalReviewer({
      unitOfWork: harness.unitOfWork,
      clock: harness.clock,
      ids: new SequentialIdGenerator(),
      inboxSettingsOf: () => ({ dailyFindingCapPerDoctor: 2, timezone: 'America/Caracas' }),
    });
    await reviewer.updateFlag(
      harness.clinicId,
      { category: 'lab_trend', enabled: true, mode: 'live', validatedBy: 'dra-castellanos' },
      'pilot-lead',
    );
    // Dr. Medina owns pat-a and pat-b; Dr. Rojas owns pat-c.
    await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
      for (const [patient, assignee] of [
        ['pat-a', 'dr-medina'],
        ['pat-b', 'dr-medina'],
        ['pat-c', 'dr-rojas'],
      ] as const) {
        await stores.cases.create(
          harness.clinicId,
          contractBuilders.aCase(harness.clinicId, {
            patientId: patientId(patient),
            assignee,
            dedupKey: `${patient}:cap`,
          }),
        );
      }
    });
    const at = (hours: number) => new Date(start.getTime() - hours * 60 * MINUTE);
    const medina = [
      finding(harness, {
        id: 'm-low-old',
        patientId: patientId('pat-a'),
        severity: 'low',
        createdAt: at(50),
      }),
      finding(harness, {
        id: 'm-high-new',
        patientId: patientId('pat-b'),
        severity: 'high',
        createdAt: at(1),
      }),
      finding(harness, {
        id: 'm-high-old',
        patientId: patientId('pat-a'),
        severity: 'high',
        createdAt: at(30),
      }),
      finding(harness, {
        id: 'm-medium',
        patientId: patientId('pat-b'),
        severity: 'medium',
        createdAt: at(40),
      }),
    ];
    const rojas = [
      finding(harness, {
        id: 'r-1',
        patientId: patientId('pat-c'),
        severity: 'low',
        createdAt: at(5),
      }),
      finding(harness, {
        id: 'r-2',
        patientId: patientId('pat-c'),
        severity: 'low',
        createdAt: at(4),
      }),
    ];
    await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
      for (const item of [...medina, ...rojas])
        await stores.clinicalFindings.create(harness.clinicId, item);
    });

    const ids = (list: { items: readonly ClinicalFinding[] }) =>
      list.items.map((item) => item.id).sort();
    // Day 1: two per doctor; Dr. Medina's two most severe (oldest first), both of Dr. Rojas's.
    const day1 = await reviewer.listInboxFindings(harness.clinicId);
    expect(ids(day1)).toEqual(['m-high-new', 'm-high-old', 'r-1', 'r-2']);
    expect(day1.queued.map((item) => [item.id, item.doctor])).toEqual([
      ['m-medium', 'dr-medina'],
      ['m-low-old', 'dr-medina'],
    ]);
    expect(day1.dailyCap).toBe(2);
    // Read again the same day: nothing more comes out, nothing is lost.
    expect(ids(await reviewer.listInboxFindings(harness.clinicId))).toEqual(ids(day1));

    // Rating a card does not free a slot today.
    await reviewer.reviewFinding(harness.clinicId, 'm-high-new', {
      verdict: 'relevant',
      userId: 'dr-medina',
    });
    const rated = await reviewer.listInboxFindings(harness.clinicId);
    expect(ids(rated)).toEqual(['m-high-old', 'r-1', 'r-2']);
    expect(rated.queued).toHaveLength(2);

    // 23:30 in Caracas: still the same clinic day (03:30 UTC the next day).
    harness.clock.set(new Date('2026-03-03T03:30:00.000Z'));
    expect((await reviewer.listInboxFindings(harness.clinicId)).queued).toHaveLength(2);

    // The next clinic day: Dr. Medina's two waiting findings come out, by severity.
    harness.clock.set(new Date('2026-03-03T13:00:00.000Z'));
    const day2 = await reviewer.listInboxFindings(harness.clinicId);
    expect(ids(day2)).toEqual(['m-high-old', 'm-low-old', 'm-medium', 'r-1', 'r-2']);
    expect(day2.queued).toEqual([]);
  });
}

describe('daily cap of finding cards per doctor (memory)', () => {
  describeCap('memory', (options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('daily cap of finding cards per doctor'), () => {
  const database = useIsolatedDatabase();
  describeCap('postgres', (options) => postgresHarness(database(), options));
});
