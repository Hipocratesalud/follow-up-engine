import type { ResourceRef, ResultInterpretation } from '@follow-up-engine/core';
import { TERMINOLOGY } from '../../terminology.ts';
import { firstDate } from '../../support/datetime.ts';
import { hasCode, type ConceptInput, type EntryContext, type MappedResource } from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';
import { orderCoding } from './orders.ts';

/** Statuses at which a result counts as received. */
const RESULT_STATUSES: readonly string[] = ['final', 'amended', 'corrected', 'appended'];

/** v3 ObservationInterpretation codes read as abnormal (high, low, critical, abnormal). */
const ABNORMAL_CODES = ['A', 'AA', 'H', 'HH', 'HU', 'L', 'LL', 'LU'] as const;
const NORMAL_CODES = ['N'] as const;

/** Interpretation of an Observation from its v3 ObservationInterpretation codes. */
export function interpretationOf(
  interpretations: readonly ConceptInput[] | undefined,
): ResultInterpretation {
  const all = interpretations ?? [];
  const system = TERMINOLOGY.observationInterpretation;
  if (all.some((concept) => hasCode(concept, ABNORMAL_CODES, system))) {
    return 'abnormal';
  }
  if (all.some((concept) => hasCode(concept, NORMAL_CODES, system))) {
    return 'normal';
  }
  return 'unknown';
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

/**
 * DiagnosticReport (final) → `result.received`. Its interpretation combines
 * the Observations it lists that are in the same bundle.
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
    return observation === undefined ? [] : [interpretationOf(observation.interpretation)];
  });
  const orderId = orderIdFrom(report.basedOn, ctx);
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
        interpretation: combine(members),
        ...(orderId === undefined ? {} : { basedOnOrderId: orderId }),
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
        ...(orderId === undefined ? {} : { basedOnOrderId: orderId }),
      },
    ],
  };
}
