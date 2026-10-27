import { firstDate } from '../../support/datetime.ts';
import { SNOMED_NO_KNOWN_ALLERGY, TERMINOLOGY } from '../../terminology.ts';
import {
  conceptLabel,
  hasCode,
  pickCoding,
  withdrawal,
  type EntryContext,
  type MappedResource,
} from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';

const REFUTED_CODES = ['refuted'] as const;
const IN_ERROR_CODES = ['entered-in-error'] as const;
const INACTIVE_CODES = ['inactive', 'resolved'] as const;

/**
 * AllergyIntolerance → `allergy.recorded`: the patient's allergy status is on
 * record, a substance (SNOMED CT, RxNorm or text) or an explicit "no known
 * allergy" (`noKnownAllergy`). Refuted or entered in error →
 * `record.withdrawn`. Inactive or resolved: no event. Nothing is expected
 * from an allergy; the clinical reviewer reads it.
 */
export function mapAllergyIntolerance(
  allergy: ParsedResourceOf<'AllergyIntolerance'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(allergy.patient, 'patient', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(allergy.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  const verification = allergy.verificationStatus;
  if (hasCode(verification, REFUTED_CODES, TERMINOLOGY.allergyVerification)) {
    return withdrawal(ctx, scope, 'refuted', allergy.meta?.lastUpdated);
  }
  if (hasCode(verification, IN_ERROR_CODES, TERMINOLOGY.allergyVerification)) {
    return withdrawal(ctx, scope, 'entered_in_error', allergy.meta?.lastUpdated);
  }
  if (hasCode(allergy.clinicalStatus, INACTIVE_CODES, TERMINOLOGY.allergyClinical)) {
    ctx.report(
      'information',
      'informational',
      'inactive or resolved AllergyIntolerance produces no event',
      'clinicalStatus',
    );
    return { ...scope, events: [] };
  }
  const coding = pickCoding(allergy.code, [TERMINOLOGY.snomed]);
  const label = conceptLabel(allergy.code);
  if (coding === undefined && label === undefined) {
    ctx.report(
      'warning',
      'required',
      'AllergyIntolerance has no code; it produces no event',
      'code',
    );
    return { ...scope, events: [] };
  }
  const noKnownAllergy =
    coding?.system === TERMINOLOGY.snomed && SNOMED_NO_KNOWN_ALLERGY.has(coding.code);
  return {
    ...scope,
    events: [
      {
        ...ctx.base(
          'allergy.recorded',
          firstDate(allergy.recordedDate, allergy.onsetDateTime, allergy.meta?.lastUpdated),
        ),
        ...(coding === undefined ? {} : { code: coding }),
        ...(label === undefined ? {} : { text: label }),
        noKnownAllergy,
        ...(allergy.category === undefined ? {} : { category: allergy.category }),
        ...(allergy.criticality === undefined ? {} : { criticality: allergy.criticality }),
      },
    ],
  };
}
