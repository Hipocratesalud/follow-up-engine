/**
 * The initial backfill: on the day the engine is turned on for a clinic, each
 * patient's history is replayed as if every document had just arrived.
 * Historical cases are held and released in daily batches.
 */

/**
 * `FollowUpCase.releaseAt` of a backfill case not scheduled for release yet:
 * held while the backfill runs, in shadow mode, or forever when it is too old
 * to notify (still listed among the patients to recover). Far in the future,
 * so every `releasedAsOf` query hides it without special cases.
 */
export const BACKFILL_UNSCHEDULED_RELEASE_AT = new Date('9999-12-31T00:00:00.000Z');

/** Whether a case's release date is the {@link BACKFILL_UNSCHEDULED_RELEASE_AT} sentinel. */
export function isUnscheduledRelease(releaseAt: Date | undefined): boolean {
  return releaseAt?.getTime() === BACKFILL_UNSCHEDULED_RELEASE_AT.getTime();
}

/** What a backfill run did so far. Every counter only grows, page by page. */
export interface BackfillCounts {
  readonly patientsScanned: number;
  /** Clinical events replayed (notes included). */
  readonly eventsProcessed: number;
  /** Notes replayed (read by the `NoteExtractor` now, or already read before). */
  readonly documentsProcessed: number;
  readonly expectationsCreated: number;
  /** Expectations the patient's own history already fulfilled during the replay. */
  readonly expectationsFulfilled: number;
  readonly casesOpened: number;
  /** Sum of `NoteExtraction.costUsd` of the notes read. */
  readonly llmCostUsd: number;
}

export const ZERO_BACKFILL_COUNTS: BackfillCounts = {
  patientsScanned: 0,
  eventsProcessed: 0,
  documentsProcessed: 0,
  expectationsCreated: 0,
  expectationsFulfilled: 0,
  casesOpened: 0,
  llmCostUsd: 0,
};

/** Adds two sets of counters. */
export function addBackfillCounts(left: BackfillCounts, right: BackfillCounts): BackfillCounts {
  return {
    patientsScanned: left.patientsScanned + right.patientsScanned,
    eventsProcessed: left.eventsProcessed + right.eventsProcessed,
    documentsProcessed: left.documentsProcessed + right.documentsProcessed,
    expectationsCreated: left.expectationsCreated + right.expectationsCreated,
    expectationsFulfilled: left.expectationsFulfilled + right.expectationsFulfilled,
    casesOpened: left.casesOpened + right.casesOpened,
    llmCostUsd: left.llmCostUsd + right.llmCostUsd,
  };
}
