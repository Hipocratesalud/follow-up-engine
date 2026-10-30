import type {
  Adjudication,
  AdjudicationDecision,
  AdjudicationOverride,
} from '../domain/adjudication.ts';
import type { ClinicId, ExpectationId, PatientId } from '../domain/ids.ts';

export interface AdjudicationListQuery {
  readonly patientId?: PatientId;
  /** Decisions on any of these expectations (a case's reasons). */
  readonly expectationIds?: readonly ExpectationId[];
  readonly decisions?: readonly AdjudicationDecision[];
  /** Default 50, at most 200. */
  readonly limit?: number;
}

/**
 * The adjudicator's decisions, one per expectation (the decision is never
 * re-run once stored, so a doctor's override is never second-guessed by a
 * later model call). Only the override is ever written after creation.
 */
export interface AdjudicationRepository {
  /**
   * Throws `TenantMismatchError` for another clinic's record and
   * `ConflictError` when the expectation already has a decision.
   */
  create(clinicId: ClinicId, adjudication: Adjudication): Promise<void>;
  get(clinicId: ClinicId, id: string): Promise<Adjudication | undefined>;
  forExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<Adjudication | undefined>;
  /** Newest first. */
  list(clinicId: ClinicId, query?: AdjudicationListQuery): Promise<readonly Adjudication[]>;
  /** Records the doctor's override. Throws `NotFoundError` for an unknown id. */
  setOverride(
    clinicId: ClinicId,
    id: string,
    override: AdjudicationOverride,
  ): Promise<Adjudication>;
}
