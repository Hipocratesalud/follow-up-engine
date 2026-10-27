import {
  type FindingCategory,
  type FindingFlag,
  type FindingMode,
  IMPLEMENTED_FINDING_CATEGORIES,
} from '../../domain/clinical-finding.ts';
import { ValidationError } from '../../domain/errors.ts';
import type { ClinicId } from '../../domain/ids.ts';
import type { CategoryGate } from './pipeline.ts';

/** The flag in force for a category and specialty: the specialty's own, else the clinic-wide one. */
export function resolveFlag(
  flags: readonly FindingFlag[],
  category: FindingCategory,
  specialty: string | undefined,
): FindingFlag | undefined {
  const own =
    specialty === undefined
      ? undefined
      : flags.find((flag) => flag.category === category && flag.specialty === specialty);
  return own ?? flags.find((flag) => flag.category === category && flag.specialty === undefined);
}

/** `undefined` when the category is off for that specialty; else where its findings go. */
export function modeOf(
  flags: readonly FindingFlag[],
  category: FindingCategory,
  specialty: string | undefined,
): FindingMode | undefined {
  if (!(IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(category)) return undefined;
  const flag = resolveFlag(flags, category, specialty);
  if (flag?.enabled !== true) return undefined;
  // Defense in depth: a live flag without a sign-off is treated as shadow.
  return flag.mode === 'live' && flag.validatedBy !== undefined ? 'live' : 'shadow';
}

export function categoryGate(flags: readonly FindingFlag[]): CategoryGate {
  return (category, specialty) => modeOf(flags, category, specialty) !== undefined;
}

/** Whether any category is on for the clinic (any specialty). */
export function anyEnabled(flags: readonly FindingFlag[]): boolean {
  return flags.some(
    (flag) =>
      flag.enabled && (IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(flag.category),
  );
}

export interface FlagUpdate {
  readonly category: FindingCategory;
  readonly specialty?: string;
  readonly enabled: boolean;
  readonly mode: FindingMode;
  /** Host user id of the clinician signing off the category: required to go `live`. */
  readonly validatedBy?: string;
}

/**
 * Applies an update to a flag (PRD: every category starts off and in
 * shadow; it goes live only with the clinical team's sign-off).
 * `similar_patients` is reserved and cannot be enabled. Going back to
 * shadow keeps the earlier sign-off on record.
 */
export function applyFlagUpdate(
  clinicId: ClinicId,
  current: FindingFlag | undefined,
  update: FlagUpdate,
  userId: string,
  now: Date,
): FindingFlag {
  if (!(IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(update.category)) {
    if (update.enabled) {
      throw new ValidationError(
        'category',
        `${update.category} is reserved: it is not implemented and cannot be enabled`,
      );
    }
  }
  if (update.mode === 'live' && (update.validatedBy ?? current?.validatedBy) === undefined) {
    throw new ValidationError(
      'validatedBy',
      'A category goes live only with the clinical sign-off of who validated it',
    );
  }
  const goingLive = update.mode === 'live' && current?.mode !== 'live';
  const validatedBy = update.validatedBy ?? current?.validatedBy;
  const validatedAt = update.validatedBy !== undefined || goingLive ? now : current?.validatedAt;
  return {
    clinicId,
    category: update.category,
    ...(update.specialty === undefined ? {} : { specialty: update.specialty }),
    enabled: update.enabled,
    mode: update.mode,
    ...(validatedBy === undefined ? {} : { validatedBy }),
    ...(validatedAt === undefined ? {} : { validatedAt }),
    updatedBy: userId,
    updatedAt: now,
  };
}

/** Every implemented category on, in shadow (how a clinic starts its shadow pilot, and the demo). */
export function shadowPilotFlags(clinicId: ClinicId, userId: string, now: Date): FindingFlag[] {
  return IMPLEMENTED_FINDING_CATEGORIES.map((category) => ({
    clinicId,
    category,
    enabled: true,
    mode: 'shadow',
    updatedBy: userId,
    updatedAt: now,
  }));
}
