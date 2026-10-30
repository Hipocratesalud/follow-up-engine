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

/**
 * Compares the name printed on a lab report with the patient's full name
 * (accents and case folded): it matches when any distinctive part (longer
 * than two letters) of the patient's name is printed. A printed name with
 * none of them is another patient's report; no printed name is `absent`.
 */
export function nameOnReport(
  printed: string | undefined,
  patientFullName: string | undefined,
): NameOnReport {
  if (printed === undefined || printed.trim() === '') return 'absent';
  const known = fold(patientFullName ?? '')
    .trim()
    .split(' ')
    .filter((part) => part.length > 2);
  const seen = fold(printed).trim().split(' ');
  return known.length > 0 && known.some((part) => seen.includes(part)) ? 'matches' : 'mismatch';
}
