import type { LabPhotoReading } from '../../domain/order-agent.ts';
import { testGroupsNamedIn } from '../terminology/test-names.ts';
import { fold } from './confirmation.ts';

type ReadTest = LabPhotoReading['tests'][number];

/**
 * HL7 v3 ObservationInterpretation of a printed value against its printed
 * reference range, computed by code (never by a model): `H` above, `L`
 * below, `N` inside, `undefined` when no range was printed.
 */
export function interpretationOfRange(test: ReadTest): 'H' | 'L' | 'N' | undefined {
  if (test.referenceHigh !== undefined && test.value > test.referenceHigh) return 'H';
  if (test.referenceLow !== undefined && test.value < test.referenceLow) return 'L';
  if (test.referenceHigh !== undefined || test.referenceLow !== undefined) return 'N';
  return undefined;
}

/** One test of a lab-result reading, coded the way the engine matches results (LOINC). */
export interface CodedLabResult {
  /** The test group (`hba1c`): part of a stable Observation id. */
  readonly groupId: string;
  /** The group's short English name (`HbA1c`). */
  readonly test: string;
  readonly code: { readonly system: string; readonly code: string; readonly display: string };
  readonly reading: ReadTest;
  readonly interpretation?: 'H' | 'L' | 'N';
}

/**
 * Codes what a lab-result reading (a photo or a PDF report) read, the same
 * way the order agent codes it before `submit_fhir_result`: each printed
 * test name to its lab test group and that group's first LOINC. A test the
 * catalog does not know is returned by name, unrecognized (never guessed);
 * a group read twice keeps its first value.
 */
export function codeLabReading(reading: LabPhotoReading): {
  readonly results: readonly CodedLabResult[];
  readonly unrecognized: readonly string[];
} {
  const results: CodedLabResult[] = [];
  const unrecognized: string[] = [];
  if (!reading.isLabReport) return { results, unrecognized };
  for (const test of reading.tests) {
    const group = testGroupsNamedIn(test.name, 'lab')[0];
    const loinc = group?.loinc[0];
    if (group === undefined || loinc === undefined) {
      unrecognized.push(test.name.slice(0, 80));
      continue;
    }
    if (results.some((item) => item.groupId === group.id)) continue;
    const interpretation = interpretationOfRange(test);
    results.push({
      groupId: group.id,
      test: group.label,
      code: { system: 'http://loinc.org', code: loinc, display: group.label },
      reading: test,
      ...(interpretation === undefined ? {} : { interpretation }),
    });
  }
  return { results, unrecognized };
}

/** Whether the name printed on a report is the patient's: compared by code, never by a model. */
export type NameOnReport = 'matches' | 'mismatch' | 'absent';

/** A name's words, accents and case folded, punctuation dropped (`María F. Rojas` → maria, f, rojas). */
function nameTokens(name: string): string[] {
  return fold(name)
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '' && !/^\d+$/.test(token));
}

/**
 * Compares the name printed on a lab report with the name in the patient's
 * record, by code. **By design it errs toward holding**: a false hold only
 * sends a report to the team ("Needs review"), a false match would record
 * another person's result in this patient's chart and could close an order.
 *
 * It matches only when the printed name shares **two full words** with the
 * record (a given name and a surname, in any order: one or two surnames,
 * swapped surnames, an extra middle name or initial, extra whitespace,
 * accents and case do not matter), or every word of a one-word record name.
 * A printed initial must be the first letter of one of the record's words.
 * One shared word is not enough (same first name with another surname, a
 * common surname with another first name, `María Rojas` vs `Mariana Rojas`:
 * all held). No printed name is `absent` (nothing to compare; accepted, as
 * on the agent path).
 */
export function nameOnReport(
  printed: string | undefined,
  patientFullName: string | undefined,
): NameOnReport {
  if (printed === undefined || printed.trim() === '') return 'absent';
  const record = nameTokens(patientFullName ?? '');
  const seen = nameTokens(printed);
  const words = (tokens: readonly string[]) => tokens.filter((token) => token.length > 1);
  const recordWords = new Set(words(record));
  if (recordWords.size === 0) return 'mismatch';
  const shared = new Set(words(seen).filter((token) => recordWords.has(token)));
  // An initial that is no word of the record (`María X. Rojas` vs `María Fernanda Rojas`).
  const initialsFit = seen
    .filter((token) => token.length === 1)
    .every((initial) => record.some((token) => token.startsWith(initial)));
  return initialsFit && shared.size >= Math.min(2, recordWords.size) ? 'matches' : 'mismatch';
}
