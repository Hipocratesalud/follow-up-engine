import { randomUUID } from 'node:crypto';
import { patientId as toPatientId } from '@follow-up-engine/core';
import { buildRecordBundle, type RecordEntryInput } from '@follow-up-engine/fhir';
import {
  ensureLabClinicAndClock,
  type EngineRuntime,
  labIngestion,
  LabClockRegistry,
} from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { HttpError, readJson } from './errors.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import { actorId } from './security.ts';
import { LabRecordAddSchema, type LabRecordEntry } from './lab-schemas.ts';
import type { App, AppEnv } from './context.ts';

/** A `YYYY-MM-DD` calendar day, read as noon UTC (never a timezone boundary issue). */
function dayAsDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

function recordEntry(entry: LabRecordEntry): RecordEntryInput {
  switch (entry.kind) {
    case 'order':
      return {
        kind: 'order',
        loinc: entry.loinc,
        display: entry.display,
        ...(entry.category === undefined ? {} : { category: entry.category }),
      };
    case 'result':
      return {
        kind: 'result',
        loinc: entry.loinc,
        display: entry.display,
        ...(entry.value === undefined ? {} : { value: entry.value }),
        ...(entry.unit === undefined ? {} : { unit: entry.unit }),
        ...(entry.interpretation === undefined ? {} : { interpretation: entry.interpretation }),
        ...(entry.basedOnOrderId === undefined ? {} : { basedOnOrderId: entry.basedOnOrderId }),
      };
    case 'prescription':
      return {
        kind: 'prescription',
        text: entry.text,
        ...(entry.durationDays === undefined ? {} : { durationDays: entry.durationDays }),
      };
    case 'visit':
      return { kind: 'visit' };
    case 'diagnosis':
      return {
        kind: 'diagnosis',
        icd10: entry.icd10,
        ...(entry.display === undefined ? {} : { display: entry.display }),
      };
    case 'appointment_booked':
      return {
        kind: 'appointment_booked',
        scheduledFor: dayAsDate(entry.scheduledFor),
        ...(entry.specialty === undefined ? {} : { specialty: entry.specialty }),
      };
    case 'appointment_cancelled':
      return {
        kind: 'appointment_cancelled',
        appointmentId: entry.appointmentId,
        scheduledFor: dayAsDate(entry.scheduledFor),
      };
  }
}

/** `lab_record_added` tracked with a label a human reviewing the activity log can read at a glance. */
function entrySummary(entry: LabRecordEntry): string {
  switch (entry.kind) {
    case 'order':
      return `order:${entry.loinc}`;
    case 'result':
      return `result:${entry.loinc}`;
    case 'prescription':
      return `prescription:${entry.text}`;
    case 'visit':
      return 'visit';
    case 'diagnosis':
      return `diagnosis:${entry.icd10}`;
    case 'appointment_booked':
      return `appointment_booked:${entry.scheduledFor}`;
    case 'appointment_cancelled':
      return `appointment_cancelled:${entry.appointmentId}`;
  }
}

function requireEvaluator(c: Context<AppEnv>): string {
  const email = c.var.evaluatorEmail;
  if (email === undefined) {
    throw new HttpError(403, 'lab_requires_evaluator', c.var.t.errors.insufficientScope('demo:ingest'));
  }
  return email;
}

/**
 * The evaluator lab's structured records (docs/deploy.md#hosted-demo): "Add
 * to the record" for a lab/imaging order, a result, a prescription, a
 * visit, a diagnosis or an appointment, each dated by the evaluator and
 * ingested with no note and no LLM call (`buildRecordBundle`). Registered
 * only on a fake clock, alongside the rest of `/api/demo/*`.
 */
export function registerLabRecordRoutes(
  app: App,
  runtime: EngineRuntime,
  labClocks: LabClockRegistry,
): void {
  app.post('/api/demo/lab/records', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const body = await readJson(c, LabRecordAddSchema);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const patientId = toPatientId(body.patientId);
    const occurredAt = dayAsDate(body.recordDate);
    if (occurredAt.getTime() > clock.now().getTime()) {
      throw new HttpError(422, 'lab_future_date', c.var.t.errors.invalidJson);
    }
    const bundle = buildRecordBundle({
      recordId: `lab-${randomUUID()}`,
      patient: { id: patientId },
      occurredAt,
      entry: recordEntry(body.entry),
    });
    const acceptance = await labIngestion(runtime, clock).accept(clinic.id, bundle, 'sync');
    if (!acceptance.ok) {
      throw new HttpError(422, 'invalid_record', c.var.t.errors.invalidConsultation);
    }
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const expectationsCreated = (acceptance.reports ?? []).flatMap((report) =>
      report.expectationsCreated.map((expectation) => ({
        id: expectation.id,
        ruleId: expectation.ruleId,
        ruleVersion: expectation.ruleVersion,
        layer: expectation.layer,
        label: presenter.reasonLabel(expectation.ruleId, expectation),
        dueAt: expectation.dueAt.toISOString(),
        status: expectation.status,
      })),
    );
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_record_added',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      payload: { kind: body.entry.kind, summary: entrySummary(body.entry), recordDate: body.recordDate },
    });
    c.var.log.info({ actor: actorId(c), kind: body.entry.kind }, 'lab record added');
    return c.json({ patientId, clinicId: clinic.id, expectationsCreated }, 201);
  });

  app.get('/api/demo/lab/patients/:id/expectations', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const patientId = toPatientId(c.req.param('id'));
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const expectations = await runtime.storage.stores.expectations.listByPatient(
      clinic.id,
      patientId,
    );
    return c.json({
      items: expectations.map((expectation) => ({
        id: expectation.id,
        ruleId: expectation.ruleId,
        ruleVersion: expectation.ruleVersion,
        layer: expectation.layer,
        label: presenter.reasonLabel(expectation.ruleId, expectation),
        status: expectation.status,
        dueAt: expectation.dueAt.toISOString(),
        ...(expectation.closedReason === undefined ? {} : { closedReason: expectation.closedReason }),
      })),
    });
  });
}
