import { randomUUID } from 'node:crypto';
import {
  type ClinicId,
  type Clock,
  type OrderAgentLanguage,
  type OrderAgentMode,
  type PatientId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import { buildConsultationBundle, buildRecordBundle, type Bundle } from '@follow-up-engine/fhir';
import { IngestionService } from '../ingestion.ts';
import type { EngineRuntime } from '../runtime.ts';

/**
 * The demo story (docs/agent/order-to-completion.md#demo-story): María, a
 * synthetic patient with type 2 diabetes. At her last visit (August 2025)
 * the doctor ordered an HbA1c and a control in three months; she never
 * came back. Previous HbA1c 6.6 % then 7.1 %. The sample photo she sends
 * later is dated 2025-12-29 (HbA1c 8.4 %), so the story's dates are fixed
 * around it (a lab clinic's clock starts on or after 2026-01-05).
 */
export const MARIA = {
  name: 'María Fernanda Rojas',
  gender: 'female',
  birthDate: '1967-04-12',
  diagnosedAt: '2024-11-20',
  results: [
    { at: '2024-12-10', value: 6.6 },
    { at: '2025-08-05', value: 7.1 },
  ],
  visitAt: '2025-08-12',
  note:
    'Control de DM2. Paciente de 58 años en tratamiento con metformina 850 mg cada 12 horas, refiere buena adherencia. ' +
    'HbA1c 7,1 % (previa 6,6 %). Glicemia en ayunas 138 mg/dL. Sin hipoglicemias. ' +
    'Plan: continuar metformina, reforzar dieta. Control en 3 meses con HbA1c.',
} as const;

export const ORDER_AGENT_STORIES = ['maria'] as const;
export type OrderAgentStory = (typeof ORDER_AGENT_STORIES)[number];

function day(value: string): Date {
  return new Date(`${value}T13:00:00Z`);
}

/**
 * Seeds María in a clinic (a new patient id each time, so a story can be
 * replayed), lets the engine read the note (the configured model, or the
 * rule-based reader on the fake provider), runs the deadline watcher on the
 * clinic's clock (the overdue orders become a case) and hands the open
 * orders to the agent.
 */
export async function startOrderAgentStory(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  clock: Clock,
  options: { readonly mode: OrderAgentMode; readonly language: OrderAgentLanguage },
): Promise<{ readonly patientId: PatientId }> {
  const patientId = toPatientId(`pat-agent-maria-${randomUUID().slice(0, 6)}`);
  const ingestion = new IngestionService({
    storage: runtime.storage,
    engine: runtime.engine,
    clock,
  });
  const accept = async (bundle: Bundle): Promise<void> => {
    const acceptance = await ingestion.accept(clinicId, bundle, 'sync');
    if (!acceptance.ok) throw new Error('The story bundle was refused');
  };
  await accept(
    buildRecordBundle({
      recordId: `${patientId}-dx`,
      patient: {
        id: patientId,
        name: MARIA.name,
        gender: MARIA.gender,
        birthDate: MARIA.birthDate,
      },
      occurredAt: day(MARIA.diagnosedAt),
      entry: { kind: 'diagnosis', icd10: 'E11.9', display: 'Diabetes mellitus tipo 2' },
    }),
  );
  for (const [index, result] of MARIA.results.entries()) {
    await accept(
      buildRecordBundle({
        recordId: `${patientId}-hba1c-${String(index)}`,
        patient: { id: patientId },
        occurredAt: day(result.at),
        entry: {
          kind: 'result',
          loinc: '4548-4',
          display: 'HbA1c',
          value: result.value,
          unit: '%',
        },
      }),
    );
  }
  await accept(
    buildConsultationBundle({
      consultationId: `${patientId}-visit`,
      patient: { id: patientId },
      specialty: 'internal_medicine',
      occurredAt: day(MARIA.visitAt),
      noteText: MARIA.note,
      prescriptions: [{ text: 'Metformina 850 mg cada 12 horas' }],
    }),
  );
  const now = clock.now();
  await runtime.engine.runWatcher(clinicId, now);
  await runtime.orderAgent.takeOwnership(clinicId, patientId, options);
  return { patientId };
}
