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
      allowUnmaskedImagesToProvider: false,
      dailyCaseCapPerOwner: 20,
      backfillNotifyMaxAgeDays: 730,
      llmMonthlyBudgetUsd: 50,
      timezone: 'America/Caracas',
      locale: 'es-VE',
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

    it('summarizes calls since a date, in total and per provider and model', async () => {
      const { a } = freshClinics();
      await log().record(aCall(a, { costUsd: 9, at: at(-40) }));
      await log().record(aCall(a, { model: 'muse-spark', provider: 'meta', costUsd: 0.25 }));
      await log().record(aCall(a, { model: 'muse-spark', provider: 'meta', costUsd: 0.5 }));
      await log().record(
        aCall(a, { model: 'muse-spark', provider: 'meta', costUsd: 0.125, ok: false, error: 'x' }),
      );
      await log().record(aCall(a, { model: 'fake-model', provider: 'fake', costUsd: 0.0625 }));
      const summary = await log().summary(a, at(-30));
      expect(summary).toMatchObject({ calls: 4, successfulCalls: 3 });
      expect(summary.costUsd).toBeCloseTo(0.9375, 10);
      expect(
        summary.byModel.map(({ provider, model, calls }) => ({ provider, model, calls })),
      ).toEqual([
        { provider: 'meta', model: 'muse-spark', calls: 3 },
        { provider: 'fake', model: 'fake-model', calls: 1 },
      ]);
      expect(summary.byModel[0]?.costUsd).toBeCloseTo(0.875, 10);
      expect(await log().summary(freshClinics().a, at(-30))).toEqual({
        calls: 0,
        successfulCalls: 0,
        costUsd: 0,
        byModel: [],
      });
    });

    it('summarizes one task when asked (notes read vs clinical reviews)', async () => {
      const { a } = freshClinics();
      await log().record(aCall(a, { task: 'note_extraction', costUsd: 0.5 }));
      await log().record(aCall(a, { task: 'clinical_review', costUsd: 0.25 }));
      await log().record(aCall(a, { task: 'clinical_review', costUsd: 0.125 }));
      expect(await log().summary(a, at(-30), { task: 'clinical_review' })).toMatchObject({
        calls: 2,
        successfulCalls: 2,
        costUsd: 0.375,
      });
      expect((await log().summary(a, at(-30), { task: 'note_extraction' })).calls).toBe(1);
      expect((await log().summary(a, at(-30))).calls).toBe(3);
    });

    it('lists every call since a date, oldest first, with model, tokens and cost', async () => {
      const { a, b } = freshClinics();
      await log().record(aCall(a, { callId: 'call-old', at: at(-40) }));
      await log().record(
        aCall(a, {
          callId: 'call-2',
          model: 'muse-spark-1.3',
          provider: 'meta',
          inputTokens: 1200,
          outputTokens: 340,
          costUsd: 0.0049,
          at: at(-1),
        }),
      );
      await log().record(
        aCall(a, { callId: 'call-1', task: 'order_agent', ok: false, error: 'x', at: at(-2) }),
      );
      await log().record(aCall(b, { callId: 'call-b', at: at(-1) }));
      const calls = await log().calls(a, at(-30));
      expect(calls.map((call) => call.callId)).toEqual(['call-1', 'call-2']);
      expect(calls[0]).toMatchObject({ task: 'order_agent', ok: false, error: 'x' });
      expect(calls[1]).toMatchObject({
        clinicId: a,
        provider: 'meta',
        model: 'muse-spark-1.3',
        inputTokens: 1200,
        outputTokens: 340,
      });
      expect(calls[1]?.costUsd).toBeCloseTo(0.0049, 10);
      expect(calls[1]?.at.toISOString()).toBe(at(-1).toISOString());
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
