import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  FOLLOW_UP_OPT_OUT_CONSENT_CODE,
} from '../../terminology.ts';
import { firstDate } from '../../support/datetime.ts';
import { hasCode, type EntryContext, type MappedResource } from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';

/**
 * Patient → `patient.opted_out` when it carries the engine's opt-out extension
 * with `valueBoolean: true`. A Patient without it is context only (no event).
 */
export function mapPatient(
  patient: ParsedResourceOf<'Patient'>,
  ctx: EntryContext,
): MappedResource {
  const optedOut = (patient.extension ?? []).some(
    (extension) =>
      extension.url === ENGINE_EXTENSIONS.followUpOptOut && extension.valueBoolean === true,
  );
  return {
    patientId: ctx.entry.ref.id,
    events: optedOut ? [ctx.base('patient.opted_out', firstDate(patient.meta?.lastUpdated))] : [],
  };
}

/**
 * Consent → `patient.opted_out` for an active `deny` Consent whose category
 * is the engine's follow-up opt-out code.
 */
export function mapConsent(
  consent: ParsedResourceOf<'Consent'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(consent.patient, 'patient', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const isOptOut =
    consent.status === 'active' &&
    consent.provision?.type === 'deny' &&
    consent.category.some((category) =>
      hasCode(category, [FOLLOW_UP_OPT_OUT_CONSENT_CODE], ENGINE_CODE_SYSTEMS.consent),
    );
  if (!isOptOut) {
    ctx.report(
      'information',
      'informational',
      'Consent is not an active follow-up opt-out; no event',
    );
  }
  return {
    patientId: patient.id,
    events: isOptOut ? [ctx.base('patient.opted_out', firstDate(consent.dateTime))] : [],
  };
}
