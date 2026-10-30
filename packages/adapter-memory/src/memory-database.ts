import type {
  Adjudication,
  BackfillProgress,
  CaseEvent,
  CaseFeedback,
  ClinicalEvent,
  ClinicalFinding,
  ClinicalReviewRun,
  ClinicId,
  ContactCommunication,
  ContactRequest,
  PatientContactFlag,
  RuleSuppression,
  DomainEvent,
  Expectation,
  ExpectationEvent,
  FhirResourceJson,
  FindingFlag,
  FollowUpCase,
  JobId,
  JsonObject,
  LlmCallRecord,
  PatientCondition,
  PatientId,
  PlanItemReview,
  QualityFinding,
  ReconciliationRepair,
  ReconciliationRun,
  RuleOverrideChange,
  RuleOverrideRecord,
} from '@follow-up-engine/core';

export interface StoredResourceRecord {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly resource: FhirResourceJson;
  readonly versionId: string;
  readonly receivedAt: Date;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'dead';

export interface JobRecord {
  readonly id: JobId;
  readonly clinicId: ClinicId;
  readonly type: string;
  readonly payload: JsonObject;
  readonly dedupKey?: string;
  readonly maxAttempts: number;
  readonly attempt: number;
  readonly status: JobStatus;
  readonly runAt: Date;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: Date;
  readonly workerId?: string;
  readonly lastError?: string;
  readonly createdAt: Date;
}

export interface OutboxRecord {
  readonly sequence: number;
  readonly clinicId: ClinicId;
  readonly event: DomainEvent;
  readonly deliveredAt?: Date;
}

/** Every table of the in-memory store. Plain data, so it can be deep-copied for rollback. */
export interface MemoryState {
  readonly resources: Map<string, StoredResourceRecord>;
  readonly events: Map<ClinicId, ClinicalEvent[]>;
  readonly eventKeys: Map<ClinicId, Set<string>>;
  readonly expectations: Map<string, Expectation>;
  readonly expectationKeys: Map<string, string>;
  readonly cases: Map<string, FollowUpCase>;
  readonly feedback: CaseFeedback[];
  readonly conditions: Map<string, PatientCondition>;
  readonly findings: Map<string, QualityFinding>;
  readonly audit: CaseEvent[];
  readonly jobs: Map<JobId, JobRecord>;
  readonly outbox: OutboxRecord[];
  readonly llmCalls: LlmCallRecord[];
  readonly backfillRuns: Map<string, BackfillProgress>;
  readonly contactRequests: Map<string, ContactRequest>;
  readonly communications: Map<string, ContactCommunication>;
  readonly contactFlags: Map<string, PatientContactFlag>;
  readonly suppressions: Map<string, RuleSuppression>;
  readonly clinicalFindings: Map<string, ClinicalFinding>;
  readonly reviewRuns: Map<string, ClinicalReviewRun>;
  readonly findingFlags: Map<string, FindingFlag>;
  readonly planItemReviews: PlanItemReview[];
  readonly expectationEvents: ExpectationEvent[];
  readonly ruleOverrides: Map<string, RuleOverrideRecord>;
  readonly ruleOverrideHistory: RuleOverrideChange[];
  readonly reconciliationRuns: Map<string, ReconciliationRun>;
  readonly reconciliationRepairs: ReconciliationRepair[];
  readonly adjudications: Map<string, Adjudication>;
  sequence: number;
}

function emptyState(): MemoryState {
  return {
    resources: new Map(),
    events: new Map(),
    eventKeys: new Map(),
    expectations: new Map(),
    expectationKeys: new Map(),
    cases: new Map(),
    feedback: [],
    conditions: new Map(),
    findings: new Map(),
    audit: [],
    jobs: new Map(),
    outbox: [],
    llmCalls: [],
    backfillRuns: new Map(),
    contactRequests: new Map(),
    communications: new Map(),
    contactFlags: new Map(),
    suppressions: new Map(),
    clinicalFindings: new Map(),
    reviewRuns: new Map(),
    findingFlags: new Map(),
    planItemReviews: [],
    expectationEvents: [],
    ruleOverrides: new Map(),
    ruleOverrideHistory: [],
    reconciliationRuns: new Map(),
    reconciliationRepairs: [],
    adjudications: new Map(),
    sequence: 0,
  };
}

/** `clinicId|key`: every row is keyed by tenant first. */
export function tenantKey(clinicId: ClinicId, ...parts: readonly string[]): string {
  return [clinicId, ...parts].join('|');
}

type Undo = () => void;

/**
 * The shared in-memory "database" behind every memory adapter.
 *
 * Repositories write through the helpers below (`setIn`, `deleteIn`,
 * `pushTo`, `replaceAt`, `addTo`, `nextSequence`). Inside a transaction each
 * helper also records how to undo its write, so a rollback costs as much as
 * the transaction wrote, not as much as the database holds. Stored values
 * are never mutated in place: a write replaces them.
 */
export class MemoryDatabase {
  #state: MemoryState = emptyState();
  #journal: Undo[] | undefined;

  get state(): MemoryState {
    return this.#state;
  }

  /** Whether a transaction is recording undo entries. */
  get inTransaction(): boolean {
    return this.#journal !== undefined;
  }

  /** Starts recording undo entries (one transaction at a time). */
  begin(): void {
    this.#journal = [];
  }

  /** Keeps every write since `begin`. */
  commit(): void {
    this.#journal = undefined;
  }

  /** Undoes every write since `begin`, newest first. */
  rollback(): void {
    const journal = this.#journal ?? [];
    this.#journal = undefined;
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      journal[index]?.();
    }
  }

  setIn<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue): void {
    if (this.#journal !== undefined) {
      const previous = map.get(key);
      this.#journal.push(
        map.has(key) ? () => map.set(key, previous as TValue) : () => map.delete(key),
      );
    }
    map.set(key, value);
  }

  deleteIn<TKey, TValue>(map: Map<TKey, TValue>, key: TKey): void {
    if (this.#journal !== undefined && map.has(key)) {
      const previous = map.get(key) as TValue;
      this.#journal.push(() => map.set(key, previous));
    }
    map.delete(key);
  }

  pushTo<TValue>(array: TValue[], value: TValue): void {
    if (this.#journal !== undefined) {
      const length = array.length;
      this.#journal.push(() => {
        array.length = length;
      });
    }
    array.push(value);
  }

  replaceAt<TValue>(array: TValue[], index: number, value: TValue): void {
    if (this.#journal !== undefined) {
      const previous = array[index] as TValue;
      this.#journal.push(() => {
        array[index] = previous;
      });
    }
    array[index] = value;
  }

  addTo<TValue>(set: Set<TValue>, value: TValue): void {
    if (this.#journal !== undefined && !set.has(value)) {
      this.#journal.push(() => set.delete(value));
    }
    set.add(value);
  }

  nextSequence(): number {
    const previous = this.#state.sequence;
    this.#journal?.push(() => {
      this.#state.sequence = previous;
    });
    this.#state.sequence = previous + 1;
    return this.#state.sequence;
  }

  /** A deep copy of the current state (fixtures, debugging). */
  snapshot(): MemoryState {
    return structuredClone(this.#state);
  }

  /** Replaces the whole state with a snapshot. Not inside a transaction. */
  restore(snapshot: MemoryState): void {
    this.#state = snapshot;
  }

  /** Empties every table. */
  reset(): void {
    this.#state = emptyState();
  }
}
