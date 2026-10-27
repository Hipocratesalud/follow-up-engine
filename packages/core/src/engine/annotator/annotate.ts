import type { CaseEventActor } from '../../domain/case.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { type CaseId, type ClinicId, expectationId, type PatientId } from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, resolveCase, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import {
  findFulfillment,
  fulfillmentReason,
  supersedes,
  toCorrelationTarget,
} from '../matching/correlation.ts';
import { loadPatientState, type LiveExpectations, type PatientState } from '../patient-state.ts';
import type { EngineSettings } from '../settings.ts';
import type { PatientTimeline } from '../timeline.ts';
import { conditionCandidates, type ExtractedMedicationHint, mergeCondition } from './conditions.ts';
import { type ExpectationDraft, materializeExpectation } from './draft.ts';
import { cadenceDrafts } from './layers/cadence.ts';
import { doctorPlanDrafts } from './layers/doctor-plan.ts';
import { protocolDrafts } from './layers/protocol.ts';
import { universalDrafts } from './layers/universal.ts';

/** Everything one annotation run needs, bound to an open transaction. */
export interface AnnotationContext {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly stores: TransactionalStores;
  readonly catalog: Catalog;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly now: Date;
}

/** Side inputs that only exist when the batch came with a freshly read note. */
export interface AnnotationHints {
  /** Model confidence of note-extracted `condition.recorded` events, by idempotency key. */
  readonly extractedConfidence?: ReadonlyMap<string, number>;
  readonly extractedMedications?: readonly ExtractedMedicationHint[];
}

/** An expectation the run closed, and why. */
export interface ClosedExpectation {
  readonly expectation: Expectation;
  readonly closedBy: ClinicalEvent['type'] | 'patient.opted_out';
}

export interface AnnotationResult {
  readonly expectationsCreated: readonly Expectation[];
  readonly expectationsClosed: readonly ClosedExpectation[];
  readonly casesResolved: readonly CaseId[];
  readonly conditionsUpserted: readonly PatientCondition[];
  readonly optedOut: boolean;
}

/**
 * Applies a batch of clinical events to a patient, in the order the PRD
 * fixes: conditions → universal rules and doctor's plan → fulfillment and
 * supersession of what was already expected → cadence where no live plan
 * covers it → protocols fill only the gaps left → cases whose reasons all
 * closed are resolved.
 * Idempotent: the same events twice change nothing the second time.
 */
export async function annotate(
  context: AnnotationContext,
  events: readonly ClinicalEvent[],
  hints: AnnotationHints = {},
): Promise<AnnotationResult> {
  const state = await loadPatientState(context.stores, context.clinicId, context.patientId);
  const writer = new CaseWriter(context.stores, context.ids, context.clinicId);
  const ordered = [...events].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  );

  if (state.timeline.optedOut) {
    return optOut(context, state, writer);
  }

  const conditions = await upsertConditions(context, state, ordered, hints);
  const created: Expectation[] = [];
  const firstDrafts = [
    ...universalDrafts(ordered, context.catalog),
    ...doctorPlanDrafts(ordered, context.catalog, context.settings.minPlanItemConfidence),
  ];
  created.push(...(await createExpectations(context, state.live, firstDrafts)));

  const closed = await applyFulfillment(context, state.timeline, state.live, ordered);

  // The doctor's explicit plan beats the inferred visit pattern for what it
  // covers; checked after fulfillment, so a visit that fulfills the plan
  // brings the pattern back.
  const cadence = cadenceDrafts(ordered, state.timeline, context.catalog).filter(
    (draft) => !coveredByPlan(state.live, draft.matchKey),
  );
  created.push(...(await createExpectations(context, state.live, cadence)));

  const protocols = protocolDrafts({
    catalog: context.catalog,
    conditions: conditions.all,
    timeline: state.timeline,
    live: state.live.list(),
    now: context.now,
  });
  created.push(...(await createExpectations(context, state.live, protocols.drafts)));

  const casesResolved: CaseId[] = [];
  for (const { expectation } of closed) {
    if (expectation.caseId === undefined) {
      continue;
    }
    casesResolved.push(
      ...(await resolveSatisfiedCases({
        stores: context.stores,
        writer,
        clinicId: context.clinicId,
        caseIds: [expectation.caseId],
        actor: { type: 'rule', id: expectation.ruleId },
        now: context.now,
      })),
    );
  }

  return {
    expectationsCreated: created,
    expectationsClosed: closed,
    casesResolved,
    conditionsUpserted: conditions.upserted,
    optedOut: false,
  };
}

/** Whether a live doctor's-plan expectation already asks for the same thing. */
function coveredByPlan(live: LiveExpectations, matchKey: string): boolean {
  return live
    .list()
    .some(
      (expectation) => expectation.layer === 'doctor_plan' && expectation.matchKey === matchKey,
    );
}

async function upsertConditions(
  context: AnnotationContext,
  state: PatientState,
  events: readonly ClinicalEvent[],
  hints: AnnotationHints,
): Promise<{ readonly all: PatientCondition[]; readonly upserted: PatientCondition[] }> {
  const upserted: PatientCondition[] = [];
  const byKey = new Map(
    state.conditions.map((condition) => [
      `${condition.code.system}|${condition.code.code}`,
      condition,
    ]),
  );
  const candidates = conditionCandidates({
    events,
    protocols: context.catalog.protocols,
    existing: state.conditions,
    extractedConfidence: hints.extractedConfidence ?? new Map(),
    extractedMedications: hints.extractedMedications ?? [],
  });
  for (const candidate of candidates) {
    const key = `${candidate.code.system}|${candidate.code.code}`;
    const merged = mergeCondition(byKey.get(key), candidate, context);
    if (merged !== undefined) {
      await context.stores.conditions.upsert(context.clinicId, merged);
      byKey.set(key, merged);
      upserted.push(merged);
    }
  }
  return { all: [...byKey.values()], upserted };
}

async function createExpectations(
  context: AnnotationContext,
  live: LiveExpectations,
  drafts: readonly ExpectationDraft[],
): Promise<Expectation[]> {
  const created: Expectation[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.idempotencyKey)) {
      continue;
    }
    seen.add(draft.idempotencyKey);
    const candidate = materializeExpectation(draft, {
      id: expectationId(context.ids.next('expectation')),
      clinicId: context.clinicId,
      patientId: context.patientId,
      now: context.now,
      origin: 'live',
    });
    const result = await context.stores.expectations.upsertByIdempotencyKey(
      context.clinicId,
      candidate,
    );
    if (result.created) {
      created.push(result.expectation);
      live.put(result.expectation);
    }
  }
  return created;
}

/**
 * Closes live expectations the batch satisfies or replaces. Supersession is
 * checked first: a newer order of the same test retires the old expectation
 * (and its case) and starts a new clock through its own expectation.
 */
async function applyFulfillment(
  context: AnnotationContext,
  timeline: PatientTimeline,
  live: LiveExpectations,
  events: readonly ClinicalEvent[],
): Promise<ClosedExpectation[]> {
  const closed: ClosedExpectation[] = [];
  for (const event of events) {
    for (const expectation of live.list()) {
      const definition = context.catalog.definition(expectation.ruleId);
      if (definition === undefined) {
        continue;
      }
      const target = toCorrelationTarget(expectation, definition, timeline);
      let next: Expectation | undefined;
      if (supersedes(event, target, timeline)) {
        next = await closeExpectation(
          context.stores,
          expectation,
          'superseded',
          'superseded_by_new_order',
          context.now,
        );
      } else if (findFulfillment(event, target, timeline) !== undefined) {
        next = await closeExpectation(
          context.stores,
          expectation,
          'fulfilled',
          fulfillmentReason(event),
          context.now,
        );
      }
      if (next !== undefined) {
        live.put(next);
        closed.push({ expectation: next, closedBy: event.type });
      }
    }
  }
  return closed;
}

/**
 * The patient asked not to be followed up: every live expectation is
 * cancelled and every active case resolved as `patient_declined`, audited
 * with the patient as actor. Nothing new is created for them afterwards.
 */
async function optOut(
  context: AnnotationContext,
  state: PatientState,
  writer: CaseWriter,
): Promise<AnnotationResult> {
  const closed: ClosedExpectation[] = [];
  for (const expectation of state.live.list()) {
    const next = await closeExpectation(
      context.stores,
      expectation,
      'cancelled',
      'patient_opted_out',
      context.now,
    );
    closed.push({ expectation: next, closedBy: 'patient.opted_out' });
  }
  const actor: CaseEventActor = { type: 'patient', id: context.patientId };
  const casesResolved: CaseId[] = [];
  for (const followUpCase of state.activeCases) {
    await resolveCase(writer, followUpCase, { kind: 'patient_declined', actor, now: context.now });
    casesResolved.push(followUpCase.id);
  }
  return {
    expectationsCreated: [],
    expectationsClosed: closed,
    casesResolved,
    conditionsUpserted: [],
    optedOut: true,
  };
}
