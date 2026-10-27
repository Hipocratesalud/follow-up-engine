import type { Protocol } from '../../config/protocol.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Evidence } from '../../domain/common.ts';
import type {
  ConditionSourceType,
  PatientCondition,
  PatientConditionStatus,
} from '../../domain/condition.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import { type Coding, ICD10_SYSTEM, type ResourceRef } from '../../domain/resource.ts';
import { sameCoding } from '../matching/match-key.ts';

/** Confidence given to a condition inferred from a medication. */
const MEDICATION_INFERENCE_CONFIDENCE = 0.7;
/** Confidence given to a condition inferred from a result. */
const RESULT_INFERENCE_CONFIDENCE = 0.8;
/** Confidence of a provisional diagnosis recorded by a clinician. */
const PROVISIONAL_CONFIDENCE = 0.6;

/** A condition the current batch suggests, before merging with what is stored. */
export interface ConditionCandidate {
  readonly code: Coding;
  readonly status: Exclude<PatientConditionStatus, 'resolved' | 'rejected' | 'entered_in_error'>;
  readonly confidence: number;
  readonly sourceType: ConditionSourceType;
  readonly source: ResourceRef;
  readonly evidence?: Evidence;
}

/** A medication read from a note, used only to infer conditions. */
export interface ExtractedMedicationHint {
  readonly text: string;
  readonly source: ResourceRef;
}

/** Lowercase without accents, so "Losartán" matches "losartan". */
function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function normalizeIcd10(code: string): string {
  return code.replace('.', '').trim().toUpperCase();
}

/** Whether an ICD-10 code falls under one of the listed codes or prefixes (`E11` matches `E11.9`). */
export function icd10Matches(code: Coding, prefixes: readonly string[]): boolean {
  if (code.system !== ICD10_SYSTEM) {
    return false;
  }
  const normalized = normalizeIcd10(code.code);
  return prefixes.some((prefix) => normalized.startsWith(normalizeIcd10(prefix)));
}

function meetsMinimumStatus(
  status: PatientConditionStatus,
  minimum: Protocol['enrollment']['minimumStatus'],
): boolean {
  return status === 'confirmed' || (status === 'probable' && minimum === 'probable');
}

/** The patient's conditions that enroll them in `protocol`. */
export function enrollingConditions(
  protocol: Protocol,
  conditions: readonly PatientCondition[],
): PatientCondition[] {
  return conditions.filter(
    (condition) =>
      meetsMinimumStatus(condition.status, protocol.enrollment.minimumStatus) &&
      icd10Matches(condition.code, protocol.enrollment.conditionCodes),
  );
}

function icd10(code: string): Coding {
  return { system: ICD10_SYSTEM, code };
}

/** The condition a recorded (or note-extracted) diagnosis suggests. */
export function recordedCandidate(
  event: Extract<ClinicalEvent, { type: 'condition.recorded' }>,
  extractedConfidence: ReadonlyMap<string, number>,
): ConditionCandidate {
  const fromNote = event.source.resourceType === 'DocumentReference';
  const confirmed = event.verification === 'confirmed' && !fromNote;
  return {
    code: event.code,
    status: confirmed ? 'confirmed' : 'probable',
    confidence: confirmed
      ? 1
      : (extractedConfidence.get(event.idempotencyKey) ?? PROVISIONAL_CONFIDENCE),
    sourceType: fromNote ? 'extracted_from_note' : 'recorded',
    source: event.source,
    ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
  };
}

function inferredCandidates(
  protocol: Protocol,
  events: readonly ClinicalEvent[],
  medications: readonly ExtractedMedicationHint[],
): ConditionCandidate[] {
  const candidates: ConditionCandidate[] = [];
  const prescribed = events.flatMap((event) =>
    event.type === 'medication.prescribed'
      ? [
          {
            text: `${event.medication.text} ${event.medication.code?.display ?? ''}`,
            source: event.source,
          },
        ]
      : [],
  );
  for (const rule of protocol.enrollment.medications ?? []) {
    const hit = [...prescribed, ...medications].find((medication) =>
      rule.match.some((needle) => foldText(medication.text).includes(foldText(needle))),
    );
    if (hit !== undefined) {
      candidates.push({
        code: icd10(rule.conditionCode),
        status: 'probable',
        confidence: MEDICATION_INFERENCE_CONFIDENCE,
        sourceType: 'inferred_from_medication',
        source: hit.source,
      });
    }
  }
  for (const rule of protocol.enrollment.results ?? []) {
    const hit = events.find(
      (event) =>
        event.type === 'result.received' &&
        sameCoding(event.code, rule.code) &&
        (event.value === undefined
          ? event.interpretation === 'abnormal'
          : event.value.value >= rule.gte),
    );
    if (hit !== undefined) {
      candidates.push({
        code: icd10(rule.conditionCode),
        status: 'probable',
        confidence: RESULT_INFERENCE_CONFIDENCE,
        sourceType: 'inferred_from_result',
        source: hit.source,
      });
    }
  }
  return candidates;
}

/**
 * Conditions suggested by a batch: coded diagnoses (confirmed), provisional
 * and note-extracted diagnoses (probable), and conditions inferred from
 * medications or results (probable) when the patient has no diagnosis that
 * already enrolls them in that protocol.
 */
export function conditionCandidates(input: {
  readonly events: readonly ClinicalEvent[];
  readonly protocols: readonly Protocol[];
  readonly existing: readonly PatientCondition[];
  readonly extractedConfidence: ReadonlyMap<string, number>;
  readonly extractedMedications: readonly ExtractedMedicationHint[];
}): ConditionCandidate[] {
  const recorded = input.events.flatMap((event) =>
    event.type === 'condition.recorded'
      ? [recordedCandidate(event, input.extractedConfidence)]
      : [],
  );
  const inferred = input.protocols.flatMap((protocol) => {
    // A diagnosis entered in error was never the patient's: it blocks nothing.
    const known = [
      ...input.existing.filter(
        (condition) =>
          (condition.status !== 'resolved' && condition.status !== 'entered_in_error') ||
          condition.confirmedBy !== undefined,
      ),
      ...recorded,
    ];
    const alreadyKnown = known.some((condition) =>
      icd10Matches(condition.code, protocol.enrollment.conditionCodes),
    );
    return alreadyKnown
      ? []
      : inferredCandidates(protocol, input.events, input.extractedMedications);
  });
  return [...recorded, ...inferred];
}

/**
 * Merges a candidate into the stored condition. Returns the condition to
 * upsert, or `undefined` when nothing changes. A clinician's review
 * (`confirmedBy`) is never overwritten by automation, and a confirmed
 * diagnosis is never downgraded to probable.
 */
export function mergeCondition(
  existing: PatientCondition | undefined,
  candidate: ConditionCandidate,
  context: { readonly clinicId: ClinicId; readonly patientId: PatientId; readonly now: Date },
): PatientCondition | undefined {
  const next: PatientCondition = {
    clinicId: context.clinicId,
    patientId: context.patientId,
    code: candidate.code,
    status: candidate.status,
    confidence: candidate.confidence,
    sourceType: candidate.sourceType,
    source: candidate.source,
    ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
    updatedAt: context.now,
  };
  if (
    existing === undefined ||
    existing.status === 'resolved' ||
    existing.status === 'rejected' ||
    existing.status === 'entered_in_error'
  ) {
    return existing?.confirmedBy === undefined ? next : undefined;
  }
  if (existing.confirmedBy !== undefined) {
    return undefined;
  }
  if (existing.status === 'confirmed') {
    return undefined;
  }
  if (candidate.status === 'confirmed' || candidate.confidence > existing.confidence) {
    return next;
  }
  return undefined;
}
