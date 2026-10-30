import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { Coding } from '../../domain/resource.ts';
import { closeExpectation } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import { differentTrimesters } from '../matching/correlation.ts';
import { kindOfMatchKey, parseCodeMatchKey } from '../matching/match-key.ts';
import type { LiveExpectations } from '../patient-state.ts';
import { sameConcept } from '../terminology/loinc.ts';
import { encounterOf, eventInstant, type PatientTimeline } from '../timeline.ts';
import type { AnnotationContext, ClosedExpectation } from './context.ts';

/** Machine reasons (`closedReason`) of a request of a test that another request of it replaced. */
export const TEST_REQUEST_REASONS = {
  /** The test was asked for again later (a new order, a later plan item): the latest request stands. */
  supersededByNewRequest: 'superseded_by_new_request',
  /** The plan item and the order of the same visit are one request: the order stands. */
  coveredByOrder: 'covered_by_order',
} as const;

const MS_PER_DAY = 86_400_000;

/** A pending request of one test: an order, or a coded lab or imaging item of the doctor's plan. */
interface TestRequest {
  readonly expectation: Expectation;
  readonly code: Coding;
  readonly isOrder: boolean;
  /** When it was asked for: the order, or the note. */
  readonly at: number;
  readonly encounterId: string | undefined;
  /** The order or note event that asked for it, when still in the record. */
  readonly anchor: ClinicalEvent | undefined;
}

function requestOf(
  expectation: Expectation,
  catalog: Catalog,
  timeline: PatientTimeline,
): TestRequest | undefined {
  const code = parseCodeMatchKey(expectation.matchKey);
  if (code === undefined) {
    return undefined;
  }
  const definition = catalog.definition(expectation.ruleId);
  const isOrder =
    expectation.layer === 'universal' && definition?.trigger?.event === 'service_request.created';
  const kind = kindOfMatchKey(expectation.matchKey);
  const isPlanTest = expectation.layer === 'doctor_plan' && (kind === 'lab' || kind === 'imaging');
  if (!isOrder && !isPlanTest) {
    return undefined;
  }
  const anchor = timeline.bySource(expectation.source);
  return {
    expectation,
    code,
    isOrder,
    at: (anchor === undefined ? expectation.createdAt : eventInstant(anchor)).getTime(),
    encounterId: anchor === undefined ? undefined : encounterOf(anchor),
    anchor,
  };
}

/**
 * Whether `left` and `right` are the same prenatal test window: orders of
 * different pregnancy trimesters (the 20-week anatomy scan, the 32-week
 * growth scan) are different tests, the same rule `supersedes` already
 * applies to a newer order against a pending one. A later-window order
 * never consolidates an earlier-window one that never came back.
 */
function sameWindow(left: TestRequest, right: TestRequest, timeline: PatientTimeline): boolean {
  const [earlier, later] = left.at <= right.at ? [left, right] : [right, left];
  if (earlier.anchor === undefined || later.anchor === undefined) {
    return true;
  }
  return !differentTrimesters(later.anchor, earlier.anchor, timeline);
}

/** Asked for at the same consultation (same encounter; else within a day, when one is unlinked). */
function sameVisit(left: TestRequest, right: TestRequest): boolean {
  if (left.encounterId !== undefined && right.encounterId !== undefined) {
    return left.encounterId === right.encounterId;
  }
  return Math.abs(left.at - right.at) <= MS_PER_DAY;
}

/** The request that stands: the latest visit's, its order rather than its plan item. */
function standing(requests: readonly TestRequest[]): TestRequest | undefined {
  const latest = requests.reduce<TestRequest | undefined>(
    (best, request) => (best === undefined || request.at > best.at ? request : best),
    undefined,
  );
  if (latest === undefined) {
    return undefined;
  }
  return requests.find((request) => request.isOrder && sameVisit(request, latest)) ?? latest;
}

/**
 * One test, one pending request. The doctor's plan item for a test and the
 * order of the same visit are one request (the order stands; the plan item
 * is `covered_by_order`), and a test asked for again at a later visit (a new
 * order, "pendiente HbA1c" in a later plan) replaces what was asked before
 * (`superseded_by_new_request`): the latest request is the one the clinic
 * follows, so a never-done lipid panel is one reason in one case, and a
 * result answers the request standing when it arrives, never a request of
 * months before. Equivalent LOINC codes are one test (every lipid panel
 * code, HbA1c by any method).
 */
export async function oneRequestPerTest(
  context: Pick<AnnotationContext, 'stores' | 'catalog' | 'now'>,
  timeline: PatientTimeline,
  live: LiveExpectations,
): Promise<ClosedExpectation[]> {
  const requests = live
    .list()
    .flatMap((expectation) => requestOf(expectation, context.catalog, timeline) ?? []);
  const closed: ClosedExpectation[] = [];
  const done = new Set<string>();
  for (const request of requests) {
    if (done.has(request.expectation.id)) {
      continue;
    }
    const sameTest = requests.filter(
      (other) =>
        !done.has(other.expectation.id) &&
        sameConcept(other.code, request.code) &&
        sameWindow(request, other, timeline),
    );
    for (const other of sameTest) {
      done.add(other.expectation.id);
    }
    const keeper = standing(sameTest);
    if (keeper === undefined || sameTest.length < 2) {
      continue;
    }
    for (const other of sameTest) {
      if (other === keeper) {
        continue;
      }
      const coveredByOrder = keeper.isOrder && !other.isOrder && sameVisit(other, keeper);
      const next = await closeExpectation(
        context.stores,
        other.expectation,
        coveredByOrder ? 'cancelled' : 'superseded',
        coveredByOrder
          ? TEST_REQUEST_REASONS.coveredByOrder
          : TEST_REQUEST_REASONS.supersededByNewRequest,
        context.now,
        keeper.expectation.source,
      );
      live.put(next);
      closed.push({
        expectation: next,
        closedBy: keeper.isOrder ? 'service_request.created' : 'plan.extracted',
      });
    }
  }
  return closed;
}
