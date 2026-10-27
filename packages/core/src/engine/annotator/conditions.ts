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
import { medicationMatches } from '../protocols/treatment-changes.ts';
import { resultValueAs, sameConcept } from '../terminology/loinc.ts';

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

/**
 * The patient's conditions a protocol rests on: those that enroll them, and
 * for an episodic protocol the outcome that ended it (the delivery behind
 * the postpartum visit). A confirmed one means the protocol's reasons rest
 * on a clinician's diagnosis, not only on an inference.
 */
export function protocolConditions(
  protocol: Protocol,
  conditions: readonly PatientCondition[],
): PatientCondition[] {
  const outcomes = (protocol.closing?.outcomes ?? []).flatMap((outcome) => outcome.conditionCodes);
  return [
    ...enrollingConditions(protocol, conditions),
    ...conditions.filter(
      (condition) =>
        outcomes.length > 0 &&
        meetsMinimumStatus(condition.status, protocol.enrollment.minimumStatus) &&
        icd10Matches(condition.code, outcomes),
    ),
  ];
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

const MS_PER_DAY = 86_400_000;

type EnrollmentResult = NonNullable<Protocol['enrollment']['results']>[number];

/** Whether a result meets an enrollment threshold (`gte`, `lt`; `abnormal` stands for `gte` without a value). */
function meetsThreshold(rule: EnrollmentResult, event: ClinicalEvent): boolean {
  if (event.type !== 'result.received' || !sameConcept(event.code, rule.code)) {
    return false;
  }
  if (event.value === undefined) {
    return rule.gte !== undefined && event.interpretation === 'abnormal';
  }
  const value = resultValueAs(rule.code, event);
  if (value === undefined) {
    return false;
  }
  return rule.gte !== undefined ? value >= rule.gte : rule.lt !== undefined && value < rule.lt;
}

/**
 * The batch result that enrolls by `rule`: one that meets the threshold
 * and, for a finding that must persist (`confirm`), is one of `count`
 * qualifying results of the record spanning `minDaysApart` days or more.
 */
function enrollingResult(
  rule: EnrollmentResult,
  events: readonly ClinicalEvent[],
  history: readonly ClinicalEvent[],
): ClinicalEvent | undefined {
  const hits = events.filter((event) => meetsThreshold(rule, event));
  if (rule.confirm === undefined) {
    return hits[0];
  }
  const { count, minDaysApart } = rule.confirm;
  const qualifying = [
    ...new Map(
      [...history, ...events]
        .filter((event) => meetsThreshold(rule, event))
        .map((event) => [event.idempotencyKey, event]),
    ).values(),
  ].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const first = qualifying[0];
  return hits.find(
    (hit) =>
      first !== undefined &&
      qualifying.filter((event) => event.occurredAt.getTime() <= hit.occurredAt.getTime()).length >=
        count &&
      hit.occurredAt.getTime() - first.occurredAt.getTime() >= minDaysApart * MS_PER_DAY,
  );
}

function inferredCandidates(
  protocol: Protocol,
  events: readonly ClinicalEvent[],
  history: readonly ClinicalEvent[],
  medications: readonly ExtractedMedicationHint[],
): ConditionCandidate[] {
  const candidates: ConditionCandidate[] = [];
  const prescribed = events.flatMap((event) =>
    event.type === 'medication.prescribed'
      ? [{ medication: event.medication, source: event.source }]
      : [],
  );
  const hinted = medications.map((hint) => ({
    medication: { text: hint.text },
    source: hint.source,
  }));
  for (const rule of protocol.enrollment.medications ?? []) {
    const hit = [...prescribed, ...hinted].find((candidate) =>
      medicationMatches(candidate.medication, rule),
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
    const hit = enrollingResult(rule, events, history);
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
  for (const rule of protocol.enrollment.records ?? []) {
    const hit = events.find(
      (event) =>
        (event.type === 'result.received' || event.type === 'service_request.created') &&
        rule.codes.some((code) => sameConcept(event.code, code)),
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
  /** The patient's record (the batch included), for findings that must repeat over time. */
  readonly history?: readonly ClinicalEvent[];
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
      : inferredCandidates(protocol, input.events, input.history ?? [], input.extractedMedications);
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
