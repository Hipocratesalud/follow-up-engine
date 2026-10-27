/** Whether something came from live traffic or from the initial backfill of history. */
export type Origin = 'live' | 'backfill';

/**
 * Why something exists, in two forms: a stable machine code for logic and
 * analytics, and a human-readable label shown in the clinic UI (neutral
 * Spanish, for example `Resultado de laboratorio pendiente`).
 */
export interface Reason {
  readonly code: string;
  readonly label: string;
}

/** A verbatim quote from a clinical document that supports a finding. */
export interface Evidence {
  readonly quote: string;
  readonly sourceDocumentId: string;
}
