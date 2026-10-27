/** Kinds of identifiers the engine mints. Adapters may use them as prefixes. */
export type IdKind = 'expectation' | 'case' | 'feedback' | 'domain_event' | 'finding';

/**
 * Mints unique identifiers. A port so the engine stays free of randomness:
 * production uses UUIDs, tests use a deterministic sequence.
 */
export interface IdGenerator {
  next(kind: IdKind): string;
}
