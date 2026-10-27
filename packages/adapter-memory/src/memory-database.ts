import type {
  CaseEvent,
  CaseFeedback,
  ClinicalEvent,
  ClinicId,
  DomainEvent,
  Expectation,
  FhirResourceJson,
  FollowUpCase,
  JobId,
  JsonObject,
  LlmCallRecord,
  PatientCondition,
  PatientId,
  QualityFinding,
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
    sequence: 0,
  };
}

/** `clinicId|key`: every row is keyed by tenant first. */
export function tenantKey(clinicId: ClinicId, ...parts: readonly string[]): string {
  return [clinicId, ...parts].join('|');
}

/**
 * The shared in-memory "database" behind every memory adapter. Adapters read
 * `state` on each call, so `restore` (used by the unit of work to roll back)
 * swaps the whole database atomically.
 */
export class MemoryDatabase {
  #state: MemoryState = emptyState();

  get state(): MemoryState {
    return this.#state;
  }

  /** A deep copy of the current state. */
  snapshot(): MemoryState {
    return structuredClone(this.#state);
  }

  restore(snapshot: MemoryState): void {
    this.#state = snapshot;
  }

  nextSequence(): number {
    this.#state.sequence += 1;
    return this.#state.sequence;
  }

  /** Empties every table. */
  reset(): void {
    this.#state = emptyState();
  }
}
