import { randomUUID } from 'node:crypto';
import { type ClinicId, clinicId } from '@follow-up-engine/core';
import { afterEach, beforeEach, expect } from 'vitest';

/** What a contract suite needs from the adapter under test. */
export interface ContractSubject<TSubject> {
  readonly subject: TSubject;
  /** Releases resources (connections, temp schemas). Called after every test. */
  readonly cleanup: () => Promise<void>;
}

export type MakeSubject<TSubject> = () => Promise<ContractSubject<TSubject>>;

/**
 * Creates a fresh subject before each test and cleans it up after. Returns
 * a getter for the current subject.
 */
export function useSubject<TSubject>(
  makeSubject: () => Promise<{ readonly cleanup: () => Promise<void> } & TSubject>,
): () => TSubject {
  let current: ({ readonly cleanup: () => Promise<void> } & TSubject) | undefined;
  beforeEach(async () => {
    current = await makeSubject();
  });
  afterEach(async () => {
    await current?.cleanup();
    current = undefined;
  });
  return () => {
    if (!current) throw new Error('contract subject used outside a test');
    return current;
  };
}

/**
 * Two fresh tenants per test. Ids are unique per run so the suites also work
 * against a persistent database that is not truncated between tests.
 */
export function freshClinics(): { readonly a: ClinicId; readonly b: ClinicId } {
  const suffix = randomUUID().slice(0, 8);
  return { a: clinicId(`contract-a-${suffix}`), b: clinicId(`contract-b-${suffix}`) };
}

/** A unique id with a readable prefix. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Asserts the promise rejects with an error whose `name` is `errorName` (works across module copies). */
export async function expectRejectsWithName(
  promise: Promise<unknown>,
  errorName: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: errorName });
}

export const T0 = new Date('2026-01-05T12:00:00.000Z');

/** `T0` plus `days` (fractional allowed). */
export function at(days: number): Date {
  return new Date(T0.getTime() + days * 86_400_000);
}
