import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  FOLLOW_UP_OPT_OUT_CONSENT_CODE,
} from '../../terminology.ts';
import { firstDate } from '../../support/datetime.ts';
import { hasCode, type EntryContext, type EventDraft, type MappedResource } from '../context.ts';
import { languageOfConcept } from '../language.ts';
import type { ParsedResourceOf } from '../schemas.ts';

/**
 * The patient's preferred language: the `preferred` communication first,
 * else the first one whose language is a BCP-47 tag. Reports a warning when
 * the Patient lists languages and none of them is a tag.
 */
function preferredLanguage(
  patient: ParsedResourceOf<'Patient'>,
  ctx: EntryContext,
): string | undefined {
  const communication = patient.communication ?? [];
  const ordered = [
    ...communication.filter((item) => item.preferred === true),
    ...communication.filter((item) => item.preferred !== true),
  ];
  for (const item of ordered) {
    const tag = languageOfConcept(item.language);
    if (tag !== undefined) return tag;
  }
  if (communication.length > 0) {
    ctx.report(
      'warning',
      'code-invalid',
      'no communication.language is a BCP-47 tag (urn:ietf:bcp:47); the language is ignored',
      'communication',
    );
  }
  return undefined;
}

/**
 * Patient → `patient.opted_out` when it carries the engine's opt-out extension
 * with `valueBoolean: true`, and `patient.language_recorded` when it lists
 * `communication` (its preferred language, forwarded on contact requests; an
 * empty list clears it). A Patient with neither is context only (no event).
 */
export function mapPatient(
  patient: ParsedResourceOf<'Patient'>,
  ctx: EntryContext,
): MappedResource {
  const optedOut = (patient.extension ?? []).some(
    (extension) =>
      extension.url === ENGINE_EXTENSIONS.followUpOptOut && extension.valueBoolean === true,
  );
  const updatedAt = firstDate(patient.meta?.lastUpdated);
  const events: EventDraft[] = optedOut ? [ctx.base('patient.opted_out', updatedAt)] : [];
  if (patient.communication !== undefined) {
    const language = preferredLanguage(patient, ctx);
    events.push({
      ...ctx.base('patient.language_recorded', updatedAt),
      ...(language === undefined ? {} : { language }),
    });
  }
  return { patientId: ctx.entry.ref.id, events };
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
