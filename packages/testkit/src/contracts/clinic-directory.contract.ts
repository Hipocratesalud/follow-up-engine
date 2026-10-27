import { createHash } from 'node:crypto';
import {
  type Clinic,
  type ClinicDirectory,
  type ClinicId,
  clinicId,
  type LlmCallRecord,
  type LlmUsageLog,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { at, freshClinics, uniqueId, useSubject } from './harness.ts';

/** A clinic to seed the directory with, plus the hash of its API key. */
export interface ClinicSeed {
  readonly clinic: Clinic;
  readonly apiKeyHash: string;
}

/** sha256 hex, the way the API hashes a presented key before looking it up. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function aClinic(id: ClinicId, overrides: Partial<Clinic> = {}): Clinic {
  return {
    id,
    name: `Clínica ${id}`,
    active: true,
    settings: {
      allowPatientContact: false,
      dailyCaseCapPerOwner: 20,
      backfillNotifyMaxAgeDays: 730,
      llmMonthlyBudgetUsd: 50,
      timezone: 'America/Caracas',
    },
    ...overrides,
  };
}

/**
 * Contract every {@link ClinicDirectory} adapter must pass. The directory is
 * read-only, so `makeSubject` receives the clinics to seed it with.
 */
export function describeClinicDirectoryContract(
  name: string,
  makeSubject: (
    seed: readonly ClinicSeed[],
  ) => Promise<{ readonly subject: ClinicDirectory; readonly cleanup: () => Promise<void> }>,
): void {
  describe(`ClinicDirectory contract: ${name}`, () => {
    const ids = freshClinics();
    const inactiveId = clinicId(uniqueId('contract-inactive'));
    const seed: readonly ClinicSeed[] = [
      {
        clinic: aClinic(ids.a, {
          settings: { ...aClinic(ids.a).settings, allowPatientContact: true },
        }),
        apiKeyHash: hashApiKey(`key-${ids.a}`),
      },
      { clinic: aClinic(ids.b, { name: 'Clínica B' }), apiKeyHash: hashApiKey(`key-${ids.b}`) },
      {
        clinic: aClinic(inactiveId, { active: false }),
        apiKeyHash: hashApiKey(`key-${inactiveId}`),
      },
    ];
    const current = useSubject(() => makeSubject(seed));
    const directory = () => current().subject;

    it('lists only active clinics', async () => {
      const active = (await directory().listActive()).map((c) => c.id);
      expect(active).toEqual(expect.arrayContaining([ids.a, ids.b]));
      expect(active).not.toContain(inactiveId);
    });

    it('gets a clinic with its settings, undefined when unknown', async () => {
      expect(await directory().get(ids.a)).toEqual(seed[0]?.clinic);
      expect(await directory().get(clinicId(uniqueId('nope')))).toBeUndefined();
    });

    it('resolves an API key hash to its own clinic only', async () => {
      expect((await directory().findByApiKeyHash(hashApiKey(`key-${ids.a}`)))?.id).toBe(ids.a);
      expect((await directory().findByApiKeyHash(hashApiKey(`key-${ids.b}`)))?.id).toBe(ids.b);
      expect(await directory().findByApiKeyHash(hashApiKey('unknown-key'))).toBeUndefined();
    });
  });
}

function aCall(clinic: ClinicId, overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    callId: uniqueId('call'),
    clinicId: clinic,
    task: 'plan_extraction',
    promptVersion: 'plan-v1',
    provider: 'fake',
    model: 'fake-model',
    inputTokens: 800,
    outputTokens: 200,
    costUsd: 0.0012,
    latencyMs: 640,
    ok: true,
    at: at(0),
    ...overrides,
  };
}

/** Contract every {@link LlmUsageLog} adapter must pass. */
export function describeLlmUsageLogContract(
  name: string,
  makeSubject: () => Promise<{
    readonly subject: LlmUsageLog;
    readonly cleanup: () => Promise<void>;
  }>,
): void {
  describe(`LlmUsageLog contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const log = () => current().subject;

    it('is zero for a clinic without calls', async () => {
      const { a } = freshClinics();
      expect(await log().totalCostUsd(a, at(-30))).toBe(0);
    });

    it('sums the cost of calls at or after `since`, failed calls included', async () => {
      const { a } = freshClinics();
      await log().record(aCall(a, { costUsd: 0.5, at: at(-40) }));
      await log().record(aCall(a, { costUsd: 0.25, at: at(-30) }));
      await log().record(aCall(a, { costUsd: 0.125, at: at(-1) }));
      await log().record(aCall(a, { costUsd: 0.0625, ok: false, error: 'timeout', at: at(0) }));
      expect(await log().totalCostUsd(a, at(-30))).toBeCloseTo(0.4375, 10);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      await log().record(aCall(a, { costUsd: 1 }));
      await log().record(aCall(b, { costUsd: 2 }));
      expect(await log().totalCostUsd(a, at(-1))).toBeCloseTo(1, 10);
      expect(await log().totalCostUsd(b, at(-1))).toBeCloseTo(2, 10);
    });
  });
}
