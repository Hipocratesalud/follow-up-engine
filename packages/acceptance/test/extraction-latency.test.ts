import { clinicId, type NoteExtraction, type NoteExtractor } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { ingestBundle, memoryHarness } from '../src/harness.ts';

/**
 * How long reading a note took is the model call's wall time, as the
 * extractor measured it: the engine's clock is simulated in the demo, so
 * timing the call with it reported 0 ms for a 6 s Muse Spark reading.
 */
describe('note reading latency', () => {
  const reading: NoteExtraction = {
    hasPlan: false,
    conditions: [],
    medications: [],
    planItems: [],
    model: 'muse-spark-1.3',
    promptVersion: 'note-extraction@5',
    costUsd: 0.005,
    latencyMs: 4_321,
  };
  const timed: NoteExtractor = { extract: () => Promise.resolve(reading) };
  const untimed: NoteExtractor = {
    extract: () =>
      Promise.resolve({
        hasPlan: false,
        conditions: [],
        medications: [],
        planItems: [],
        model: reading.model,
        promptVersion: reading.promptVersion,
        costUsd: reading.costUsd,
      }),
  };
  const bundle = buildConsultationBundle({
    consultationId: 'latency-1',
    patient: { id: 'pat-latency', name: 'Paciente Sintética' },
    specialty: 'diabetology',
    occurredAt: dayToDate(0),
    noteText: 'Control de DM2. Plan: control en 3 meses.',
  });

  it('is the latency the extractor reports, on a fake clock', async () => {
    const harness = memoryHarness({
      clinicId: clinicId('clinic-latency'),
      start: dayToDate(0),
      extractor: timed,
    });
    const [report] = await ingestBundle(harness, bundle, dayToDate(0));
    expect(report?.notes[0]).toMatchObject({ status: 'extracted', latencyMs: 4_321 });
  });

  it('falls back to the engine clock when the extractor reports none', async () => {
    const harness = memoryHarness({
      clinicId: clinicId('clinic-latency'),
      start: dayToDate(0),
      extractor: untimed,
    });
    const [report] = await ingestBundle(harness, bundle, dayToDate(0));
    expect(report?.notes[0]).toMatchObject({ status: 'extracted', latencyMs: 0 });
  });
});
