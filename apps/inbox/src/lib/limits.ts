/**
 * Input limits of the API (`apps/api/src/http/schemas.ts`). The inputs carry
 * them as `maxLength`, so the team sees the limit while typing instead of a
 * rejected request; a click still validates before sending.
 */
export const INPUT_LIMITS = {
  /** Internal note of a case action. */
  note: 2000,
  /** Comment of a "No útil" verdict. */
  comment: 2000,
  /** Patient search box of the inbox. */
  search: 100,
  /** Name of a new patient in the demo. */
  patientName: 120,
  /** Note of a demo consultation. */
  noteText: 20_000,
} as const;

/** "2000", "20.000": a limit as the team reads it. */
export function formatLimit(limit: number): string {
  return limit.toLocaleString('es');
}
