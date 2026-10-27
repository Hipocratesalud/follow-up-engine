import { randomUUID } from 'node:crypto';
import type { IdGenerator, IdKind } from '@follow-up-engine/core';

const PREFIXES: Readonly<Record<IdKind, string>> = {
  expectation: 'exp',
  case: 'case',
  feedback: 'fb',
  domain_event: 'evt',
  finding: 'qf',
  clinical_finding: 'cf',
  review_run: 'rr',
};

/** Deterministic ids (`case-1`, `exp-2`, ...) for tests and reproducible demos. */
export class SequentialIdGenerator implements IdGenerator {
  readonly #counters = new Map<IdKind, number>();

  next(kind: IdKind): string {
    const value = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, value);
    return `${PREFIXES[kind]}-${String(value)}`;
  }
}

/** Random UUID v4 ids for production. */
export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
