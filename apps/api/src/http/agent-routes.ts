import {
  type AgentConversationView,
  type AgentMessage,
  type AgentStep,
  type CaseId,
  type ClinicalFinding,
  ladderTimeline,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  type EngineRuntime,
  ensureLabClinicAndClock,
  InvalidLabDateError,
  ORDER_AGENT_STORIES,
  readSample,
  SAMPLE_FILES,
  setLabClinicDate,
  startOrderAgentStory,
} from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { z } from 'zod';
import { FindingPresenter } from '../inbox/reviewer-presenter.ts';
import type { App, AppEnv } from './context.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { HttpError, readJson } from './errors.ts';
import { requireEvaluator } from './lab-records-routes.ts';

/** Largest voice note or photo accepted from the simulated phone. */
export const MAX_AGENT_MEDIA_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);

export const AgentStoryStartSchema = z
  .object({
    story: z.enum(ORDER_AGENT_STORIES).default('maria'),
    mode: z.enum(['scripted', 'live']),
    language: z.enum(['en', 'es']),
  })
  .strict();

export const AgentTextMessageSchema = z
  .object({ text: z.string().trim().min(1).max(1_000) })
  .strict();
export const AgentSampleSchema = z
  .object({ sample: z.enum(['lab_report', 'voice_note']) })
  .strict();
export const AgentDeliverySchema = z
  .object({ status: z.enum(['delivered', 'read', 'undelivered']) })
  .strict();
export const AgentClockSchema = z.object({ days: z.number().int().min(1).max(60) }).strict();

function iso(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

function messageView(message: AgentMessage): Record<string, unknown> {
  return {
    id: message.id,
    direction: message.direction,
    kind: message.kind,
    text: message.text,
    at: message.at.toISOString(),
    ...(message.deliveryStatus === undefined ? {} : { deliveryStatus: message.deliveryStatus }),
    ...(message.offeredSlots === undefined
      ? {}
      : {
          offeredSlots: message.offeredSlots.map((slot) => ({
            id: slot.id,
            start: slot.start.toISOString(),
          })),
        }),
    ...(message.media === undefined
      ? {}
      : { media: { id: message.media.id, contentType: message.media.contentType } }),
    ...(message.transcript === undefined ? {} : { transcript: message.transcript }),
    ...(message.reading === undefined
      ? {}
      : {
          reading: {
            isLabReport: message.reading.isLabReport,
            tests: message.reading.tests.map((test) => ({ ...test })),
          },
        }),
    ...(message.rung === undefined ? {} : { rung: message.rung }),
    ...(message.proactive === undefined ? {} : { proactive: message.proactive }),
  };
}

function stepView(step: AgentStep): Record<string, unknown> {
  return {
    seq: step.seq,
    at: step.at.toISOString(),
    kind: step.kind,
    outcome: step.outcome,
    event: step.event,
    ...(step.runId === undefined ? {} : { runId: step.runId }),
    ...(step.tool === undefined ? {} : { tool: step.tool }),
    ...(step.arguments === undefined ? {} : { arguments: step.arguments }),
    ...(step.read === undefined ? {} : { read: step.read }),
    ...(step.reason === undefined ? {} : { reason: step.reason }),
    ...(step.params === undefined ? {} : { params: step.params }),
    ...(step.model === undefined ? {} : { model: step.model }),
    ...(step.costUsd === undefined ? {} : { costUsd: step.costUsd }),
    ...(step.latencyMs === undefined ? {} : { latencyMs: step.latencyMs }),
    ...(step.inputTokens === undefined ? {} : { inputTokens: step.inputTokens }),
    ...(step.outputTokens === undefined ? {} : { outputTokens: step.outputTokens }),
  };
}

/**
 * What the doctor reads first: a worsening result, then what to ask about it
 * at the visit; routine gaps (screenings, record quality) last, collapsed.
 */
const FINDING_ORDER = [
  'lab_trend',
  'abnormal_result_no_followup',
  'vital_trend',
  'pre_visit_question',
  'drug_interaction',
  'drug_condition_conflict',
  'unaddressed_symptom',
  'utilization_change',
  'missing_screening',
  'record_quality',
];
const ROUTINE_CATEGORIES: ReadonlySet<string> = new Set(['missing_screening', 'record_quality']);

function findingRank(finding: ClinicalFinding): number {
  const index = FINDING_ORDER.indexOf(finding.category);
  const rank = index === -1 ? FINDING_ORDER.length : index;
  // Among questions, the one about the result that just came in goes first.
  const aboutResult = finding.citations.some((citation) => /hba1c|a1c/i.test(citation.quote));
  return rank * 2 + (finding.category === 'pre_visit_question' && aboutResult ? 0 : 1);
}

function byPriority(left: ClinicalFinding, right: ClinicalFinding): number {
  return findingRank(left) - findingRank(right);
}

/** Whether the agent still has work queued or running for the patient (the console's "working" state). */
function isBusy(view: AgentConversationView): boolean {
  if (view.runs.some((run) => run.status === 'running')) return true;
  if (view.runs.length === 0 && view.conversation.status === 'active') return true;
  const lastInbound = view.messages.findLast((message) => message.direction === 'inbound');
  if (lastInbound === undefined) return false;
  if (view.conversation.status === 'opted_out') return false;
  return !view.runs.some((run) => run.inboundMessageId === lastInbound.id);
}

/**
 * What reached the doctor, first things first, each finding with its
 * citations (verbatim quote, source document, date) as the reviewer's
 * presenter builds them for "Before the visit".
 */
async function findingViews(
  c: Context<AppEnv>,
  clinicId: Parameters<EngineRuntime['reviewer']['listFindings']>[0],
  findings: readonly ClinicalFinding[],
  runtime: EngineRuntime,
): Promise<Record<string, unknown>[]> {
  const presenter = new FindingPresenter(runtime, clinicId, c.var.t);
  return Promise.all(
    [...findings].sort(byPriority).map(async (finding) => {
      const presented = await presenter.view(finding);
      return {
        id: finding.id,
        category: finding.category,
        severity: finding.severity,
        // The reviewer presenter's words: the reader's language once findings carry both.
        summary: presented.summary,
        suggestion: presented.suggestion,
        mode: finding.mode,
        modelId: finding.modelId,
        createdAt: finding.createdAt.toISOString(),
        routine: ROUTINE_CATEGORIES.has(finding.category),
        citations: presented.citations.map((citation) => ({
          docId: citation.docId,
          kind: citation.kind,
          quote: citation.quote,
          date: citation.date,
          title: citation.title,
        })),
      };
    }),
  );
}

/**
 * The order-to-completion agent's demo routes (docs/agent/order-to-completion.md),
 * inside each evaluator's lab clinic and on its own clock: start María's
 * story, write as the patient on the simulated phone (text, a voice note,
 * a photo), mark delivery statuses, fix a phone, jump the clock, and read
 * the conversation, the trace, the orders, staff tasks and what reached
 * the doctor. Registered only on a fake clock, like the rest of `/api/demo/*`.
 */
export function registerAgentRoutes(app: App, runtime: EngineRuntime): void {
  async function lab(c: Context<AppEnv>) {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(
      runtime,
      runtime.labClocks,
      evaluatorEmail,
    );
    return { evaluatorEmail, clinic, clock };
  }

  async function requireConversation(
    c: Context<AppEnv>,
    clinicId: Parameters<typeof runtime.orderAgent.view>[0],
    patientId: string,
  ) {
    const view = await runtime.orderAgent.view(clinicId, toPatientId(patientId));
    if (view === undefined) {
      throw new HttpError(404, 'agent_not_started', c.var.t.errors.agentNotStarted);
    }
    return view;
  }

  /** The whole page: the latest (or the given) patient's conversation, trace, orders, tasks and findings. */
  app.get('/api/demo/agent', async (c) => {
    const { clinic, clock } = await lab(c);
    const conversations = await runtime.orderAgent.listConversations(clinic.id);
    const requested = c.req.query('patientId');
    const target =
      requested === undefined
        ? conversations.at(-1)
        : conversations.find((item) => item.patientId === requested);
    const base = {
      now: clock.now().toISOString(),
      liveAvailable: runtime.liveAgent,
      model: `${runtime.extractor.provider}:${runtime.extractor.model}`,
      patients: conversations.map((item) => ({
        patientId: item.patientId,
        createdAt: item.createdAt.toISOString(),
        status: item.status,
      })),
    };
    if (target === undefined) return c.json({ ...base, conversation: null });
    const view = await requireConversation(c, clinic.id, target.patientId);
    /** What closed an order, in words a doctor reads: the visit's date, or the result's date and value. */
    const closedByDetail = async (
      reference: string | undefined,
    ): Promise<Record<string, unknown> | undefined> => {
      if (reference === undefined) return undefined;
      const [resourceType, id] = reference.split('/');
      if (resourceType === 'Appointment') {
        const appointment = view.appointments.find((item) => item.fhirAppointmentId === reference);
        return appointment === undefined
          ? undefined
          : { kind: 'appointment', at: appointment.slot.start.toISOString() };
      }
      if (resourceType !== 'Observation' || id === undefined) return undefined;
      const stored = await runtime.storage.stores.clinicalRecords.getResource(clinic.id, {
        resourceType: 'Observation',
        id,
      });
      const resource = stored?.resource as
        | {
            effectiveDateTime?: unknown;
            valueQuantity?: { value?: unknown; unit?: unknown };
            code?: { text?: unknown };
          }
        | undefined;
      const at = resource?.effectiveDateTime;
      if (typeof at !== 'string') return undefined;
      const value = resource?.valueQuantity?.value;
      const unit = resource?.valueQuantity?.unit;
      const test = resource?.code?.text;
      return {
        kind: 'result',
        at,
        ...(typeof value === 'number' ? { value } : {}),
        ...(typeof unit === 'string' ? { unit } : {}),
        ...(typeof test === 'string' ? { test } : {}),
      };
    };
    const findings = await runtime.reviewer.listFindings(clinic.id, {
      patientId: target.patientId,
      limit: 20,
    });
    const { conversation } = view;
    return c.json({
      ...base,
      conversation: {
        patientId: conversation.patientId,
        mode: conversation.mode,
        language: conversation.language,
        status: conversation.status,
        phoneStatus: conversation.phoneStatus,
        ...(conversation.retryAt === undefined ? {} : { retryAt: iso(conversation.retryAt) }),
        flagAtNextContact: conversation.flagAtNextContact === true,
        createdAt: conversation.createdAt.toISOString(),
        busy: isBusy(view),
        ladder: {
          track: conversation.ladder.track,
          anchorAt: conversation.ladder.anchorAt.toISOString(),
          rungs: ladderTimeline(conversation.ladder).map((item) => ({
            id: item.rung.id,
            action: item.rung.action,
            dueAt: item.dueAt.toISOString(),
            done: item.done,
          })),
        },
      },
      timeZone: view.timeZone,
      messages: view.messages.map(messageView),
      orders: (
        await Promise.all(
          view.orders.map(async (order) => ({
            order,
            detail: await closedByDetail(order.closedBy),
          })),
        )
      ).map(({ order, detail }) => ({
        orderId: order.orderId,
        kind: order.descriptor.kind,
        ...(order.descriptor.test === undefined ? {} : { test: order.descriptor.test }),
        source: order.descriptor.source,
        stage: order.stage,
        expectationStatus: order.expectationStatus,
        dueAt: order.dueAt.toISOString(),
        urgent: order.urgent,
        ...(order.closedBy === undefined ? {} : { closedBy: order.closedBy }),
        ...(order.closedAt === undefined ? {} : { closedAt: order.closedAt.toISOString() }),
        ...(detail === undefined ? {} : { closedByDetail: detail }),
        needsConfirmation: order.needsConfirmation,
        ...(order.doctorConfirmation === undefined
          ? {}
          : {
              doctorConfirmation: {
                by: order.doctorConfirmation.by,
                at: order.doctorConfirmation.at.toISOString(),
              },
            }),
      })),
      ignoredEngineItems: view.ignoredEngineItems,
      steps: view.steps.map(stepView),
      runs: view.runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        mode: run.mode,
        ...(run.model === undefined ? {} : { model: run.model }),
        startedAt: run.startedAt.toISOString(),
        modelCalls: run.modelCalls,
        toolCalls: run.toolCalls,
        costUsd: run.costUsd,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      })),
      tasks: view.tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        priority: task.priority,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        dueAt: task.dueAt.toISOString(),
        summary: {
          orders: task.summary.orders,
          outboundCount: task.summary.outboundCount,
          ...(task.summary.lastOutboundAt === undefined
            ? {}
            : { lastOutboundAt: task.summary.lastOutboundAt.toISOString() }),
          ...(task.summary.lastStatus === undefined ? {} : { lastStatus: task.summary.lastStatus }),
          replied: task.summary.replied,
          ask: task.summary.ask,
        },
      })),
      appointments: view.appointments.map((appointment) => ({
        id: appointment.id,
        start: appointment.slot.start.toISOString(),
        resourceKind: appointment.slot.resourceKind,
        resource: appointment.slot.resource,
        ...(appointment.fhirAppointmentId === undefined
          ? {}
          : { fhirAppointmentId: appointment.fhirAppointmentId }),
        ...(appointment.originCaseId === undefined
          ? {}
          : { originCaseId: appointment.originCaseId }),
      })),
      findings: await findingViews(c, clinic.id, findings.items, runtime),
    });
  });

  /**
   * One patient's whole run, for the evidence pack and its reviewers: the
   * agent's console trace (every model call with its model, tokens, cost and
   * gateway call id; every tool call with its arguments and outcome), the
   * clinic's LLM usage log rows (`llm_gateway`, one per provider call), the
   * conversation, staff tasks and bookings, and the engine's side: the
   * patient's expectations (status, what closed them), the clinical events
   * ingested (the agent's FHIR writes among them) and every case's audit
   * trail (actor `rule` / `system` / `patient` / `user`, never the agent).
   * Synthetic data only, like every lab clinic.
   */
  app.get('/api/demo/agent/patients/:id/export', async (c) => {
    const { clinic, clock } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    const patientId = view.conversation.patientId;
    const [llmCalls, findings, engine] = await Promise.all([
      runtime.storage.llmUsage.calls(clinic.id, new Date(0)),
      runtime.reviewer.listFindings(clinic.id, { patientId, limit: 50 }),
      runtime.storage.unitOfWork.withTransaction(clinic.id, async (stores) => {
        const [expectations, events] = await Promise.all([
          stores.expectations.listByPatient(clinic.id, patientId),
          stores.clinicalRecords.listEventsForPatient(clinic.id, patientId),
        ]);
        const caseIds = [
          ...new Set(
            expectations.flatMap((item) => (item.caseId === undefined ? [] : [item.caseId])),
          ),
        ];
        const cases = await Promise.all(
          caseIds.map(async (caseId: CaseId) => ({
            followUpCase: await stores.cases.get(clinic.id, caseId),
            audit: await stores.audit.listForCase(clinic.id, caseId),
          })),
        );
        return { expectations, events, cases };
      }),
    ]);
    const patientCalls = new Set(
      view.steps.flatMap((step) => {
        const callId = step.params?.['callId'];
        return typeof callId === 'string' ? [callId] : [];
      }),
    );
    return c.json({
      exportedAt: clock.now().toISOString(),
      clinicId: clinic.id,
      patientId,
      timeZone: view.timeZone,
      conversation: {
        mode: view.conversation.mode,
        language: view.conversation.language,
        status: view.conversation.status,
        phoneStatus: view.conversation.phoneStatus,
        ladder: {
          track: view.conversation.ladder.track,
          anchorAt: view.conversation.ladder.anchorAt.toISOString(),
          done: view.conversation.ladder.done,
        },
        createdAt: view.conversation.createdAt.toISOString(),
      },
      orders: view.orders.map((order) => ({
        orderId: order.orderId,
        kind: order.descriptor.kind,
        ...(order.descriptor.test === undefined ? {} : { test: order.descriptor.test }),
        source: order.descriptor.source,
        stage: order.stage,
        urgent: order.urgent,
        needsConfirmation: order.needsConfirmation,
        ...(order.doctorConfirmation === undefined
          ? {}
          : {
              doctorConfirmation: {
                by: order.doctorConfirmation.by,
                at: order.doctorConfirmation.at.toISOString(),
              },
            }),
      })),
      messages: view.messages.map(messageView),
      steps: view.steps.map(stepView),
      runs: view.runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        mode: run.mode,
        ...(run.model === undefined ? {} : { model: run.model }),
        ...(run.rung === undefined ? {} : { rung: run.rung }),
        ...(run.inboundMessageId === undefined ? {} : { inboundMessageId: run.inboundMessageId }),
        startedAt: run.startedAt.toISOString(),
        modelCalls: run.modelCalls,
        toolCalls: run.toolCalls,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: run.costUsd,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        ...(run.error === undefined ? {} : { error: run.error }),
      })),
      tasks: view.tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        priority: task.priority,
        status: task.status,
        ...(task.rung === undefined ? {} : { rung: task.rung }),
        createdAt: task.createdAt.toISOString(),
        dueAt: task.dueAt.toISOString(),
        summary: {
          ...task.summary,
          ...(task.summary.lastOutboundAt === undefined
            ? {}
            : { lastOutboundAt: task.summary.lastOutboundAt.toISOString() }),
        },
      })),
      appointments: view.appointments.map((appointment) => ({
        id: appointment.id,
        orderId: appointment.orderId,
        slotId: appointment.slot.id,
        start: appointment.slot.start.toISOString(),
        resourceKind: appointment.slot.resourceKind,
        confirmationMessageId: appointment.confirmationMessageId,
        bookedAt: appointment.bookedAt.toISOString(),
        ...(appointment.fhirAppointmentId === undefined
          ? {}
          : { fhirAppointmentId: appointment.fhirAppointmentId }),
        ...(appointment.originCaseId === undefined
          ? {}
          : { originCaseId: appointment.originCaseId }),
      })),
      findings: await findingViews(c, clinic.id, findings.items, runtime),
      llmUsage: llmCalls.map((call) => ({
        callId: call.callId,
        task: call.task,
        promptVersion: call.promptVersion,
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costUsd: call.costUsd,
        latencyMs: call.latencyMs,
        ok: call.ok,
        ...(call.error === undefined ? {} : { error: call.error }),
        at: call.at.toISOString(),
        /** A model call of this patient's agent turns (others: vision, voice, reviews, other patients of the lab clinic). */
        agentTurnOfPatient: patientCalls.has(call.callId),
      })),
      engine: {
        expectations: engine.expectations.map((item) => ({
          id: item.id,
          ruleId: item.ruleId,
          layer: item.layer,
          status: item.status,
          matchKey: item.matchKey,
          dueAt: item.dueAt.toISOString(),
          ...(item.caseId === undefined ? {} : { caseId: item.caseId }),
          ...(item.closedAt === undefined ? {} : { closedAt: item.closedAt.toISOString() }),
          ...(item.closedBy === undefined
            ? {}
            : { closedBy: `${item.closedBy.resourceType}/${item.closedBy.id}` }),
          ...(item.closedReason === undefined ? {} : { closedReason: item.closedReason }),
          agentOwned: view.orders.some((order) => order.orderId === item.id),
        })),
        clinicalEvents: engine.events.map((event) => ({
          type: event.type,
          source: `${event.source.resourceType}/${event.source.id}`,
          occurredAt: event.occurredAt.toISOString(),
          ...(event.recordedAt === undefined ? {} : { recordedAt: event.recordedAt.toISOString() }),
        })),
        cases: engine.cases.map(({ followUpCase, audit }) => ({
          ...(followUpCase === undefined
            ? {}
            : {
                id: followUpCase.id,
                status: followUpCase.status,
                ...(followUpCase.resolution === undefined
                  ? {}
                  : { resolution: followUpCase.resolution.kind }),
              }),
          audit: audit.map((event) => ({
            type: event.type,
            actor: event.actor,
            payload: event.payload,
            at: event.at.toISOString(),
          })),
        })),
      },
    });
  });

  app.post('/api/demo/agent/story', async (c) => {
    const body = await readJson(c, AgentStoryStartSchema);
    const { clinic, clock, evaluatorEmail } = await lab(c);
    if (body.mode === 'live' && !runtime.liveAgent) {
      throw new HttpError(422, 'agent_live_unavailable', c.var.t.errors.agentLiveUnavailable);
    }
    const { patientId } = await startOrderAgentStory(runtime, clinic.id, clock, {
      mode: body.mode,
      language: body.language,
      story: body.story,
    });
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_patient_created',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      payload: { story: body.story, mode: body.mode, language: body.language },
    });
    return c.json({ patientId }, 201);
  });

  /** The patient writes: JSON `{ text }`, or multipart with a `file` (a WAV voice note, a photo). */
  app.post('/api/demo/agent/patients/:id/messages', async (c) => {
    const { clinic } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    const patientId = view.conversation.patientId;
    const contentType = c.req.header('content-type') ?? '';
    let message: AgentMessage;
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form['file'];
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_AGENT_MEDIA_BYTES) {
        throw new HttpError(422, 'agent_media_type', c.var.t.errors.agentMediaType);
      }
      const type = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
      const kind = IMAGE_TYPES.has(type) ? 'image' : AUDIO_TYPES.has(type) ? 'voice' : undefined;
      if (kind === undefined) {
        throw new HttpError(422, 'agent_media_type', c.var.t.errors.agentMediaType);
      }
      message = await runtime.orderAgent.receiveMessage(clinic.id, patientId, {
        kind,
        media: { data: new Uint8Array(await file.arrayBuffer()), contentType: type },
      });
    } else {
      const body = await readJson(c, AgentTextMessageSchema);
      message = await runtime.orderAgent.receiveMessage(clinic.id, patientId, {
        kind: 'text',
        text: body.text,
      });
    }
    return c.json(messageView(message), 201);
  });

  /** The story's sample media: María's lab report photo, or her voice note in the conversation's language. */
  app.post('/api/demo/agent/patients/:id/samples', async (c) => {
    const body = await readJson(c, AgentSampleSchema);
    const { clinic } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    const name =
      body.sample === 'lab_report'
        ? 'labReport'
        : view.conversation.language === 'es'
          ? 'voiceEs'
          : 'voiceEn';
    const message = await runtime.orderAgent.receiveMessage(
      clinic.id,
      view.conversation.patientId,
      {
        kind: body.sample === 'lab_report' ? 'image' : 'voice',
        media: { data: readSample(name), contentType: SAMPLE_FILES[name].contentType },
      },
    );
    return c.json(messageView(message), 201);
  });

  app.post('/api/demo/agent/messages/:id/status', async (c) => {
    const body = await readJson(c, AgentDeliverySchema);
    const { clinic } = await lab(c);
    try {
      const message = await runtime.orderAgent.setDeliveryStatus(
        clinic.id,
        c.req.param('id'),
        body.status,
      );
      return c.json(messageView(message));
    } catch (error) {
      if (error instanceof Error && error.name === 'ValidationError') {
        throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
      }
      throw error;
    }
  });

  /**
   * The doctor confirms an order the engine created from a result ("Abnormal
   * result: confirm a follow-up visit?"): recorded with the doctor's id (the
   * evaluator's email in a lab clinic) and the clinic's time; only then does
   * the agent write to the patient about it.
   */
  app.post('/api/demo/agent/patients/:id/orders/:orderId/confirm', async (c) => {
    const { clinic, evaluatorEmail } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    try {
      await runtime.orderAgent.confirmOrder(
        clinic.id,
        view.conversation.patientId,
        c.req.param('orderId'),
        { by: evaluatorEmail },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'ValidationError') {
        throw new HttpError(409, 'order_not_awaiting_confirmation', c.var.t.errors.notFound);
      }
      throw error;
    }
    return c.body(null, 204);
  });

  app.post('/api/demo/agent/patients/:id/phone-fixed', async (c) => {
    const { clinic } = await lab(c);
    const view = await requireConversation(c, clinic.id, c.req.param('id'));
    await runtime.orderAgent.fixPhone(clinic.id, view.conversation.patientId);
    return c.body(null, 204);
  });

  /** Jumps the lab clinic's own clock: the engine's sweeps and the agent's ladder run day by day. */
  app.post('/api/demo/agent/clock', async (c) => {
    const body = await readJson(c, AgentClockSchema);
    const { clinic, clock, evaluatorEmail } = await lab(c);
    const target = new Date(clock.now().getTime() + body.days * 86_400_000);
    try {
      const advance = await setLabClinicDate(runtime, clock, clinic.id, target);
      await trackEvaluatorEvent(runtime, {
        clinicId: clinic.id,
        evaluatorEmail,
        action: 'lab_date_viewed',
        payload: { from: advance.from.toISOString(), to: advance.to.toISOString() },
      });
      return c.json({ from: advance.from.toISOString(), to: advance.to.toISOString() });
    } catch (error) {
      if (error instanceof InvalidLabDateError) {
        throw new HttpError(422, 'lab_past_date', c.var.t.errors.labPastDate);
      }
      throw error;
    }
  });

  /** A voice note or photo of the lab clinic's conversations (for the simulated phone). */
  app.get('/api/demo/agent/media/:id', async (c) => {
    const { clinic } = await lab(c);
    const media = await runtime.storage.orderAgent.getMedia(clinic.id, c.req.param('id'));
    if (media === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    return c.body(new Uint8Array(media.data), 200, {
      'content-type': media.contentType,
      'cache-control': 'private, max-age=3600',
    });
  });
}
