import type {
  Coding,
  RecordWithdrawalReason,
  ResourceRef,
  ResultInterpretation,
  ResultReceivedEvent,
  ResultSeverity,
} from '@follow-up-engine/core';
import { TERMINOLOGY } from '../../terminology.ts';
import { firstDate } from '../../support/datetime.ts';
import {
  hasCode,
  pickCoding,
  withdrawal,
  type ConceptInput,
  type EntryContext,
  type MappedResource,
} from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';
import { orderCoding } from './orders.ts';

/** Statuses at which a result counts as received. */
const RESULT_STATUSES: readonly string[] = ['final', 'amended', 'corrected', 'appended'];

/** Result statuses that withdraw a result sent before: what it fulfilled is open again. */
const WITHDRAWN_RESULT_STATUSES: Readonly<Record<string, RecordWithdrawalReason>> = {
  cancelled: 'cancelled',
  'entered-in-error': 'entered_in_error',
};

/** v3 ObservationInterpretation codes read as abnormal (high, low, critical, abnormal). */
const ABNORMAL_CODES = ['A', 'AA', 'H', 'HH', 'HU', 'L', 'LL', 'LU'] as const;
const NORMAL_CODES = ['N'] as const;
/** v3 ObservationInterpretation codes of a critical (panic) value. */
const CRITICAL_CODES = ['AA', 'HH', 'LL'] as const;
/** Wording of a critical value in an interpretation's text or display. */
const CRITICAL_WORDING = /\b(?:critic[oa]|critical|panic|panico)\b/;

function readsCritical(label: string): boolean {
  return CRITICAL_WORDING.test(
    label
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase(),
  );
}

/**
 * Severity of an abnormal result: `critical` when an interpretation is a v3
 * critical code (`AA`, `HH`, `LL`) or reads critical / panic, else `mild`.
 * `undefined` when the result is not abnormal.
 */
export function severityOf(
  interpretations: readonly ConceptInput[] | undefined,
): ResultSeverity | undefined {
  const all = interpretations ?? [];
  if (all.some(isCritical)) {
    return 'critical';
  }
  return interpretationOf(all) === 'abnormal' ? 'mild' : undefined;
}

/** A v3 critical code, or an interpretation that reads critical / panic. */
function isCritical(concept: ConceptInput): boolean {
  return (
    hasCode(concept, CRITICAL_CODES, TERMINOLOGY.observationInterpretation) ||
    [concept.text, ...(concept.coding ?? []).map((coding) => coding.display ?? coding.code)].some(
      (label) => label !== undefined && readsCritical(label),
    )
  );
}

/** The worst severity of several results. */
function worstSeverity(
  severities: readonly (ResultSeverity | undefined)[],
): ResultSeverity | undefined {
  if (severities.includes('critical')) {
    return 'critical';
  }
  return severities.includes('mild') ? 'mild' : undefined;
}

/** Interpretation of an Observation from its v3 ObservationInterpretation codes (a critical value is abnormal). */
export function interpretationOf(
  interpretations: readonly ConceptInput[] | undefined,
): ResultInterpretation {
  const all = interpretations ?? [];
  const system = TERMINOLOGY.observationInterpretation;
  if (all.some((concept) => hasCode(concept, ABNORMAL_CODES, system) || isCritical(concept))) {
    return 'abnormal';
  }
  if (all.some((concept) => hasCode(concept, NORMAL_CODES, system))) {
    return 'normal';
  }
  return 'unknown';
}

/** The numeric value of an Observation (`valueQuantity`), with its unit (`unit`, else the UCUM `code`). */
export function quantityValue(
  observation: ParsedResourceOf<'Observation'>,
): ResultReceivedEvent['value'] {
  const quantity = observation.valueQuantity;
  if (quantity?.value === undefined) {
    return undefined;
  }
  const unit = quantity.unit ?? quantity.code;
  return unit === undefined ? { value: quantity.value } : { value: quantity.value, unit };
}

function sameCode(left: Coding, right: Coding): boolean {
  return left.system === right.system && left.code === right.code;
}

/** Worst interpretation wins: any abnormal → abnormal; all normal → normal; else unknown. */
function combine(interpretations: readonly ResultInterpretation[]): ResultInterpretation {
  if (interpretations.includes('abnormal')) {
    return 'abnormal';
  }
  return interpretations.length > 0 && interpretations.every((i) => i === 'normal')
    ? 'normal'
    : 'unknown';
}

function orderIdFrom(
  basedOn: readonly { readonly reference?: string | undefined }[] | undefined,
  ctx: EntryContext,
): string | undefined {
  for (const [index, reference] of (basedOn ?? []).entries()) {
    const target = ctx.follow(reference, `basedOn[${String(index)}]`, ['ServiceRequest'], false);
    if (target !== undefined) {
      return target.id;
    }
  }
  return undefined;
}

/** DiagnosticReports in the bundle that list `observation` among their results. */
function parentReports(
  observation: ResourceRef,
  ctx: EntryContext,
): ParsedResourceOf<'DiagnosticReport'>[] {
  return ctx.bundle.entries.flatMap((entry) => {
    const report = entry.parsed;
    if (report?.resourceType !== 'DiagnosticReport') {
      return [];
    }
    const lists = (report.result ?? []).some((result) => {
      const target =
        result.reference === undefined ? undefined : ctx.bundle.resolve(result.reference);
      return target?.resourceType === observation.resourceType && target.id === observation.id;
    });
    return lists ? [report] : [];
  });
}

function optionalSeverity(severity: ResultSeverity | undefined): {
  readonly severity?: ResultSeverity;
} {
  return severity === undefined ? {} : { severity };
}

/**
 * A report entered in error (or cancelled) withdraws itself and the
 * Observations it lists: the report's status applies to it as a whole, so
 * its results no longer stand even when the host does not re-send each one
 * (what they fulfilled is open again).
 */
function withdrawReport(
  report: ParsedResourceOf<'DiagnosticReport'>,
  ctx: EntryContext,
  scope: { readonly patientId: string; readonly encounterId?: string },
  reason: RecordWithdrawalReason,
): MappedResource {
  const own = withdrawal(ctx, scope, reason, report.meta?.lastUpdated);
  const [event] = own.events;
  if (event === undefined) {
    return own;
  }
  const members = (report.result ?? []).flatMap((result) => {
    const target =
      result.reference === undefined ? undefined : ctx.bundle.resolve(result.reference);
    return target?.resourceType === 'Observation' ? [target] : [];
  });
  return {
    ...own,
    events: [
      event,
      ...members.map((member) => ({
        ...event,
        source: { resourceType: member.resourceType, id: member.id },
        idempotencyKey: `${event.idempotencyKey}:${member.resourceType}/${member.id}`,
      })),
    ],
  };
}

/**
 * DiagnosticReport (final) → `result.received`. Its interpretation combines
 * the Observations it lists that are in the same bundle; the references it
 * lists are kept (`listedResults`), so a later withdrawal of the report
 * withdraws them even when it comes without its `result` list.
 */
export function mapDiagnosticReport(
  report: ParsedResourceOf<'DiagnosticReport'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(report.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(report.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  const withdrawn = WITHDRAWN_RESULT_STATUSES[report.status];
  if (withdrawn !== undefined) {
    return withdrawReport(report, ctx, scope, withdrawn);
  }
  if (!RESULT_STATUSES.includes(report.status)) {
    ctx.report(
      'information',
      'informational',
      `DiagnosticReport status "${report.status}" produces no event (needs final)`,
      'status',
    );
    return { ...scope, events: [] };
  }
  const code = orderCoding(report.code, ctx, 'code');
  if (code === undefined) {
    return undefined;
  }
  const members = (report.result ?? []).flatMap((result) => {
    const target =
      result.reference === undefined ? undefined : ctx.bundle.resolve(result.reference);
    const observation = target === undefined ? undefined : ctx.bundle.parsed('Observation', target);
    return observation === undefined ? [] : [observation];
  });
  // A report of a single test (HbA1c) carries the value of its member of the same code.
  const valued = members.filter((observation) => {
    const memberCode = pickCoding(observation.code, [TERMINOLOGY.loinc]);
    return memberCode !== undefined && sameCode(memberCode, code) && quantityValue(observation);
  });
  const value =
    valued.length === 1 && valued[0] !== undefined ? quantityValue(valued[0]) : undefined;
  const orderId = orderIdFrom(report.basedOn, ctx);
  // Kept with the report, so withdrawing it later reaches them without the list.
  const listedResults = (report.result ?? []).flatMap((result) => {
    const target =
      result.reference === undefined ? undefined : ctx.bundle.resolve(result.reference);
    return target?.resourceType === 'Observation'
      ? [{ resourceType: target.resourceType, id: target.id }]
      : [];
  });
  return {
    ...scope,
    events: [
      {
        ...ctx.base(
          'result.received',
          firstDate(
            report.issued,
            report.effectiveDateTime,
            report.effectivePeriod?.end,
            report.effectivePeriod?.start,
          ),
        ),
        code,
        interpretation: combine(
          members.map((observation) => interpretationOf(observation.interpretation)),
        ),
        ...optionalSeverity(
          worstSeverity(members.map((observation) => severityOf(observation.interpretation))),
        ),
        ...(orderId === undefined ? {} : { basedOnOrderId: orderId }),
        ...(value === undefined ? {} : { value }),
        ...(listedResults.length === 0 ? {} : { listedResults }),
      },
    ],
  };
}

/**
 * Observation (final) → `result.received`. Without its own `basedOn`, it
 * inherits the order of the DiagnosticReport that lists it.
 */
export function mapObservation(
  observation: ParsedResourceOf<'Observation'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(observation.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(observation.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  const withdrawn = WITHDRAWN_RESULT_STATUSES[observation.status];
  if (withdrawn !== undefined) {
    return withdrawal(ctx, scope, withdrawn, observation.meta?.lastUpdated);
  }
  if (!RESULT_STATUSES.includes(observation.status)) {
    ctx.report(
      'information',
      'informational',
      `Observation status "${observation.status}" produces no event (needs final)`,
      'status',
    );
    return { ...scope, events: [] };
  }
  const code = orderCoding(observation.code, ctx, 'code');
  if (code === undefined) {
    return undefined;
  }
  const orderId =
    orderIdFrom(observation.basedOn, ctx) ??
    parentReports(ctx.entry.ref, ctx)
      .flatMap((report) => report.basedOn ?? [])
      .map((reference) =>
        reference.reference === undefined ? undefined : ctx.bundle.resolve(reference.reference),
      )
      .find((target) => target?.resourceType === 'ServiceRequest')?.id;
  const value = quantityValue(observation);
  // A date result: the estimated delivery date, the last menstrual period.
  const valueDate = firstDate(observation.valueDateTime);
  return {
    ...scope,
    events: [
      {
        ...ctx.base(
          'result.received',
          firstDate(
            observation.issued,
            observation.effectiveDateTime,
            observation.effectiveInstant,
            observation.effectivePeriod?.end,
            observation.effectivePeriod?.start,
          ),
        ),
        code,
        interpretation: interpretationOf(observation.interpretation),
        ...optionalSeverity(severityOf(observation.interpretation)),
        ...(orderId === undefined ? {} : { basedOnOrderId: orderId }),
        ...(value === undefined ? {} : { value }),
        ...(valueDate === undefined ? {} : { valueDate }),
      },
    ],
  };
}
