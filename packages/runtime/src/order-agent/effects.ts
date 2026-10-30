import {
  appointmentFhirId,
  type ClinicalReviewAgent,
  type ClinicId,
  type Clock,
  createClinicalReviewer,
  type EngineOutcome,
  type FollowUpEngine,
  type IdGenerator,
  type IngestReport,
  type OrderAgentEffects,
  shadowPilotFlags,
} from '@follow-up-engine/core';
import {
  buildAgentAppointmentBundle,
  buildAgentResultBundle,
  type Bundle,
} from '@follow-up-engine/fhir';
import { IngestionService } from '../ingestion.ts';
import { patientRedactTerms } from '../redaction.ts';
import type { Storage } from '../storage.ts';

export interface OrderAgentEffectsDeps {
  readonly storage: Storage;
  readonly engine: FollowUpEngine;
  readonly ids: IdGenerator;
  /** The clinic's own clock (a lab clinic has its own). */
  readonly clockOf: (clinicId: ClinicId) => Clock;
  /** The live reviewer agent, and the scripted one (the agent's scripted mode never spends). */
  readonly reviewAgents: {
    readonly live: ClinicalReviewAgent;
    readonly scripted: ClinicalReviewAgent;
  };
}

function outcomeOf(resource: string, reports: readonly IngestReport[]): EngineOutcome {
  return {
    resource,
    closed: reports.flatMap((report) =>
      report.expectationsClosed.map((closed) => ({
        expectationId: closed.expectation.id,
        reason: closed.expectation.closedReason ?? closed.closedBy,
      })),
    ),
    created: reports.flatMap((report) =>
      report.expectationsCreated.map((created) => ({
        expectationId: created.id,
        ruleId: created.ruleId,
      })),
    ),
  };
}

/**
 * The engine side of the order agent: every write goes through the same
 * FHIR ingestion as `POST /fhir` (validation, mapping, the annotator), so
 * the engine alone decides what a booking or a result fulfills. The
 * clinical reviewer runs on the clinic's own clock, findings in the
 * clinic's flag modes (a lab clinic gets the shadow pilot's flags).
 */
export function createOrderAgentEffects(deps: OrderAgentEffectsDeps): OrderAgentEffects {
  async function ingest(clinicId: ClinicId, bundle: Bundle): Promise<readonly IngestReport[]> {
    const ingestion = new IngestionService({
      storage: deps.storage,
      engine: deps.engine,
      clock: deps.clockOf(clinicId),
    });
    const acceptance = await ingestion.accept(clinicId, bundle, 'sync');
    if (!acceptance.ok) {
      throw new Error('The engine refused the agent bundle (FHIR validation)');
    }
    return acceptance.reports ?? [];
  }

  return {
    async bookVisit(clinicId, input) {
      const id = appointmentFhirId(input.appointmentId);
      const reports = await ingest(
        clinicId,
        buildAgentAppointmentBundle({
          appointmentId: id,
          patientId: input.patientId,
          start: input.slot.start,
          end: input.slot.end,
          practitionerName: input.slot.resourceName,
          location: input.slot.location,
          bookedAt: input.bookedAt,
          ...(input.originCaseId === undefined ? {} : { originCaseId: input.originCaseId }),
        }),
      );
      return outcomeOf(`Appointment/${id}`, reports);
    },

    async submitResult(clinicId, input) {
      const bundle = buildAgentResultBundle({
        observationId: input.observationId,
        patientId: input.patientId,
        code: input.code,
        value: input.value,
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        ...(input.referenceLow === undefined ? {} : { referenceLow: input.referenceLow }),
        ...(input.referenceHigh === undefined ? {} : { referenceHigh: input.referenceHigh }),
        ...(input.interpretation === undefined ? {} : { interpretation: input.interpretation }),
        effectiveAt: input.effectiveAt,
        receivedAt: input.receivedAt,
      });
      const observation = bundle.entry?.[0]?.resource;
      const reports = await ingest(clinicId, bundle);
      return outcomeOf(`Observation/${observation?.id ?? input.observationId}`, reports);
    },

    async requestClinicalReview(clinicId, patientId, mode, language) {
      const clock = deps.clockOf(clinicId);
      // A clinic with no reviewer categories configured gets the shadow pilot's (never live).
      await deps.storage.unitOfWork.withTransaction(clinicId, async (stores) => {
        if ((await stores.findingFlags.list(clinicId)).length > 0) return;
        for (const flag of shadowPilotFlags(clinicId, 'order-agent', clock.now())) {
          await stores.findingFlags.upsert(clinicId, flag);
        }
      });
      const reviewer = createClinicalReviewer({
        unitOfWork: deps.storage.unitOfWork,
        clock,
        ids: deps.ids,
        agent: mode === 'live' ? deps.reviewAgents.live : deps.reviewAgents.scripted,
        redactTermsOf: patientRedactTerms,
        loadCatalog: (id) => deps.engine.catalog(id),
        localeOf: () => language,
      });
      const report = await reviewer.reviewPatient(clinicId, patientId, 'result.received');
      return {
        runId: report.run.id,
        status: report.run.status,
        findings: report.findings.map((finding) => ({
          id: finding.id,
          category: finding.category,
        })),
      };
    },
  };
}
