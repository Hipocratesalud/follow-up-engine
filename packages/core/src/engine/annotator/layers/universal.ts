import {
  DEFAULT_CRITICAL_RESULT_DUE_IN_DAYS,
  type ResultTarget,
  type Rule,
} from '../../../config/rule.ts';
import type { ClinicalEvent, ResultReceivedEvent } from '../../../domain/clinical-event.ts';
import type { PatientCondition } from '../../../domain/condition.ts';
import type { Expectation } from '../../../domain/expectation.ts';
import type { Catalog, ExpectationDefinition } from '../../catalog.ts';
import { matchesFilter } from '../../matching/filter.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
import { resultValueAs } from '../../terminology/loinc.ts';
import { codeOfEvent } from '../../matching/correlation.ts';
import { addDays } from '../../support/time.ts';
import { encounterOf, eventInstant, type PatientTimeline, refKey } from '../../timeline.ts';

const MS_PER_DAY = 86_400_000;
import { icd10Matches } from '../conditions.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';
import { expectsTreatmentControl } from '../treatment.ts';

/** A critical (panic) result: acted on within `criticalDueInDays`, ranked above everything. */
function isCritical(event: ClinicalEvent): boolean {
  return event.type === 'result.received' && event.severity === 'critical';
}

function dueAtFor(rule: Rule, event: ClinicalEvent): Date | undefined {
  if (isCritical(event)) {
    return addDays(
      event.occurredAt,
      Math.min(rule.dueInDays, rule.criticalDueInDays ?? DEFAULT_CRITICAL_RESULT_DUE_IN_DAYS),
    );
  }
  if (rule.dueFrom === 'treatment_end') {
    if (event.type !== 'medication.prescribed' || event.durationDays === undefined) {
      return undefined;
    }
    return addDays(event.startAt, event.durationDays + rule.dueInDays);
  }
  if (rule.dueFrom === 'recommended_follow_up' && event.type === 'result.received') {
    return addDays(event.occurredAt, event.recommendedFollowUpDays ?? rule.dueInDays);
  }
  return addDays(event.occurredAt, rule.dueInDays);
}

function draftFor(
  rule: Rule,
  definition: ExpectationDefinition,
  event: ClinicalEvent,
): ExpectationDraft | undefined {
  const dueAt = dueAtFor(rule, event);
  if (dueAt === undefined) {
    return undefined;
  }
  return {
    definition,
    source: event.source,
    matchKey: matchKeyFor(definition.expects ?? 'follow_up_visit', codeOfEvent(event)),
    dueAt,
    idempotencyKey: expectationIdempotencyKey(event.source, rule.id),
    ...(isCritical(event) ? { severity: 'critical' as const } : {}),
  };
}

/** Something the doctor's plan asks for, and by when. */
export interface PlannedItem {
  readonly matchKey: string;
  readonly dueAt: Date;
}

/**
 * What the doctor's plan asks for at this point: the live doctor's-plan
 * expectations plus the plan drafts of the batch being annotated.
 */
export function plannedItems(
  live: readonly Expectation[],
  drafts: readonly ExpectationDraft[],
): PlannedItem[] {
  return [
    ...live.filter((expectation) => expectation.layer === 'doctor_plan'),
    ...drafts.filter((draft) => draft.definition.layer === 'doctor_plan'),
  ].map((item) => ({ matchKey: item.matchKey, dueAt: item.dueAt }));
}

/**
 * Whether the doctor's plan already asks for what `draft` would, due after
 * the trigger and no later than the draft (same day included): see
 * `Rule.coveredByPlan`.
 */
export function coveredByPlannedItem(
  draft: Pick<ExpectationDraft, 'matchKey' | 'dueAt'>,
  trigger: ClinicalEvent,
  planned: readonly PlannedItem[],
): boolean {
  const triggeredAt = eventInstant(trigger).getTime();
  const latest = draft.dueAt.getTime() + MS_PER_DAY;
  return planned.some(
    (item) =>
      item.matchKey === draft.matchKey &&
      item.dueAt.getTime() >= triggeredAt &&
      item.dueAt.getTime() < latest,
  );
}

/**
 * A result at the target of a condition the patient was already known to
 * have (HbA1c 6.8 % in a known diabetic): not actionable, whatever the lab
 * flag says. A condition inferred from this very batch's results does not
 * count: a first high HbA1c is a new finding.
 */
function atKnownTarget(
  targets: readonly ResultTarget[] | undefined,
  event: ResultReceivedEvent,
  conditions: readonly PatientCondition[],
  batch: readonly ClinicalEvent[],
): boolean {
  if (targets === undefined || event.value === undefined) {
    return false;
  }
  const batchResults = new Set(
    batch.flatMap((other) => (other.type === 'result.received' ? [refKey(other.source)] : [])),
  );
  const known = conditions.filter(
    (condition) =>
      (condition.status === 'confirmed' || condition.status === 'probable') &&
      !(
        condition.sourceType === 'inferred_from_result' &&
        batchResults.has(refKey(condition.source))
      ),
  );
  // The value read as the target's code and unit: an IFCC HbA1c in mmol/mol
  // is compared with the % target after conversion.
  return targets.some((target) => {
    const value = resultValueAs(target.code, event);
    return (
      value !== undefined &&
      known.some((condition) => icd10Matches(condition.code, target.conditionCodes)) &&
      matchesFilter({ value: target.atTarget }, { value })
    );
  });
}

/** Whether `event` triggers `rule`, its clinical criteria included. */
function triggers(rule: Rule, event: ClinicalEvent, input: UniversalInput): boolean {
  if (event.type !== rule.trigger.event || !matchesFilter(rule.trigger.filter, event)) {
    return false;
  }
  if (event.type === 'medication.prescribed') {
    return expectsTreatmentControl(rule, event, input.timeline);
  }
  if (event.type === 'result.received') {
    return !atKnownTarget(rule.resultTargets, event, input.conditions, input.events);
  }
  return true;
}

export interface UniversalInput {
  /** The batch, in clinical order. */
  readonly events: readonly ClinicalEvent[];
  readonly catalog: Catalog;
  /** The patient's record, the batch included. */
  readonly timeline: PatientTimeline;
  /** The patient's conditions after this batch. */
  readonly conditions: readonly PatientCondition[];
  /** What the doctor's plan asks for (live expectations and this batch's plan). */
  readonly planned: readonly PlannedItem[];
}

/**
 * Universal layer: deterministic rules over structured data, no LLM. An
 * order expects its result, a short treatment expects a control visit, an
 * abnormal result expects a consultation.
 *
 * - Within one batch, a rule asking for the same thing by the same date is
 *   one expectation: an abnormal report and its abnormal observations expect
 *   one consultation, not one each. The first source in batch order anchors it.
 * - A treatment rule expects one control per consultation, when the longest
 *   short treatment ends; as-needed drugs, chronic drug classes and
 *   treatments whose note makes the return conditional expect none.
 * - A result at the target of a known condition is not abnormal.
 * - A rule the doctor's plan already covers by then (`coveredByPlan`) adds
 *   nothing: the doctor's explicit plan beats the generic rule.
 */
export function universalDrafts(input: UniversalInput): ExpectationDraft[] {
  const drafts: ExpectationDraft[] = [];
  const seen = new Map<string, number>();
  for (const rule of input.catalog.rulesOfLayer('universal')) {
    const definition = input.catalog.definition(rule.id);
    if (definition === undefined) {
      continue;
    }
    for (const event of input.events) {
      if (!triggers(rule, event, input)) {
        continue;
      }
      const draft = draftFor(rule, definition, event);
      if (
        draft === undefined ||
        (rule.coveredByPlan === true && coveredByPlannedItem(draft, event, input.planned))
      ) {
        continue;
      }
      const key =
        rule.treatment === undefined
          ? `${rule.id}|${draft.matchKey}|${draft.dueAt.toISOString()}`
          : `${rule.id}|${encounterOf(event) ?? refKey(event.source)}`;
      const index = seen.get(key);
      if (index === undefined) {
        seen.set(key, drafts.length);
        drafts.push(draft);
      } else if (
        rule.treatment !== undefined &&
        draft.dueAt > (drafts[index]?.dueAt ?? draft.dueAt)
      ) {
        // One control per consultation, when its longest treatment ends.
        drafts[index] = draft;
      }
    }
  }
  return drafts;
}
