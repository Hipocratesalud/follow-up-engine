import { ICD10_SYSTEM, type ConditionVerification } from '@follow-up-engine/core';
import { TERMINOLOGY } from '../../terminology.ts';
import { firstDate } from '../../support/datetime.ts';
import {
  hasCode,
  pickCoding,
  withdrawal,
  type EntryContext,
  type MappedResource,
} from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';

const PROVISIONAL_CODES = ['provisional', 'differential', 'unconfirmed'] as const;
const REFUTED_CODES = ['refuted'] as const;
const IN_ERROR_CODES = ['entered-in-error'] as const;
const INACTIVE_CODES = ['inactive', 'resolved', 'remission'] as const;

/**
 * Condition refuted or entered in error → `record.withdrawn`. Otherwise
 * Condition → `condition.recorded` with its ICD-10 code (ICD-10-CM codings are
 * accepted and reported under the ICD-10 system: the engine matches on the
 * category prefix). An absent verification status reads as confirmed: a
 * diagnosis a clinician records is the clinician's diagnosis.
 */
export function mapCondition(
  condition: ParsedResourceOf<'Condition'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(condition.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(condition.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  const noEvent = (message: string, path: string): MappedResource => {
    ctx.report('information', 'informational', message, path);
    return { ...scope, events: [] };
  };
  const verification = condition.verificationStatus;
  // A refuted diagnosis, or one entered in error, withdraws what its earlier
  // version enrolled (the protocol expectations of the condition it recorded).
  if (hasCode(verification, REFUTED_CODES, TERMINOLOGY.conditionVerification)) {
    return withdrawal(ctx, scope, 'refuted', condition.meta?.lastUpdated);
  }
  if (hasCode(verification, IN_ERROR_CODES, TERMINOLOGY.conditionVerification)) {
    return withdrawal(ctx, scope, 'entered_in_error', condition.meta?.lastUpdated);
  }
  if (hasCode(condition.clinicalStatus, INACTIVE_CODES, TERMINOLOGY.conditionClinical)) {
    return noEvent('inactive or resolved Condition produces no event', 'clinicalStatus');
  }
  const icd = pickCoding(condition.code, [TERMINOLOGY.icd10, TERMINOLOGY.icd10cm]);
  if (icd?.system !== TERMINOLOGY.icd10 && icd?.system !== TERMINOLOGY.icd10cm) {
    ctx.report(
      'warning',
      'code-invalid',
      'Condition has no ICD-10 coding; it produces no event',
      'code',
    );
    return { ...scope, events: [] };
  }
  const status: ConditionVerification = hasCode(
    verification,
    PROVISIONAL_CODES,
    TERMINOLOGY.conditionVerification,
  )
    ? 'provisional'
    : 'confirmed';
  return {
    ...scope,
    events: [
      {
        ...ctx.base(
          'condition.recorded',
          firstDate(condition.recordedDate, condition.onsetDateTime),
        ),
        code: { ...icd, system: ICD10_SYSTEM },
        verification: status,
      },
    ],
  };
}
