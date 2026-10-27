import { z } from 'zod';
import { FINDING_SEVERITIES } from '../../domain/clinical-finding.ts';
import type {
  ReviewToolbox,
  ReviewToolDefinition,
  ToolExecution,
} from '../../ports/clinical-review-agent.ts';
import { atcCodeOfName } from '../terminology/atc.ts';
import { excerpt, isoDay, type ReviewDossier } from './dossier.ts';
import {
  classKeysOf,
  DRUG_CLASSES,
  findMeasurement,
  INTERACTION_RULES,
  MEASUREMENTS,
} from './knowledge.ts';
import { foldWithMap } from './text.ts';

/** Tool names of the reviewer's protocol, in the order the prompt lists them. */
export const REVIEW_TOOL_NAMES = [
  'get_lab_trend',
  'get_notes',
  'get_medications',
  'get_open_follow_ups',
  'check_interaction',
  'submit_findings',
] as const;
export type ReviewToolName = (typeof REVIEW_TOOL_NAMES)[number];

export const SUBMIT_FINDINGS_TOOL = 'submit_findings';

/** Characters of a note returned by `get_notes`. */
const NOTE_TOOL_CHARS = 2_400;
const MAX_NOTES_PER_CALL = 4;

export const GetLabTrendArgs = z
  .object({
    test: z
      .string()
      .min(2)
      .max(60)
      .describe(
        'Measurement key, Spanish name or LOINC code: creatinine, egfr, hba1c, systolic_bp, weight, ...',
      ),
  })
  .strict();

export const GetNotesArgs = z
  .object({
    query: z
      .string()
      .min(3)
      .max(60)
      .nullable()
      .describe('Word or phrase to search for in every note (accent-insensitive), or null.'),
    docIds: z
      .array(z.string().regex(/^N\d{1,4}$/))
      .max(MAX_NOTES_PER_CALL)
      .nullable()
      .describe('Note handles to read whole (N1, N2...), or null.'),
  })
  .strict()
  .refine((args) => args.query !== null || (args.docIds !== null && args.docIds.length > 0), {
    message: 'give a query or at least one docId',
  });

export const EmptyArgs = z.object({}).strict();

export const CheckInteractionArgs = z
  .object({
    drugA: z.string().min(3).max(80).describe('Drug name as written in the record'),
    drugB: z.string().min(3).max(80),
  })
  .strict();

export const ProposedFindingSchema = z
  .object({
    category: z.string().min(3).max(40),
    severity: z.enum(FINDING_SEVERITIES),
    summary: z.string().min(5).max(240).describe('One line, Spanish, for the clinician'),
    rationale: z.string().min(5).max(800).describe('Why it matters, Spanish'),
    suggestion: z
      .string()
      .min(5)
      .max(400)
      .describe('What to consider reviewing, Spanish, for the clinician'),
    citations: z
      .array(
        z
          .object({
            docId: z.string().min(2).max(12),
            quote: z.string().min(1).max(600).describe('Verbatim text copied from that document'),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    signalIds: z.array(z.string().regex(/^S\d{1,3}$/)).max(12),
  })
  .strict();

export const SubmitFindingsArgs = z
  .object({ findings: z.array(ProposedFindingSchema).max(12) })
  .strict();

export const REVIEW_TOOL_DEFINITIONS: readonly ReviewToolDefinition[] = [
  {
    name: 'get_lab_trend',
    description:
      'Every value of one measurement (lab or vital sign) with its date, document id, range and the trend computed by code.',
    parameters: GetLabTrendArgs,
    terminal: false,
  },
  {
    name: 'get_notes',
    description:
      'Searches the clinical notes for a word (returns the matching sentences) or returns whole notes by document id.',
    parameters: GetNotesArgs,
    terminal: false,
  },
  {
    name: 'get_medications',
    description:
      'Every medication of the record: name, dose, start date, ATC code, whether still active.',
    parameters: EmptyArgs,
    terminal: false,
  },
  {
    name: 'get_open_follow_ups',
    description:
      'Follow-ups the engine already tracks for the patient (open expectations and active cases): a finding they cover is not new.',
    parameters: EmptyArgs,
    terminal: false,
  },
  {
    name: 'check_interaction',
    description:
      'Looks two drugs up in the curated interaction table. Returns the risk when the pair (or a class pair) is listed.',
    parameters: CheckInteractionArgs,
    terminal: false,
  },
  {
    name: SUBMIT_FINDINGS_TOOL,
    description:
      'Ends the review with the findings for the clinician. Every finding must cite at least one document id with a verbatim quote from it.',
    parameters: SubmitFindingsArgs,
    terminal: true,
  },
];

function getLabTrend(dossier: ReviewDossier, args: z.infer<typeof GetLabTrendArgs>): ToolExecution {
  const measurement = findMeasurement(args.test);
  const trend =
    measurement === undefined
      ? undefined
      : dossier.trends.find((item) => item.test === measurement.key);
  if (measurement === undefined || trend === undefined) {
    return {
      ok: true,
      result: {
        found: false,
        available: dossier.trends.map((item) => item.test),
        known: MEASUREMENTS.map((item) => item.key),
      },
      summary: 'not found',
    };
  }
  return {
    ok: true,
    result: {
      found: true,
      test: trend.test,
      label: trend.label,
      unit: trend.unit,
      low: trend.low ?? null,
      high: trend.high ?? null,
      values: trend.points.map((point) => ({
        docId: point.handle,
        date: isoDay(point.at),
        value: point.value,
        text: dossier.documents.get(point.handle)?.text ?? '',
      })),
      changePct: trend.changePct,
      slopePerYear: trend.slopePerYear,
      consecutiveWorsening: trend.consecutiveWorsening,
      latestOutOfRange: trend.latestOutOfRange,
    },
    summary: `${String(trend.points.length)} points`,
  };
}

function getNotes(dossier: ReviewDossier, args: z.infer<typeof GetNotesArgs>): ToolExecution {
  if (args.docIds !== null && args.docIds.length > 0) {
    const notes = args.docIds.flatMap((handle) => {
      const note = dossier.notes.find((item) => item.handle === handle);
      return note === undefined
        ? []
        : [
            {
              docId: note.handle,
              date: isoDay(note.occurredAt),
              specialty: note.specialty ?? null,
              text: excerpt(note.text, NOTE_TOOL_CHARS),
            },
          ];
    });
    return { ok: true, result: { notes }, summary: `${String(notes.length)} notes` };
  }
  const query = foldWithMap(args.query ?? '').folded.trim();
  const matches = dossier.notes.flatMap((note) => {
    const text = foldWithMap(note.text);
    const at = text.folded.indexOf(query);
    if (at < 0) return [];
    const sentences = note.text
      .split(/(?<=[.;!?\n])/)
      .filter((sentence) => foldWithMap(sentence).folded.includes(query))
      .map((sentence) => sentence.trim())
      .slice(0, 3);
    return [
      {
        docId: note.handle,
        date: isoDay(note.occurredAt),
        specialty: note.specialty ?? null,
        sentences,
      },
    ];
  });
  return {
    ok: true,
    result: { query: args.query, matches },
    summary: `${String(matches.length)} notes match`,
  };
}

function getMedications(dossier: ReviewDossier): ToolExecution {
  return {
    ok: true,
    result: {
      medications: dossier.medications.map((medication) => ({
        docId: medication.handle,
        name: medication.name,
        dose: medication.dose ?? null,
        since: isoDay(medication.since),
        atc: medication.atc ?? null,
        active: medication.active,
        classes: [...classKeysOf(medication.atc)],
      })),
    },
    summary: `${String(dossier.medications.length)} medications`,
  };
}

function getOpenFollowUps(dossier: ReviewDossier): ToolExecution {
  const { liveExpectations, activeCases } = dossier.snapshot;
  return {
    ok: true,
    result: {
      expectations: liveExpectations.map((expectation) => ({
        ruleId: expectation.ruleId,
        label: expectation.reason.label,
        dueAt: isoDay(expectation.dueAt),
        status: expectation.status,
      })),
      cases: activeCases.map((item) => ({
        status: item.status,
        reasons: item.reasons.map((reason) => reason.reasonCode),
      })),
    },
    summary: `${String(liveExpectations.length)} expectations, ${String(activeCases.length)} cases`,
  };
}

/** Drug classes of a name: through its ATC code, else a class named directly ("AINE"). */
function classesOfName(name: string): Set<string> {
  const keys = classKeysOf(atcCodeOfName(name));
  const folded = foldWithMap(name).folded;
  for (const drugClass of DRUG_CLASSES) {
    if (drugClass.names.some((name) => folded.includes(name)) || folded === drugClass.key) {
      keys.add(drugClass.key);
      if (drugClass.key === 'ace_inhibitor' || drugClass.key === 'arb') keys.add('raas');
    }
  }
  return keys;
}

function checkInteraction(
  dossier: ReviewDossier,
  args: z.infer<typeof CheckInteractionArgs>,
): ToolExecution {
  const left = classesOfName(args.drugA);
  const right = classesOfName(args.drugB);
  const rule = INTERACTION_RULES.find(
    (candidate) =>
      candidate.classes.length === 2 &&
      ((left.has(candidate.classes[0] ?? '') && right.has(candidate.classes[1] ?? '')) ||
        (right.has(candidate.classes[0] ?? '') && left.has(candidate.classes[1] ?? ''))),
  );
  const triple = INTERACTION_RULES.filter((candidate) => candidate.classes.length > 2).find(
    (candidate) =>
      candidate.classes.filter((drugClass) => left.has(drugClass) || right.has(drugClass)).length >=
      2,
  );
  return {
    ok: true,
    result: {
      drugA: { name: args.drugA, classes: [...left] },
      drugB: { name: args.drugB, classes: [...right] },
      found: rule !== undefined,
      ...(rule === undefined
        ? {}
        : {
            severity: rule.severity,
            risk: dossier.copy.interactions[rule.key]?.risk ?? rule.key,
            suggestion: dossier.copy.interactions[rule.key]?.suggestion ?? '',
            source: 'curated_table',
          }),
      ...(triple === undefined
        ? {}
        : {
            partOf: {
              classes: triple.classes,
              risk: dossier.copy.interactions[triple.key]?.risk ?? triple.key,
            },
          }),
    },
    summary: rule === undefined ? 'found: none' : `found: ${rule.severity}`,
  };
}

/**
 * The read-only tools of one review. Each runs over the dossier only (one
 * patient, already loaded), returns document handles (never host ids) and
 * is pure: calling it twice gives the same answer.
 */
export function createReviewToolbox(dossier: ReviewDossier): ReviewToolbox {
  return {
    definitions: REVIEW_TOOL_DEFINITIONS,
    execute(name, args) {
      switch (name) {
        case 'get_lab_trend': {
          const parsed = GetLabTrendArgs.safeParse(args);
          return parsed.success ? getLabTrend(dossier, parsed.data) : invalid();
        }
        case 'get_notes': {
          const parsed = GetNotesArgs.safeParse(args);
          return parsed.success ? getNotes(dossier, parsed.data) : invalid();
        }
        case 'get_medications':
          return EmptyArgs.safeParse(args).success ? getMedications(dossier) : invalid();
        case 'get_open_follow_ups':
          return EmptyArgs.safeParse(args).success ? getOpenFollowUps(dossier) : invalid();
        case 'check_interaction': {
          const parsed = CheckInteractionArgs.safeParse(args);
          return parsed.success ? checkInteraction(dossier, parsed.data) : invalid();
        }
        default:
          return { ok: false, error: 'unknown_tool' };
      }
    },
  };
}

function invalid(): ToolExecution {
  return { ok: false, error: 'invalid_arguments' };
}
