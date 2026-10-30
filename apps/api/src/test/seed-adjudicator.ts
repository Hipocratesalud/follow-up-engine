import {
  ACTIVE_CASE_STATUSES,
  type ClinicId,
  type PatientId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { DEMO_CLINIC, type EngineRuntime, Worker } from '@follow-up-engine/runtime';

/*
 * The adjudicator's shadow pilot on the demo clinic (PRD V2, workstream E):
 * the backfill reads the clinic's history without queuing decisions (only a
 * new consultation does), so the seed decides the ambiguous plan items of
 * the patients the inbox shows first, the way a clinic switching the
 * adjudicator on would run it once over its open items. Shadow mode: the
 * decisions are shown next to each item, nothing is suppressed. While the
 * demo seeds, a Muse Spark runtime answers with the scripted adjudicator
 * (labeled `fake`), so seeding never spends.
 */

/** Decisions the seed makes at most (the inbox's first patients). */
export const SEED_ADJUDICATIONS = 12;

const MS_PER_DAY = 86_400_000;

/**
 * Three fictional consultations written ambiguously on purpose (a
 * conditional plan, a possibility, an item already done), seven weeks
 * before the demo's "today": their plan items are overdue, so they open
 * cases the inbox shows with the adjudicator's decision. Synthetic people
 * and notes only.
 */
const AMBIGUOUS_CONSULTATIONS = [
  {
    patient: { id: 'pat-adj-01', name: 'Rosa Elena Márquez', gender: 'female' as const },
    specialty: 'internal_medicine',
    noteText:
      'Lumbalgia mecánica de 3 semanas, mejora parcial con AINES. Sin déficit neurológico.\n' +
      'Plan: control en 4 semanas, a valorar radiografía lumbar si persiste el dolor.',
  },
  {
    patient: { id: 'pat-adj-02', name: 'Julio César Pineda', gender: 'male' as const },
    specialty: 'internal_medicine',
    noteText:
      'HTA en tratamiento con losartán 50 mg, TA 128/82. Refiere buena adherencia.\n' +
      'Plan: continuar igual tratamiento. Perfil lipídico en 6 semanas, eventualmente, a discutir con el paciente.',
  },
  {
    patient: { id: 'pat-adj-03', name: 'Carmen Lucía Rondón', gender: 'female' as const },
    specialty: 'internal_medicine',
    noteText:
      'Prediabetes, glicemia en ayunas 104 mg/dL. Plan: dieta y ejercicio.\n' +
      'La HbA1c en 6 semanas que pidió endocrinología ya se realizó y salió normal.',
  },
] as const;

/** Ingests the ambiguous consultations (once) and opens their cases. */
async function ingestAmbiguousConsultations(
  runtime: EngineRuntime,
  clinicId: ClinicId,
): Promise<PatientId[]> {
  const occurredAt = new Date(runtime.clock.now().getTime() - 50 * MS_PER_DAY);
  const ids: PatientId[] = [];
  for (const consultation of AMBIGUOUS_CONSULTATIONS) {
    const bundle = buildConsultationBundle({
      consultationId: `c-${consultation.patient.id}`,
      patient: consultation.patient,
      specialty: consultation.specialty,
      occurredAt,
      noteText: consultation.noteText,
    });
    await runtime.ingestion.accept(clinicId, bundle, 'sync');
    ids.push(toPatientId(consultation.patient.id));
  }
  // Their items are overdue: the watcher opens their cases before the decisions.
  await new Worker(runtime).runSweeps([clinicId]);
  return ids;
}

export interface AdjudicatorSeedReport {
  readonly decided: number;
  readonly byDecision: Readonly<Record<string, number>>;
  readonly ms: number;
}

export async function seedAdjudicatorPilot(
  runtime: EngineRuntime,
  options: { readonly limit?: number } = {},
): Promise<AdjudicatorSeedReport> {
  const started = performance.now();
  const clinicId = DEMO_CLINIC.id as ClinicId;
  // Seeding again is a no-op: the pilot ran once already.
  if ((await runtime.adjudicator.list(clinicId, { limit: 1 })).length > 0) {
    return { decided: 0, byDecision: {}, ms: Math.round(performance.now() - started) };
  }
  const ambiguous = await ingestAmbiguousConsultations(runtime, clinicId);
  const now = runtime.clock.now();
  // The ambiguous consultations, then the inbox's patients, most urgent first; then the rest.
  const page = await runtime.storage.stores.cases.list(clinicId, {
    statuses: ACTIVE_CASE_STATUSES,
    releasedAsOf: now,
    limit: 200,
  });
  const patientIds = [...new Set([...ambiguous, ...page.items.map((item) => item.patientId)])];
  const limit = options.limit ?? SEED_ADJUDICATIONS;
  const decided = [
    ...(await runtime.adjudicator.adjudicatePending(clinicId, { patientIds, limit })),
  ];
  if (decided.length < limit) {
    decided.push(
      ...(await runtime.adjudicator.adjudicatePending(clinicId, { limit: limit - decided.length })),
    );
  }
  const byDecision: Record<string, number> = {};
  for (const item of decided) byDecision[item.decision] = (byDecision[item.decision] ?? 0) + 1;
  return { decided: decided.length, byDecision, ms: Math.round(performance.now() - started) };
}
