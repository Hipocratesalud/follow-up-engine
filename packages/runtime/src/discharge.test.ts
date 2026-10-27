import { type ClinicId, type Expectation, patientId } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { createRuntime, type EngineRuntime } from './runtime.ts';
import { Worker } from './worker.ts';

/*
 * A discharge travels end to end through the extractor the runtime wires
 * (gateway, provider, post-processing, patient redaction): the model's
 * `discharge` (with its quote) becomes the engine's `discharged` plan flag,
 * and the cadence layer stops expecting the patient back.
 */

const CLINIC = 'clinic-demo' as ClinicId;
const PATIENT = 'p-discharge';
const START = new Date('2026-01-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function dayToDate(day: number): Date {
  return new Date(START.getTime() + day * DAY_MS);
}

function session(id: string, day: number, noteText: string): unknown {
  return buildConsultationBundle({
    consultationId: id,
    patient: { id: PATIENT, name: 'Paciente Sintética' },
    specialty: 'psychology',
    occurredAt: dayToDate(day),
    noteText,
  });
}

function liveCadence(expectations: readonly Expectation[]): Expectation[] {
  return expectations.filter(
    (expectation) =>
      expectation.ruleId === 'cadence_break' &&
      (expectation.status === 'open' || expectation.status === 'expired'),
  );
}

describe('discharge through the runtime extractor', () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  async function lastSession(noteText: string): Promise<readonly Expectation[]> {
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        FAKE_CLOCK_START: START.toISOString(),
        LLM_PROVIDER: 'fake',
        LOG_LEVEL: 'silent',
        DEMO_API_KEY: 'demo-key',
      }),
    );
    const worker = new Worker(runtime);
    const clock = runtime.fakeClock;
    if (clock === undefined) {
      throw new Error('expected a fake clock');
    }
    const visits: readonly (readonly [string, number, string])[] = [
      ['psy-a', 0, 'Sesión de seguimiento. Trabajamos ansiedad.'],
      ['psy-b', 7, 'Sesión de seguimiento. Trabajamos ansiedad.'],
      ['psy-c', 14, 'Sesión de seguimiento. Trabajamos ansiedad.'],
      ['psy-d', 21, noteText],
    ];
    for (const [id, day, text] of visits) {
      clock.set(dayToDate(day));
      await runtime.ingestion.accept(CLINIC, session(id, day, text), 'async');
      await worker.runJobs();
    }
    clock.set(dayToDate(120));
    await worker.runSweeps([CLINIC]);
    return runtime.storage.stores.expectations.listByPatient(CLINIC, patientId(PATIENT));
  }

  it('without a discharge, the visit pattern expects the patient back', async () => {
    const expectations = await lastSession('Sesión de seguimiento. Trabajamos ansiedad.');
    expect(liveCadence(expectations)).toHaveLength(1);
  });

  it('"Se da de alta" in a psychology note cancels the visit pattern', async () => {
    const expectations = await lastSession('Se revisan logros del proceso. Se da de alta.');
    expect(liveCadence(expectations)).toEqual([]);
  });
});
